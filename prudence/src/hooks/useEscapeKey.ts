import { useEffect, useRef } from 'react';

/**
 * Invoke `onEscape` when the Escape key is pressed anywhere. Used by modals so
 * they close on Esc, not just on a backdrop click or the X button. The handler
 * is held in a ref so the listener binds once and isn't re-attached on every
 * parent render.
 */
export function useEscapeKey(onEscape: () => void): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
