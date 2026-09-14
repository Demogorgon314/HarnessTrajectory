import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Bundle the workspace core package; keep npm dependencies external.
  noExternal: ['@harness-trajectory/core'],
})
