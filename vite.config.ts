import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 600000 },
});
