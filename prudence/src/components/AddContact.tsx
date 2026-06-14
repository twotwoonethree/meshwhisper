import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { MeshWhisper } from '@meshwhisper/sdk';
import { NAMESPACE, NODE, getSDK } from '../sdk.ts';
import { saveContactName } from '../contact-names.ts';
import { markAccepted } from '../accepted-contacts.ts';
import { peerIdFromContactQR, looksLikeContactQR } from '../qr.ts';
import QRScanner from './QRScanner.tsx';

type Mode = 'search' | 'mycode' | 'scan';

interface Props {
  myUsername: string;
  onClose: () => void;
  onAdded: (peerId: string, username: string) => void;
  /** Which tab to open on. Defaults to 'search'. */
  initialMode?: Mode;
}

type SearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'found'; peerId: string; username: string }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export default function AddContact({ myUsername, onClose, onAdded, initialMode = 'search' }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });

  // My code (mode: 'mycode')
  const [myCode, setMyCode] = useState('');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Scan (mode: 'scan')
  const [scanFailed, setScanFailed] = useState(false);
  const [pasteCode, setPasteCode] = useState('');

  const trimmed = query.trim().replace(/^@/, '');
  const valid = /^[a-z0-9_-]{3,30}$/.test(trimmed);
  const relayHttp = NODE.replace('wss://', 'https://').replace('ws://', 'http://');

  // Generate my contact QR when the "My code" tab opens.
  useEffect(() => {
    if (mode !== 'mycode') return;
    try {
      const code = MeshWhisper.generateContactQR();
      setMyCode(code);
      QRCode.toDataURL(code, { errorCorrectionLevel: 'M', width: 260, margin: 1 })
        .then(setQrUrl)
        .catch(() => setQrUrl(null));
    } catch {
      setState({ status: 'error', message: 'Still connecting — try again in a moment.' });
    }
  }, [mode]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setState({ status: 'searching' });
    try {
      const url = `${relayHttp}/directory?namespace=${encodeURIComponent(NAMESPACE)}&username=${encodeURIComponent(trimmed)}`;
      const res = await fetch(url);
      if (res.status === 404) { setState({ status: 'not_found' }); return; }
      if (!res.ok) throw new Error('relay error');
      const data = await res.json() as { publicKey: string; username: string };
      setState({ status: 'found', peerId: data.publicKey, username: data.username ?? trimmed });
    } catch {
      setState({ status: 'error', message: 'Search failed. Check your connection.' });
    }
  }

  async function handleConnect() {
    if (state.status !== 'found') return;
    const sdk = getSDK();
    if (!sdk) { setState({ status: 'error', message: 'Still connecting to relay — try again in a moment.' }); return; }
    try {
      const peerId = await sdk.addContactByKeyInstance(state.peerId);
      if (!peerId) { setState({ status: 'error', message: 'Could not reach user — bundle not found on relay.' }); return; }
      const payload = new TextEncoder().encode(JSON.stringify({ __prudence_ctrl: 'contact_request', username: myUsername }));
      await sdk.sendMessage(peerId, payload);
      // onAdded opens the conversation and closes this modal.
      onAdded(peerId, state.username);
    } catch (err: unknown) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Could not send request.' });
    }
  }

  // Pair from a scanned/pasted contact code: establish the session, learn their
  // @name from the directory, tell them who connected, open the conversation.
  async function connectByQR(data: string) {
    const sdk = getSDK();
    if (!sdk) { setState({ status: 'error', message: 'Still connecting to relay — try again in a moment.' }); return; }
    if (!looksLikeContactQR(data)) { setState({ status: 'error', message: "That doesn't look like a valid contact code." }); return; }
    setState({ status: 'searching' });
    try {
      await MeshWhisper.acceptContact(data.trim());
      const peerId = peerIdFromContactQR(data);
      const username = (await MeshWhisper.resolveUsername(peerId).catch(() => undefined)) ?? '';
      if (username) saveContactName(peerId, username);
      markAccepted(peerId);
      const payload = new TextEncoder().encode(JSON.stringify({ __prudence_ctrl: 'contact_request', username: myUsername }));
      await sdk.sendMessage(peerId, payload);
      onAdded(peerId, username); // opens the conversation and closes this modal
    } catch {
      setState({ status: 'error', message: 'Could not pair from that code.' });
    }
  }

  const tabClass = (m: Mode) =>
    `flex-1 text-sm py-2 rounded-lg transition-colors ${mode === m ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-white font-semibold">Add contact</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <>
            <div className="flex gap-1 bg-slate-950/50 rounded-lg p-1 mb-5">
              <button className={tabClass('search')} onClick={() => { setMode('search'); setState({ status: 'idle' }); }}>Username</button>
              <button className={tabClass('mycode')} onClick={() => { setMode('mycode'); setState({ status: 'idle' }); }}>My code</button>
              <button className={tabClass('scan')} onClick={() => { setMode('scan'); setState({ status: 'idle' }); setScanFailed(false); }}>Scan</button>
            </div>

            {mode === 'search' && (
              <>
                <form onSubmit={handleSearch} className="flex gap-2 mb-4">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">@</span>
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => { setQuery(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '')); setState({ status: 'idle' }); }}
                      placeholder="username"
                      autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-7 pr-3 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors text-sm font-mono"
                    />
                  </div>
                  <button type="submit" disabled={!valid || state.status === 'searching'} className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap">
                    {state.status === 'searching' ? '…' : 'Search'}
                  </button>
                </form>
                {state.status === 'not_found' && <p className="text-slate-400 text-sm text-center py-4">No user found with that username.</p>}
                {state.status === 'found' && (
                  <div className="bg-slate-800 rounded-xl p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-brand-600 flex items-center justify-center text-white text-sm font-semibold">{state.username[0].toUpperCase()}</div>
                      <span className="text-white font-medium">@{state.username}</span>
                    </div>
                    <button onClick={handleConnect} className="bg-brand-500 hover:bg-brand-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors">Connect</button>
                  </div>
                )}
              </>
            )}

            {mode === 'mycode' && (
              <div className="text-center">
                <p className="text-slate-400 text-sm mb-4">Have them scan this with their <span className="text-slate-200">Scan</span> tab — no username or directory needed.</p>
                <div className="bg-white rounded-xl p-3 inline-block mx-auto">
                  {qrUrl
                    ? <img src={qrUrl} alt="Your contact code" width={260} height={260} className="block" />
                    : <div className="w-[260px] h-[260px] flex items-center justify-center text-slate-400 text-sm">Generating…</div>}
                </div>
                <button
                  onClick={() => { void navigator.clipboard.writeText(myCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  disabled={!myCode}
                  className="mt-4 w-full bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy code instead'}
                </button>
              </div>
            )}

            {mode === 'scan' && (
              <div className="space-y-3">
                {!scanFailed
                  ? <QRScanner onResult={(d) => { void connectByQR(d); }} onError={() => setScanFailed(true)} />
                  : <p className="text-slate-400 text-sm">Camera unavailable. Paste their code below instead.</p>}
                <div>
                  <textarea
                    value={pasteCode}
                    onChange={(e) => setPasteCode(e.target.value)}
                    placeholder="…or paste a contact code"
                    rows={3}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 text-xs font-mono resize-none"
                  />
                  <button
                    onClick={() => { void connectByQR(pasteCode); }}
                    disabled={!pasteCode.trim() || state.status === 'searching'}
                    className="mt-2 w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                  >
                    {state.status === 'searching' ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </div>
            )}

            {state.status === 'error' && <p className="text-red-400 text-sm text-center mt-3">{state.message}</p>}
        </>
      </div>
    </div>
  );
}
