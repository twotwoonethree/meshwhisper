import { useEffect, useRef, useState } from 'react';
import type { AppMessage, Contact, GroupInfo } from '../types.ts';

interface Props {
  contact: Contact;
  group?: GroupInfo;
  messages: AppMessage[];
  isTyping: boolean;
  onBack: () => void;
  onSend: (text: string) => void;
  onRemove: () => void;
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function StatusIcon({ status }: { status: AppMessage['status'] }) {
  if (status === 'sending') return <span className="text-slate-600">○</span>;
  if (status === 'sent') return <span className="text-slate-500">✓</span>;
  if (status === 'delivered') return <span className="text-slate-400">✓✓</span>;
  if (status === 'read') return <span className="text-brand-400">✓✓</span>;
  if (status === 'failed') return <span className="text-red-400">!</span>;
  return null;
}

export default function Thread({ contact, group, messages, isTyping, onBack, onSend, onRemove }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = inputRef.current?.value.trim();
    if (!text) return;
    onSend(text);
    if (inputRef.current) inputRef.current.value = '';
    autoResize();
  }

  function autoResize() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900">
        <button
          onClick={onBack}
          className="sm:hidden text-slate-400 hover:text-white transition-colors mr-1"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
        </button>
        {group ? (
          <div className="w-8 h-8 rounded-full bg-brand-700 flex-shrink-0 flex items-center justify-center">
            <svg className="w-4 h-4 text-brand-200" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
            </svg>
          </div>
        ) : (
          <div className="w-8 h-8 rounded-full bg-brand-600 flex-shrink-0 flex items-center justify-center text-white text-sm font-semibold">
            {contact.displayName[0]?.toUpperCase()}
          </div>
        )}
        <div className="flex-1">
          <p className="text-white font-medium text-sm">{contact.displayName}</p>
          {group ? (
            <p className="text-slate-500 text-xs">{group.members.length} members</p>
          ) : contact.username ? (
            <p className="text-slate-500 text-xs">@{contact.username}</p>
          ) : null}
        </div>
        <button
          onClick={() => setConfirmDelete(true)}
          className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-red-400 transition-colors"
          title="Delete conversation"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
          </svg>
        </button>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setConfirmDelete(false)} />
          <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xs p-6 text-center">
            <p className="text-white font-medium mb-1">Delete conversation?</p>
            <p className="text-slate-400 text-sm mb-5">
              This will remove {contact.displayName} and all messages locally. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirmDelete(false); onRemove(); }}
                className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 scrollable px-4 py-4 space-y-1">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-slate-600 text-sm text-center">
              {group
                ? <>This is the beginning of <br /><span className="font-medium">{contact.displayName}</span>.</>
                : <>This is the beginning of your encrypted conversation<br />with {contact.displayName}.</>
              }
            </p>
          </div>
        )}
        {messages.map((msg, i) => {
          const isOut = msg.direction === 'outbound';
          const prev = messages[i - 1];
          const grouped = prev?.direction === msg.direction &&
            msg.timestamp - prev.timestamp < 60_000;

          return (
            <div
              key={msg.id}
              className={`flex ${isOut ? 'justify-end' : 'justify-start'} ${grouped ? 'mt-0.5' : 'mt-3'}`}
            >
              <div className={`max-w-[75%] ${isOut ? 'items-end' : 'items-start'} flex flex-col`}>
                {!isOut && !grouped && msg.senderName && (
                  <span className="text-brand-400 text-[10px] font-medium mb-0.5 px-1">
                    {msg.senderName}
                  </span>
                )}
                <div
                  className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
                    isOut
                      ? 'bg-brand-600 text-white rounded-br-sm'
                      : 'bg-slate-800 text-slate-100 rounded-bl-sm'
                  }`}
                >
                  {msg.text}
                </div>
                {!grouped && (
                  <div className={`flex items-center gap-1 mt-1 ${isOut ? 'flex-row-reverse' : ''}`}>
                    <span className="text-slate-600 text-[10px]">{formatTimestamp(msg.timestamp)}</span>
                    {isOut && <StatusIcon status={msg.status} />}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {isTyping && (
          <div className="flex justify-start mt-3">
            <div className="bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Compose */}
      <div className="border-t border-slate-800 bg-slate-900 px-4 py-3 flex items-end gap-3">
        <textarea
          ref={inputRef}
          placeholder="Message"
          rows={1}
          onKeyDown={handleKeyDown}
          onInput={autoResize}
          className="flex-1 bg-slate-800 border border-slate-700 rounded-2xl px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-slate-600 transition-colors text-sm resize-none leading-relaxed"
          style={{ height: '40px' }}
        />
        <button
          onClick={submit}
          className="w-9 h-9 flex-shrink-0 bg-brand-500 hover:bg-brand-600 rounded-full flex items-center justify-center transition-colors"
        >
          <svg className="w-4 h-4 text-white translate-x-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
