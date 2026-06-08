# Security policy

MeshWhisper is cryptographic messaging infrastructure: a flaw can cost users the privacy guarantee they relied on. This document describes how to report security issues, what's in scope, and what response you can expect.

## Reporting a vulnerability

**Please report security issues privately, not in public GitHub issues.** Use one of:

1. **GitHub Security Advisory** (preferred) — open a private advisory at <https://github.com/twotwoonethree/meshwhisper/security/advisories/new>. This gives us an encrypted channel and a structured workflow.
2. **Email** — `anton@gestureloop.com`. Plain email is acceptable for low-sensitivity reports. For high-sensitivity material, request a PGP key in your initial message and we'll provide one before exchanging details.

Please include:

- A description of the issue, ideally with concrete impact (what an attacker can do).
- Steps to reproduce, code, or proof-of-concept where possible. PoCs help us triage; they're not required.
- The affected component and version: SDK (`@meshwhisper/sdk` version), relay (`meshwhisper-node` commit or version), or both.
- Whether you've shared this with anyone else, and any planned disclosure timeline on your side.

We do not currently run a bug bounty programme, but we acknowledge confirmed reporters publicly (with permission) in the [Acknowledgments](#acknowledgments) section below.

## What you can expect from us

MeshWhisper is currently maintained as a single-maintainer project. Response timelines reflect that honestly:

- **Acknowledgment within 7 days** of receipt.
- **Initial triage** (in scope? severity?) **within 14 days**.
- **Fix timeline** depends on severity:
  - *Critical* (active exploitation, full content compromise, key recovery): goal is a fixed release within 7 days of triage.
  - *High* (auth bypass, significant metadata leak, DoS that takes down a typical operator): within 30 days.
  - *Medium / low*: rolled into normal release cadence; we'll give you an estimate after triage.
- **Coordinated disclosure**: we prefer to publish the advisory together once a fix is shipped and adopters have had reasonable time to upgrade. 90 days from initial report is a sensible default. If you have a fixed disclosure date, tell us and we'll work to that.

If you don't hear back within 7 days, please re-send. Mail can be lost. We'd rather receive a duplicate than miss a report.

## Scope

### In scope

- **The MeshWhisper SDK** (`src/`): everything that affects message confidentiality, integrity, authenticity, or the documented metadata privacy properties. Specifically: X3DH / PQXDH key exchange, Double Ratchet, identity persistence, group sender-key handling, archive encryption, namespace isolation, signed-transfer username handover, device-announcement signing, the linked-devices QR pairing flow.
- **The MeshWhisper Node** (`node/src/`): authentication on directory / OPK / archive endpoints, namespace policy enforcement, prekey directory integrity, push notification handling, signed-transfer verification.
- **Federation protocol** (specified in [`docs/federation.md`](docs/federation.md)): handshake authentication, loop prevention, frame parsing, threat-model conformance. Implementation is forthcoming; spec-level issues are in scope today.
- **Reference codebases** (`prudence/`, `examples/`) where a bug could mislead an adopter into building an insecure pattern.

### Out of scope

- **The protocol's documented limitations.** The [whitepaper](docs/whitepaper.md), [federation spec](docs/federation.md), and [direction.md](docs/direction.md) are explicit about MeshWhisper's threat model and what it does NOT defend against. Examples that are NOT vulnerabilities: privacy degradation at low mesh density (a documented property), the plaintext `flags` byte at packet offset 1 (acknowledged v1 limitation pending wire-format revision), traffic-timing correlation by a global passive observer (acknowledged), two colluding operators seeing both ends of a conversation between their users (acknowledged).
- **Scaffolded modules that aren't load-bearing**: `src/routing/`, `src/sybil/`, `src/reciprocity/`, `src/compliance/`, the `introduction` / `transactional` / `custom` permission models. These are not claimed as production-grade and are documented as such in [`docs/codebase-overview.md`](docs/codebase-overview.md). Issues here are accepted as feedback but won't be treated as security incidents.
- **Third-party dependencies.** Report to upstream first; we'll coordinate updates once a patch is available.
- **Applications built on top of MeshWhisper.** Apps integrate the SDK; their own auth, storage, and UX choices are their responsibility. A report along the lines of "Prudence's contact-name display can be confused by a unicode bidi attack" is in scope (Prudence is a reference); the same issue in a third-party app built on MeshWhisper is between you and that app's maintainer.
- **Theoretical attacks** requiring resources well beyond a state-level adversary (e.g. breaks of Ed25519 or AES-GCM, quantum capabilities not yet reduced to practice). Report them anyway; we may not treat them as urgent.
- **Operational issues at the Foundation relay** (`relay.meshwhisper.org`) that don't stem from a protocol or implementation flaw — that's operator responsibility, not a security issue.

If you're unsure whether something is in scope, **err on the side of reporting**. We'd rather close a report as out-of-scope than miss a real issue.

## Threat model summary

A full statement of MeshWhisper's threat model lives in the [whitepaper](docs/whitepaper.md), particularly the "What it is not" and "Privacy that strengthens with scale" sections. The federation-specific threat model lives in [`docs/federation.md`](docs/federation.md). One-paragraph summary for reporters:

> MeshWhisper provides end-to-end encryption between devices (PQXDH-extended X3DH + Double Ratchet) such that no relay node — including the Foundation relay, self-hosted relays, and federated forwarding nodes — can read message content. Relays see opaque packets routed by rotating destination hashes (`BLAKE3(namespace_id || peer_key || epoch_hour)`). The relay can observe its directly-connected devices' source IPs, traffic timing, and (where push is enabled) push tokens. At low mesh density, traffic correlation by a single relay operator is the dominant metadata risk; chaff partially obscures it. As more operators federate, no single party sees the full path of any conversation. The protocol does NOT defend against compromise of an endpoint device, collusion between both endpoints' home relays, or a global passive network observer; the whitepaper is explicit about these limits.

A vulnerability is something that breaks a property the protocol claims to provide. The documented limitations are not vulnerabilities.

## Coordinated disclosure

For reported issues that we accept and fix:

1. We confirm receipt and triage.
2. We work with you on a fix. You're welcome (but not required) to review the patch.
3. We agree a disclosure date. The default is 90 days from initial report, or as soon as the fix is shipped and a reasonable upgrade window has passed — whichever is sooner. We'll move faster on critical issues.
4. On disclosure, we publish a GitHub Security Advisory with a CVE where appropriate, credit you (with permission), and update the changelog.
5. Adopters running pinned versions or self-hosted nodes get notified via the repo's "Watch → Security alerts" mechanism; there's no mailing list yet.

If a fix isn't possible within a reasonable window (architectural change required, etc.), we will say so honestly and discuss mitigations and disclosure timing case by case.

## Cryptographic primitives

For context, MeshWhisper relies on:

- **X25519** for ECDH (key exchange).
- **Ed25519** for signatures (identity, signed-transfer, device announcements, federation handshake).
- **ML-KEM-768** for post-quantum key encapsulation (PQXDH layer over X3DH).
- **BLAKE3** for destination-hash derivation, packet IDs, sybil-related commitments.
- **AES-GCM (256)** for ratchet AEAD and archive encryption.
- **HKDF-SHA-256** for key derivation throughout.
- **PBKDF2-HMAC-SHA-256** for password-derived identity (Prudence and other Pattern-1 apps).

Underlying implementations come from `@noble/curves`, `@noble/ciphers`, `@noble/hashes`, `@noble/post-quantum`. Issues in those libraries should be reported upstream; we'll track and coordinate updates.

## Acknowledgments

A public acknowledgment for reporters of confirmed issues, listed with permission. This section is currently empty — it'll grow as the project does.

<!--
Format:
- YYYY-MM-DD — Name (affiliation, optional link) — short description of issue, severity, fixed in commit/version
-->

---

This policy is itself a living document. If you find it incomplete or misleading, an issue or PR against this file is welcome.
