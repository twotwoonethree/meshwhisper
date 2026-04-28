import { useState } from 'react';
import { MeshWhisper } from '@meshwhisper/sdk';
import { NAMESPACE, NODE } from '../sdk.ts';

interface Props {
  onClose: () => void;
}

type SearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'found'; peerId: string; username: string }
  | { status: 'not_found' }
  | { status: 'sent' }
  | { status: 'error'; message: string };

export default function AddContact({ onClose }: Props) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });

  const trimmed = query.trim().replace(/^@/, '');
  const valid = /^[a-z0-9_-]{3,30}$/.test(trimmed);

  const relayHttp = NODE.replace('wss://', 'https://').replace('ws://', 'http://');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setState({ status: 'searching' });
    try {
      const url = `${relayHttp}/directory?namespace=${encodeURIComponent(NAMESPACE)}&username=${encodeURIComponent(trimmed)}`;
      const res = await fetch(url);
      if (res.status === 404) {
        setState({ status: 'not_found' });
        return;
      }
      if (!res.ok) throw new Error('relay error');
      const data = await res.json() as { publicKey: string; username: string };
      setState({ status: 'found', peerId: data.publicKey, username: data.username ?? trimmed });
    } catch {
      setState({ status: 'error', message: 'Search failed. Check your connection.' });
    }
  }

  async function handleConnect() {
    if (state.status !== 'found') return;
    try {
      await MeshWhisper.addContactByKey(state.peerId);
      setState({ status: 'sent' });
    } catch {
      setState({ status: 'error', message: 'Could not send request.' });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-white font-semibold">Add contact</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {state.status !== 'sent' ? (
          <>
            <form onSubmit={handleSearch} className="flex gap-2 mb-4">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">@</span>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''));
                    setState({ status: 'idle' });
                  }}
                  placeholder="username"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-7 pr-3 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors text-sm font-mono"
                />
              </div>
              <button
                type="submit"
                disabled={!valid || state.status === 'searching'}
                className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
              >
                {state.status === 'searching' ? '…' : 'Search'}
              </button>
            </form>

            {state.status === 'not_found' && (
              <p className="text-slate-400 text-sm text-center py-4">No user found with that username.</p>
            )}

            {state.status === 'found' && (
              <div className="bg-slate-800 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-brand-600 flex items-center justify-center text-white text-sm font-semibold">
                    {state.username[0].toUpperCase()}
                  </div>
                  <span className="text-white font-medium">@{state.username}</span>
                </div>
                <button
                  onClick={handleConnect}
                  className="bg-brand-500 hover:bg-brand-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                >
                  Connect
                </button>
              </div>
            )}

            {state.status === 'error' && (
              <p className="text-red-400 text-sm text-center">{state.message}</p>
            )}
          </>
        ) : (
          <div className="text-center py-4">
            <div className="w-12 h-12 rounded-full bg-brand-600/20 border border-brand-600/30 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-brand-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-white font-medium mb-1">Request sent</p>
            <p className="text-slate-400 text-sm">They'll see your request when they're next online.</p>
            <button onClick={onClose} className="mt-4 text-brand-400 text-sm hover:text-brand-300 transition-colors">Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
