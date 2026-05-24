import { useEffect, useMemo, useRef, useState } from 'react';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import FlexSearchPkg from 'flexsearch';
import type { AuditEntry, AuditResponse } from './types.ts';

// FlexSearch ships as CJS; ESM interop gives us the namespace object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Document } = FlexSearchPkg as any;

// Index identifiers don't survive file order, so we key each entry by a
// composite of its timestamp + groupId + first few payload bytes. Stable
// enough for our purposes; if two messages collide we just lose one match
// hit, not data.
function entryId(e: AuditEntry): string {
  return `${e.ts}|${e.groupId.slice(0, 8)}|${e.text.slice(0, 16)}`;
}

interface GroupSummary {
  groupId: string;
  count: number;
  lastTs: string;
  lastText: string;
  senders: Set<string>;
}

function summariseGroups(entries: AuditEntry[]): GroupSummary[] {
  const map = new Map<string, GroupSummary>();
  for (const e of entries) {
    const cur = map.get(e.groupId);
    if (!cur) {
      map.set(e.groupId, {
        groupId: e.groupId,
        count: 1,
        lastTs: e.ts,
        lastText: e.text,
        senders: new Set([e.groupSenderId ?? e.senderPeerId]),
      });
    } else {
      cur.count++;
      cur.senders.add(e.groupSenderId ?? e.senderPeerId);
      if (e.ts > cur.lastTs) {
        cur.lastTs = e.ts;
        cur.lastText = e.text;
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

export default function App() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matchedIds, setMatchedIds] = useState<Set<string> | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const indexRef = useRef<any>(null);

  // Build / rebuild the FlexSearch index whenever entries change.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx: any = new Document({
      tokenize: 'forward',
      document: {
        id: 'id',
        index: ['text'],
        store: ['groupId'],
      },
    });
    for (const e of entries) {
      idx.add({ id: entryId(e), text: e.text, groupId: e.groupId });
    }
    indexRef.current = idx;
    // Re-run the existing query against the new index.
    if (query.trim()) {
      runSearch(query, idx);
    } else {
      setMatchedIds(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Poll the API every 3 s. The supervisor bot writes to the audit file
  // asynchronously, so polling is the simplest "update when new entries
  // arrive" pattern. For high-volume deployments, swap to SSE/WebSocket.
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const res = await fetch('/api/audit');
        if (!res.ok) return;
        const data = (await res.json()) as AuditResponse;
        if (cancelled) return;
        setEntries(data.entries);
        setLastRefresh(new Date());
      } catch {
        // Network blip — leave state as-is; next tick will retry.
      }
    };
    const refreshHealth = async (): Promise<void> => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) return;
        const data = (await res.json()) as { logPath?: string };
        if (!cancelled && data.logPath) setLogPath(data.logPath);
      } catch { /* ignore */ }
    };
    void refresh();
    void refreshHealth();
    const t = setInterval(refresh, 3_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function runSearch(q: string, idx: any): void {
    if (!q.trim() || !idx) {
      setMatchedIds(null);
      return;
    }
    const results = idx.search(q, { limit: 1000, enrich: false });
    // Document index returns { field, result: [...ids] } shape.
    const ids = new Set<string>();
    for (const r of results) {
      for (const id of r.result ?? []) ids.add(String(id));
    }
    setMatchedIds(ids);
  }

  function onQueryChange(value: string): void {
    setQuery(value);
    runSearch(value, indexRef.current);
  }

  const groups = useMemo(() => summariseGroups(entries), [entries]);

  // If a search is active, restrict group list to those that have at least
  // one match. (Easier to find which conversation the hit is in.)
  const visibleGroups = useMemo(() => {
    if (!matchedIds) return groups;
    const groupsWithMatches = new Set<string>();
    for (const e of entries) {
      if (matchedIds.has(entryId(e))) groupsWithMatches.add(e.groupId);
    }
    return groups.filter((g) => groupsWithMatches.has(g.groupId));
  }, [groups, matchedIds, entries]);

  const activeMessages = useMemo(() => {
    if (!activeGroup) return [];
    return entries
      .filter((e) => e.groupId === activeGroup)
      .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }, [entries, activeGroup]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <h1>Supervisor Audit Dashboard</h1>
          <span className="topbar-sub">{logPath ?? 'connecting…'}</span>
        </div>
        <input
          type="text"
          placeholder="Search across all conversations…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="search"
        />
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-header">
            Conversations <span className="muted">({visibleGroups.length})</span>
          </div>
          {visibleGroups.length === 0 && (
            <div className="empty">
              {entries.length === 0
                ? 'No audit entries yet. Send a message in a supervised group to populate.'
                : 'No conversations match your search.'}
            </div>
          )}
          {visibleGroups.map((g) => (
            <button
              key={g.groupId}
              className={`group-row ${activeGroup === g.groupId ? 'active' : ''}`}
              onClick={() => setActiveGroup(g.groupId)}
            >
              <div className="group-row-top">
                <span className="group-id">{shortId(g.groupId)}…</span>
                <span className="group-count">{g.count}</span>
              </div>
              <div className="group-row-preview">{g.lastText}</div>
              <div className="group-row-meta">
                {g.senders.size} {g.senders.size === 1 ? 'sender' : 'senders'} ·{' '}
                {formatTs(g.lastTs)}
              </div>
            </button>
          ))}
        </aside>

        <main className="thread">
          {!activeGroup && (
            <div className="empty thread-empty">
              Select a conversation to view its audit trail.
            </div>
          )}
          {activeGroup && (
            <>
              <div className="thread-header">
                <span className="thread-id">{activeGroup}</span>
                <span className="muted">{activeMessages.length} messages</span>
              </div>
              <div className="thread-messages">
                {activeMessages.map((e) => {
                  const matched = matchedIds?.has(entryId(e));
                  return (
                    <div
                      key={`${e.ts}-${e.text.slice(0, 8)}`}
                      className={`message ${matched ? 'matched' : ''}`}
                    >
                      <div className="message-head">
                        <span className="message-sender">
                          {shortId(e.groupSenderId ?? e.senderPeerId)}
                        </span>
                        <span className="message-ts">{formatTs(e.ts)}</span>
                        <span className="message-observed">
                          observed +{ageMs(e.ts, e.observedAt)}ms
                        </span>
                      </div>
                      <div className="message-text">{e.text}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span>{entries.length} entries indexed</span>
        <span className="muted">
          {lastRefresh ? `refreshed ${lastRefresh.toLocaleTimeString()}` : 'not yet refreshed'}
        </span>
      </footer>
    </div>
  );
}

function ageMs(sent: string, observed: string): number {
  try {
    return new Date(observed).getTime() - new Date(sent).getTime();
  } catch {
    return 0;
  }
}
