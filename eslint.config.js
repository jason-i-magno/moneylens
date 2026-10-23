import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  { ignores: ['dist'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Core no-unused-vars can't see JSX usage, so PascalCase (components) is ignored.
      // ALL_CAPS constants are still checked.
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z](?![A-Z0-9_]*$)' }],
    },
  },
  {
    files: ['**/*.test.js', 'server/**/*.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
];
