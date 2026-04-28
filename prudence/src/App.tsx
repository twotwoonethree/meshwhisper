import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message, Conversation as SDKConversation, StoredMessage } from '@meshwhisper/sdk';
import { MeshWhisper } from '@meshwhisper/sdk';
import { initSDK, getSDK } from './sdk.ts';
import { idbStorage } from './storage.ts';
import type { AppState, AppMessage, Conversation, Contact } from './types.ts';
import Onboarding from './components/Onboarding.tsx';
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

function makeContact(peerId: string, username?: string): Contact {
  return {
    peerId,
    username,
    displayName: username ? `@${username}` : peerId.slice(0, 8),
    addedAt: Date.now(),
  };
}

export default function App() {
  const [username, setUsername] = useState<string | null>(null);
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

  // Load persisted username on mount
  useEffect(() => {
    idbStorage.get(USERNAME_KEY).then((u: string | null) => {
      setUsername(u);
      setLoading(false);
    });
  }, []);

  const handleMessage = useCallback((msg: Message) => {
    const text = decoder(Array.from(msg.payload));
    if (!text) return;

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

  // Boot SDK when username is known
  useEffect(() => {
    if (!username) return;
    let cancelled = false;

    void initSDK(username, {
      onMessage: handleMessage,
      onTyping: handleTyping,
      onContactRequest: handleContactRequest,
      onConnectionStatus: handleConnectionStatus,
    }).then(() => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, myUsername: username, connected: true }));
      // Load existing conversations from SDK storage
      MeshWhisper.getConversations().then((convs: SDKConversation[]) => {
        if (cancelled) return;
        const appConvs: Conversation[] = convs.map((c: SDKConversation) => ({
          id: c.peerId,
          contact: makeContact(c.peerId),
          unread: c.unreadCount ?? 0,
          isTyping: false,
        }));
        setState((prev) => ({ ...prev, conversations: appConvs }));
        convs.forEach(async (c: SDKConversation) => {
          const msgs = await MeshWhisper.getMessages(c.peerId);
          if (!msgs || cancelled) return;
          const appMsgs: AppMessage[] = msgs.map((m: StoredMessage) => ({
            id: m.id,
            conversationId: c.peerId,
            text: decoder(m.payload),
            timestamp: m.timestamp,
            direction: m.direction,
            status: m.status,
          }));
          if (appMsgs.length > 0) {
            setState((prev) => ({
              ...prev,
              messages: { ...prev.messages, [c.peerId]: appMsgs },
              conversations: prev.conversations.map((conv) =>
                conv.id === c.peerId
                  ? { ...conv, lastMessage: appMsgs[appMsgs.length - 1] }
                  : conv,
              ),
            }));
          }
        });
      });
    }).catch(console.error);

    return () => { cancelled = true; };
  }, [username, handleMessage, handleTyping, handleContactRequest, handleConnectionStatus]);

  async function handleOnboardingComplete(chosenUsername: string) {
    await idbStorage.set(USERNAME_KEY, chosenUsername);
    setUsername(chosenUsername);
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
    }).catch(() => {
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

  function handleAcceptRequest(peerId: string) {
    const req = state.pendingRequests.find((r) => r.peerId === peerId);
    const contact = makeContact(peerId, req?.username);
    setState((prev) => ({
      ...prev,
      pendingRequests: prev.pendingRequests.filter((r) => r.peerId !== peerId),
      conversations: [
        { id: peerId, contact, unread: 0, isTyping: false },
        ...prev.conversations.filter((c) => c.id !== peerId),
      ],
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
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  const activeConv = state.conversations.find((c) => c.id === state.activeConversationId);

  return (
    <div className="h-full flex">
      {/* Sidebar — always visible on sm+, hidden on mobile when thread is open */}
      <div className={`${activeConv ? 'hidden sm:flex' : 'flex'} w-full sm:w-72 lg:w-80 flex-shrink-0 flex-col`}>
        <ConversationList
          myUsername={state.myUsername}
          conversations={state.conversations}
          activeId={state.activeConversationId}
          pendingCount={state.pendingRequests.length}
          connected={state.connected}
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
        />
      </div>

      {/* Thread pane */}
      <div className={`${activeConv ? 'flex' : 'hidden sm:flex'} flex-1 flex-col`}>
        {activeConv ? (
          <Thread
            contact={activeConv.contact}
            messages={state.messages[activeConv.id] ?? []}
            isTyping={activeConv.isTyping}
            onBack={() => setState((prev) => ({ ...prev, activeConversationId: null }))}
            onSend={(text) => handleSend(activeConv.id, text)}
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
          onAccept={handleAcceptRequest}
          onDecline={handleDeclineRequest}
          onClose={() => setShowPending(false)}
        />
      )}
    </div>
  );
}
