# Examples

End-to-end working integrations of the MeshWhisper SDK, intended as copy-paste starting points for your own apps.

| Example | What it shows |
|---|---|
| **[support-bot](support-bot/)** | An AI customer-service agent running as a MeshWhisper peer. Two modes: a no-API-key echo bot (proves the wiring) and an LLM-backed bot (uses Claude, with streaming replies). ~150 lines of code, fully E2E-encrypted, deployable in minutes. |
| **[supervised-chat](supervised-chat/)** | Compliance-readable customer support without breaking E2EE. A three-actor demo (agent + silent supervisor with audit log + customer-side group-creation snippet) showing how to add "the team lead can read every chat" to a MeshWhisper app via standard group membership. Includes a Vite + React + FlexSearch dashboard. |
| **[ticket-lifecycle](ticket-lifecycle/)** | The full pattern: LLM triage front-line → tool-use-driven escalation → audited human handoff. Composes the previous two into the closest thing to a real customer-service product running on MeshWhisper. Four actors (triage-bot + human-agent + supervisor + customer). |
| **[linked-devices](linked-devices/)** | Reference for the Model-3 multi-device protocol (see [docs/multi-device.md](../docs/multi-device.md)). A focused ~200-line browser app: a "secondary" device mints a `DeviceLinkOffer`, the "primary" accepts it, both end up sharing an account afterwards. Demonstrates `createDeviceLinkOffer` / `acceptDeviceLinkOffer` / `onDeviceLinked`. |

The big reference is still **[Prudence](../prudence/)** — a complete PWA covering every SDK feature. Examples in this directory are intentionally minimal: each demonstrates one integration shape in as little code as practical.
