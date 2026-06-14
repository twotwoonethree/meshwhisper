# Architecture Decision Records

This directory holds short, dated records of significant architectural decisions made about MeshWhisper. Each ADR captures the *why* behind a choice — context, the decision itself, the alternatives that were considered, and the consequences — in enough detail that a future contributor or auditor can reason about it without reading three years of issue threads.

## Format

We use the Michael Nygard ADR format. Each file is named `NNN-short-title.md` where `NNN` is a zero-padded sequence number and the title is a one-line slug.

Sections:

- **Status** — Proposed / Accepted / Deprecated / Superseded by ADR-NNN
- **Date** — when the decision was recorded
- **Context** — what problem prompted this, what constraints were in play
- **Decision** — the choice that was made, stated plainly
- **Alternatives considered** — each alternative + why it lost
- **Consequences** — what changes about the system, the team, the roadmap

Keep each ADR to one page where possible. Long ADRs are usually a sign that two or three decisions are entangled and should be split.

## When to write one

Write an ADR when a decision:

- Affects the public protocol or wire format
- Closes off a future architectural option
- Replaces an earlier convention with a new one
- Is the kind of decision someone will ask "why?" about six months from now

Don't write an ADR for a typo fix or a refactor that doesn't change semantics. Don't write an ADR for code style — that's `CONTRIBUTING.md`'s job.

## Index

- [ADR-001 — Adoption-driven mesh](001-adoption-driven-mesh.md)
- [ADR-002 — Relay-based architecture instead of P2P first](002-relay-first-not-p2p-first.md)
- [ADR-003 — Tombstone + revival model for delete-and-re-add](003-tombstones-and-revivals.md)
- [ADR-004 — Opportunistic transport upgrade, not P2P-or-relay](004-opportunistic-transport-upgrade.md)
- [ADR-006 — Presentation-layer state stays in the app; deferred typed event log](006-presentation-state-stays-in-the-app.md)
- [ADR-007 — E2EE relay-backed message backup with a user-held recovery key (proposed)](007-e2ee-message-backup.md)
- [ADR-008 — Ciphertext Peek: SDK transparency hook for the relay-visible bytes](008-ciphertext-peek-transparency-hook.md)
