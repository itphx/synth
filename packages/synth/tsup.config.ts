import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  dts: false,
  external: [
    'commander',
    'hono',
    '@hono/node-server',
    'ws',
    'zod',
    'node:*',
    '@synth/core',
    '@synth/shared',
    '@synth/ui',
  ],
  platform: 'node',
  banner: {
    js: '#!/usr/bin/env node',
  },
});
