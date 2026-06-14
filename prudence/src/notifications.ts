// Foreground rich notifications.
//
// When Prudence is open in any tab — even hidden / backgrounded — and a
// new message arrives, surface it via the Notification API with the
// sender and a preview. The closed-app path still goes through the
// service worker's generic "New message" notification because the SW
// can't decrypt without bundling the SDK; that's the encrypted-push-
// payload work we've planned for a future tier.
//
// Suppression rules:
//   - Skip if the user is actively viewing that conversation (window
//     visible AND active conversation matches the message's).
//   - Skip if the message is older than ~30 seconds — we don't want to
//     pop a notification for backfilled history on reconnect.
//   - Skip if permission isn't granted.
//   - Skip if the document is fully visible AND focused — no need to
//     interrupt someone already looking at the app.

const RECENT_THRESHOLD_MS = 30_000;

// Notification text comes from peer-controlled content (display names, message
// bodies). The Notification API doesn't parse HTML, so this isn't an injection
// vector — but unbounded length and stray control characters make for ugly /
// abusable notifications. Strip control chars and cap the length.
function sanitizeNotificationText(text: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + '…' : cleaned;
}

export function canShowNotifications(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted'
  );
}

export interface MessageNotificationOptions {
  /** What to show in the notification heading — usually `@username` or a fallback. */
  title: string;
  /** Body text — usually the message preview, or "Photo" / "File" for media. */
  body: string;
  /** Conversation id used to deduplicate notifications and route clicks. */
  conversationId: string;
  /** When the underlying message was sent (ms epoch). Older messages suppress. */
  timestamp: number;
  /** True if the user is currently viewing this conversation in a focused tab. */
  suppressBecauseActive: boolean;
}

export function showMessageNotification(opts: MessageNotificationOptions): void {
  if (!canShowNotifications()) return;
  if (opts.suppressBecauseActive) return;
  if (Date.now() - opts.timestamp > RECENT_THRESHOLD_MS) return;

  // Use the conversation id as the notification tag so multiple messages
  // from the same conversation collapse into one bubble rather than
  // stacking endlessly. This matches WhatsApp / iMessage behaviour.
  const tag = `prudence:${opts.conversationId}`;

  try {
    const n = new Notification(sanitizeNotificationText(opts.title, 80), {
      body: sanitizeNotificationText(opts.body, 200),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag,
      // renotify ensures the device alerts again even when the tag matches
      // an older notification — important so back-to-back messages from the
      // same person produce a buzz / sound rather than silently updating.
      // Cast to any: TypeScript's NotificationOptions doesn't include
      // `renotify` everywhere yet but the spec does.
      ...({ renotify: true } as Record<string, unknown>),
    });
    n.onclick = () => {
      window.focus();
      // Let the app react — open the conversation in the UI.
      document.dispatchEvent(
        new CustomEvent('prudence:openConversation', {
          detail: { conversationId: opts.conversationId },
        }),
      );
      n.close();
    };
  } catch {
    // Some browsers throw if Notification is constructed in restricted
    // contexts. Safe to ignore — the SW path will still surface a generic
    // notification when the app isn't focused.
  }
}
