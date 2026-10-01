import { defineConfig } from 'vitest/config';

/** QA balance probes (not part of the suite): `npx vitest run --config dev/qa-balance/vitest.config.ts` */
export default defineConfig({
  test: { environment: 'node', include: ['dev/qa-balance/**/*.test.ts'], testTimeout: 7200000, pool: 'forks' },
});
