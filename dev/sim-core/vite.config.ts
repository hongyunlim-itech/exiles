// Dev-only config for sim-core browser checks: no HMR / file watching (other agents edit files concurrently).
import { defineConfig } from 'vite';

export default defineConfig({
  root: process.cwd(),
  base: './',
  server: { port: 5188, strictPort: true, hmr: false, watch: null },
});
