import { defineConfig } from 'vitest/config';

// Dev-only runner for sim-world visual/benchmark scripts:
//   npx vitest run --config dev/sim-world/vitest.config.ts
export default defineConfig({
  test: { environment: 'node', include: ['dev/sim-world/**/*.dev.ts'], testTimeout: 600000},
});
