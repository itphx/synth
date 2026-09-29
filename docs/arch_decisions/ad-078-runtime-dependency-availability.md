# AD-078: Авто-отключение инструментов при отсутствии внешней зависимости

> **Статус:** ✅ Реализовано (2026-09-29, ветка `feat/ad-075-workspace-provisioning`)
> **Источник:** согласовано 2026-09-29 (следствие эксплуатационных ограничений AD-077)
> **Реализация:** 2026-09-29; поведение — в разделе «Реализация».

**Решение:** часть встроенных инструментов работает только через внешние программы (`git`, `rg`, `sh`). Если программы в окружении нет, тул **не удаляется** из реестра (набор дефинишенов постоянен, AD-070 §2.9.1), а помечается недоступным с причиной `dependency`: слой доступности сообщает об этом модели и UI, вызов блокируется локальным `deny` с пояснением «установите программу».

## Контекст

- Встроенные тулы исполняются в процессе core/backend и используют внешние бинарники: git-тулы — `git`, `grep_files` — `rg`, `execute_shell` — `sh` (`packages/core/src/engine/tools/{git,search,shell}.ts`).
- В **managed**-развёртывании (K8s-образ на `node:22-alpine`) этих программ может не быть; их доставка — предмет AD-077 (⏳ не реализовано).
- До AD-078 отсутствие бинарника проявлялось сырой ошибкой запуска (`ENOENT`) уже во время исполнения: модель не знала о причине и повторяла вызов, а тул формально числился доступным.
- Ось доступности (AD-070 §2.9.1) уже разделяла причины `mode` и `role`, открывающиеся сменой режима/делегированием. Не хватало третьей причины — окружения.

## Решение

### Детекция окружения

- Новый листовой модуль `packages/core/src/engine/tools/runtime-deps.ts` — не импортирует permission/evaluator (иначе цикл), только `node:child_process`.
- `detectRuntimeDeps()` параллельно пробует `bin --version` (таймаут 3 c) для `git`/`rg`/`sh`. `ENOENT` → `false` (нет бинарника); **любая прочая ошибка** (таймаут, ненулевой код, `EACCES`) → `true` — **fail-open**, тул из-за неоднозначной ошибки не блокируется.
- Промис детекции кэшируется на уровне модуля (один пробинг на процесс); `resetRuntimeDepsCache()` — для тестов.
- Дефолт `ALL_RUNTIME_DEPS_AVAILABLE` (`{ git: true, rg: true, sh: true }`); `undefined` тоже трактуется как «всё доступно».

### Карта зависимостей и ось доступности

- `TOOL_RUNTIME_DEP` сопоставляет тулы внешней программе: `grep_files → rg`, `execute_shell → sh`, все `git_* → git` (файловые/plan/todo/web/task/skill в карте отсутствуют).
- `RUNTIME_DEP_BINARY` — человекочитаемые имена (`git`, `rg (ripgrep)`, `sh`) для текстов модели/UI.
- Слой доступности (`engine/permission/availability.ts`) получает `runtimeDeps` и возвращает `{ available: false, reason: 'dependency' }`; порядок причин — `role → mode → dependency`.
- `PermissionEvaluator` на эту причину возвращает `deny` с `unavailable: { reason: 'dependency' }`, `messageId: 'tool-unavailable-dependency'` и `params: { binary }` — тул виден модели (набор постоянен), но вызвать его нельзя.

### Сообщения модели и UI

- State-сообщение `[НЕДОСТУПНЫЕ ТУЛЫ]` (`engine/context/state-messages.ts`) для `dependency` добавляет текст «не установлена программа …» + подсказку установить/обратиться к администратору.
- `SystemPromptComposer` (`engine/context/composer.ts`) при непустом списке отсутствующих добавляет строку в `tools.guide` **даже в режиме `consistency`** (как и admin-отключения).
- Security-промпты (на отказ в вызове): `packages/core/prompts/security/tool-unavailable-dependency.{ru,en}.md`.
- i18n-ключи (контракт AD-041): `tool.binary_missing` (`{tool}`, `{binary}`), `permission.dep_unavailable` (`{binary}`) — `shared/i18n` + core `engine/system-messages.ts` (en) + ui `messages/ru.ts` (ru).

