import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss()],
  envDir: false,
  envPrefix: [],
  define: {
    'import.meta.env.VITE_BOARD_MODE': JSON.stringify('fixture'),
  },
  build: {
    manifest: true,
  },
  server: {
    host: '127.0.0.1',
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      'tests/browser/**',
      'server/**',
      'tests/composition/**',
    ],
  },
});
