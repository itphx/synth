# ADR-038: Монорепо как набор публикуемых npm-пакетов

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

**Решение:** каждый пакет монорепозитория публикуется в npm независимо и владеет
своими ассетами через поле `files`. Потребитель ставит только `@itphx/synth`, а
зависимости (`@itphx/synth-core`, `@itphx/synth-ui`, `@itphx/synth-shared`) доставляются как
транзитивные npm-зависимости. Никакого дублирования файлов и бандла core внутрь CLI.

**Контекст:** исторически `@itphx/synth` собирался как самодостаточный пакет —
скрипт сборки через `cp -r` копировал в него промпты, собранный UI, docs и README
из соседних пакетов, а `cli.js` бандлил core через `noExternal`. Это порождало
несколько источников истины: одни и те же файлы (промпты, UI-ассеты, документация)
существовали и в `packages/core`, и в `packages/ui`, и в `packages/synth`. Любая
правка промпта требовала пересборки и перекопирования, а рассинхронизация копий
давала трудноуловимые баги. Кроме того, бандл core внутрь `cli.js` раздувал пакет
и ломал дерево зависимостей для npm-потребителей.

**Решение:**

```
@itphx/synth-shared  ←  только контракты (types/schemas/protocols/config)
       ↑
@itphx/synth-core    ←  владеет prompts/, dictionaries/, definitions/ (files)
       ↑
┌──────┴──────┐
@itphx/synth-backend │ @itphx/synth-ui   ←  core и ui владеют своими ассетами
       ↑
@itphx/synth   ←  тонкая обёртка: dependencies = core + ui + shared
                  bin: synth → dist/cli.js (external: core/ui/shared)
```

**Принципы:**
- **Каждый пакет владеет своими ассетами.** Ассеты перечислены в поле `files`
  (`dist`, `prompts`, `dictionaries` и т.д.) и доставляются через npm.
- **`@itphx/synth` — тонкая обёртка.** В `dependencies` — только `@itphx/synth-core`,
  `@itphx/synth-ui`, `@itphx/synth-shared` (и runtime-библиотеки). Сборка tsup помечает
  `@itphx/*` как `external` — core **не** бандлится в `cli.js`.
- **Никакого копирования ассетов.** `cp -r prompts`, `cp -r ui/dist`, копирование
  README/docs при сборке synth — удалены. В репозитории больше нет идентичных файлов.
- **Резолвинг из node_modules.** `@itphx/synth-core` находит свои промпты по
  `{packageRoot}/prompts` (поиск package.json вверх от `import.meta.url`, fallback
  на `dist/prompts` для Docker). `@itphx/synth` резолвит собранный UI через
  `require.resolve('@itphx/synth-ui/package.json')` → `dist/`.
- **Docker из npm-публикации.** Образ ставит `npm install -g @itphx/synth@<version>`,
  зависимости резолвятся npm-ом — не из workspace-сборки.

**Порядок публикации** (строгая иерархия зависимостей):

```
shared → core → ui → backend → sdk → synth
```

**`pnpm publish` вместо `npm publish`:** `npm publish` не переписывает
`workspace:*` в зависимостях — опубликованные пакеты падают у npm-потребителей
(не резолвится `workspace:*`). `pnpm publish` автоматически заменяет
`workspace:*` на фактические версии workspace-пакетов, поэтому используется именно
он (с флагом `--no-git-checks`, т.к. публикация идёт не из чистого git-дерева).

**Реестры:**
- npmjs.org: `https://registry.npmjs.org` (токен `NPM_TOKEN`)
- GitVerse: `https://gitverse.ru/api/packages/itphx/npm/` (токен `GV_TOKEN`)

**Что не делаем:**
- Не публикуем workspace-сборку как единый артефакт — только npm-пакеты
- Не копируем ассеты между пакетами при сборке
- Не используем `noExternal`-бандл core/ui/shared в `@itphx/synth`

## Обновлено (2026-10-21)

Пакетов в монорепо стало **8** — добавлен `@itphx/synth-executor` (`packages/executor`),
исполнитель агентских команд ([ADR-077](./adr-077-runtime-toolchain.md)):

- **Форма поставки — по образцу драйвера хранилища**
  ([ADR-097](./adr-097-storage-provider-class.md)): отдельный in-tree пакет с
  `dependencies` — `@itphx/synth-shared` (`workspace:*`), `peerDependencies` —
  `@itphx/synth-core` (`workspace:*`), `files: ["dist"]`; core подключает его
  **динамическим `import()`** по `execution.mode === 'remote'` и **fail-closed** при
  недоступности пакета.
- **Причина** — исполнитель выступает внешним «бэкендом» **порта исполнения**
  ([ADR-077](./adr-077-runtime-toolchain.md)): одна семантика команд в control plane
  и в worker'е, отдельный release-цикл, чистое разделение секретов между control plane
  и исполнителем. По форме это ровно тот же класс, что драйвер БД у слоя хранения.
- **Порядок публикации** дополнен: `shared → core → executor → ui → backend → sdk → synth`.
  Цикл `core ↔ @itphx/synth-executor` намеренный — `ignoreWorkspaceCycles: true` в
  `pnpm-workspace.yaml:14` (как у `@itphx/synth-storage-postgres`).

Тело ADR не меняется: решение «каждый пакет монорепо публикуется в npm независимо»
остаётся в силе — расширен только состав пакетов.

## История

- 2026-10-21 — добавлен восьмой пакет — `@itphx/synth-executor` (исполнитель, ADR-077): форма поставки по образцу драйвера хранилища (ADR-097), подключение динамическим `import()` по `execution.mode=remote` (fail-closed), порядок сборки `shared → core → executor → …`.