### Проброс и обновление

- `ChatOrchestrator.runtimeDeps` (опция конструктора) + `setRuntimeDeps()` — live-обновление.
- Детекция при старте: core `server/app.ts` и `server/chat.ts`, backend `src/app.ts` (`runtimeDeps: await detectRuntimeDeps()`), до сборки оркестратора — первый же запрос видит корректную доступность.
- Экспорт из core: `detectRuntimeDeps`, `probeBinary`, `isRuntimeDepAvailable`, `ALL_RUNTIME_DEPS_AVAILABLE`, `RUNTIME_DEP_BINARY`, `TOOL_RUNTIME_DEP`, типы `RuntimeDeps`/`RuntimeDependency` (`src/index.ts`).

## Реализация

| Слой | Файл |
|---|---|
| Детекция | `packages/core/src/engine/tools/runtime-deps.ts` |
| Доступность/решение | `packages/core/src/engine/permission/{availability,evaluator}.ts`; `packages/shared/src/types/permission.ts` (`PermissionDecision.unavailable`), `types/index.ts` (`PromptToolDetail.reason`) |
| Промпт/сообщения | `packages/core/src/engine/context/{state-messages,composer}.ts`; `packages/core/prompts/security/tool-unavailable-dependency.{ru,en}.md` |
| Оркестратор/серверы | `packages/core/src/engine/orchestrator.ts`; `packages/core/src/server/{app,chat}.ts`; `packages/backend/src/app.ts` |
| i18n | `packages/shared/src/i18n/index.ts`; `packages/core/src/engine/system-messages.ts`; `packages/ui/src/lib/i18n/messages/ru.ts` |
| Защитный fallback | `packages/core/src/engine/tools/{git,shell}.ts` (`ENOENT` → `tool.binary_missing`) |

Защитные `ENOENT`-ветки в `git.ts`/`shell.ts` оставлены на случай, когда детекция не сработала (fail-open), а бинарника фактически нет. `grep_files` при отсутствии `rg` сохраняет собственную локализованную ошибку `search.rg_not_installed`.

## Последствия

- Модель получает явную причину недоступности и не зацикливается на повторных вызовах; UI показывает локализованное пояснение.
- `setRuntimeDeps` позволяет применить результат перепроверки без рестарта (детекция — разовая при старте).
- Список дефинишенов постоянен — стабильны промпт-кэш (AD-070), индекс тулов и UI-рендер.

## Ограничения

- Детектируются только три программы (`git`/`rg`/`sh`); остальные внешние зависимости (например, `python` для stdio-MCP) не покрыты.
- Проверка `--version` приблизительна: нестандартный бинарник, отвечающий на `--version` нулевым кодом, считается доступным.
- **Доставка** бинарников в managed-окружение (tools-образ + volume) AD-078 не решает — это AD-077; JS-fallback для `grep_files` там же.
- Признак `sh` не отражает доступность иных shell'ов; экзотические окружения без `sh` (но с аналогом) получат `dependency` ложно.

## Связи

- [AD-070](./ad-070-system-prompt-composer.md) §2.9.1 — ось доступности тулов (`mode`/`role`), сюда добавлена причина `dependency`.
- [AD-077](./ad-077-runtime-toolchain.md) — инструментальное окружение исполнения: доставка `git`/`rg`/`python` (не переписывается; AD-078 — реакция на их отсутствие).
- [AD-029](./ad-029-granular-permissions.md) — гранулярные permissions (`deny`/`ask`/`allow`), над которыми надстроен `unavailable`.
- [AD-041](./ad-041-llm-error-taxonomy.md) — контракт локализации строк движка (`shared/i18n`).
