// Vite config for the input sandbox: serves the project root on port 5205 with HMR and file watching disabled, so
// concurrent edits by other agents don't reload the page in the middle of a Playwright run.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  server: { port: 5205, strictPort: true, open: false, hmr: false, watch: { ignored: ['**/*'] } },
  logLevel: 'warn',
});
