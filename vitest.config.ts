import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Much of this suite is integration tests that spawn REAL processes — relay
    // nodes and child-process SDK workers. Running test files in parallel
    // oversubscribes the machine: federation handshakes and address gossip get
    // CPU-starved, hit their timeouts, and then reconnect-backoff compounds the
    // stall. Run files serially (tests within a file already run in order) so
    // the suite is deterministic regardless of host load. Slower, but reliable.
    fileParallelism: false,
  },
});
