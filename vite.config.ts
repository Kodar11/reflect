import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite'


// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: 'dist-react',
    rollupOptions: {
      // index.html is the app; widget.html is the floating widget — a small
      // page of its own, so the always-on widget never loads the app bundle.
      input: { main: 'index.html', widget: 'widget.html' },
    },
  },
  server: {
    port: 5123,
    strictPort: true,
  },
} as any);
