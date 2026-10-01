import { defineConfig } from 'vitest/config';

/** Dev-only probes for sim-ext: `npx vitest run --config dev/sim-ext/vitest.config.ts` */
export default defineConfig({
  test: { environment: 'node', include: ['dev/sim-ext/**/*.test.ts'], testTimeout: 600000 },
});
