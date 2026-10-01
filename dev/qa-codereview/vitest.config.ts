import { defineConfig } from 'vitest/config';

/** QA code-review repros: `npx vitest run --config dev/qa-codereview/vitest.config.ts` */
export default defineConfig({
  test: {
    environment: 'node', include: ['dev/qa-codereview/**/*.test.ts'], testTimeout: 600000,
    fsModuleCache: true, fsModuleCachePath: 'dev/qa-codereview/.cache',
  },
});
