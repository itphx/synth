# ADR-018: Выбор AI-движка на уровне сессии

> **Статус:** ⚠️ Частично — поле `Session.engine` **удалено из контракта** (намеренное ломающее изменение, коммит `43f3a69c`); реализации выбора движка и адаптеров (Runner) в коде нет — остаётся предложением: [PROP-050](./prop-050-external-engines-runner.md)
> **Источник:** перенесено из AGENTS.md (исторический ADR-018 прототипа уточнён по коду)

**Решение:** движок выбирается на уровне сессии, а не глобально: у сессии есть поле `engine` — выбор AI-движка, исполняющего сессию (`'synth'` — собственный движок, `'opencode'` — `opencode serve`, `'cline'` — `cline headless`); бэкенд/раннер конфигурирует и запускает выбранный движок, используя провайдера/модель из настроек Synth. Внутри модели сессии движок stateless: история хранится в Synth, движку передаётся история + новое сообщение + контекст.

> ⚠️ **Обновлено (2026-10-16).** Поле `Session.engine` в контракте **больше нет** — удалено коммитом `43f3a69c` (намеренно, breaking: поле плумбилось сквозь все слои, но логики по нему не существовало, при этом оно попало в публичный OpenAPI/SDK). Пакет-заглушка `packages/runner` удалён (`3b1b32e6`). Таблица ниже — **историческая запись** на момент фиксации as-built; выбор движка и адаптеры (EngineManager, WS-канал backend↔runner, LLM Proxy) остаются **предложением** — [PROP-050](./prop-050-external-engines-runner.md).

**Контекст:** исторический ADR-018 (`archive/AGENTS_OLD.md`) вводил `Session.engine` и планировал `EngineManager`/`EngineAdapter`. В TS-стеке поле и плумбинг были реализованы (см. таблицу ниже), менеджер/адаптеры движков — нет; затем поле признано мёртвым контрактом и удалено, поэтому решение о выборе движка целиком ушло в PROP-050.

**Реализация (as-built, на момент фиксации — историческая запись, см. «Обновлено» выше):**

| Компонент | Файл | Назначение |
|---|---|---|
| Тип `Session.engine` | `packages/shared/src/types/index.ts` | `engine: 'synth' \| 'opencode' \| 'cline'` (поле удалено) |
| Zod-схема | `packages/shared/src/schemas/index.ts` | `engine` c `.default('synth')` при создании, optional при обновлении (удалено) |
| Создание/обновление | `packages/core/src/server/routes/sessions.ts`, `packages/backend/src/routes/sessions.ts` | `body.engine || 'synth'` при создании, `PATCH` при обновлении (удалено) |
| Персистенция | `packages/core/src/storage/file-store.ts`, `packages/core/src/sessions/manager.ts` | сериализация/десериализация `engine`, дефолт `synth` (удалено) |
| Наследование | `packages/core/src/engine/tools/task.ts` | дочерняя сессия саб-агента получает `engine` родителя (удалено) |
| UI | `packages/ui/src/components/panels/SessionSettingsTab.tsx`, `packages/ui/src/components/admin/SessionsPanel.tsx` | отображение движка сессии (удалено) |
| Порты движков | `packages/shared/src/config/defaults.ts` (`runner.enginePorts`) | `opencode: 4100`, `cline: 4200`, `synth` (конфиг остался, движки не запускаются) |
| Раннер (заготовка) | `packages/runner/src/main.ts` | каркас Gateway/Engine Manager/LLM Proxy; реализация — `TODO`. **Пакет удалён (`3b1b32e6`)** |

**Статус механики:** выбора движка в коде нет — поле `Session.engine` удалено из контракта (`43f3a69c`), пакет `packages/runner` удалён (`3b1b32e6`). Адаптеры opencode/cline и маршрутизация запросов в выбранный движок не реализованы: весь объём (EngineManager, адаптеры, WS-канал backend↔runner, LLM Proxy `:9090`) вынесен в [PROP-050](./prop-050-external-engines-runner.md). Фактическое исполнение сессий идёт собственным движком `synth`.

**Связь:** ADR-017 (движки за собственным API-контрактом), ADR-022 (Runner-архитектура).

## История

- 2026-10-16 — поле `Session.engine` удалено из контракта (`43f3a69c`, breaking), `packages/runner` удалён (`3b1b32e6`); выбор движка и адаптеры вынесены в PROP-050.
