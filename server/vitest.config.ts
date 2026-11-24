import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    // The integration tests share one database, so files run one after another.
    fileParallelism: false,
  },
});
