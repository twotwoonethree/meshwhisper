# Contributing to MeshWhisper

## Repository layout

```
src/             SDK source (TypeScript, compiled to dist/)
tests/           Vitest tests
node/            Relay server (@meshwhisper/node)
push-service/    Push notification service (@meshwhisper/push-service)
service-worker/  PWA service worker (@meshwhisper/service-worker)
cli/             Scaffolding CLI (@meshwhisper/cli)
docs/            Documentation
scripts/         Dev utilities
```

## Prerequisites

- Node.js 22+
- npm 10+
- Docker (optional — only needed to test the full container stack)

## Set up

```bash
git clone https://github.com/twotwoonethree/anton.git meshwhisper
cd meshwhisper
npm install
```

## Build the SDK

```bash
npm run build
```

Output goes to `dist/`. The relay and push service each have their own build:

```bash
cd node && npm ci && npm run build
cd push-service && npm ci && npm run build
```

## Run the tests

```bash
npm test
```

The integration tests spin up a real relay process using `tsx` — no external services required. All 5 test files run against an in-memory SQLite database.

To run a single file:

```bash
npx vitest run tests/crypto.test.ts
```

## Type check

```bash
npx tsc --noEmit
```

## Lint

```bash
npx eslint src/
```

## VAPID keys (push service)

If you're working on the push service locally, generate VAPID keys once:

```bash
npx tsx scripts/generate-vapid-keys.ts
```

Copy the output into a `.env` file. Never commit `.env`.

## Run the demo

Start two simulated peers in separate terminals:

```bash
npm run demo:alice   # http://localhost:3001
npm run demo:bob     # http://localhost:3002
```

Open both in a browser to send messages between them.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `test:` tests only
- `refactor:` code change that neither fixes a bug nor adds a feature

## Pull requests

- One logical change per PR
- All tests must pass (`npm test`)
- Type check must be clean (`npx tsc --noEmit`)
- Add or update tests for any changed behaviour
