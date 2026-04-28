import { useState } from 'react';
import type { Conversation } from '../types.ts';
import AddContact from './AddContact.tsx';

interface Props {
  myUsername: string;
  conversations: Conversation[];
  activeId: string | null;
  pendingCount: number;
  connected: boolean;
  onSelect: (id: string) => void;
  onPendingClick: () => void;
}

function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const s = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
  return (
    <div className={`${s} rounded-full bg-brand-600 flex-shrink-0 flex items-center justify-center text-white font-semibold`}>
      {name[0]?.toUpperCase() ?? '?'}
    </div>
  );
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function ConversationList({
  myUsername,
  conversations,
  activeId,
  pendingCount,
  connected,
  onSelect,
  onPendingClick,
}: Props) {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <>
      <div className="flex flex-col h-full bg-slate-900 border-r border-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800">
          <div>
            <h1 className="text-white font-semibold text-base">Prudence</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-slate-600'}`} />
              <span className="text-slate-500 text-xs">@{myUsername}</span>
            </div>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
            title="Add contact"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>

        {/* Pending requests banner */}
        {pendingCount > 0 && (
          <button
            onClick={onPendingClick}
            className="flex items-center gap-3 px-4 py-3 bg-brand-600/10 border-b border-brand-600/20 hover:bg-brand-600/20 transition-colors text-left"
          >
            <div className="w-2 h-2 rounded-full bg-brand-400 flex-shrink-0" />
            <span className="text-brand-400 text-sm font-medium">
              {pendingCount} contact request{pendingCount > 1 ? 's' : ''}
            </span>
          </button>
        )}

        {/* List */}
        <div className="flex-1 scrollable">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <p className="text-slate-500 text-sm mb-2">No conversations yet</p>
              <p className="text-slate-600 text-xs">Tap + to add a contact</p>
            </div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-800/60 transition-colors text-left border-b border-slate-800/50 ${activeId === conv.id ? 'bg-slate-800' : ''}`}
              >
                <Avatar name={conv.contact.displayName} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-white text-sm font-medium truncate">
                      {conv.contact.displayName}
                    </span>
                    {conv.lastMessage && (
                      <span className="text-slate-500 text-xs flex-shrink-0">
                        {formatTime(conv.lastMessage.timestamp)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <p className="text-slate-400 text-xs truncate">
                      {conv.isTyping ? (
                        <span className="text-brand-400 italic">typing…</span>
                      ) : conv.lastMessage ? (
                        conv.lastMessage.text
                      ) : (
                        <span className="text-slate-600">No messages yet</span>
                      )}
                    </p>
                    {conv.unread > 0 && (
                      <span className="flex-shrink-0 min-w-[18px] h-[18px] rounded-full bg-brand-500 text-white text-[10px] font-semibold flex items-center justify-center px-1">
                        {conv.unread > 99 ? '99+' : conv.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {showAdd && <AddContact onClose={() => setShowAdd(false)} />}
    </>
  );
}
