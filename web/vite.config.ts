import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // Every asset as a file of its own: the page's security policy allows nothing inline, data: URIs included.
    assetsInlineLimit: 0,
  },
  // In development the API runs on the host; nginx does this job in the built app.
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
});
