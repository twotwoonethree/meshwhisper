import { useEffect, useRef } from 'react';
import type { AppMessage, Contact } from '../types.ts';

interface Props {
  contact: Contact;
  messages: AppMessage[];
  isTyping: boolean;
  onBack: () => void;
  onSend: (text: string) => void;
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

export default function Thread({ contact, messages, isTyping, onBack, onSend }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
        <div className="w-8 h-8 rounded-full bg-brand-600 flex-shrink-0 flex items-center justify-center text-white text-sm font-semibold">
          {contact.displayName[0]?.toUpperCase()}
        </div>
        <div>
          <p className="text-white font-medium text-sm">{contact.displayName}</p>
          {contact.username && (
            <p className="text-slate-500 text-xs">@{contact.username}</p>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 scrollable px-4 py-4 space-y-1">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-slate-600 text-sm text-center">
              This is the beginning of your encrypted conversation<br />with {contact.displayName}.
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
