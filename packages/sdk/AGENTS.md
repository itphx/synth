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
bindings/keys/routes), `sessions` (CRUD + prompt/messages/status + ToDo),
`schedules` (CRUD + run/jobs), `projects` (list/get + план/журнал/инварианты),
`pipelines`, `models`, `fs`, `git`, `llm` (OpenAI-совместимый `chatCompletions`).
Ошибки — `SynthApiError` (`{ status, code, message, body? }`); единый формат
`{ error: { code, message } }`, сетевые сбои → `status: 0` / `NETWORK_ERROR`.

**План/ToDo/журнал/инварианты (PROP-054).** `projects`: `projectPlan` +
мутации плана (пункты: create/update/move/delete; колонки: create/update/delete/
reorder) — все возвращают `{plan}`; `projectLog(id, {limit, offset})` →
`ProjectLogPage` (`{entries, total, offset, limit, next_offset}`), `projectLog*` —
CRUD записей журнала; `projectInvariants`/`putProjectInvariants` →
`{invariants, updated_at}`. `sessions`: `sessionTodos` + create/update/delete/
reorder/clear → `{todos}`. **Формы разные и это не опечатка:** журнал и
инварианты сериализуются в **snake_case**, план приходит **доменной формой**
(camelCase). **Журнала в детали проекта нет** — `projects.get()` отдаёт DTO без
поля `log`; у `SerializedProject` есть индекс-сигнатура `[key: string]: unknown`,
поэтому «удаление» поля из ответа **не ломает компиляцию** — отсутствие `log`
закреплено явным тестом (`src/client.test.ts`).

ADR-118: `sessions.prompt` возвращает типизированный `PromptAcceptedResponse`
(`202 {messageId, mode, position}`) — сырого `Response`/SSE на отправку больше нет
(наблюдение за ходом — по шине событий); `meta()` — публичный (без аутентификации,
заголовок `Authorization` не отправляется) `GET /meta` → `InstanceCapabilities`
(`{messageModel, eventSeq, replay, version}`). DTO сообщения в `SessionMessagesResponse` —
`SerializedMessage` (snake_case, подмножество `serializeMessage`) с полями
`ord`/`turn_id`/`step_index`/`status`.

Отклонение от «типы из shared»: публичный срез сериализованной сессии
(`SerializedSession`, snake_case DTO `serializeSession`) и контракт LLM-прокси
описаны локально (`src/types.ts`) — их нет в shared. Доменные типы событий/
расписаний и входные DTO берутся из shared. Локальные же — транспортные оболочки
PROP-054 (`ProjectLogEntryDto`/`ProjectLogEntryResponse`/`ProjectLogPage`/
`ProjectPlanResponse`/`ProjectPlanMutationResponse`/`ProjectInvariantsResponse`/
`SessionTodosResponse`): в shared лежат доменные формы (`ProjectPlan`, `TodoItem`)
и Zod-схемы тел мутаций, а не формы ответа API.

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest, mock `fetch`).
  `pnpm --filter @itphx/synth-sdk test`.
- Сборка: `pnpm --filter @itphx/synth-sdk build` (`tsc -p tsconfig.build.json`);
  перед этим нужен собранный `@itphx/synth-shared` (типы из `dist`).
- Публикация — вместе с остальными пакетами (`scripts/publish-packages.sh`,
  порядок `… core → sdk → synth`); поле `repository` в `package.json` не
  добавлять (GitVerse → 403, ADR-038).
