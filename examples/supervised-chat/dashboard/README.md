# supervisor audit dashboard

A small Vite + React + FlexSearch app for browsing and searching the supervisor bot's JSONL audit log. Ships alongside the supervised-chat example as the operator-side UI for compliance auditing.

## What it does

- Streams the `audit.jsonl` file via a tiny Node API server.
- Indexes every message with FlexSearch for sub-millisecond full-text search.
- Groups entries by `groupId` and shows a per-conversation thread view.
- Polls the API every 3 seconds so new messages appear without a refresh.
- Highlights matched messages and filters the conversation list down to groups that contain hits while a search is active.

## What it doesn't do (intentionally)

This is a reference, not a finished product. Three deliberate omissions, each marked in the code:

1. **No authentication.** The API server binds to `127.0.0.1` and assumes you've fronted it with something — a reverse proxy with basic auth, an SSO portal, mTLS, whatever your org already uses. Anyone with HTTP access to the supervisor's machine would otherwise be able to read every chat the supervisor has been on.
2. **No tamper-evidence.** The supervisor bot's audit log is plain JSON-Lines. A production deployment should chain entries with a hash of the previous line so deletions or edits are detectable; the dashboard would verify the chain on load and surface anomalies.
3. **No pagination.** The dashboard loads the full log on every poll. Fine for thousands of messages; would need streaming + on-demand loading at scale. The simplest path is to keep the FlexSearch index server-side and have the client query for hits only — but that requires the search index to live somewhere other than the user's browser.

## Quick start

```bash
# T1 (from examples/supervised-chat/)
npm run agent           # already in the parent example

# T2
npm run supervisor      # already in the parent example
                        # …writes to ./data/supervisor/audit.jsonl

# T3 (in this directory)
cd dashboard
npm install
npm run dev             # spawns the API server + the Vite dev server
                        # open http://localhost:5174
```

Now in any MeshWhisper client (e.g. Prudence), create a supervised group with both `@acme-support` and `@acme-compliance` as members, send a few messages, and watch them appear in the dashboard within a few seconds.

## Pointing the dashboard at a different log

By default the API server reads `../data/supervisor/audit.jsonl` (relative to the dashboard directory). Override either with env vars:

```bash
AUDIT_LOG_PATH=/var/log/meshwhisper/supervisor/audit.jsonl \
DASHBOARD_API_PORT=8080 \
npm run dev:server
```

For a production deployment, the dashboard's API server is just one of many ways to expose audit data. You could swap it for a thin wrapper around an Elasticsearch / OpenSearch / Postgres-FTS index, keep the React UI, and end up with a real auditor's tool in a couple of days.

## How it's wired

```
supervisor.ts (bot)         server.ts (this dir)         src/App.tsx
─────────────────           ────────────────────         ──────────
appends each msg            reads file on each            polls /api/audit
to audit.jsonl              request, parses JSON          every 3 s, rebuilds
                            lines, returns array          FlexSearch index,
                                                          renders thread/list
```

The supervisor bot doesn't know the dashboard exists. The dashboard doesn't know about MeshWhisper. The only contract between them is the JSON-Lines schema in `src/types.ts`:

```ts
interface AuditEntry {
  ts: string;          // message envelope timestamp (sender's clock)
  observedAt: string;  // supervisor's clock when received — gap = delivery latency
  groupId: string;
  senderPeerId: string;
  groupSenderId?: string;
  text: string;
}
```

Add fields freely — the dashboard ignores anything it doesn't render, and adding new columns is a straightforward TS + render edit.

## Going further

- **Per-message tamper-evidence**: have the supervisor bot include `prevHash` in each line (computed over the previous serialized line), and verify the chain in `server.ts` before returning entries. Surface broken chain links in the dashboard with a red warning.
- **Search by sender / by date range**: FlexSearch supports indexing additional fields. The current setup only indexes `text`; extend `Document.document.index` to include `senderPeerId` and `groupId` for filterable lookup.
- **Export to PDF / CSV for legal**: add a download button per conversation that calls `MeshWhisper.exportConversation(groupId, { format: 'text' })` on the supervisor bot side (via a new API endpoint) so the dashboard never has to do the formatting itself.
- **Server-Sent Events** instead of polling: the supervisor bot tails its own log via `fs.watch`, pushes new entries to the dashboard as they land. Sub-second freshness without 3 s lag.
