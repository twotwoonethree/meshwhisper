import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message, Conversation as SDKConversation, StoredMessage } from '@meshwhisper/sdk';
import { MeshWhisper } from '@meshwhisper/sdk';
import { initSDK, getSDK } from './sdk.ts';
import { getPushSubscription } from './push.ts';
import { initStorage, idbStorage } from './storage.ts';
import { deriveIdentityKey, uint8ArrayToHex } from './crypto.ts';
import { saveContactName, getContactName, getAllContactNames, removeContactName } from './contact-names.ts';
import { isHandled, markAccepted, markDeclined as markDeclinedContact, getAll as getAllAccepted, restoreAll as restoreAccepted } from './accepted-contacts.ts';
import { loadGroups, upsertGroup } from './group-storage.ts';
import { generateThumbnail, readFileBytes, downloadAndDecrypt, triggerDownload, isImageMime, formatFileSize as _formatFileSize } from './media.ts';
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
  const archiveSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleArchiveSync(sdk: ReturnType<typeof getSDK>) {
    if (!sdk) return;
    if (archiveSyncTimer.current) clearTimeout(archiveSyncTimer.current);
    archiveSyncTimer.current = setTimeout(() => {
      archiveSyncTimer.current = null;
      sdk.pushArchive({
        contactNames: getAllContactNames(),
        acceptedContacts: getAllAccepted(),
        groups: JSON.parse(localStorage.getItem('prudence:groups') ?? '[]'),
      }).catch((e: unknown) => console.warn('[archive] push failed:', e));
    }, 5_000);
  }

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

  const handleMessage = useCallback((msg: Message) => {
    console.log('[prudence] onMessage', { senderId: msg.senderId, payloadLen: msg.payload.length });
    const text = decoder(Array.from(msg.payload));
    if (!text) return;

    const conversationId = msg.groupId ?? msg.senderId;
    const isGroup = !!msg.groupId;

    try {
      const ctrl = JSON.parse(text) as { __prudence_ctrl?: string; username?: string };
      if (ctrl.__prudence_ctrl === 'contact_request') {
        console.log('[prudence] contact_request from', msg.senderId, 'username:', ctrl.username);
        if (ctrl.username) saveContactName(msg.senderId, ctrl.username);
        if (!isHandled(msg.senderId)) {
          setState((prev) => {
            if (prev.pendingRequests.some((r) => r.peerId === msg.senderId)) return prev;
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
        direction: 'inbound',
        status: 'delivered',
        media: { ...mediaPtr, status: 'pending' },
        ...(isGroup && msg.groupSenderId ? { senderId: msg.groupSenderId, senderName: senderDisplayName(msg.groupSenderId) } : {}),
      };
      setState((prev) => {
        const existingConv = prev.conversations.find((c) => c.id === conversationId);
        const contact = existingConv?.contact ?? makeContact(conversationId);
        const isActive = prev.activeConversationId === conversationId;
        const updatedConv: Conversation = existingConv
          ? { ...existingConv, lastMessage: mediaMsg, unread: isActive ? 0 : existingConv.unread + 1 }
          : { id: conversationId, contact, lastMessage: mediaMsg, unread: 1, isTyping: false };
        const conversations = existingConv
          ? prev.conversations.map((c) => (c.id === conversationId ? updatedConv : c))
          : [updatedConv, ...prev.conversations];
        conversations.sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
        return { ...prev, conversations, messages: { ...prev.messages, [conversationId]: [...(prev.messages[conversationId] ?? []), mediaMsg] } };
      });
      return;
    }

    const appMsg: AppMessage = {
      id: msg.id ?? crypto.randomUUID(),
      conversationId,
      text,
      timestamp: msg.timestamp ?? Date.now(),
      direction: 'inbound',
      status: 'delivered',
      ...(isGroup && msg.groupSenderId ? {
        senderId: msg.groupSenderId,
        senderName: senderDisplayName(msg.groupSenderId),
      } : {}),
    };

    setState((prev) => {
      const existingConv = prev.conversations.find((c) => c.id === conversationId);
      const contact = existingConv?.contact ?? makeContact(conversationId);
      const isActive = prev.activeConversationId === conversationId;

      const updatedConv: Conversation = existingConv
        ? { ...existingConv, lastMessage: appMsg, unread: isActive ? 0 : existingConv.unread + 1 }
        : { id: conversationId, contact, lastMessage: appMsg, unread: 1, isTyping: false };

      const conversations = existingConv
        ? prev.conversations.map((c) => (c.id === conversationId ? updatedConv : c))
        : [updatedConv, ...prev.conversations];

      conversations.sort((a, b) =>
        (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0),
      );

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

  const handleConnectionStatus = useCallback((status: 'connected' | 'disconnected') => {
    setState((prev) => ({ ...prev, connected: status === 'connected' }));
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
        onTyping: handleTyping,
        onContactRequest: handleContactRequest,
        onConnectionStatus: handleConnectionStatus,
        onGroupInvite: handleGroupInvite,
      }, pushSub).then(async (sdk) => {
      if (cancelled) return;

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
        setState((prev) => ({ ...prev, conversations: appConvs }));
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
  }, [username, authenticated, handleMessage, handleTyping, handleContactRequest, handleConnectionStatus, handleGroupInvite]);

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

  function handleSend(conversationId: string, text: string) {
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
      : sdk.sendMessage(conversationId, payload as Uint8Array);
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
    if (resolvedUsername) saveContactName(peerId, resolvedUsername);
    const contact = makeContact(peerId, resolvedUsername);
    setState((prev) => ({
      ...prev,
      pendingRequests: prev.pendingRequests.filter((r) => r.peerId !== peerId),
      conversations: [
        { id: peerId, contact, unread: 0, isTyping: false },
        ...prev.conversations.filter((c) => c.id !== peerId),
      ],
    }));
    scheduleArchiveSync(getSDK());
  }

  async function handleRemoveContact(peerId: string) {
    const sdk = getSDK();
    if (sdk) await sdk.deleteConversationInstance(peerId).catch(console.error);
    removeContactName(peerId);
    setState((prev) => ({
      ...prev,
      activeConversationId: null,
      conversations: prev.conversations.filter((c) => c.id !== peerId),
      messages: Object.fromEntries(
        Object.entries(prev.messages).filter(([id]) => id !== peerId),
      ),
    }));
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
          onSelect={(id) =>
            setState((prev) => ({
              ...prev,
              activeConversationId: id,
              conversations: prev.conversations.map((c) =>
                c.id === id ? { ...c, unread: 0 } : c,
              ),
            }))
          }
          onPendingClick={() => setShowPending(true)}
          onGroupInviteClick={() => setShowGroupInvites(true)}
          onNewGroup={() => setShowCreateGroup(true)}
          onContactAdded={(peerId, addedUsername) => {
            saveContactName(peerId, addedUsername);
            setState((prev) => {
              const existing = prev.conversations.find((c) => c.id === peerId);
              if (existing) {
                return {
                  ...prev,
                  conversations: prev.conversations.map((c) =>
                    c.id === peerId ? { ...c, contact: makeContact(peerId, addedUsername) } : c,
                  ),
                };
              }
              return {
                ...prev,
                conversations: [
                  { id: peerId, contact: makeContact(peerId, addedUsername), unread: 0, isTyping: false },
                  ...prev.conversations,
                ],
              };
            });
          }}
        />
      </div>

      <div className={`${activeConv ? 'flex' : 'hidden sm:flex'} flex-1 flex-col`}>
        {activeConv ? (
          <Thread
            contact={activeConv.contact}
            group={activeConv.group}
            messages={state.messages[activeConv.id] ?? []}
            isTyping={activeConv.isTyping}
            onBack={() => setState((prev) => ({ ...prev, activeConversationId: null }))}
            onSend={(text) => handleSend(activeConv.id, text)}
            onRemove={() => handleRemoveContact(activeConv.id)}
            onAttach={activeConv.group ? undefined : (file) => { void handleAttach(activeConv.id, file); }}
            onDownloadMedia={(msgId) => handleDownloadMedia(msgId, activeConv.id)}
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
