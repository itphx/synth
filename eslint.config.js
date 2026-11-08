import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        // `_`-префикс — канон проекта для намеренно неиспользуемых значений;
        // rest-сиблинг нужен, чтобы «выкинуть поле» деструктуризацией
        // (`const { name: _name, ...rest } = data`).
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      // `no-explicit-any` остаётся warning осознанно (аудит 0.13.4, F10):
      // 650+ существующих мест — отдельная волна. «Предупреждения не растут»
      // держит ратчет: `--max-warnings <N>` в скрипте `lint` каждого пакета
      // (N = фактическое число на момент ввода). Новый `as any` или любое
      // другое предупреждение сверх N валит `pnpm lint`. Снизили — уменьшаем N.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.*'],
  },
);
