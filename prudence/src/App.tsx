import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message, Conversation as SDKConversation, StoredMessage } from '@meshwhisper/sdk';
import { MeshWhisper } from '@meshwhisper/sdk';
import { initSDK, getSDK } from './sdk.ts';
import { getPushSubscription } from './push.ts';
import { initStorage, idbStorage } from './storage.ts';
import { deriveIdentityKey, uint8ArrayToHex } from './crypto.ts';
import { saveContactName, saveContactNameInteractive, getContactName, getAllContactNames, removeContactName } from './contact-names.ts';
import { isHandled, markAccepted, markDeclined as markDeclinedContact, getAll as getAllAccepted, restoreAll as restoreAccepted } from './accepted-contacts.ts';
import { loadGroups, upsertGroup, removeStoredGroup } from './group-storage.ts';
import { generateThumbnail, readFileBytes, downloadAndDecrypt, triggerDownload, isImageMime, formatFileSize as _formatFileSize } from './media.ts';
import { showMessageNotification } from './notifications.ts';
import type { AppState, AppMessage, AppMessageMedia, Conversation, Contact, GroupInfo } from './types.ts';
import Onboarding from './components/Onboarding.tsx';
import Login from './components/Login.tsx';
import ConversationList from './components/ConversationList.tsx';
import Thread from './components/Thread.tsx';
import PendingRequests from './components/PendingRequests.tsx';
import CreateGroup from './components/CreateGroup.tsx';
import GroupInviteModal from './components/GroupInviteModal.tsx';

const USERNAME_KEY = 'prudence:username';

function decoder(payload: number[]): string {
  try {
    return new TextDecoder().decode(new Uint8Array(payload));
  } catch {
    return '';
  }
}

function isControlMessage(text: string): boolean {
  try {
    const obj = JSON.parse(text) as { __prudence_ctrl?: unknown };
    return typeof obj.__prudence_ctrl === 'string';
  } catch {
    return false;
  }
}

function extractMediaPointer(text: string): { url: string; key: string; mimeType: string; thumb?: string; fileName?: string; fileSize?: number } | null {
  try {
    const obj = JSON.parse(text) as { __mw_media?: boolean; url?: string; key?: string; mimeType?: string; thumb?: string; fileName?: string; fileSize?: number };
    if (!obj.__mw_media || !obj.url || !obj.key) return null;
    return { url: obj.url, key: obj.key, mimeType: obj.mimeType ?? 'application/octet-stream', thumb: obj.thumb, fileName: obj.fileName, fileSize: obj.fileSize };
  } catch { return null; }
}

function extractContactRequest(text: string): { username?: string } | null {
  try {
    const obj = JSON.parse(text) as { __prudence_ctrl?: string; username?: string };
    return obj.__prudence_ctrl === 'contact_request' ? { username: obj.username } : null;
  } catch {
    return null;
  }
}

function makeContact(peerId: string, username?: string): Contact {
  const name = username ?? getContactName(peerId);
  return {
    peerId,
    username: name,
    displayName: name ? `@${name}` : peerId.slice(0, 8),
    addedAt: Date.now(),
  };
}

function makeGroupConversation(group: GroupInfo): Conversation {
  return {
    id: group.id,
    contact: { peerId: group.id, displayName: group.name, addedAt: Date.now() },
    group,
    unread: 0,
    isTyping: false,
  };
}

function senderDisplayName(senderId: string): string {
  const name = getContactName(senderId);
  return name ? `@${name}` : senderId.slice(0, 8);
}

