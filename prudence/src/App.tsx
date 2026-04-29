import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message, Conversation as SDKConversation, StoredMessage } from '@meshwhisper/sdk';
import { initSDK, getSDK } from './sdk.ts';
import { getPushSubscription } from './push.ts';
import { initStorage, idbStorage } from './storage.ts';
import { deriveIdentityKey, uint8ArrayToHex } from './crypto.ts';
import { saveContactName, getContactName, removeContactName } from './contact-names.ts';
import type { AppState, AppMessage, Conversation, Contact } from './types.ts';
import Onboarding from './components/Onboarding.tsx';
import Login from './components/Login.tsx';
import ConversationList from './components/ConversationList.tsx';
import Thread from './components/Thread.tsx';
import PendingRequests from './components/PendingRequests.tsx';

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
    connected: false,
  });
  const [showPending, setShowPending] = useState(false);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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

    try {
      const ctrl = JSON.parse(text) as { __prudence_ctrl?: string; username?: string };
      if (ctrl.__prudence_ctrl === 'contact_request') {
        console.log('[prudence] contact_request from', msg.senderId, 'username:', ctrl.username);
        if (ctrl.username) saveContactName(msg.senderId, ctrl.username);
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
        return;
      }
    } catch { /* not a control message */ }

    const conversationId = msg.senderId;
    const appMsg: AppMessage = {
      id: msg.id ?? crypto.randomUUID(),
      conversationId,
      text,
      timestamp: msg.timestamp ?? Date.now(),
      direction: 'inbound',
      status: 'delivered',
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
      setState((prev) => ({
        ...prev,
        pendingRequests: [...prev.pendingRequests, { peerId, introducedBy, username: reqUsername }],
      }));
      setShowPending(true);
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

    void (async () => {
      const pushSub = await getPushSubscription().catch(() => null);
      if (cancelled) return;

      void initSDK(username, {
        onMessage: handleMessage,
        onTyping: handleTyping,
        onContactRequest: handleContactRequest,
        onConnectionStatus: handleConnectionStatus,
      }, pushSub).then((sdk) => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, myUsername: username, connected: true }));
      sdk.getConversationsInstance().then((convs: SDKConversation[]) => {
        if (cancelled) return;
        const appConvs: Conversation[] = convs.map((c: SDKConversation) => ({
          id: c.peerId,
          contact: makeContact(c.peerId),
          unread: c.unreadCount ?? 0,
          isTyping: false,
        }));
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
                if (cr) pendingFromHistory.push({ peerId: c.peerId, username: cr.username });
              }
              continue;
            }
            appMsgs.push({
              id: m.id,
              conversationId: c.peerId,
              text,
              timestamp: m.timestamp,
              direction: m.direction,
              status: m.status,
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

    return () => { cancelled = true; };
  }, [username, authenticated, handleMessage, handleTyping, handleContactRequest, handleConnectionStatus]);

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

    const payload = new TextEncoder().encode(text);
    sdk.sendMessage(conversationId, payload as Uint8Array).then(() => {
      setState((prev) => ({
        ...prev,
        messages: {
          ...prev.messages,
          [conversationId]: prev.messages[conversationId]?.map((m) =>
            m.id === msgId ? { ...m, status: 'sent' as const } : m,
          ) ?? [],
        },
      }));
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
    setState((prev) => ({
      ...prev,
      pendingRequests: prev.pendingRequests.filter((r) => r.peerId !== peerId),
    }));
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

  return (
    <div className="h-full flex">
      <div className={`${activeConv ? 'hidden sm:flex' : 'flex'} w-full sm:w-72 lg:w-80 flex-shrink-0 flex-col`}>
        <ConversationList
          myUsername={state.myUsername}
          conversations={state.conversations}
          activeId={state.activeConversationId}
          pendingCount={state.pendingRequests.length}
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
          onContactAdded={(peerId, username) => {
            saveContactName(peerId, username);
            setState((prev) => {
              const existing = prev.conversations.find((c) => c.id === peerId);
              if (existing) {
                // Update the contact name if it was previously unknown
                return {
                  ...prev,
                  conversations: prev.conversations.map((c) =>
                    c.id === peerId ? { ...c, contact: makeContact(peerId, username) } : c,
                  ),
                };
              }
              return {
                ...prev,
                conversations: [
                  { id: peerId, contact: makeContact(peerId, username), unread: 0, isTyping: false },
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
            messages={state.messages[activeConv.id] ?? []}
            isTyping={activeConv.isTyping}
            onBack={() => setState((prev) => ({ ...prev, activeConversationId: null }))}
            onSend={(text) => handleSend(activeConv.id, text)}
            onRemove={() => handleRemoveContact(activeConv.id)}
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
    </div>
  );
}
