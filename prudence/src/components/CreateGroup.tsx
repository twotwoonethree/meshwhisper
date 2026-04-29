import { useState } from 'react';
import type { Contact } from '../types.ts';

interface Props {
  contacts: Contact[];
  onClose: () => void;
  onCreate: (name: string, memberPeerIds: string[]) => void;
}

export default function CreateGroup({ contacts, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(peerId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId); else next.add(peerId);
      return next;
    });
  }

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || selected.size === 0) return;
    onCreate(trimmed, [...selected]);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-white font-semibold text-sm">New group</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 border-b border-slate-800">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name"
            maxLength={64}
            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-slate-600 text-sm"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {contacts.length === 0 ? (
            <p className="text-slate-500 text-sm text-center py-6">No contacts yet</p>
          ) : (
            contacts.map((c) => (
              <button
                key={c.peerId}
                onClick={() => toggle(c.peerId)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-800 transition-colors text-left"
              >
                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${selected.has(c.peerId) ? 'bg-brand-500 border-brand-500' : 'border-slate-600'}`}>
                  {selected.has(c.peerId) && (
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  )}
                </div>
                <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                  {c.displayName[0]?.toUpperCase() ?? '?'}
                </div>
                <span className="text-white text-sm">{c.displayName}</span>
              </button>
            ))
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-800">
          <button
            onClick={handleCreate}
            disabled={!name.trim() || selected.size === 0}
            className="w-full py-2.5 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            Create group {selected.size > 0 ? `(${selected.size + 1} members)` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
