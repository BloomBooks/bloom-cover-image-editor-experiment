import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const usePolling = env.VITE_USE_POLLING === '1' || env.VITE_USE_POLLING === 'true';
  const pollingInterval = Number(env.VITE_POLLING_INTERVAL ?? 100);

  return {
    // Set base path for GitHub Pages deployment
    base: '/bloom-cover-image-editor-experiment/',
    plugins: [react()],
    server: {
      port: 5176,
      strictPort: true, // Fail if port is in use, don't auto-pick another
      open: true,
      watch: usePolling ? { usePolling: true, interval: pollingInterval } : undefined,
    },
  };
});
