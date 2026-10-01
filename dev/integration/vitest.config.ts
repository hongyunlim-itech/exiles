import { defineConfig } from 'vitest/config';

/** Dev-only integration probes: `npx vitest run --config dev/integration/vitest.config.ts` */
export default defineConfig({
  test: { environment: 'node', include: ['dev/integration/**/*.test.ts'], testTimeout: 1200000 },
});
