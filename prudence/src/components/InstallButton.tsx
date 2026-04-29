import { useState, useEffect, useRef } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

type InstallState =
  | { kind: 'hidden' }
  | { kind: 'android'; prompt: () => void }
  | { kind: 'ios' };

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true);
}

export default function InstallButton() {
  const [state, setState] = useState<InstallState>({ kind: 'hidden' });
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStandalone()) return;

    const handler = (e: Event) => {
      e.preventDefault();
      const prompt = () => (e as BeforeInstallPromptEvent).prompt();
      setState({ kind: 'android', prompt });
    };

    window.addEventListener('beforeinstallprompt', handler);

    if (isIos() && !isStandalone()) {
      setState({ kind: 'ios' });
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (state.kind === 'hidden' || installed) return null;

  async function handleInstall() {
    if (state.kind !== 'android') return;
    state.prompt();
    setOpen(false);
    setInstalled(true);
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-slate-300 transition-colors"
        title="Install app"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-xl z-50 p-4">
          {state.kind === 'android' && (
            <>
              <p className="text-white text-sm font-medium mb-1">Install Prudence</p>
              <p className="text-slate-400 text-xs mb-3 leading-relaxed">
                Add to your home screen for the full app experience — works offline too.
              </p>
              <button
                onClick={handleInstall}
                className="w-full bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium py-2 rounded-lg transition-colors"
              >
                Install
              </button>
            </>
          )}

          {state.kind === 'ios' && (
            <>
              <p className="text-white text-sm font-medium mb-1">Add to Home Screen</p>
              <p className="text-slate-400 text-xs leading-relaxed">
                Tap the{' '}
                <svg className="inline w-3.5 h-3.5 mb-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                </svg>
                {' '}Share button in Safari, then choose{' '}
                <span className="text-white font-medium">Add to Home Screen</span>.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
