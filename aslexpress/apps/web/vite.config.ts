import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
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
  },
  server: {
    port: 4200,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
