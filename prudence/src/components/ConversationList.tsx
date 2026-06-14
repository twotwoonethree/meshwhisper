import { useState } from 'react';
import type { Conversation } from '../types.ts';
import AddContact from './AddContact.tsx';
import InstallButton from './InstallButton.tsx';
import Settings from './Settings.tsx';

interface Props {
  myUsername: string;
  conversations: Conversation[];
  activeId: string | null;
  pendingCount: number;
  pendingGroupInviteCount: number;
  connected: boolean;
  onSelect: (id: string) => void;
  onPendingClick: () => void;
  onGroupInviteClick: () => void;
  onContactAdded: (peerId: string, username: string) => void;
  onNewGroup: () => void;
  onLock: () => void;
}

function Avatar({ name, isGroup = false }: { name: string; isGroup?: boolean }) {
  if (isGroup) {
    return (
      <div className="w-10 h-10 rounded-full bg-brand-700 flex-shrink-0 flex items-center justify-center">
        <svg className="w-5 h-5 text-brand-200" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
        </svg>
      </div>
    );
  }
  return (
    <div className="w-10 h-10 rounded-full bg-brand-600 flex-shrink-0 flex items-center justify-center text-white text-sm font-semibold">
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
  pendingGroupInviteCount,
  connected,
  onSelect,
  onPendingClick,
  onGroupInviteClick,
  onContactAdded,
  onNewGroup,
  onLock,
}: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  return (
    <>
      <div className="flex flex-col h-full bg-slate-900 border-r border-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800">
          <div>
            <img src="/logo-long.png" alt="Prudence" className="h-6 object-contain object-left" />
            <div className="flex items-center gap-1.5 mt-1">
              <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-slate-600'}`} />
              <span className="text-slate-500 text-xs">@{myUsername}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <InstallButton />
            <button
              onClick={() => setShowSettings(true)}
              className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-slate-300 transition-colors"
              title="Settings"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.542-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
            </button>
            <button
              onClick={onLock}
              className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-slate-300 transition-colors"
              title="Lock"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            </button>
            <button
              onClick={onNewGroup}
              className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
              title="New group"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
              </svg>
            </button>
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
        </div>

        {/* Pending contact requests banner */}
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

        {/* Pending group invitations banner */}
        {pendingGroupInviteCount > 0 && (
          <button
            onClick={onGroupInviteClick}
            className="flex items-center gap-3 px-4 py-3 bg-brand-600/10 border-b border-brand-600/20 hover:bg-brand-600/20 transition-colors text-left"
          >
            <div className="w-2 h-2 rounded-full bg-brand-400 flex-shrink-0" />
            <span className="text-brand-400 text-sm font-medium">
              {pendingGroupInviteCount} group invitation{pendingGroupInviteCount > 1 ? 's' : ''}
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
                <Avatar name={conv.contact.displayName} isGroup={!!conv.group} />
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
                        conv.group && conv.lastMessage.senderName
                          ? <><span className="text-slate-500">{conv.lastMessage.senderName}:</span> {conv.lastMessage.text}</>
                          : conv.lastMessage.text
                      ) : conv.group ? (
                        <span className="text-slate-600">{conv.group.members.length} members</span>
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

      {showAdd && (
        <AddContact
          myUsername={myUsername}
          onClose={() => setShowAdd(false)}
          onAdded={(peerId, username) => { onContactAdded(peerId, username); setShowAdd(false); }}
        />
      )}

      {showSettings && (
        <Settings myUsername={myUsername} onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}
