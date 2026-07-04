// Shared ESLint flat config for the consulting-web monorepo.
// Encodes ADR boundary rules (hexagonal layering) via eslint-plugin-boundaries.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';

/**
 * Base config consumed by every package/app via `extends`.
 * Layer boundary rules (ADR-0005/0006/0010) are opt-in per package
 * by adding boundaries element settings; see `layered` export below.
 */
export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.js', '*.config.ts', 'coverage/**'],
  },
);

/**
 * Hexagonal layer boundaries for apps/api (ADR-0010, design §5).
 * domain/application must NOT import adapters/http/db/bullmq/nestjs directly.
 */
export const apiBoundaries = {
  plugins: { boundaries },
  settings: {
    'boundaries/elements': [
      { type: 'domain', pattern: 'src/**/domain/**' },
      { type: 'application', pattern: 'src/**/application/**' },
      { type: 'adapter', pattern: 'src/**/adapters/**' },
      { type: 'infra', pattern: 'src/**/infra/**' },
      { type: 'http', pattern: 'src/**/*.controller.ts' },
    ],
  },
  rules: {
    'boundaries/element-types': [
      'error',
      {
        default: 'allow',
        rules: [
          {
            from: 'domain',
            disallow: ['adapter', 'infra', 'http'],
            message: 'domain layer must not import ${dependency.type} (ADR-0010).',
          },
          {
            from: 'application',
            disallow: ['adapter', 'http'],
            message: 'application layer must not import ${dependency.type} directly (use ports).',
          },
        ],
      },
    ],
  },
};

export default base;
