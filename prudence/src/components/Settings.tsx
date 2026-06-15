import { useState } from 'react';
import { exportMyData } from '../dataExport.ts';
import { INTEROP_KEY, interopEnabled } from '../sdk.ts';
import { useEscapeKey } from '../hooks/useEscapeKey.ts';

interface Props {
  myUsername: string;
  onClose: () => void;
}

export default function Settings({ myUsername, onClose }: Props) {
  useEscapeKey(onClose);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interop] = useState(interopEnabled());

  // interop is init-time config — persist the choice and restart to re-init
  // the SDK with it. (Existing conversations live in IndexedDB and survive.)
  function toggleInterop() {
    localStorage.setItem(INTEROP_KEY, interop ? '0' : '1');
    location.reload();
  }

  async function handleExport() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await exportMyData(myUsername, passphrase.trim());
      setResult(
        `Saved ${res.filename} — ${res.conversationCount} conversation${res.conversationCount === 1 ? '' : 's'}` +
        (res.encrypted ? ', encrypted with your passphrase.' : ' (unencrypted; account key not included).'),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-white font-semibold text-sm">Settings</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors" title="Close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="scrollable px-5 py-4 space-y-6">
          {/* Account & recovery */}
          <section>
            <h3 className="text-slate-300 text-xs font-semibold uppercase tracking-wider mb-2">Account &amp; recovery</h3>
            <div className="text-slate-400 text-sm leading-relaxed space-y-2">
              <p>
                Your account <span className="text-slate-200">is</span> your username and password — there's no
                server-side account to lose. Sign in with the same <span className="text-slate-200">@{myUsername}</span> and
                password on any device to recover it.
              </p>
              <ul className="space-y-1.5 text-xs">
                <li className="flex gap-2">
                  <span className="text-green-400">✓</span>
                  <span><span className="text-slate-200">Contacts &amp; groups</span> are restored automatically from the encrypted relay archive when you sign back in.</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-amber-400">!</span>
                  <span><span className="text-slate-200">Message history</span> lives only on this device. Clearing your browser data erases it. Export it below to keep a copy.</span>
                </li>
              </ul>
            </div>
          </section>

          {/* Cross-app messaging (interop) */}
          <section>
            <h3 className="text-slate-300 text-xs font-semibold uppercase tracking-wider mb-2">Cross-app messaging</h3>
            <div className="flex items-start justify-between gap-3">
              <p className="text-slate-400 text-sm leading-relaxed flex-1">
                Let people using <span className="text-slate-200">other MeshWhisper apps</span> message you, and you them —
                like email between providers. Off (default) keeps you to Prudence users only. Either way, no relay can read
                your messages.
              </p>
              <button
                onClick={toggleInterop}
                role="switch"
                aria-checked={interop}
                title="Toggle cross-app messaging (restarts the app)"
                className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors ${interop ? 'bg-brand-500' : 'bg-slate-700'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${interop ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
            <p className="text-slate-600 text-[11px] mt-2">Changing this restarts the app. Your conversations are kept.</p>
          </section>

          {/* Export */}
          <section>
            <h3 className="text-slate-300 text-xs font-semibold uppercase tracking-wider mb-2">Export my data</h3>
            <p className="text-slate-400 text-sm leading-relaxed mb-3">
              Download a copy of your conversation transcripts and settings. Set a passphrase to encrypt the
              file and include your account key — leave it blank for a plain, readable copy (account key omitted).
            </p>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Passphrase (optional, but recommended)"
              autoComplete="new-password"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-brand-500 mb-3"
            />
            <button
              onClick={() => { void handleExport(); }}
              disabled={busy}
              className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors flex items-center justify-center gap-2"
            >
              {busy ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Exporting…
                </>
              ) : (
                'Export my data'
              )}
            </button>
            {result && <p className="text-green-400 text-xs mt-3 leading-relaxed">{result}</p>}
            {error && <p className="text-red-400 text-xs mt-3 leading-relaxed">{error}</p>}
            <p className="text-slate-600 text-[11px] mt-3 leading-relaxed">
              This is a one-way export — there's no in-app restore yet. If you lose the passphrase on an encrypted
              file, it can't be recovered.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
