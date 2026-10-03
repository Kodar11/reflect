import { defineConfig } from 'vitest/config';

/**
 * Vitest runs against the Node toolchain (same as `src/electron/tsconfig` —
 * `NodeNext` + `.js` import specifiers). The tracker/database/models modules
 * are pure logic with no Electron imports, so they can be tested headless.
 *
 * We exclude `src/electron` (Electron-only) and the build output dirs. Renderer
 * logic is tested through pure view-model modules; `.test.tsx` files render
 * presentational components to static markup (no DOM environment needed).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    globals: false,
  },
});