export default function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<AppState>({
    myUsername: '',
    conversations: [],
    activeConversationId: null,
    messages: {},
    pendingRequests: [],
    pendingGroupInvites: [],
    connected: false,
  });
  const [showPending, setShowPending] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showGroupInvites, setShowGroupInvites] = useState(false);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Two timers: a 5s "no-activity" debounce and a 30s "max wait" cap so
  // the debounce can't be reset forever during a busy conversation.
  // Whichever fires first triggers the push; both are cancelled on fire.
  const archiveSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const archiveSyncMaxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const archivePending = useRef(false);

  // SDK reference: archive sync. See ../REFERENCE.md "Archive sync".
  // scheduleArchiveSync = debounced (5s) for routine state changes;
  // forceArchiveSync = immediate (no debounce) for tombstone/revival;
  // flushArchiveSync = the actual push, called by both and by pagehide.
  function flushArchiveSync(sdk: ReturnType<typeof getSDK>, keepalive = false): void {
    if (!sdk) return;
    if (archiveSyncTimer.current) {
      clearTimeout(archiveSyncTimer.current);
      archiveSyncTimer.current = null;
    }
    if (archiveSyncMaxTimer.current) {
      clearTimeout(archiveSyncMaxTimer.current);
      archiveSyncMaxTimer.current = null;
    }
    if (!archivePending.current) return;
    archivePending.current = false;
    sdk.pushArchive(
      {
        contactNames: getAllContactNames(),
        acceptedContacts: getAllAccepted(),
        groups: JSON.parse(localStorage.getItem('prudence:groups') ?? '[]'),
      },
      keepalive ? { keepalive: true } : undefined,
    ).catch((e: unknown) => console.warn('[archive] push failed:', e));
  }

  function scheduleArchiveSync(sdk: ReturnType<typeof getSDK>) {
    if (!sdk) return;
    archivePending.current = true;
    if (archiveSyncTimer.current) clearTimeout(archiveSyncTimer.current);
    archiveSyncTimer.current = setTimeout(() => flushArchiveSync(sdk), 5_000);
    if (!archiveSyncMaxTimer.current) {
      archiveSyncMaxTimer.current = setTimeout(() => flushArchiveSync(sdk), 30_000);
    }
  }

  // Force an immediate archive push (no debounce). Used for tombstone /
  // revival events fired by the SDK via onArchiveDirty — those *must* reach
  // the relay before the next reload, otherwise stale remote state can
  // resurrect deleted peers or re-suppress revived ones.
  function forceArchiveSync(sdk: ReturnType<typeof getSDK>): void {
    if (!sdk) return;
    archivePending.current = true;
    flushArchiveSync(sdk, /* keepalive */ false);
  }

  // Flush any pending archive push when the tab is hidden or unloaded —
  // a 5s debounce is meaningless if the user closes the tab in the
  // middle of activity. visibilitychange covers the common PWA case
  // (switching tabs / putting phone to sleep); pagehide is the most
  // reliable mobile-Safari/iOS unload signal.
  useEffect(() => {
    const flush = () => flushArchiveSync(getSDK(), true);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SDK reference: read-status persistence. See ../REFERENCE.md
  // "Delivery / read receipts". markRead (DM) sends a receipt to the peer;
  // markReadLocal (group) only updates IDB without a receipt.
  // Mark all inbound unread messages in a conversation as read.
  // Persists status to SDK storage so getConversations() doesn't
  // resurface them as unread on the next reload. Sends a read
  // receipt to the peer for DMs; for groups we just update locally
  // (read-receipt fan-out across group members is a TODO).
  // Side effects fire inside the updater, so in React strict mode
  // they may run twice per render — both SDK calls are idempotent.
  function markConversationRead(conversationId: string) {
    setState((prev) => {
      const conv = prev.conversations.find((c) => c.id === conversationId);
      if (!conv) return prev;
      const isGroup = !!conv.group;
      const msgs = prev.messages[conversationId] ?? [];
      let changed = false;
      const updatedMsgs = msgs.map((m) => {
        if (m.direction === 'inbound' && m.status !== 'read') {
          changed = true;
          (isGroup
            ? MeshWhisper.markReadLocal(m.id, conversationId)
            : MeshWhisper.markRead(m.id, conversationId)
          ).catch(() => {});
          return { ...m, status: 'read' as const };
        }
        return m;
      });
      if (!changed && conv.unread === 0) return prev;
      return {
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.id === conversationId ? { ...c, unread: 0 } : c,
        ),
        messages: changed ? { ...prev.messages, [conversationId]: updatedMsgs } : prev.messages,
      };
    });
  }

  // When a notification is clicked, navigate to that conversation.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ conversationId?: string }>).detail;
      if (!detail?.conversationId) return;
      const id = detail.conversationId;
      setState((prev) => ({ ...prev, activeConversationId: id }));
      markConversationRead(id);
    };
    document.addEventListener('prudence:openConversation', handler);
    return () => document.removeEventListener('prudence:openConversation', handler);
  }, []);

  useEffect(() => {
    const u = localStorage.getItem(USERNAME_KEY);
    if (!u) {
      setLoading(false);
      return;
    }
    initStorage(u);
    setUsername(u);
    // If the app was explicitly locked this session, require password
    if (sessionStorage.getItem('prudence:locked')) {
      setLoading(false);
      return;
    }
    // Auto-authenticate if identity key is already in IDB
    idbStorage.get('identity').then((key) => {
      if (key) setAuthenticated(true);
      setLoading(false);
    });
  }, []);

  // SDK reference: onMessage receive path. See ../REFERENCE.md "Sending
  // and receiving messages". Note the early-return branches for app-level
  // __prudence_ctrl messages and media-pointer messages before the
  // "normal chat message" fall-through.
  const handleMessage = useCallback((msg: Message) => {
    console.log('[prudence] onMessage', { senderId: msg.senderId, payloadLen: msg.payload.length });
    const text = decoder(Array.from(msg.payload));
    if (!text) return;

    // Self-fan-out (sdk 0.5+): a message I sent from another linked device
    // arrives here as a sync. The senderId is *this* device's peerId, and
    // the conversation key is the original recipient (or groupId).
    const isSelfSync = msg.senderId === MeshWhisper.getLocalPeerId();
    const conversationId = msg.groupId ?? (isSelfSync ? msg.recipientId : msg.senderId);
    const isGroup = !!msg.groupId;

    try {
      const ctrl = JSON.parse(text) as { __prudence_ctrl?: string; username?: string };
      if (ctrl.__prudence_ctrl === 'contact_request') {
        console.log('[prudence] contact_request from', msg.senderId, 'username:', ctrl.username);
        if (ctrl.username) saveContactName(msg.senderId, ctrl.username);
        if (!isHandled(msg.senderId)) {
          setState((prev) => {
            // If the SDK already surfaced this peer as a pending request when
            // their x3dh_init arrived, just fill in the username we now have.
            const existing = prev.pendingRequests.find((r) => r.peerId === msg.senderId);
            if (existing) {
              if (!ctrl.username || existing.username === ctrl.username) return prev;
              return {
                ...prev,
                pendingRequests: prev.pendingRequests.map((r) =>
                  r.peerId === msg.senderId ? { ...r, username: ctrl.username } : r,
                ),
              };
            }
            return {
              ...prev,
              pendingRequests: [...prev.pendingRequests, {
                peerId: msg.senderId,
                username: ctrl.username,
                introducedBy: msg.senderId,
              }],
            };
          });
          setShowPending(true);
        }
        return;
      }
    } catch { /* not a control message */ }

    const mediaPtr = extractMediaPointer(text);
    if (mediaPtr) {
      const mediaMsg: AppMessage = {
        id: msg.id ?? crypto.randomUUID(),
        conversationId,
        text: isImageMime(mediaPtr.mimeType) ? 'Photo' : (mediaPtr.fileName ?? 'File'),
        timestamp: msg.timestamp ?? Date.now(),
        direction: isSelfSync ? 'outbound' : 'inbound',
        status: isSelfSync ? 'sent' : 'delivered',
        media: { ...mediaPtr, status: 'pending' },
        ...(isGroup && msg.groupSenderId ? { senderId: msg.groupSenderId, senderName: senderDisplayName(msg.groupSenderId) } : {}),
      };
      setState((prev) => {
        const existingConv = prev.conversations.find((c) => c.id === conversationId);
        const contact = existingConv?.contact ?? makeContact(conversationId);
        const isActive = prev.activeConversationId === conversationId;
        if (isActive && mediaMsg.id && !isSelfSync) {
          // Conversation is open — mark as read immediately so the unread
          // badge doesn't resurface on the next reload.
          (isGroup
            ? MeshWhisper.markReadLocal(mediaMsg.id, conversationId)
            : MeshWhisper.markRead(mediaMsg.id, conversationId)
          ).catch(() => {});
          mediaMsg.status = 'read';
        }
        const unread = isSelfSync
          ? (existingConv?.unread ?? 0)
          : (isActive ? 0 : (existingConv?.unread ?? 0) + 1);
        const updatedConv: Conversation = existingConv
          ? { ...existingConv, lastMessage: mediaMsg, unread }
          : { id: conversationId, contact, lastMessage: mediaMsg, unread, isTyping: false };
        const conversations = existingConv
          ? prev.conversations.map((c) => (c.id === conversationId ? updatedConv : c))
          : [updatedConv, ...prev.conversations];
        conversations.sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
        if (!isSelfSync) {
          const isActiveAndVisible = isActive && document.visibilityState === 'visible' && document.hasFocus();
          const senderLabel = isGroup
            ? (existingConv?.contact.displayName ?? '@group')
            : (`@${contact.username ?? contact.peerId.slice(0, 8)}`);
          showMessageNotification({
            title: senderLabel,
            body: mediaMsg.text,
            conversationId,
            timestamp: mediaMsg.timestamp,
            suppressBecauseActive: isActiveAndVisible,
          });
        }
        return { ...prev, conversations, messages: { ...prev.messages, [conversationId]: [...(prev.messages[conversationId] ?? []), mediaMsg] } };
      });
      return;
    }

    const appMsg: AppMessage = {
      id: msg.id ?? crypto.randomUUID(),
      conversationId,
      text,
      timestamp: msg.timestamp ?? Date.now(),
      direction: isSelfSync ? 'outbound' : 'inbound',
      status: isSelfSync ? 'sent' : 'delivered',
      ...(isGroup && msg.groupSenderId ? {
        senderId: msg.groupSenderId,
        senderName: senderDisplayName(msg.groupSenderId),
      } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.forwardedFrom ? { forwardedFrom: msg.forwardedFrom } : {}),
    };

    setState((prev) => {
      const existingConv = prev.conversations.find((c) => c.id === conversationId);
      const contact = existingConv?.contact ?? makeContact(conversationId);
      const isActive = prev.activeConversationId === conversationId;

      // For inbound messages with the conversation open, mark as read so
      // the unread badge doesn't resurface on the next reload. Self-sync
      // messages are already "ours" — nothing to mark read.
      if (isActive && !isSelfSync) {
        (isGroup
          ? MeshWhisper.markReadLocal(appMsg.id, conversationId)
          : MeshWhisper.markRead(appMsg.id, conversationId)
        ).catch(() => {});
        appMsg.status = 'read';
      }

      // Self-sync never bumps unread or fires a notification — it's a
      // mirror of something I just typed on another device.
      const unread = isSelfSync
        ? (existingConv?.unread ?? 0)
        : (isActive ? 0 : (existingConv?.unread ?? 0) + 1);
      const updatedConv: Conversation = existingConv
        ? { ...existingConv, lastMessage: appMsg, unread }
        : { id: conversationId, contact, lastMessage: appMsg, unread, isTyping: false };

      const conversations = existingConv
        ? prev.conversations.map((c) => (c.id === conversationId ? updatedConv : c))
        : [updatedConv, ...prev.conversations];

      conversations.sort((a, b) =>
        (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0),
      );

      if (!isSelfSync) {
        const isActiveAndVisible = isActive && document.visibilityState === 'visible' && document.hasFocus();
        const senderLabel = isGroup && msg.groupSenderId
          ? `${senderDisplayName(msg.groupSenderId)} · ${existingConv?.contact.displayName ?? 'group'}`
          : `@${contact.username ?? contact.peerId.slice(0, 8)}`;
        showMessageNotification({
          title: senderLabel,
          body: appMsg.text,
          conversationId,
          timestamp: appMsg.timestamp,
          suppressBecauseActive: isActiveAndVisible,
        });
      }

      return {
        ...prev,
        conversations,
        messages: {
          ...prev.messages,
          [conversationId]: [...(prev.messages[conversationId] ?? []), appMsg],
        },
      };
    });
    scheduleArchiveSync(getSDK());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // SDK reference: onMessageStatus. The SDK fires this when a peer's
  // 'delivered' or 'read' control receipt updates the local stored copy
  // of an outbound message. Walk the in-memory thread state and bump
  // the matching message's status. Only ever advances (sent → delivered
  // → read), so a stale 'delivered' arriving after a 'read' is ignored
  // — receipts can race across reconnects.
  const handleMessageStatus = useCallback((messageId: string, status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed') => {
    const rank: Record<typeof status, number> = {
      sending: 0, sent: 1, delivered: 2, read: 3, failed: 1,
    };
    setState((prev) => {
      let touched = false;
      const messages: typeof prev.messages = {};
      for (const [convId, msgs] of Object.entries(prev.messages)) {
        let any = false;
        const next = msgs.map((m) => {
          if (m.id !== messageId) return m;
          if (rank[status] <= rank[m.status]) return m;
          any = true; touched = true;
          return { ...m, status };
        });
        messages[convId] = any ? next : msgs;
      }
      if (!touched) return prev;
      // Also keep the conversation list's lastMessage in sync so the
      // tick on the conversation row matches the thread.
      const conversations = prev.conversations.map((c) => {
        if (c.lastMessage?.id !== messageId) return c;
        if (rank[status] <= rank[c.lastMessage.status]) return c;
        return { ...c, lastMessage: { ...c.lastMessage, status } };
      });
      return { ...prev, messages, conversations };
    });
  }, []);

  const handleTyping = useCallback((peerId: string, isTyping: boolean) => {
    setState((prev) => ({
      ...prev,
      conversations: prev.conversations.map((c) =>
        c.id === peerId ? { ...c, isTyping } : c,
      ),
    }));

    if (isTyping) {
      const existing = typingTimers.current.get(peerId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        setState((prev) => ({
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === peerId ? { ...c, isTyping: false } : c,
          ),
        }));
        typingTimers.current.delete(peerId);
      }, 7000);
      typingTimers.current.set(peerId, timer);
    }
  }, []);

  const handleContactRequest = useCallback(
    (peerId: string, introducedBy: string, reqUsername?: string) => {
      if (isHandled(peerId)) return;
      setState((prev) => ({
        ...prev,
        pendingRequests: [...prev.pendingRequests, { peerId, introducedBy, username: reqUsername }],
      }));
      setShowPending(true);
    },
    [],
  );

  const handleGroupInvite = useCallback(
    (groupId: string, groupName: string, invitedBy: string, members: string[]) => {
      setState((prev) => {
        if (prev.pendingGroupInvites.some((i) => i.groupId === groupId)) return prev;
        return { ...prev, pendingGroupInvites: [...prev.pendingGroupInvites, { groupId, groupName, invitedBy, members }] };
      });
      setShowGroupInvites(true);
    },
    [],
  );

  // Fires when the group's admin adds someone new to a group we're already
  // in. The SDK has already added them to the in-memory roster and stored
  // their sender + Ed25519 keys. We persist the membership change and
  // surface a "@alice added @carol" system message.
  const handleGroupMemberAdded = useCallback((groupId: string, peerId: string, addedBy: string) => {
    void (async () => {
      let addedName = getContactName(peerId);
      if (!addedName) {
        addedName = (await MeshWhisper.resolveUsername(peerId).catch(() => undefined))
          ?? (peerId.slice(0, 8) + '…');
        if (addedName && !addedName.includes('…')) saveContactName(peerId, addedName);
      }
      let adderName = getContactName(addedBy);
      if (!adderName) {
        adderName = (await MeshWhisper.resolveUsername(addedBy).catch(() => undefined))
          ?? (addedBy.slice(0, 8) + '…');
        if (adderName && !adderName.includes('…')) saveContactName(addedBy, adderName);
      }

      const groups = await loadGroups();
      const stored = groups.find((g) => g.id === groupId);
      if (stored && !stored.members.some((m) => m.peerId === peerId)) {
        const updated = {
          ...stored,
          members: [...stored.members, { peerId, role: 'member' as const, username: addedName }],
        };
        await upsertGroup(updated).catch(() => {});
      }

      const systemMsg: AppMessage = {
        id: crypto.randomUUID(),
        conversationId: groupId,
        text: `@${adderName} added @${addedName}`,
        timestamp: Date.now(),
        direction: 'inbound',
        status: 'delivered',
      };
      setState((prev) => {
        const conv = prev.conversations.find((c) => c.id === groupId);
        if (!conv?.group) return prev;
        if (conv.group.members.some((m) => m.peerId === peerId)) return prev;
        const newGroup: GroupInfo = {
          ...conv.group,
          members: [...conv.group.members, { peerId, role: 'member', username: addedName }],
        };
        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === groupId ? { ...c, group: newGroup, lastMessage: systemMsg } : c,
          ),
          messages: {
            ...prev.messages,
            [groupId]: [...(prev.messages[groupId] ?? []), systemMsg],
          },
        };
      });
    })();
  }, []);

  // Fires when another group member leaves and their group_leave control
  // message arrives. The SDK has already removed them from its in-memory
  // roster and rotated remaining sender keys. We mirror the change in
  // IDB-stored group state and inject a system message into the
  // conversation so the user sees "@alice left the group."
  const handleGroupMemberLeft = useCallback((groupId: string, peerId: string) => {
    void (async () => {
      // Try to resolve the leaver's @username — local contact name first,
      // relay directory as fallback. If both fail, show a truncated peer ID.
      let leftName = getContactName(peerId);
      if (!leftName) {
        leftName = (await MeshWhisper.resolveUsername(peerId).catch(() => undefined))
          ?? (peerId.slice(0, 8) + '…');
        if (leftName && !leftName.includes('…')) saveContactName(peerId, leftName);
      }

      const groups = await loadGroups();
      const stored = groups.find((g) => g.id === groupId);
      if (stored) {
        const updated = { ...stored, members: stored.members.filter((m) => m.peerId !== peerId) };
        await upsertGroup(updated).catch(() => {});
      }

      const systemMsg: AppMessage = {
        id: crypto.randomUUID(),
        conversationId: groupId,
        text: `@${leftName} left the group`,
        timestamp: Date.now(),
        direction: 'inbound',
        status: 'delivered',
      };
      setState((prev) => {
        const conv = prev.conversations.find((c) => c.id === groupId);
        if (!conv?.group) return prev;
        const newGroup: GroupInfo = {
          ...conv.group,
          members: conv.group.members.filter((m) => m.peerId !== peerId),
        };
        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === groupId ? { ...c, group: newGroup, lastMessage: systemMsg } : c,
          ),
          messages: {
            ...prev.messages,
            [groupId]: [...(prev.messages[groupId] ?? []), systemMsg],
          },
        };
      });
    })();
  }, []);

  const handleConnectionStatus = useCallback((status: 'connected' | 'disconnected') => {
    setState((prev) => ({ ...prev, connected: status === 'connected' }));
  }, []);

  // SDK reference: history recovery — recipient consent gate.
  // See ../REFERENCE.md "Conversation history recovery".
  // Peer is asking us to share our copy of their conversation history (they
  // probably deleted it locally and want to recover). Prompt once per peer
  // and remember the decision in localStorage so the recipient isn't asked
  // again on every request.
  const handleHistoryRequest = useCallback((peerId: string): boolean => {
    const consentKey = `prudence:share-history-consent:${peerId}`;
    const cached = localStorage.getItem(consentKey);
    if (cached === 'yes') return true;
    if (cached === 'no') return false;
    const name = getContactName(peerId) ?? peerId.slice(0, 8);
    const ok = window.confirm(
      `@${name} is asking for a copy of your conversation history. They've lost their messages and need to recover.\n\nShare your message history with them?`,
    );
    localStorage.setItem(consentKey, ok ? 'yes' : 'no');
    return ok;
  }, []);

  // Peer has just sent back our requested history. The SDK already wrote the
  // recovered messages to IDB; reload them into React state so the UI shows
  // them. count > 0 means actual new messages landed (after dedup). We mirror
  // the same isControlMessage filter the boot loader uses — Prudence's app-
  // level control messages (__prudence_ctrl: 'contact_request' etc.) are
  // persisted alongside real messages but must not surface in the thread.
  const handleHistoryRestored = useCallback((peerId: string, _count: number) => {
    void (async () => {
      const sdk = getSDK();
      if (!sdk) return;
      const msgs = await sdk.getMessagesInstance(peerId).catch(() => null);
      if (!msgs) return;
      const appMsgs: AppMessage[] = [];
      for (const m of msgs as StoredMessage[]) {
        const text = decoder(m.payload);
        if (text && isControlMessage(text)) continue;
        const mediaPtr = text ? extractMediaPointer(text) : null;
        appMsgs.push({
          id: m.id,
          conversationId: peerId,
          text: mediaPtr
            ? (isImageMime(mediaPtr.mimeType) ? 'Photo' : (mediaPtr.fileName ?? 'File'))
            : (text ?? ''),
          timestamp: m.timestamp,
          direction: m.direction,
          status: m.status,
          ...(mediaPtr ? { media: { ...mediaPtr, status: 'ready' as const } } : {}),
          ...(m.reactions ? { reactions: m.reactions } : {}),
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
          ...(m.forwardedFrom ? { forwardedFrom: m.forwardedFrom } : {}),
        });
      }
      setState((prev) => ({
        ...prev,
        messages: { ...prev.messages, [peerId]: appMsgs },
        conversations: prev.conversations.map((c) =>
          c.id === peerId && appMsgs.length > 0
            ? { ...c, lastMessage: appMsgs[appMsgs.length - 1] }
            : c,
        ),
      }));
    })();
  }, []);

  // Boot SDK once identity key is in IDB and username is confirmed
  useEffect(() => {
    if (!username || !authenticated) return;
    let cancelled = false;

    const onVisibility = () => {
      if (document.visibilityState === 'visible') getSDK()?.pullInstance();
    };
    document.addEventListener('visibilitychange', onVisibility);

    void (async () => {
      const pushSub = await getPushSubscription().catch(() => null);
      if (cancelled) return;

      void initSDK(username, {
        onMessage: handleMessage,
        onMessageStatus: handleMessageStatus,
        onTyping: handleTyping,
        onContactRequest: handleContactRequest,
        onConnectionStatus: handleConnectionStatus,
        onGroupInvite: handleGroupInvite,
        onGroupMemberLeft: handleGroupMemberLeft,
        onGroupMemberAdded: handleGroupMemberAdded,
        onGroupAdminChanged: handleGroupAdminChanged,
        onGroupMemberKicked: handleGroupMemberKicked,
        onGroupRenamed: handleGroupRenamed,
        onReactionUpdated: handleReactionUpdated,
        onDisappearingMessagesChanged: handleDisappearingMessagesChanged,
        onKickedFromGroup: handleKickedFromGroup,
        // Force-push the archive whenever the SDK writes a tombstone or
        // revival. Bypasses the 5s debounce so a delete or re-add can't be
        // lost if the user closes the app before the timer fires.
        onArchiveDirty: () => forceArchiveSync(getSDK()),
        onHistoryRequest: handleHistoryRequest,
        onHistoryRestored: handleHistoryRestored,
      }, pushSub).then(async (sdk) => {
      if (cancelled) return;

      // SDK reference: boot sequence. See ../REFERENCE.md "Archive sync".
      // Archive sync: always pull from relay (merge with local data) so that
      // conversations started on another device appear here too. Then push the
      // merged state back so the relay stays up to date.
      try {
        const { restored, extra } = await sdk.pullArchive();
        if (restored && extra) {
          if (extra.contactNames && typeof extra.contactNames === 'object') {
            for (const [pid, name] of Object.entries(extra.contactNames as Record<string, string>)) {
              // Only fill in names we don't already have locally.
              if (!getContactName(pid)) saveContactName(pid, name);
            }
          }
          if (Array.isArray(extra.acceptedContacts)) {
            restoreAccepted(extra.acceptedContacts as string[]);
          }
        }
        if (cancelled) return;
        // Push merged state so the relay archive reflects all devices.
        scheduleArchiveSync(sdk);
      } catch (e) {
        console.warn('[archive] sync failed:', e);
      }
      if (cancelled) return;

      // Restore persisted group state into SDK memory
      const storedGroups = await loadGroups();
      for (const g of storedGroups) {
        MeshWhisper.restoreGroup(g.id, g.name, g.members.map((m) => m.peerId), g.senderKeys);
      }

      setState((prev) => ({ ...prev, myUsername: username, connected: true }));
      sdk.getConversationsInstance().then((convs: SDKConversation[]) => {
        if (cancelled) return;
        const groupIds = new Set(storedGroups.map((g) => g.id));

        const dmConvs: Conversation[] = convs
          .filter((c) => !groupIds.has(c.peerId))
          .map((c: SDKConversation) => ({
            id: c.peerId,
            contact: makeContact(c.peerId),
            unread: c.unreadCount ?? 0,
            isTyping: false,
          }));

        const groupConvs: Conversation[] = storedGroups.map((g) => ({
          id: g.id,
          contact: { peerId: g.id, displayName: g.name, addedAt: g.createdAt },
          group: { id: g.id, name: g.name, members: g.members } satisfies GroupInfo,
          unread: convs.find((c) => c.peerId === g.id)?.unreadCount ?? 0,
          isTyping: false,
        }));

        const appConvs = [...dmConvs, ...groupConvs];
        // Hydrate the disappearing-messages policy for each DM from the
        // SDK's persisted state so the header icon reflects reality on
        // boot, not just after the user re-opens the picker.
        const disappearingByConversation: Record<string, number | null> = {};
        for (const conv of appConvs) {
          if (conv.group) continue;
          const ttl = MeshWhisper.getDisappearingMessages(conv.id);
          if (ttl) disappearingByConversation[conv.id] = ttl;
        }
        setState((prev) => ({ ...prev, conversations: appConvs, disappearingByConversation }));

        // Backfill display names for any DM whose peer doesn't have a
        // saved contactName. This heals conversations whose original
        // prudence_contact_request follow-up was lost — the relay
        // directory still knows the peer's @name.
        for (const conv of dmConvs) {
          if (conv.contact.username) continue;
          void MeshWhisper.resolveUsername(conv.contact.peerId).then((username) => {
            if (!username || cancelled) return;
            saveContactName(conv.contact.peerId, username);
            setState((prev) => ({
              ...prev,
              conversations: prev.conversations.map((c) =>
                c.id === conv.contact.peerId
                  ? { ...c, contact: { ...c.contact, username, displayName: username } }
                  : c,
              ),
            }));
          }).catch(() => {});
        }
        convs.forEach(async (c: SDKConversation) => {
          const msgs = await sdk.getMessagesInstance(c.peerId);
          if (!msgs || cancelled) return;

          const pendingFromHistory: Array<{ peerId: string; username?: string }> = [];
          const appMsgs: AppMessage[] = [];

          for (const m of msgs as StoredMessage[]) {
            const text = decoder(m.payload);
            if (isControlMessage(text)) {
              if (m.direction === 'inbound') {
                const cr = extractContactRequest(text);
                if (cr && !isHandled(c.peerId)) pendingFromHistory.push({ peerId: c.peerId, username: cr.username });
              }
              continue;
            }
            const mediaPtr = extractMediaPointer(text);
            appMsgs.push({
              id: m.id,
              conversationId: c.peerId,
              text: mediaPtr
                ? (isImageMime(mediaPtr.mimeType) ? 'Photo' : (mediaPtr.fileName ?? 'File'))
                : text,
              timestamp: m.timestamp,
              direction: m.direction,
              status: m.status,
              ...(m.groupSenderId && m.direction === 'inbound' ? {
                senderId: m.groupSenderId,
                senderName: senderDisplayName(m.groupSenderId),
              } : {}),
              ...(mediaPtr ? { media: { ...mediaPtr, status: 'pending' as const } } : {}),
              ...(m.reactions ? { reactions: m.reactions } : {}),
              ...(m.replyTo ? { replyTo: m.replyTo } : {}),
              ...(m.forwardedFrom ? { forwardedFrom: m.forwardedFrom } : {}),
            });
          }

          setState((prev) => {
            let next = { ...prev };
            if (pendingFromHistory.length > 0) {
              const newPending = pendingFromHistory.filter(
                (r) => !prev.pendingRequests.some((p) => p.peerId === r.peerId),
              );
              if (newPending.length > 0) {
                next = {
                  ...next,
                  pendingRequests: [
                    ...next.pendingRequests,
                    ...newPending.map((r) => ({ ...r, introducedBy: r.peerId })),
                  ],
                };
              }
            }
            if (appMsgs.length > 0) {
              next = {
                ...next,
                messages: { ...next.messages, [c.peerId]: appMsgs },
                conversations: next.conversations.map((conv) =>
                  conv.id === c.peerId
                    ? { ...conv, lastMessage: appMsgs[appMsgs.length - 1] }
                    : conv,
                ),
              };
            }
            return next;
          });

          if (pendingFromHistory.length > 0 && !cancelled) setShowPending(true);
        });
      });
    }).catch(console.error);
    })();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [username, authenticated, handleMessage, handleMessageStatus, handleTyping, handleContactRequest, handleConnectionStatus, handleGroupInvite, handleHistoryRequest, handleHistoryRestored]);

  async function handleRegister(chosenUsername: string, password: string) {
    initStorage(chosenUsername);
    const seed = await deriveIdentityKey(chosenUsername, password);
    await idbStorage.set('identity', uint8ArrayToHex(seed));
    localStorage.setItem(USERNAME_KEY, chosenUsername);
    setUsername(chosenUsername);
    setAuthenticated(true);
  }

  async function handleLogin(password: string) {
    if (!username) return;
    const seed = await deriveIdentityKey(username, password);
    await idbStorage.set('identity', uint8ArrayToHex(seed));
    sessionStorage.removeItem('prudence:locked');
    setAuthenticated(true);
  }

  function handleSwitchUser() {
    localStorage.removeItem(USERNAME_KEY);
    location.reload();
  }

  // SDK reference: send path. See ../REFERENCE.md "Sending and receiving
  // messages". DMs route through sdk.sendMessage; groups through sdk.sendToGroup.
  // DM-only reactions. Optimistically toggle locally then send the control.
  async function handleReact(conversationId: string, messageId: string, emoji: string) {
    const me = MeshWhisper.getLocalPeerId();
    setState((prev) => ({
      ...prev,
      messages: {
        ...prev.messages,
        [conversationId]: (prev.messages[conversationId] ?? []).map((m) => {
          if (m.id !== messageId) return m;
          const reactions = { ...(m.reactions ?? {}) };
          const peers = reactions[emoji] ?? [];
          if (peers.includes(me)) {
            const next = peers.filter((p) => p !== me);
            if (next.length === 0) delete reactions[emoji];
            else reactions[emoji] = next;
          } else {
            reactions[emoji] = [...peers, me];
          }
          return { ...m, reactions };
        }),
      },
    }));
    try {
      await MeshWhisper.toggleReaction(conversationId, messageId, emoji);
      scheduleArchiveSync(getSDK());
    } catch (err) {
      console.error('[react] failed:', err);
    }
  }

  // Forward an existing message to another contact.
  async function handleForward(fromConversationId: string, messageId: string, toPeerId: string) {
    try {
      await MeshWhisper.forwardMessage(fromConversationId, messageId, toPeerId);
      scheduleArchiveSync(getSDK());
    } catch (err) {
      console.error('[forward] failed:', err);
    }
  }

  // Set the disappearing-messages policy on a DM. Updates local state +
  // injects a system message so the change is visible in the timeline.
  async function handleSetDisappearing(conversationId: string, ttlMs: number | null) {
    try {
      await MeshWhisper.setDisappearingMessages(conversationId, ttlMs);
    } catch (err) {
      console.error('[setDisappearingMessages] failed:', err);
      return;
    }
    const label = ttlMs === null
      ? 'off'
      : ttlMs >= 24 * 60 * 60_000 ? `${Math.round(ttlMs / (24 * 60 * 60_000))} day(s)`
      : ttlMs >= 60 * 60_000 ? `${Math.round(ttlMs / (60 * 60_000))} hour(s)`
      : `${Math.round(ttlMs / 60_000)} minute(s)`;
    const sysMsg: AppMessage = {
      id: crypto.randomUUID(),
      conversationId,
      text: `Disappearing messages set to ${label}`,
      timestamp: Date.now(),
      direction: 'outbound',
      status: 'delivered',
    };
    setState((prev) => ({
      ...prev,
      disappearingByConversation: { ...(prev.disappearingByConversation ?? {}), [conversationId]: ttlMs },
      messages: {
        ...prev.messages,
        [conversationId]: [...(prev.messages[conversationId] ?? []), sysMsg],
      },
    }));
  }

  // Fires when a peer toggles a reaction on one of their messages OR on
  // one of mine. peerId is the reactor.
  const handleReactionUpdated = useCallback(
    (conversationId: string, messageId: string, peerId: string, emoji: string, added: boolean) => {
      setState((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [conversationId]: (prev.messages[conversationId] ?? []).map((m) => {
            if (m.id !== messageId) return m;
            const reactions = { ...(m.reactions ?? {}) };
            const peers = reactions[emoji] ?? [];
            if (added && !peers.includes(peerId)) {
              reactions[emoji] = [...peers, peerId];
            } else if (!added) {
              const next = peers.filter((p) => p !== peerId);
              if (next.length === 0) delete reactions[emoji];
              else reactions[emoji] = next;
            }
            return { ...m, reactions };
          }),
        },
      }));
    },
    [],
  );

  // Fires when a peer changes the disappearing-messages policy. Injects a
  // system message so the change is visible.
  const handleDisappearingMessagesChanged = useCallback(
    (conversationId: string, ttlMs: number | null, changedBy: string) => {
      void (async () => {
        let name = getContactName(changedBy);
        if (!name) {
          name = (await MeshWhisper.resolveUsername(changedBy).catch(() => undefined))
            ?? (changedBy.slice(0, 8) + '…');
        }
        const label = ttlMs === null
          ? 'off'
          : ttlMs >= 24 * 60 * 60_000 ? `${Math.round(ttlMs / (24 * 60 * 60_000))} day(s)`
          : ttlMs >= 60 * 60_000 ? `${Math.round(ttlMs / (60 * 60_000))} hour(s)`
          : `${Math.round(ttlMs / 60_000)} minute(s)`;
        const sysMsg: AppMessage = {
          id: crypto.randomUUID(),
          conversationId,
          text: `@${name} set disappearing messages to ${label}`,
          timestamp: Date.now(),
          direction: 'inbound',
          status: 'delivered',
        };
        setState((prev) => ({
          ...prev,
          disappearingByConversation: { ...(prev.disappearingByConversation ?? {}), [conversationId]: ttlMs },
          messages: {
            ...prev.messages,
            [conversationId]: [...(prev.messages[conversationId] ?? []), sysMsg],
          },
        }));
      })();
    },
    [],
  );

  function handleSend(conversationId: string, text: string, replyTo?: { messageId: string; snippetText?: string }) {
    const sdk = getSDK();
    if (!sdk) return;

    const msgId = crypto.randomUUID();
    const appMsg: AppMessage = {
      id: msgId,
      conversationId,
      text,
      timestamp: Date.now(),
      direction: 'outbound',
      status: 'sending',
      ...(replyTo ? { replyTo } : {}),
    };

    setState((prev) => {
      const conv = prev.conversations.find((c) => c.id === conversationId);
      if (!conv) return prev;
      const conversations = prev.conversations
        .map((c) => c.id === conversationId ? { ...c, lastMessage: appMsg } : c)
        .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
      return {
        ...prev,
        conversations,
        messages: {
          ...prev.messages,
          [conversationId]: [...(prev.messages[conversationId] ?? []), appMsg],
        },
      };
    });

    const isGroupConv = !!state.conversations.find((c) => c.id === conversationId)?.group;
    const payload = new TextEncoder().encode(text);
    const sendPromise = isGroupConv
      ? sdk.sendToGroup(conversationId, payload as Uint8Array)
      : sdk.sendMessage(conversationId, payload as Uint8Array, replyTo ? { replyTo } : undefined);
    sendPromise.then(() => {
      setState((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [conversationId]: prev.messages[conversationId]?.map((m) =>
            m.id === msgId ? { ...m, status: 'sent' as const } : m,
          ) ?? [],
        },
      }));
      scheduleArchiveSync(getSDK());
    }).catch((err: unknown) => {
      console.error('[send] failed:', err);
      setState((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [conversationId]: prev.messages[conversationId]?.map((m) =>
            m.id === msgId ? { ...m, status: 'failed' as const } : m,
          ) ?? [],
        },
      }));
    });
  }

  function handleAcceptRequest(peerId: string, reqUsername?: string) {
    markAccepted(peerId);
    const req = state.pendingRequests.find((r) => r.peerId === peerId);
    const resolvedUsername = reqUsername ?? req?.username;
    const finalDisplayName = resolvedUsername
      ? saveContactNameInteractive(peerId, resolvedUsername)
      : undefined;
    const contact = makeContact(peerId, finalDisplayName);
    setState((prev) => ({
      ...prev,
      pendingRequests: prev.pendingRequests.filter((r) => r.peerId !== peerId),
      conversations: [
        { id: peerId, contact, unread: 0, isTyping: false },
        ...prev.conversations.filter((c) => c.id !== peerId),
      ],
    }));
    scheduleArchiveSync(getSDK());

    // If we still don't have a username, the prudence_contact_request
    // follow-up never arrived. Look up the relay directory by peer ID
    // as a fallback so the conversation isn't stuck displaying the
    // truncated peer ID instead of their @name.
    if (!resolvedUsername) {
      void MeshWhisper.resolveUsername(peerId).then((username) => {
        if (!username) return;
        const finalName = saveContactNameInteractive(peerId, username);
        setState((prev) => ({
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === peerId
              ? { ...c, contact: { ...c.contact, username: finalName, displayName: finalName } }
              : c,
          ),
        }));
      }).catch(() => {});
    }
  }

  // SDK reference: deletion. See ../REFERENCE.md "Contacts (X3DH)" — the
  // SDK writes a tombstone + fires onArchiveDirty itself; this handler
  // doesn't need to call scheduleArchiveSync.
  async function handleRemoveContact(peerId: string) {
    const sdk = getSDK();
    // If this is a group, the leave path differs: broadcast a group_leave
    // control message to remaining members, drop SDK + IDB group state,
    // skip the contact-name cleanup (groups don't have contact names).
    const conv = state.conversations.find((c) => c.id === peerId);
    const isGroup = !!conv?.group;
    if (sdk && isGroup) {
      const handle = MeshWhisper.getGroup(peerId);
      if (handle) {
        await handle.leave().catch((e) => console.error('[group leave] broadcast failed:', e));
      }
      await removeStoredGroup(peerId).catch(() => {});
      // Wipe `messages/{groupId}` from SDK storage too. Without this, the
      // next boot's getConversations() finds the orphan key, can't match
      // it to a known group (we just removed it), and surfaces it as a
      // DM-shaped conversation with a truncated peer-ID title.
      await sdk.deleteConversationInstance(peerId).catch(console.error);
    } else if (sdk) {
      await sdk.deleteConversationInstance(peerId).catch(console.error);
      removeContactName(peerId);
    }
    setState((prev) => ({
      ...prev,
      activeConversationId: null,
      conversations: prev.conversations.filter((c) => c.id !== peerId),
      messages: Object.fromEntries(
        Object.entries(prev.messages).filter(([id]) => id !== peerId),
      ),
    }));
    // The SDK wrote a deletion tombstone. Push it now (debounced via
    // scheduleArchiveSync, flushed on pagehide) so the relay archive
    // carries the deletion and the next pull doesn't resurrect this peer.
    scheduleArchiveSync(getSDK());
  }

  // SDK reference: conversation export. See ../REFERENCE.md (TODO add
  // a section). Builds a peerId → display-name map from contactNames so
  // the transcript shows "@alice" instead of raw hex, filters out the
  // app-level __prudence_ctrl envelopes, then triggers a browser download.
  async function handleExportConversation(conversationId: string) {
    const sdk = getSDK();
    if (!sdk) return;
    const conv = state.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const myPeerId = MeshWhisper.getLocalPeerId();
    const displayName: Record<string, string> = {};
    if (state.myUsername) displayName[myPeerId] = `${state.myUsername} (you)`;
    if (conv.group) {
      for (const m of conv.group.members) {
        const name = m.username ?? getContactName(m.peerId);
        if (name) displayName[m.peerId] = name;
      }
    } else if (conv.contact.username) {
      displayName[conversationId] = conv.contact.username;
    }
    try {
      const transcript = await sdk.exportConversationInstance(conversationId, {
        format: 'text',
        displayName,
        filter: (m) => {
          try {
            const text = new TextDecoder().decode(new Uint8Array(m.payload));
            return !isControlMessage(text);
          } catch {
            return true;
          }
        },
      });
      const label = conv.group?.name ?? conv.contact.username ?? conversationId.slice(0, 8);
      const safeLabel = label.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
      const filename = `prudence-${safeLabel}-${new Date().toISOString().slice(0, 10)}.txt`;
      const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.warn('[export] failed:', e);
    }
  }

  // SDK reference: history recovery — manual button path.
  // See ../REFERENCE.md "Conversation history recovery". The auto-fire on
  // revival-after-delete path lives in the SDK, no Prudence code needed.
  async function handleRestoreHistory(peerId: string) {
    const sdk = getSDK();
    if (!sdk) return;
    const name = getContactName(peerId) ?? peerId.slice(0, 8);
    if (!window.confirm(`Ask @${name} to share their copy of this conversation? They'll see a one-time prompt asking permission.`)) {
      return;
    }
    try {
      await sdk.requestHistoryInstance(peerId);
    } catch (e) {
      console.warn('[restore-history] request failed:', e);
    }
  }

  function handleDeclineRequest(peerId: string) {
    markDeclinedContact(peerId);
    setState((prev) => ({
      ...prev,
      pendingRequests: prev.pendingRequests.filter((r) => r.peerId !== peerId),
    }));
  }

  async function handleCreateGroup(name: string, memberPeerIds: string[]) {
    const sdk = getSDK();
    if (!sdk) return;
    const handle = MeshWhisper.createGroup({ name, members: memberPeerIds });
    const senderKeys: Record<string, number[]> = {};
    for (const [peerId, member] of handle.group.members) {
      senderKeys[peerId] = Array.from(member.senderKey);
    }
    const group: GroupInfo = {
      id: handle.id,
      name: handle.name,
      members: [...handle.group.members.values()].map((m) => ({
        peerId: m.id,
        role: m.role,
        username: getContactName(m.id),
      })),
    };
    await upsertGroup({
      id: handle.id,
      name: handle.name,
      creatorId: MeshWhisper.getLocalPeerId(),
      members: group.members,
      senderKeys,
      createdAt: handle.group.createdAt,
    });
    setState((prev) => ({
      ...prev,
      conversations: [makeGroupConversation(group), ...prev.conversations],
    }));
  }

  async function handleAddGroupMember(groupId: string, peerId: string) {
    const handle = MeshWhisper.getGroup(groupId);
    if (!handle) return;
    try {
      await handle.addMember(peerId);
    } catch (err) {
      console.error('[group add] failed:', err);
      return;
    }
    // Update local state to reflect the addition immediately. The
    // stored-group + system-message side mirrors what we'd otherwise
    // get from the receive handler, but since we initiated the add we
    // need to apply it ourselves.
    const newName = getContactName(peerId)
      ?? (await MeshWhisper.resolveUsername(peerId).catch(() => undefined))
      ?? (peerId.slice(0, 8) + '…');
    const myName = MeshWhisper.instance['config'].username ?? 'you';
    const groups = await loadGroups();
    const stored = groups.find((g) => g.id === groupId);
    if (stored && !stored.members.some((m) => m.peerId === peerId)) {
      const updated = {
        ...stored,
        members: [...stored.members, { peerId, role: 'member' as const, username: newName }],
      };
      await upsertGroup(updated).catch(() => {});
    }
    const systemMsg: AppMessage = {
      id: crypto.randomUUID(),
      conversationId: groupId,
      text: `@${myName} added @${newName}`,
      timestamp: Date.now(),
      direction: 'outbound',
      status: 'delivered',
    };
    setState((prev) => {
      const conv = prev.conversations.find((c) => c.id === groupId);
      if (!conv?.group) return prev;
      if (conv.group.members.some((m) => m.peerId === peerId)) return prev;
      const newGroup: GroupInfo = {
        ...conv.group,
        members: [...conv.group.members, { peerId, role: 'member', username: newName }],
      };
      return {
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.id === groupId ? { ...c, group: newGroup, lastMessage: systemMsg } : c,
        ),
        messages: {
          ...prev.messages,
          [groupId]: [...(prev.messages[groupId] ?? []), systemMsg],
        },
      };
    });
  }

  async function handleKickGroupMember(groupId: string, peerId: string) {
    const handle = MeshWhisper.getGroup(groupId);
    if (!handle) return;
    try {
      await handle.kickMember(peerId);
    } catch (err) {
      console.error('[group kick] failed:', err);
      return;
    }
    const kickedName = getContactName(peerId)
      ?? (await MeshWhisper.resolveUsername(peerId).catch(() => undefined))
      ?? (peerId.slice(0, 8) + '…');
    const systemMsg: AppMessage = {
      id: crypto.randomUUID(),
      conversationId: groupId,
      text: `You removed @${kickedName}`,
      timestamp: Date.now(),
      direction: 'outbound',
      status: 'delivered',
    };
    const groups = await loadGroups();
    const stored = groups.find((g) => g.id === groupId);
    if (stored) {
      await upsertGroup({ ...stored, members: stored.members.filter((m) => m.peerId !== peerId) }).catch(() => {});
    }
    setState((prev) => {
      const conv = prev.conversations.find((c) => c.id === groupId);
      if (!conv?.group) return prev;
      const newGroup: GroupInfo = {
        ...conv.group,
        members: conv.group.members.filter((m) => m.peerId !== peerId),
      };
      return {
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.id === groupId ? { ...c, group: newGroup, lastMessage: systemMsg } : c,
        ),
        messages: {
          ...prev.messages,
          [groupId]: [...(prev.messages[groupId] ?? []), systemMsg],
        },
      };
    });
  }

  // Fires on remaining members when the admin kicks someone.
  const handleGroupMemberKicked = useCallback((groupId: string, peerId: string, kickedBy: string) => {
    void (async () => {
      let kickedName = getContactName(peerId);
      if (!kickedName) {
        kickedName = (await MeshWhisper.resolveUsername(peerId).catch(() => undefined))
          ?? (peerId.slice(0, 8) + '…');
      }
      let kickerName = getContactName(kickedBy);
      if (!kickerName) {
        kickerName = (await MeshWhisper.resolveUsername(kickedBy).catch(() => undefined))
          ?? (kickedBy.slice(0, 8) + '…');
      }
      const groups = await loadGroups();
      const stored = groups.find((g) => g.id === groupId);
      if (stored) {
        await upsertGroup({ ...stored, members: stored.members.filter((m) => m.peerId !== peerId) }).catch(() => {});
      }
      const systemMsg: AppMessage = {
        id: crypto.randomUUID(),
        conversationId: groupId,
        text: `@${kickerName} removed @${kickedName}`,
        timestamp: Date.now(),
        direction: 'inbound',
        status: 'delivered',
      };
      setState((prev) => {
        const conv = prev.conversations.find((c) => c.id === groupId);
        if (!conv?.group) return prev;
        const newGroup: GroupInfo = {
          ...conv.group,
          members: conv.group.members.filter((m) => m.peerId !== peerId),
        };
        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === groupId ? { ...c, group: newGroup, lastMessage: systemMsg } : c,
          ),
          messages: {
            ...prev.messages,
            [groupId]: [...(prev.messages[groupId] ?? []), systemMsg],
          },
        };
      });
    })();
  }, []);

  // Fires on the local user when they're the one kicked. SDK has wiped
  // its in-memory group state already; we mirror by removing the
  // conversation from the UI and from IDB.
  const handleKickedFromGroup = useCallback((groupId: string, kickedBy: string) => {
    void (async () => {
      await removeStoredGroup(groupId).catch(() => {});
      const sdk = getSDK();
      if (sdk) await sdk.deleteConversationInstance(groupId).catch(() => {});

      let kickerName = getContactName(kickedBy);
      if (!kickerName) {
        kickerName = (await MeshWhisper.resolveUsername(kickedBy).catch(() => undefined))
          ?? (kickedBy.slice(0, 8) + '…');
      }
      // Surface a one-time browser notification so the user knows
      // why the conversation just disappeared.
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('Removed from group', {
            body: `@${kickerName} removed you from the group.`,
            icon: '/icon-192.png',
            tag: `prudence-kick-${groupId}`,
          });
        } catch { /* ignored */ }
      }

      setState((prev) => ({
        ...prev,
        activeConversationId: prev.activeConversationId === groupId ? null : prev.activeConversationId,
        conversations: prev.conversations.filter((c) => c.id !== groupId),
        messages: Object.fromEntries(Object.entries(prev.messages).filter(([id]) => id !== groupId)),
      }));
    })();
  }, []);

  async function handleRenameGroup(groupId: string, newName: string) {
    const handle = MeshWhisper.getGroup(groupId);
    if (!handle) throw new Error('Group not found');
    const oldName = handle.name;
    await handle.rename(newName);
    // Mirror the change in our local conversation state + inject a system
    // message so the local UI reflects the rename immediately. Other members
    // get the same via the onGroupRenamed callback below.
    setState((prev) => ({
      ...prev,
      conversations: prev.conversations.map((c) =>
        c.id === groupId && c.group
          ? { ...c, contact: { ...c.contact, displayName: newName }, group: { ...c.group, name: newName } }
          : c,
      ),
      messages: {
        ...prev.messages,
        [groupId]: [...(prev.messages[groupId] ?? []), {
          id: crypto.randomUUID(),
          conversationId: groupId,
          text: `Group renamed from "${oldName}" to "${newName}"`,
          timestamp: Date.now(),
          direction: 'outbound',
          status: 'delivered',
        }],
      },
    }));
    // Persist the new name in the locally-stored group roster so it survives reload.
    const stored = await loadGroups();
    const existing = stored.find((g) => g.id === groupId);
    if (existing) await upsertGroup({ ...existing, name: newName }).catch(() => {});
    scheduleArchiveSync(getSDK());
  }

  // Fires when another member (the admin, or any member of an adminless
  // group) renames the group. The SDK has updated the underlying group's
  // name already; we mirror it into our local conversation state.
  const handleGroupRenamed = useCallback((groupId: string, newName: string, renamedBy: string) => {
    void (async () => {
      let renamedByName = getContactName(renamedBy);
      if (!renamedByName) {
        renamedByName = (await MeshWhisper.resolveUsername(renamedBy).catch(() => undefined))
          ?? (renamedBy.slice(0, 8) + '…');
      }
      setState((prev) => {
        const conv = prev.conversations.find((c) => c.id === groupId);
        if (!conv?.group) return prev;
        const oldName = conv.group.name;
        if (oldName === newName) return prev;
        const sysMsg: AppMessage = {
          id: crypto.randomUUID(),
          conversationId: groupId,
          text: `@${renamedByName} renamed the group from "${oldName}" to "${newName}"`,
          timestamp: Date.now(),
          direction: 'inbound',
          status: 'delivered',
        };
        return {
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === groupId && c.group
              ? { ...c, contact: { ...c.contact, displayName: newName }, group: { ...c.group, name: newName } }
              : c,
          ),
          messages: {
            ...prev.messages,
            [groupId]: [...(prev.messages[groupId] ?? []), sysMsg],
          },
        };
      });
      const stored = await loadGroups();
      const existing = stored.find((g) => g.id === groupId);
      if (existing) await upsertGroup({ ...existing, name: newName }).catch(() => {});
    })();
  }, []);

  async function handleTransferGroupAdmin(groupId: string, newAdminId: string) {
    const handle = MeshWhisper.getGroup(groupId);
    if (!handle) return;
    try {
      await handle.transferAdmin(newAdminId);
    } catch (err) {
      console.error('[group transfer admin] failed:', err);
      return;
    }
    // Mirror the change locally and inject a system message.
    const newAdminName = newAdminId === ''
      ? null
      : (getContactName(newAdminId)
        ?? (await MeshWhisper.resolveUsername(newAdminId).catch(() => undefined))
        ?? (newAdminId.slice(0, 8) + '…'));
    const text = newAdminId === ''
      ? 'The group is now admin-less'
      : `@${newAdminName} is now the admin`;
    const systemMsg: AppMessage = {
      id: crypto.randomUUID(),
      conversationId: groupId,
      text,
      timestamp: Date.now(),
      direction: 'outbound',
      status: 'delivered',
    };
    setState((prev) => ({
      ...prev,
      messages: {
        ...prev.messages,
        [groupId]: [...(prev.messages[groupId] ?? []), systemMsg],
      },
    }));
  }

  // Fires when the admin transfers admin or makes the group adminless.
  // The SDK has updated treeRoot already; we surface a system message.
  const handleGroupAdminChanged = useCallback((groupId: string, newAdminId: string, changedBy: string) => {
    void (async () => {
      let changedByName = getContactName(changedBy);
      if (!changedByName) {
        changedByName = (await MeshWhisper.resolveUsername(changedBy).catch(() => undefined))
          ?? (changedBy.slice(0, 8) + '…');
      }
      let newAdminName: string | null = null;
      if (newAdminId !== '') {
        newAdminName = getContactName(newAdminId)
          ?? (await MeshWhisper.resolveUsername(newAdminId).catch(() => undefined))
          ?? (newAdminId.slice(0, 8) + '…');
      }
      const text = newAdminId === ''
        ? `@${changedByName} made the group admin-less`
        : `@${changedByName} made @${newAdminName} the admin`;
      const systemMsg: AppMessage = {
        id: crypto.randomUUID(),
        conversationId: groupId,
        text,
        timestamp: Date.now(),
        direction: 'inbound',
        status: 'delivered',
      };
      setState((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [groupId]: [...(prev.messages[groupId] ?? []), systemMsg],
        },
      }));
    })();
  }, []);

  async function handleAcceptGroupInvite(groupId: string) {
    const inv = state.pendingGroupInvites.find((i) => i.groupId === groupId);
    if (!inv) return;
    MeshWhisper.acceptGroupInvite(groupId);
    const handle = MeshWhisper.getGroup(groupId);
    if (handle) {
      const senderKeys: Record<string, number[]> = {};
      for (const [peerId, member] of handle.group.members) {
        senderKeys[peerId] = Array.from(member.senderKey);
      }
      const group: GroupInfo = {
        id: handle.id,
        name: handle.name,
        members: [...handle.group.members.values()].map((m) => ({
          peerId: m.id,
          role: m.role,
          username: getContactName(m.id),
        })),
      };
      await upsertGroup({
        id: handle.id,
        name: handle.name,
        creatorId: inv.invitedBy,
        members: group.members,
        senderKeys,
        createdAt: Date.now(),
      });
      setState((prev) => ({
        ...prev,
        pendingGroupInvites: prev.pendingGroupInvites.filter((i) => i.groupId !== groupId),
        conversations: [makeGroupConversation(group), ...prev.conversations],
      }));
    } else {
      setState((prev) => ({
        ...prev,
        pendingGroupInvites: prev.pendingGroupInvites.filter((i) => i.groupId !== groupId),
      }));
    }
  }

  function handleDeclineGroupInvite(groupId: string) {
    MeshWhisper.declineGroupInvite(groupId);
    setState((prev) => ({
      ...prev,
      pendingGroupInvites: prev.pendingGroupInvites.filter((i) => i.groupId !== groupId),
    }));
  }

  async function handleAttach(conversationId: string, file: File) {
    const isImage = isImageMime(file.type || '');
    // Full-res thumbnail for local display only; tiny thumb travels in the message pointer.
    const thumb = isImage ? await generateThumbnail(file, 220).catch(() => undefined) : undefined;
    const thumbForPointer = isImage ? await generateThumbnail(file, 40).catch(() => undefined) : undefined;
    const localObjectUrl = URL.createObjectURL(file);
    const msgId = crypto.randomUUID();
    const media: AppMessageMedia = {
      url: '', key: '',
      mimeType: file.type || 'application/octet-stream',
      thumb, fileName: file.name, fileSize: file.size,
      status: 'uploading', objectUrl: localObjectUrl,
    };
    const appMsg: AppMessage = {
      id: msgId, conversationId,
      text: isImage ? 'Photo' : file.name,
      timestamp: Date.now(), direction: 'outbound', status: 'sending', media,
    };
    setState((prev) => {
      const conv = prev.conversations.find((c) => c.id === conversationId);
      if (!conv) return prev;
      const conversations = prev.conversations
        .map((c) => c.id === conversationId ? { ...c, lastMessage: appMsg } : c)
        .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
      return { ...prev, conversations, messages: { ...prev.messages, [conversationId]: [...(prev.messages[conversationId] ?? []), appMsg] } };
    });
    try {
      const bytes = await readFileBytes(file);
      await MeshWhisper.sendMedia(conversationId, bytes, {
        mimeType: file.type || 'application/octet-stream',
        ...(thumbForPointer ? { thumb: thumbForPointer } : {}),
        fileName: file.name, fileSize: file.size,
      });
      setState((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [conversationId]: prev.messages[conversationId]?.map((m) =>
            m.id === msgId ? { ...m, status: 'sent' as const, media: m.media ? { ...m.media, status: 'ready' as const } : undefined } : m,
          ) ?? [],
        },
      }));
    } catch (err) {
      console.error('[media] upload failed:', err);
      URL.revokeObjectURL(localObjectUrl);
      setState((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [conversationId]: prev.messages[conversationId]?.map((m) =>
            m.id === msgId ? { ...m, status: 'failed' as const, media: m.media ? { ...m.media, status: 'error' as const } : undefined } : m,
          ) ?? [],
        },
      }));
    }
  }

  async function handleDownloadMedia(msgId: string, conversationId: string): Promise<string | null> {
    const msg = state.messages[conversationId]?.find((m) => m.id === msgId);
    if (!msg?.media?.url || !msg.media.key) return null;
    setState((prev) => ({
      ...prev,
      messages: {
        ...prev.messages,
        [conversationId]: prev.messages[conversationId]?.map((m) =>
          m.id === msgId ? { ...m, media: m.media ? { ...m.media, status: 'downloading' as const } : undefined } : m,
        ) ?? [],
      },
    }));
    try {
      const bytes = await downloadAndDecrypt(msg.media.url, msg.media.key);
      if (isImageMime(msg.media.mimeType)) {
        const objectUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: msg.media.mimeType }));
        setState((prev) => ({
          ...prev,
          messages: {
            ...prev.messages,
            [conversationId]: prev.messages[conversationId]?.map((m) =>
              m.id === msgId ? { ...m, media: m.media ? { ...m.media, status: 'ready' as const, objectUrl } : undefined } : m,
            ) ?? [],
          },
        }));
        return objectUrl;
      } else {
        triggerDownload(bytes, msg.media.fileName ?? 'download', msg.media.mimeType);
        setState((prev) => ({
          ...prev,
          messages: {
            ...prev.messages,
            [conversationId]: prev.messages[conversationId]?.map((m) =>
              m.id === msgId ? { ...m, media: m.media ? { ...m.media, status: 'ready' as const } : undefined } : m,
            ) ?? [],
          },
        }));
        return null;
      }
    } catch (err) {
      console.error('[media] download failed:', err);
      setState((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [conversationId]: prev.messages[conversationId]?.map((m) =>
            m.id === msgId ? { ...m, media: m.media ? { ...m.media, status: 'error' as const } : undefined } : m,
          ) ?? [],
        },
      }));
      return null;
    }
  }

  if (loading) {
    return (
      <div className="h-full bg-slate-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!username) {
    return <Onboarding onComplete={handleRegister} />;
  }

  if (!authenticated) {
    return <Login username={username} onLogin={handleLogin} onSwitchUser={handleSwitchUser} />;
  }

  const activeConv = state.conversations.find((c) => c.id === state.activeConversationId);

  const allContacts = state.conversations
    .filter((c) => !c.group)
    .map((c) => c.contact);

  return (
    <div className="h-full flex">
      <div className={`${activeConv ? 'hidden sm:flex' : 'flex'} w-full sm:w-72 lg:w-80 flex-shrink-0 flex-col`}>
        <ConversationList
          myUsername={state.myUsername}
          conversations={state.conversations}
          activeId={state.activeConversationId}
          pendingCount={state.pendingRequests.length}
          pendingGroupInviteCount={state.pendingGroupInvites.length}
          connected={state.connected}
          onLock={() => { sessionStorage.setItem('prudence:locked', '1'); setAuthenticated(false); }}
          onSelect={(id) => {
            setState((prev) => ({ ...prev, activeConversationId: id }));
            markConversationRead(id);
          }}
          onPendingClick={() => setShowPending(true)}
          onGroupInviteClick={() => setShowGroupInvites(true)}
          onNewGroup={() => setShowCreateGroup(true)}
          onContactAdded={(peerId, addedUsername) => {
            const finalName = saveContactNameInteractive(peerId, addedUsername);
            setState((prev) => {
              const existing = prev.conversations.find((c) => c.id === peerId);
              if (existing) {
                return {
                  ...prev,
                  conversations: prev.conversations.map((c) =>
                    c.id === peerId ? { ...c, contact: makeContact(peerId, finalName) } : c,
                  ),
                };
              }
              return {
                ...prev,
                conversations: [
                  { id: peerId, contact: makeContact(peerId, finalName), unread: 0, isTyping: false },
                  ...prev.conversations,
                ],
              };
            });
            // The SDK recorded a revival event for this peer. Push the archive
            // so the relay sees the revival and a future pull won't re-apply
            // any stale tombstone.
            scheduleArchiveSync(getSDK());
          }}
        />
      </div>

      <div className={`${activeConv ? 'flex' : 'hidden sm:flex'} flex-1 flex-col`}>
        {activeConv ? (
          <Thread
            contact={activeConv.contact}
            group={activeConv.group}
            localPeerId={MeshWhisper.getLocalPeerId()}
            isGroupAdmin={
              !!activeConv.group &&
              (() => {
                const sdkGroup = MeshWhisper.getGroup(activeConv.id)?.group;
                return sdkGroup?.treeRoot === MeshWhisper.getLocalPeerId();
              })()
            }
            isAdminless={
              !!activeConv.group &&
              (() => {
                const sdkGroup = MeshWhisper.getGroup(activeConv.id)?.group;
                return sdkGroup?.treeRoot === '';
              })()
            }
            addableContacts={
              activeConv.group
                ? state.conversations
                    .filter((c) => !c.group)
                    .map((c) => c.contact)
                    .filter((c) => !activeConv.group!.members.some((m) => m.peerId === c.peerId))
                : undefined
            }
            messages={state.messages[activeConv.id] ?? []}
            isTyping={activeConv.isTyping}
            onBack={() => setState((prev) => ({ ...prev, activeConversationId: null }))}
            onSend={(text, replyTo) => handleSend(activeConv.id, text, replyTo)}
            onRemove={() => handleRemoveContact(activeConv.id)}
            onAddMember={activeConv.group ? (peerId) => handleAddGroupMember(activeConv.id, peerId) : undefined}
            onTransferAdmin={activeConv.group ? (newAdminId) => handleTransferGroupAdmin(activeConv.id, newAdminId) : undefined}
            onKickMember={activeConv.group ? (peerId) => { void handleKickGroupMember(activeConv.id, peerId); } : undefined}
            onRenameGroup={activeConv.group ? (newName) => handleRenameGroup(activeConv.id, newName) : undefined}
            onReact={(messageId, emoji) => handleReact(activeConv.id, messageId, emoji)}
            onForwardMessage={(messageId, toPeerId) => handleForward(activeConv.id, messageId, toPeerId)}
            onSetDisappearing={(ttlMs) => handleSetDisappearing(activeConv.id, ttlMs)}
            disappearingTtlMs={state.disappearingByConversation?.[activeConv.id] ?? null}
            // Forwarding targets: every other conversation (DMs and groups alike)
            forwardTargets={state.conversations.filter((c) => c.id !== activeConv.id).map((c) => c.contact)}
            onAttach={activeConv.group ? undefined : (file) => { void handleAttach(activeConv.id, file); }}
            onDownloadMedia={(msgId) => handleDownloadMedia(msgId, activeConv.id)}
            onRestoreHistory={activeConv.group ? undefined : () => handleRestoreHistory(activeConv.id)}
            onExport={() => handleExportConversation(activeConv.id)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-slate-950">
            <p className="text-slate-700 text-sm">Select a conversation</p>
          </div>
        )}
      </div>

      {showPending && state.pendingRequests.length > 0 && (
        <PendingRequests
          requests={state.pendingRequests}
          onAccept={(peerId, reqUsername) => handleAcceptRequest(peerId, reqUsername)}
          onDecline={handleDeclineRequest}
          onClose={() => setShowPending(false)}
        />
      )}

      {showGroupInvites && state.pendingGroupInvites.length > 0 && (
        <GroupInviteModal
          invites={state.pendingGroupInvites}
          getContactName={(peerId) => getContactName(peerId)}
          onAccept={(groupId) => { void handleAcceptGroupInvite(groupId); }}
          onDecline={handleDeclineGroupInvite}
          onClose={() => setShowGroupInvites(false)}
        />
      )}

      {showCreateGroup && (
        <CreateGroup
          contacts={allContacts}
          onClose={() => setShowCreateGroup(false)}
          onCreate={(name, memberPeerIds) => { void handleCreateGroup(name, memberPeerIds); }}
        />
      )}
    </div>
  );
}
