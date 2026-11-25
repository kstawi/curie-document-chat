import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
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
