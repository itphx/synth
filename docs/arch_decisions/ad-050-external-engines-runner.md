# AD-050: Управление внешними движками (opencode/cline) — Runner

> **Статус:** ⏳ Не реализовано (проект)
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D5, идея 5 + [AD-018](./ad-018-session-engine-selection.md),
> [AD-022](./ad-022-typescript-stack-runner.md), `docs/ARCHITECTURE.md`).
> **Связано:** [AD-018](./ad-018-session-engine-selection.md), [AD-022](./ad-022-typescript-stack-runner.md),
> [AD-024](./ad-024-eventhub-transport.md), [AD-029](./ad-029-granular-permissions.md),
> [AD-036](./ad-036-llm-gateway.md), [AD-057](./ad-057-loop-engine.md).

**Решение:** реализовать **Runner** — слой управления внешними агентными движками:

- `EngineManager` + адаптеры движков: **OpenCode** по HTTP (`opencode serve`), **Cline** по stdin/stdout
  (`--auto --json`);
- WS-канал backend ↔ runner для управления и событий;
- **LLM Proxy** `:9090/v1` (OpenAI-совместимый) — чтобы трафик движка шёл через Synth для guard/аудита;
- маршрутизация по полю `Session.engine`;
- UI-селектор движка.

Модель **«движок stateless»** ([AD-022](./ad-022-typescript-stack-runner.md), инвариант №4 корневого
`AGENTS.md`): история и состояние — на бэкенде; движок получает историю + новое сообщение + контекст.

## Контекст

### Что уже есть

- Поле `Session.engine` (`'synth' | 'opencode' | 'cline'`) и плумбинг выбора — есть:
  `packages/shared/src/types/index.ts`, `packages/shared/src/schemas/index.ts`.
- Конфиг раннера: `runner.enginePorts` (opencode=4100, cline=4200) и `runner.proxyPort` (=9090) —
  `packages/shared/src/config/types.ts` / `defaults.ts`.
- LLM Proxy частично реализован на backend: OpenAI-совместимый `POST /api/v2/llm/chat/completions`
  (`packages/backend/src/routes/llm.ts`).
- `packages/runner/src/main.ts` — **заглушка** (37 строк, `// TODO: реализация раннера`); адаптеров движков нет.

### Проблема

Выбор движка заявлен на уровне сессии (AD-018), но фактически исполняется только встроенный движок Synth.
Внешние движки (opencode/cline) не запускаются, не управляются и не маршрутизируются. Это блокирует
Loop Engine (D12/AD-057), где шаг цикла может исполняться внешним движком, и мешает сценариям, которые уже
используют внешние агентные движки (в частности, системы семейства **synth-media** опираются именно на
управление внешним движком для генерации/сборки материалов).

## Детали

### EngineManager и адаптеры

- Единый интерфейс адаптера движка: старт/стоп, отправка истории + сообщения + контекста, стриминг событий,
  отмена, статус.
- **OpenCode**: `opencode serve` + HTTP-взаимодействие (либо ACP — открытый вопрос).
- **Cline**: headless по stdin/stdout (`--auto --json`) — точный протокол уточнить по версии.

### Транспорт и маршрутизация

- WS-контрольный канал backend ↔ runner (не плодить новых каналов в UI — там остаётся EventHub,
  [AD-024](./ad-024-eventhub-transport.md)).
- Роутинг по `Session.engine`; движок stateless, сессия/история — на бэкенде.

### LLM Proxy

- `:9090/v1` OpenAI-совместимый; движок обращается к нему как к LLM-провайдеру, а Synth применяет
  guard/обфускацию/rate limit/аудит ([AD-036](./ad-036-llm-gateway.md)).
- Не смешивать с backend-роутом `/api/v2/llm/chat/completions`: уточнить, один это прокси или два контура
  (внутренний backend-прокси vs runner-прокси для движков).

### Permissions и UI

- Permissions движка — через permission-слой ([AD-029](./ad-029-granular-permissions.md)), не хардкодом.
- UI-селектор движка в настройках сессии; индикация активного движка.

## Статус реализации в коде

**Не реализовано (заглушка).**

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- `packages/runner/src/main.ts` — 37 строк, содержит только `console.log` и комментарий
  `// TODO: реализация раннера — Gateway, Engine Manager, LLM Proxy`. Адаптеров нет.
- `Session.engine` (`'synth' | 'opencode' | 'cline'`) — есть в `shared` (типы + zod-схема).
- Порты движков и `proxyPort` (9090) — есть в конфиге раннера (`shared/config`).
- OpenAI-совместимый прокси существует на backend (`packages/backend/src/routes/llm.ts`,
  `POST /api/v2/llm/chat/completions`); отдельного runner-прокси `:9090/v1` нет.
- Тестов на `packages/runner` — нет.

> В черновике упомянуто, что LLM Proxy «заявлен» на раннере; фактически OpenAI-совместимый прокси
> реализован на **backend**, а `runner.proxyPort` остаётся конфигом.

## Открытые вопросы

- OpenCode — REST `opencode serve` или ACP?
- Cline headless — точный протокол stdin/stdout (проверить версию)?
- Как вписывается stateless-модель в стриминг ответов?
- Один прокси или два (backend-прокси гибрида vs runner-прокси для движков)?

## Связи

- [AD-018](./ad-018-session-engine-selection.md) «Выбор AI-движка на уровне сессии» — закрывает отложенные адаптеры.
- [AD-022](./ad-022-typescript-stack-runner.md) «Runner-архитектура» — движки stateless, мост к движкам.
- [AD-024](./ad-024-eventhub-transport.md) «EventHub + TransportClient» — транспорт событий.
- [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions» — права внутри движка.
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — аудит трафика движка через прокси.
- [AD-057](./ad-057-loop-engine.md) «Loop Engine» — исполнение шага цикла через Runner.
- Смежные: D15/AD-060 (Contour Bridge — на базе Runner), D28/AD-086 (плагины/points расширения).
