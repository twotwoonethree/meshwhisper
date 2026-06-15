# ADR-009 — Identity-layer interoperability: decentralized `user@namespace` addressing without DNS

- **Status**: Proposed
- **Date**: 2026-06-14

## Context

[ADR-001](001-adoption-driven-mesh.md) made federation **transport-only** and kept apps **namespace-isolated at the identity layer**: App A's users can't message App B's users, even though both run on MeshWhisper. That keeps each app a clean island and dodges the global-identity governance/spam problem — but it also means every adopter faces the messaging cold-start problem *alone*, and it forfeits the most differentiated thing the protocol could be: **the "email model" for private chat** — any client/app/operator able to message any other, with no walled garden, and (unlike email) end-to-end encrypted throughout.

That interoperability would **invert the network-effects trap**: adopting MeshWhisper would mean your users can reach the *whole* federated network from day one, not just your app's users — the way a new email provider's users can email everyone immediately. It also rides the regulatory tailwind (EU DMA mandating messaging interop) and is the truest expression of the project's anti-lock-in, un-enshittifiable DNA: an open protocol nobody owns can't be bought and ruined.

The obvious way to build it — `user@domain`, resolved via DNS/`.well-known` (the email MX / Matrix pattern) — is **rejected up front**: DNS is a centrally-controlled choke point (registrars, ICANN, court-ordered seizure, registrar coercion). Rooting identity in domains reintroduces exactly the control MeshWhisper exists to remove. The design question is therefore: **how do we get human-usable, ownable, federated addresses without DNS or any central/blockchain naming authority?**

The governing constraint is **Zooko's Triangle**: a name can be at most two of {human-meaningful, globally-unique, decentralized}. DNS sacrifices *decentralized*. Blockchain naming (ENS/Handshake) only relocates the choke point and is heavy/off-brand. To stay decentralized we sacrifice **global-uniqueness of the human name** — via petnames.

## Stage-1 spike — landed & proven (2026-06-15)

A minimal SDK spike demonstrates cross-namespace messaging end-to-end (`tests/cross-namespace.test.ts`): a sender in `com.test.appA` reaches a recipient in `com.test.appB`, E2EE, over a single unmodified relay; a negative-control test confirms isolation still holds by default.

Mechanism, confirmed in code: the relay is **already namespace-blind** (forwards opaque packets by `destHash`) and the identity key is already cross-namespace — so this needed **zero relay changes** and is purely sender-side addressing. Added: a `peerNamespaces` map + `setPeerNamespace(peerId, nsId)` + `destNamespaceFor(peerId)`, used at the DM send sites.

Key finding worth recording: it's not enough to address the *data* message into the recipient's namespace — the **X3DH handshake (`x3dh_init`) must address into it too**, otherwise the recipient never establishes a session and the data can't decrypt (`isForUs` is true but decrypt fails silently). `SessionManager` was changed from a fixed namespace id to a per-peer resolver. X3DH itself is namespace-agnostic (fixed KDF context), so no crypto change was needed.

**Stage-1b — automatic, bidirectional, opt-in (2026-06-15).** Promoted from the manual spike to a real, opt-in capability via a new `interop?: boolean` config flag (default off):

- When **on**, pairing exchanges namespace ids both ways with no manual calls: the contact QR carries a versioned prefix (`0x01` + the generator's namespace id — the original format always starts `0x00`, so it's unambiguous and backward-compatible), and the `x3dh_init` handshake envelope carries the scanner's namespace id (`senderNamespace`), recorded atomically when the session is established (no ordering race). Both sides then address each other automatically.
- When **off** (the default), the QR and handshake bytes are **identical to before**, no namespace is announced or honoured, and the app stays fully isolated (ADR-001). Verified: Prudence (non-interop) pairing is unchanged (QR length identical), same-namespace integration tests green, and a negative-control test confirms a message does not cross without opt-in.

`tests/cross-namespace.test.ts` now proves automatic **bidirectional** A↔B messaging when both opt in, plus default isolation. Remaining: stage-2 federation routing across *different operators* (today: one shared relay), then DNS-free relay location (mesh/DHT).

## Decision (proposed)

Adopt a **self-certifying + petname** addressing model. `anton@prudence` is a human label, locally meaningful and cryptographically anchored — *not* a DNS-resolvable global address.

1. **Namespaces are keypairs, not domains.** A namespace is identified by a public key; the operator signs its directory/membership with it. `@prudence` is shorthand for that key. No registrar, nothing to seize. Username ownership *within* a namespace continues to be governed by the existing `namespace_policy` (sticky usernames / signed-transfer), now anchored to the namespace key.

