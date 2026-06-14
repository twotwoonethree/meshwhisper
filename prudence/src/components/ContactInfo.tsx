import { useState } from 'react';
import { MeshWhisper } from '@meshwhisper/sdk';
import type { Contact } from '../types.ts';
import { useEscapeKey } from '../hooks/useEscapeKey.ts';

interface Props {
  contact: Contact;
  verified: boolean;
  onToggleVerified: (verified: boolean) => void;
  onClose: () => void;
}

// Group the fingerprint into 5-char blocks for readable, comparable display.
function formatNumber(n: string): string {
  return (n.match(/.{1,5}/g) ?? [n]).join(' ');
}

export default function ContactInfo({ contact, verified, onToggleVerified, onClose }: Props) {
  useEscapeKey(onClose);
  // getSafetyNumber throws if no session/identity key is known yet.
  let safetyNumber: string | null = null;
  let error: string | null = null;
  try {
    safetyNumber = MeshWhisper.getSafetyNumber(contact.peerId);
  } catch {
    error = 'A secure session with this contact is still being established. Send a message first, then try again.';
  }

  const [candidate, setCandidate] = useState('');
  const [checkResult, setCheckResult] = useState<'match' | 'mismatch' | null>(null);

  function handleCheck() {
    const ok = MeshWhisper.verifySafetyNumber(contact.peerId, candidate);
    setCheckResult(ok ? 'match' : 'mismatch');
    if (ok) { markAndToggle(true); }
  }

  function markAndToggle(next: boolean) {
    onToggleVerified(next);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-white font-semibold text-sm">{contact.displayName}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors" title="Close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="scrollable px-5 py-4 space-y-4">
          {verified && (
            <div className="flex items-center gap-2 text-green-400 text-sm">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              Verified
            </div>
          )}

          {error ? (
            <p className="text-slate-400 text-sm leading-relaxed">{error}</p>
          ) : (
            <>
              <div>
                <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider mb-2">Safety number</p>
                <p className="text-slate-400 text-sm leading-relaxed mb-3">
                  Compare this with {contact.displayName}'s safety number on their device. If they match, no one is
                  intercepting your conversation — the relay can't read it, and now you know there's no impostor either.
                </p>
                <div className="bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-sm text-brand-300 break-all tracking-wide">
                  {formatNumber(safetyNumber!)}
                </div>
              </div>

              <div>
                <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider mb-2">
                  Or check theirs
                </p>
                <input
                  value={candidate}
                  onChange={(e) => { setCandidate(e.target.value); setCheckResult(null); }}
                  placeholder="Paste their safety number"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-brand-500 font-mono mb-2"
                />
                <button
                  onClick={handleCheck}
                  disabled={!candidate.trim()}
                  className="w-full bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  Check
                </button>
                {checkResult === 'match' && <p className="text-green-400 text-xs mt-2">Match — marked as verified.</p>}
                {checkResult === 'mismatch' && <p className="text-red-400 text-xs mt-2">No match. The numbers differ — do not trust this session until they match.</p>}
              </div>

              <button
                onClick={() => markAndToggle(!verified)}
                className={`w-full text-sm font-medium rounded-lg px-4 py-2.5 transition-colors ${
                  verified
                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                    : 'bg-brand-600 hover:bg-brand-500 text-white'
                }`}
              >
                {verified ? 'Mark as unverified' : 'Mark as verified'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
