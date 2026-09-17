# @itphx/synth-shared

> Точечные правила пакета. Слои, инварианты и команды — в корневом [AGENTS.md](../../AGENTS.md);
> конфиг — [AD-023](../../docs/arch_decisions/ad-023-configuration.md), i18n — [AD-041](../../docs/arch_decisions/ad-041-llm-error-taxonomy.md) (здесь не дублируются).

## Граница пакета

`@itphx/synth-shared` — контракты и межупаковочная инфраструктура для всех пакетов,
**без бизнес-логики движка** (сессии, LLM, MCP, permissions — в core).
- Содержит: типы, интерфейсы, Zod-схемы, протоколы, i18n-словарь, конфиг-лоадер и общие утилиты.
- Рантайм здесь только инфраструктурный: `atomicWrite`, `AsyncLock`, `generateId`,
  `pickLocalized` (`src/utils/index.ts`); `loadConfig`/`ensureDataDir` (`src/config/`).
  Бизнес-правила сюда не переезжают.
- Зависимости минимальны и осознанны: `zod`, `js-yaml`; `node:*` — только в
  `src/config/` (см. «Публичная поверхность»).

## Публичная поверхность

Публикуется 9 subpath-export'ами (`package.json`): `.`, `./version`, `./types`,
`./interfaces`, `./schemas`, `./protocols`, `./utils`, `./config`, `./i18n`.
- Новый публичный модуль = subpath-export в `package.json` + (для root-части)
  экспорт из `src/index.ts`; внутренние `src/...` наружу не торчат.
- **Browser-safety**: `./config` тянет `node:fs`/`node:path` — только Node-потребители.
  UI импортирует ровно `.`, `./i18n`, `./version`; брать `./config` в UI нельзя.

## Конфигурация

`src/config/`: `types.ts` (Zod-схема + `SynthConfig`), `defaults.ts`
(`defaultConfig`), `merge.ts` (`deepMerge`), `loader.ts` (`loadConfig`, приоритет
defaults ← yaml ← overrides), `resolve.ts` (env-резолверы, `ensureDataDir`).
- **Добавление поля = `types.ts` + `defaults.ts` + тест** (`defaults.test.ts`).
- Читать только через `@itphx/synth-shared/config` (корневой инвариант 10).

## i18n-контракт

`src/i18n/index.ts` — словарь-контракт без текста: `ENGINE_MESSAGE_KEYS`,
`ENGINE_MESSAGE_PARAMS` (плейсхолдеры), `extractParams`; синхронизируется с core
`engine/system-messages.ts` (en) и ui `lib/i18n/messages/ru.ts` (ru).

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest), сборка — `tsc`.
- После правки публичной поверхности — `pnpm --filter @itphx/synth-shared build`,
  иначе typecheck зависимых пакетов не увидит типы (см. корневой «GitVerse CI»).
