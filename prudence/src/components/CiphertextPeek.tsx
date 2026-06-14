import type { CiphertextInfo } from '../types.ts';
import { useEscapeKey } from '../hooks/useEscapeKey.ts';

interface Props {
  plaintext: string;
  info?: CiphertextInfo;
  onClose: () => void;
}

// "What the relay sees" — shows the plaintext you typed next to the actual
// encrypted bytes the relay received (captured via the SDK's onCiphertext hook,
// ADR-008). Makes the "the relay can't read this" promise tangible.
export default function CiphertextPeek({ plaintext, info, onClose }: Props) {
  useEscapeKey(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-white font-semibold text-sm">What the relay sees</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors" title="Close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="scrollable px-5 py-4 space-y-4">
          <div>
            <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider mb-1.5">You sent</p>
            <div className="bg-slate-800 rounded-lg p-3 text-sm text-white break-words">{plaintext}</div>
          </div>

          {info ? (
            <>
              <div>
                <div className="flex items-baseline justify-between mb-1.5">
                  <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider">The relay receives</p>
                  <p className="text-slate-500 text-[11px]">{info.byteLength} bytes</p>
                </div>
                <div className="bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-[11px] leading-relaxed text-brand-300 break-all max-h-44 overflow-y-auto">
                  {info.ciphertextHex}
                </div>
              </div>

              <div>
                <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider mb-1.5">Addressed to</p>
                <div className="bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-[11px] text-slate-400 break-all">
                  {info.destHashHex}
                </div>
                <p className="text-slate-600 text-[11px] mt-1.5">A one-way hash that rotates every hour — the relay can't link your messages over time.</p>
              </div>

              <p className="text-slate-400 text-xs leading-relaxed">
                <span className="text-slate-200">relay.meshwhisper.org stores and forwards exactly these bytes.</span> It
                holds no keys and can't turn them back into your {info.plaintextLength}-character message — only the
                person you're talking to can.
              </p>
            </>
          ) : (
            <p className="text-slate-400 text-sm leading-relaxed">
              The encrypted bytes for this message weren't captured (it was sent in an earlier session). Send a new
              message and tap it to see exactly what the relay receives.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
