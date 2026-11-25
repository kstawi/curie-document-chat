import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  // Type-aware rules for the server: an unawaited promise there is a lost error or a job that silently never ran.
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  // The web app runs in the browser; the same type-aware promise rules, and React's rules for hooks.
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  // Only the parser's extraction code may load the PDF library; it runs in its own container and process.
  {
    files: ['server/**/*.ts'],
    ignores: ['server/src/pdf/extract.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pdfjs-dist', 'pdfjs-dist/*'],
              message: 'Only src/pdf/extract.ts reads PDFs.',
            },
          ],
        },
      ],
    },
  },
  // A migration describes the schema as it was when written, not the app's current types (Kysely's own advice).
  {
    files: ['server/src/migrations/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