2. **Petnames over global keys.** The global identifier is the key; each user assigns their own human label locally. This already exists as `prudence/src/contact-names.ts` (local display names per peerId). Names are per-user and un-seizable; there is deliberately **no global registry of human names**.

3. **Self-describing invites.** The QR/link already embeds peerId + prekey bundle (`generateContactQR`). Extend it to also carry the namespace key + a relay coordinate, so the common "add someone" path needs **zero global lookup** — full coordinates are exchanged out-of-band (QR, link, NFC, paper).

4. **Discovery via the trust graph, not a directory.** Introductions (`introduceContacts`, already in the SDK) let people be found *through people they already trust*. Cross-namespace messaging is enabled by lifting the identity-layer isolation for *known* keys — the relay already forwards opaque packets by `destHash` and is namespace-blind at the packet layer; the identity key is already cross-namespace.

5. **No central or blockchain naming authority, ever.** Authority comes from keys and each user's own trust graph.

### Explicit non-goal
**Cold-messaging a stranger by typing a global human handle, with no prior key exchange, is out of scope** — it is the forbidden corner of Zooko's Triangle (human + global + decentralized) and is only achievable by reintroducing a central (DNS) or blockchain directory. MeshWhisper supports reaching anyone you've exchanged an invite/introduction with; it does not promise stranger-by-handle discovery. This is the deliberate trade: **un-seizable, registrar-free identity in exchange for stranger discovery.**

## The hard part: locating a relay without DNS

Today relay endpoints are `wss://` URLs — i.e., DNS. Truly DNS-free routing must locate an operator's relay **by key**, not name. Options, in increasing ambition:

- **Endpoint-in-invite (now):** the self-describing invite carries a relay coordinate; works without any lookup for invited contacts. (A raw IP is fragile/semi-central; acceptable as a bootstrap.)
- **Bootstrap + federation gossip (near):** you know some relays (the Foundation relay is already a published bootstrap peer; relays already hold federation keys); they federate and route packets to the holder of a `destHash`.
- **DHT / mesh rendezvous (aspirational):** publish/locate relays by key over a Kademlia-style overlay — the Tor/IPFS pattern, and the "mesh" the project always aspired to. This is the genuinely hard infrastructure and the residual centralization to design out.

## Alternatives considered

1. **DNS / `.well-known` (`user@domain`).** The email/Matrix pattern — human + global, easy discovery. **Rejected:** DNS is a central, seizable choke point; it contradicts the project's reason to exist.
2. **Blockchain naming (ENS, Handshake, Namecoin).** Human + global + "decentralized-ish." **Rejected:** relocates rather than removes the choke point, adds a chain dependency + fees + governance, and is heavy and off-brand for a one-container, low-burn project.
3. **Raw self-certifying keys as the only address (no human layer).** Maximally decentralized + secure. **Rejected as the *sole* UX:** keys aren't memorable; petnames layer human meaning on top without sacrificing decentralization.
4. **Keep ADR-001 isolation (do nothing).** Simplest, avoids spam/governance. **Rejected for this track** because it forfeits the interop that inverts network effects — though it remains valid if MeshWhisper stays "private SDK islands" rather than "one open fabric." This ADR is the deliberate fork.

## Consequences

- **Reframes the project** from ADR-001's namespace-isolated islands toward an interoperable fabric — a strategic fork, not a feature. Both bets are coherent; this one chooses interop.
- **Builds mostly on existing primitives**: petnames (`contact-names.ts`), self-describing QR (`generateContactQR`), introductions (`introduceContacts`), per-namespace ownership (`namespace_policy`), namespace-blind packet relays + cross-namespace identity keys, federation v1, the bootstrap relay.
- **Abuse/governance** ride the modules email never had: sybil resistance, reciprocity, permissions, rate limiting, per-namespace policy, federation allow/blocklists. Open interop is a spam vector; these are the boundary.
- **Honest limitation**: no stranger-by-handle discovery without reintroducing a directory; relay-location is the residual DNS dependency to engineer out (mesh/DHT).
- **Staged rollout**: (1) cross-namespace messaging between two *cooperating* namespaces using petnames + self-describing invites (no new infra); (2) bootstrap/federation-gossip relay location; (3) DHT/mesh rendezvous for fully nameless, registrar-free routing at scale.

See also: [ADR-001](001-adoption-driven-mesh.md) (the isolation this forks from), [ADR-002](002-relay-first-not-p2p-first.md), `docs/federation.md`, and `docs/messenger-gap-analysis.md`.
