import { defineConfig } from 'vitest/config';

/**
 * Vitest runs against the Node toolchain (same as `src/electron/tsconfig` —
 * `NodeNext` + `.js` import specifiers). The tracker/database/models modules
 * are pure logic with no Electron imports, so they can be tested headless.
 *
 * We exclude `src/electron` (Electron-only), `src/ui` (renderer, tested via
 * e2e), and the build output dirs.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});