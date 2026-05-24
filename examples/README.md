# Examples

End-to-end working integrations of the MeshWhisper SDK, intended as copy-paste starting points for your own apps.

| Example | What it shows |
|---|---|
| **[support-bot](support-bot/)** | An AI customer-service agent running as a MeshWhisper peer. Two modes: a no-API-key echo bot (proves the wiring) and an LLM-backed bot (uses Claude, with streaming replies). ~150 lines of code, fully E2E-encrypted, deployable in minutes. |
| **[supervised-chat](supervised-chat/)** | Compliance-readable customer support without breaking E2EE. A three-actor demo (agent + silent supervisor with audit log + customer-side group-creation snippet) showing how to add "the team lead can read every chat" to a MeshWhisper app via standard group membership. |

The big reference is still **[Prudence](../prudence/)** — a complete PWA covering every SDK feature. Examples in this directory are intentionally minimal: each demonstrates one integration shape in as little code as practical.
