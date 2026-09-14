import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: 'packages/core',
          include: ['tests/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'ui',
          root: 'packages/ui',
          include: ['tests/**/*.spec.{ts,tsx}'],
          environment: 'jsdom',
          css: { modules: { classNameStrategy: 'non-scoped' } },
        },
      },
      {
        test: {
          name: 'server',
          root: 'apps/server',
          include: ['tests/**/*.spec.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
