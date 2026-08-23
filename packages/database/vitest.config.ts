import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites share one local PostgreSQL database and truncate shared tables in their
    // setup hooks, so test files must not run concurrently.
    fileParallelism: false,
  },
});
