import { defineConfig } from 'vitest/config';
import { version } from './package.json';

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
