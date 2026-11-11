import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 构建产物由 panel/server.mjs 在 /ui/ 下静态托管；开发时把 /api 代理到后端
export default defineConfig({
  base: '/ui/',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3120', changeOrigin: false }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2020',
    chunkSizeWarningLimit: 900
  }
});
