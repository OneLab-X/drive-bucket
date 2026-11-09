import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'testing/index': 'src/testing/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
});
