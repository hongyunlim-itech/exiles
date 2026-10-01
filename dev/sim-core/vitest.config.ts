import { defineConfig } from 'vitest/config';

/** sim-core probes (not part of the suite): `npx vitest run --config dev/sim-core/vitest.config.ts --maxWorkers=1` */
export default defineConfig({
  test: { environment: 'node', include: ['dev/sim-core/**/*.test.ts'], testTimeout: 3600000 },
});
