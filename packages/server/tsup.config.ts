import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node20',
  },
  {
    entry: ['src/bin.ts'],
    format: ['esm'],
    sourcemap: true,
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
