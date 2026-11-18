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
      // `no-explicit-any` — error: долг вычищен (606 срабатываний, волна закрыта),
      // поэтому новый `any` валит `pnpm lint` сразу. Ратчет `--max-warnings <N>`
      // в скрипте `lint` каждого пакета остаётся, но теперь он не про `any`,
      // а про будущие правила: каждое новое предупреждение сверх N валит сборку.
      // Снизили — уменьшаем N.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.*'],
  },
);
