import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['test/**/*.mjs', 'scripts/**/*.mjs'], languageOptions: { globals: { process: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly', Response: 'readonly', structuredClone: 'readonly' } } },
);
