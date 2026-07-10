import eslint from '@eslint/js';
import tseslintPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import stylistic from '@stylistic/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';

const WARN = 'warn';
const ERROR = 'error';

export default [
  // Things ESLint should never look at
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
    ],
  },

  // ESLint's built-in recommended JS rules — covers most of the no-* logic rules
  // (no-cond-assign, no-debugger, no-const-assign, etc.) without listing them manually.
  eslint.configs.recommended,

  // TypeScript files
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslintPlugin,
      '@stylistic': stylistic,
    },
    rules: {
      // Disable JS rules that misbehave on TS — TypeScript itself or @typescript-eslint
      // versions handle these correctly.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-dupe-class-members': 'off',

      // @typescript-eslint replacements
      '@typescript-eslint/no-unused-vars': [WARN, { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Project logic-rule preferences (character-level formatting is Prettier's job, not here)
      'consistent-return': WARN,
      'curly': [ERROR, 'multi-line'],
      'dot-notation': [WARN, { allowKeywords: true }],
      'eqeqeq': [ERROR, 'smart'],
      'no-else-return': WARN,
      'no-unused-expressions': ERROR,
      'no-use-before-define': ERROR,
      'quotes': [ERROR, 'single', { avoidEscape: true }],
      'require-await': WARN,
      'wrap-iife': [WARN, 'any'],
      'yoda': [WARN, 'never'],

      // Statement-level layout — things Prettier intentionally leaves alone.
      // `padding-line-between-statements` enforces blank-line policies between
      // pairs of statement kinds; order matters (last matching rule wins).
      '@stylistic/padding-line-between-statements': [WARN,
        // Blank line BEFORE every return statement
        { blankLine: 'always', prev: '*', next: 'return' },
        // Blank line AFTER any variable declaration block
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        // …but allow consecutive declarations to stack without a blank line between
        { blankLine: 'any',    prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
        // Blank line AFTER import block (no blanks between individual imports)
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any',    prev: 'import', next: 'import' },
        // Blank line between switch cases (clearer scan-down readability)
        // { blankLine: 'always', prev: 'case', next: 'case' },
        // Blank line BEFORE control-flow blocks (if/for/while/switch/try)
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'switch', 'try'] },
      ],
      // Blank line between class members (methods, getters, setters, fields).
      // `exceptAfterSingleLine` lets short single-line field declarations cluster
      // without forced spacing between them.
      '@stylistic/lines-between-class-members': [WARN, 'always', { exceptAfterSingleLine: true }],
      // No more than one consecutive empty line
      '@stylistic/no-multiple-empty-lines': [WARN, { max: 1, maxEOF: 0, maxBOF: 0 }],
    },
  },

  // Prettier compatibility — disables any rules that conflict with Prettier formatting.
  // MUST be last in this array to override everything that came before.
  prettierConfig,
];
