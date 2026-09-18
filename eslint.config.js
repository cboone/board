import globals from 'globals';

export default [
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'server/node_modules/**',
      'server/.generated/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      sourceType: 'module',
    },
    rules: {
      'no-console': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
    },
  },
  {
    files: [
      'server/**/*.mjs',
      'scripts/**/*.mjs',
      'tests/composition/**/*.mjs',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
];
