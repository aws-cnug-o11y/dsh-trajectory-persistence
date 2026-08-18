import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'lib/**',
      'node_modules/**',
      '.pnpm-store/**',
      'docs/.vitepress/dist/**',
      'docs/.vitepress/cache/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Interface-stub parameters are named with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
)
