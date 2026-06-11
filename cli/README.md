# @meshwhisper/cli

Developer tooling for [MeshWhisper](https://github.com/twotwoonethree/meshwhisper) — the self-hostable, end-to-end encrypted messaging SDK and relay.

```bash
npx @meshwhisper/cli init
```

## Commands

### `init`

Scaffolds a MeshWhisper project in the current directory. Asks for your namespace, where your app should connect (Foundation relay for development, self-hosted for production), and what kind of app you're building. Writes:

- **`meshwhisper-node/`** (self-hosted only) — a complete server deployment: `docker-compose.yml`, standalone Dockerfiles that install the published `@meshwhisper/node` and `@meshwhisper/push-service` packages, a `.env` (mode 600) with generated Web Push VAPID keys, and a `federation-peers.json` bootstrapped against the Foundation relay so your node can join the open relay mesh
- **`src/meshwhisper.ts`** (browser/PWA) or **`meshwhisper-chat.mts`** (Node.js) — a working SDK skeleton with your namespace and node URL threaded in
- **`.gitignore`** entries for the `.env` and local identity stores

Idempotent: existing files are never overwritten.

### `doctor [url]`

Health-checks a MeshWhisper node (defaults to the Foundation relay):

```bash
npx @meshwhisper/cli doctor wss://relay.myapp.com
```

Prints the `/health` snapshot — connected clients, stored blobs, prekey entries, federation status.

### `vapid`

Generates a Web Push VAPID key pair (RFC 8292) with no dependencies — byte-identical output format to `web-push generate-vapid-keys`:

```bash
npx @meshwhisper/cli vapid
```

## Documentation

- [Getting started](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/getting-started.md)
- [Self-hosting guide](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/self-hosting.md)
- [Federation](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/federation.md)

MIT
