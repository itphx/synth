# @itphx/synth-sdk

> Точечные правила пакета. Общие инварианты, команды и стиль — в корневом
> [AGENTS.md](../../AGENTS.md); публичный контракт и ADR-052 — в
> [ADR-052](../../docs/arch_decisions/adr-052-public-api-platform.md).

## Роль и границы

`@itphx/synth-sdk` — **публикуемый** типизированный клиент **публичного** API
Synth (ADR-052, этап III, часть 2). Тонкий пакет по образцу `synth`.

- Зависит только от `@itphx/synth-shared` — **не** тянет core/backend/ui;
  HTTP-контракт описан в `packages/core/src/server/openapi/public-openapi.ts`
  (источник спеки), SDK его не дублирует логикой.
- **Runtime-agnostic**: глобальный `fetch` (инъекция — `options.fetch`),
  ESM-only, никаких `node:*` импортов на верхнем уровне → браузер-совместим.
- Типы — только browser-safe subpath'ы shared (`./types`, `./schemas`);
  `@itphx/synth-shared/config` (Node-only) не тянуть.

## Состав клиента

`SynthClient` / `createSynthClient(options)`; auth-заголовок
`Authorization: Bearer <cred>` с приоритетом **serviceKey → apiKey → token**,
базовый путь по умолчанию `/api/v2`. Namespaces: `events` (ingest/journal/
bindings/keys/routes), `sessions` (CRUD + prompt/messages/status), `schedules`
(CRUD + run/jobs), `llm` (OpenAI-совместимый `chatCompletions`). Ошибки —
`SynthApiError` (`{ status, code, message, body? }`); единый формат
`{ error: { code, message } }`, сетевые сбои → `status: 0` / `NETWORK_ERROR`.

Отклонение от «типы из shared»: публичный срез сериализованной сессии
(`SerializedSession`, snake_case DTO `serializeSession`) и контракт LLM-прокси
описаны локально (`src/types.ts`) — их нет в shared. Доменные типы событий/
расписаний и входные DTO берутся из shared.

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest, mock `fetch`).
  `pnpm --filter @itphx/synth-sdk test`.
- Сборка: `pnpm --filter @itphx/synth-sdk build` (`tsc -p tsconfig.build.json`);
  перед этим нужен собранный `@itphx/synth-shared` (типы из `dist`).
- Публикация — вместе с остальными пакетами (`scripts/publish-packages.sh`,
  порядок `… core → sdk → synth`); поле `repository` в `package.json` не
  добавлять (GitVerse → 403, ADR-038).
