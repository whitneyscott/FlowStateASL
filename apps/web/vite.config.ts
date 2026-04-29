import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const WEB_BUILD_SHA = (
  process.env.RENDER_GIT_COMMIT ??
  process.env.SOURCE_VERSION ??
  process.env.GIT_COMMIT ??
  ''
).trim() || 'unknown';

export default defineConfig({
  define: {
    __MODE_PASSWORD__: JSON.stringify(process.env.MODE_PASSWORD ?? ''),
    __WEB_BUILD_SHA__: JSON.stringify(WEB_BUILD_SHA),
  },
  resolve: {
    alias: {
      '@aslexpress/shared-types': resolve(__dirname, '../../libs/shared-types/src/index.ts'),
    },
  },
  plugins: [react()],
  root: __dirname,
  publicDir: 'public',
  build: {
    outDir: '../../dist/apps/web',
    emptyOutDir: true,
    /** Main bundle is a single app chunk (~650kB minified); silence Rollup’s 500kB default warning. */
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 4200,
    host: '0.0.0.0', // Listen on all interfaces so localhost (IPv4) connects
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
