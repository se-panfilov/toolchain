import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/reports/**', '.agents/**', '.claude/**', '.codex/**', '.gemini/**'] },
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'consistent-return': 'error',
      'no-useless-computed-key': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "MethodDefinition[kind='set']", message: 'Use an explicit method instead of a property setter.' },
        { selector: "Property[kind='set']", message: 'Use an explicit method instead of a property setter.' },
        {
          selector:
            "Identifier[name='arguments']:not(MemberExpression[computed=false] > Identifier.property):not(Property[computed=false] > Identifier.key):not(MethodDefinition[computed=false] > Identifier.key):not(TSPropertySignature > Identifier.key)",
          message: 'Use explicit parameters or rest parameters.'
        },
        {
          selector: "CallExpression[arguments.length>2][callee.type='MemberExpression'][callee.object.name='Object'][callee.property.name='assign'][callee.computed=false]",
          message: 'Use at most two Object.assign arguments. Split the changes into explicit steps.'
        },
        {
          selector: "CallExpression[arguments.length>2][callee.type='MemberExpression'][callee.object.name='Object'][callee.property.value='assign'][callee.computed=true]",
          message: 'Use at most two Object.assign arguments. Split the changes into explicit steps.'
        }
      ]
    }
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/naming-convention': ['error', { selector: 'typeAlias', format: ['PascalCase'] }]
    }
  },
  {
    files: ['apps/*/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: fileURLToPath(new URL('..', import.meta.url)) }
    },
    rules: {
      '@typescript-eslint/no-misused-spread': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }]
    }
  },
  {
    files: ['apps/*/src/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // These rules trust static types over runtime values. Keep runtime checks of untrusted input, platform constants, and TTY state.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-useless-default-assignment': 'off'
    }
  },
  {
    files: ['apps/reHistory/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'tx-rehistory', message: 'Use the @reHistory/* application alias.' }],
          patterns: [{ group: ['tx-rehistory/*', './*', '../*'], message: 'Use the @reHistory/* application alias for runtime modules.' }]
        }
      ]
    }
  },
  prettier
]);
