import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: Object.fromEntries(
      ['core', 'dom', 'react'].map((name) => [
        `@shortcutkit/${name}`,
        path.resolve(root, `node_modules/@shortcutkit/${name}/src/index.ts`),
      ]),
    ),
    dedupe: ['react', 'react-dom', '@shortcutkit/core', '@shortcutkit/dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
