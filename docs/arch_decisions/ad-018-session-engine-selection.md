# AD-018: Выбор AI-движка на уровне сессии

> **Статус:** ✅ Реализовано (поле/плумбинг); ⏳ механика движков — в работе
> **Источник:** перенесено из AGENTS.md (исторический AD-018 прототипа уточнён по коду)

**Решение:** у сессии есть поле `engine` — выбор AI-движка, исполняющего сессию: `'synth'` (собственный движок), `'opencode'` (`opencode serve`), `'cline'` (`cline headless`). Движок выбирается на уровне сессии, а не глобально; бэкенд/раннер конфигурирует и запускает выбранный движок, используя провайдера/модель из настроек Synth. Внутри модели сессии движок stateless: история хранится в Synth, движку передаётся история + новое сообщение + контекст.

**Контекст:** исторический AD-018 (`archive/AGENTS_OLD.md`) вводил `Session.engine` и планировал `EngineManager`/`EngineAdapter`. В текущем TS-стеке поле и плумбинг реализованы полностью, а менеджер/адаптеры движков ещё не реализованы (см. статус ниже) — это честная фиксация as-built.

**Реализация (as-built):**

| Компонент | Файл | Назначение |
|---|---|---|
| Тип `Session.engine` | `packages/shared/src/types/index.ts` | `engine: 'synth' \| 'opencode' \| 'cline'` |
| Zod-схема | `packages/shared/src/schemas/index.ts` | `engine` c `.default('synth')` при создании, optional при обновлении |
| Создание/обновление | `packages/core/src/server/routes/sessions.ts`, `packages/backend/src/routes/sessions.ts` | `body.engine || 'synth'` при создании, `PATCH` при обновлении |
| Персистенция | `packages/core/src/storage/file-store.ts`, `packages/core/src/sessions/manager.ts` | сериализация/десериализация `engine`, дефолт `synth` |
| Наследование | `packages/core/src/engine/tools/task.ts` | дочерняя сессия саб-агента получает `engine` родителя |
| UI | `packages/ui/src/components/panels/SessionSettingsTab.tsx`, `packages/ui/src/components/admin/SessionsPanel.tsx` | отображение движка сессии |
| Порты движков | `packages/shared/src/config/defaults.ts` (`runner.enginePorts`) | `opencode: 4100`, `cline: 4200`, `synth` |
| Раннер (заготовка) | `packages/runner/src/main.ts` | каркас Gateway/Engine Manager/LLM Proxy; реализация — `TODO` |

**Статус механики:** `packages/runner/src/main.ts` пока печатает конфигурацию и содержит `TODO: реализация раннера — Gateway, Engine Manager, LLM Proxy`. Адаптеры opencode/cline и маршрутизация запросов в выбранный движок — запланированы, но не реализованы. Выбор `engine` на данный момент персистится и виден в UI, влияет на наследование в саб-агентах, но фактическое исполнение идёт собственным движком `synth`.

**Связь:** AD-017 (движки за собственным API-контрактом), AD-022 (Runner-архитектура).
