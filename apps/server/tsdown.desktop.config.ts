import { defineConfig } from 'tsdown'

// The desktop bundle must run without node_modules beside the installed app.
// Built-in node:* modules remain provided by the bundled Node runtime.
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: '../../src-tauri/resources/server',
  clean: true,
  noExternal: [/.*/],
})
