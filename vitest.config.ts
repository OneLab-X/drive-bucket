import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against workspace sources, not built dist.
const alias = [
  { find: '@drivebucket/core/testing', replacement: fileURLToPath(new URL('./packages/core/src/testing/index.ts', import.meta.url)) },
  { find: /^@drivebucket\/core$/, replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) },
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
          exclude: ['packages/*/test/integration/**'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['packages/*/test/integration/**/*.test.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
