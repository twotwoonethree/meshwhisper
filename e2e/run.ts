// Entry point for running e2e tests against a fresh local stack.
//
// Usage:
//   npx tsx e2e/run.ts e2e/03-reload-during-conversation.ts
//   npx tsx e2e/run.ts e2e/03-reload-during-conversation.ts e2e/04-offline-then-back.ts
//
// Spins up a local relay + Prudence dev server, then runs each test
// script in sequence with PRUDENCE_URL pointing at the local stack.
// Tears the stack down on exit, even on failure.

import { spawn } from 'node:child_process';
import { startLocalStack } from './local-stack.js';

async function runScript(script: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', script], {
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const scripts = process.argv.slice(2);
  if (scripts.length === 0) {
    console.error('Usage: npx tsx e2e/run.ts <script.ts> [<script2.ts> ...]');
    process.exit(2);
  }

  console.log('==> Starting local stack...');
  const stack = await startLocalStack();
  console.log(`==> Stack ready: relay=${stack.relayWsUrl}  prudence=${stack.prudenceUrl}`);

  let failed = false;
  try {
    for (const script of scripts) {
      console.log(`\n==> Running ${script}`);
      const code = await runScript(script, {
        ...process.env,
        PRUDENCE_URL: stack.prudenceUrl,
      });
      if (code !== 0) {
        console.error(`==> ${script} FAILED (exit ${code})`);
        failed = true;
      } else {
        console.log(`==> ${script} OK`);
      }
    }
  } finally {
    console.log('\n==> Tearing down stack...');
    await stack.stop();
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
