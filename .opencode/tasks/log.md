# Журнал задач оркестратора

> Архив: `log.1.md` (по 2026-08-31), `log.2.md` (2026-08-31 — 2026-09-16).

## 2026-09-17 — docs(ad): перенос реализованных AD + проекты AD-046/068/069 (скиллы, реестр, AGENTS.md)
- **Задача:** «Проработать продуктовые идеи (скиллы, память, self-help, worktrees, шедулер, API, CLI/TUI, kanban, инстанс↔инстанс, MCP наружу) и зафиксировать; актуализировать Obsidian-роадмап. Затем детально проработать AD-046 (скиллы и slash-команды), выделить реестр как AD-068, разобрать автозагрузку AGENTS.md и `/init` как AD-069».
- **Тип:** docs / design (ADR)
- **Исполнитель:** @orchestrator → @researcher (explore ×3, general ×1) / @fixer (×6)
- **Результат:** PASS
- **Что сделано:**
  - **Порядок в AD:** перенесены в `docs/arch_decisions/` AD-005, 008, 009, 014, 017, 018 (⚠️ частично — только плумбинг, `packages/runner/src/main.ts` — заглушка), 019, 026 (оказался реализован); AD-027 → `legacy/` (⛔ deprecated, AD-039); AD-032 переформулирован как миграция физического хранилища JSON→PostgreSQL (логическая модель уже в JSON).
  - `AD-DRAFTS.md` (вне git, корень проекта `/mnt/data/Agent/dev/Synth/`): **24 черновика D1–D24 = AD-046…AD-069**; решения по памяти (Gbrain `github.com/garrytan/gbrain` — целевое портирование на TS, первый шаг внешним модулем через MCP, RAG покрывает память + код/доки, каталог индексов local→server как в t11), AD-031 влит в D13 (консилиум).
  - **AD-046** «Скиллы и slash-команды» (524 стр.): формат `SKILL.md` (совместимость Anthropic/opencode/Claude + namespace `metadata.synth.*`), scope instance/project, project-trust гейт, progressive disclosure (каталог → core-тул `skill` / `/name`), binding `agents`/`groups` (по умолчанию все), **capability-aware с делегированием через `task`**, bundles, inline shell default off, права per-skill (AD-029), события `skill.invoked`/`command.invoked`, `skill-creator`.
  - **AD-068** «Реестр и каталог скиллов и агентов» (512 стр.): свой репозиторий с категориями + agent-packs, JSON-индекс с TTL/stale-fallback, адаптеры источников, trust-уровни `builtin→verified→trusted→community→agent-created` + install-policy, сканер, `lock.json`/audit/quarantine, подписи/checksums, health-floors + watchdog. Внешние каталоги **не включены по умолчанию** (вендорские предлагаются явно); ClawHub исключён (инцидент ClawHavoc).
  - **AD-069** «Проектные инструкции (AGENTS.md) и `/init`» (603 стр.): три тира контекста, discovery `AGENTS.override.md` > `AGENTS.md` (+ read-only `CLAUDE.md`), **merged chain git root→cwd**, **lazy-догрузка вложенных в tool result**, обрезка head/tail, threat-scan через AD-036, install-tree guard, `/init` (промпт по мотивам opencode `initialize.txt`) и скилл `agents-md`.
  - **Референсы:** прототип t11 (хардкод `/help`, `/add_repo`, `/review`, `/commands`); `~/dev/opencode` (`session/instruction.ts`, `command/template/initialize.txt`, skill/skill/discovery/tool); `~/dev/hermes-agent` (`skills_hub.py`, `skills_guard.py`, `init_command.py`, `subdirectory_hints.py`, 82 bundled + 117 optional скиллов); `~/dev/openchamber` (`curated-sources.js` — 4 источника, ClawdHub удалён); `archive/synth-frontend` (готовый UI-слой skills/commands, бэкенда нет).
  - **Roadmap.md** (Obsidian) актуализирован: 2026-09-17; D1→AD-046, D23→AD-068, D24→AD-069; помечено реализованное, убран шум.
- **Проверки (оркестратор):** относительные ссылки — 112, битых 0; конфликтов нумерации AD нет; код не менялся (typecheck/lint/test не применимы).
- **Коммит:** `bb83f5d` (docs, 14 files, +2030/−83). `AD-DRAFTS.md` и `Roadmap.md` — вне git-репозитория `synth/`, не коммитятся.
- **Замечания:** реализация ни одного из новых AD не начата. Открытые вопросы зафиксированы внутри AD (приоритет `config.instructions` относительно merged chain; формат `AGENT.md`/agent-pack; `verified` vs `trusted`; `allowed-tools` — advisory или deny). Неймспейс команд trust разведён: механизм — `synth skills trust-project`, реестр — `synth skills trust <source> --level`.

## 2026-09-18 — реорганизация корневого AGENTS.md (1221→378) и вынос AD-030/031/032/037
- **Задача:** «AGENTS.md нереально большой, есть ошибки (строки 691–695). Нужно ли держать все AD в постоянном доступе? Ссылки на отдельные файлы работали плохо. Помогает ли файл агенту?» Решения: агрессивно ~300 строк; черновики AD — в отдельные файлы; вложенные пакетные AGENTS.md — отдельной задачей; «Инварианты» — ядро нового файла.
- **Тип:** docs / refactor (инструкции агента)
- **Исполнитель:** @orchestrator → @fixer ×4
- **Результат:** PASS
- **Что сделано:**
  - **AD-030/031/032/037** вынесены из AGENTS.md в собственные файлы (`ad-030-hooks-agent-events.md` 76, `ad-031-verification-agent.md` 87, `ad-032-history-storage-postgresql.md` 83, `ad-037-commit-security-step.md` 137) со статусом ⏳ и разделом «Статус реализации в коде» (проверено grep'ом: кода нет ни по одному). Убран дубль AD-037 внутри `ad-036-llm-gateway.md` (91 строка → ссылка).
  - **Корневой AGENTS.md переписан:** 1221 → **378 строк**, 83.8 → 35.6 КБ (−58%). Введён раздел **«Инварианты (не нарушать)»** (14 пунктов) как замена чтению AD; индекс AD сжат до таблицы (34 строки, без прозы); добавлена таблица **«Куда смотреть (триггеры)»** (24 темы «трогаешь → читай AD/docs/скилл»).
  - Исправлены ошибки: сироты `### Модель Runner` (→ строка AD-022) и `### Отказ от JSON-блока` (→ AD-039 + инвариант 11), дубль раздела «Роутинг задач по агентам», мёртвые ссылки `plan.md`/`SPEC.md`/`rbac-design.md` (в репо `synth/` их нет).
  - Вынесено по адресам: гибрид (131 стр.) → `docs/HYBRID.md` + AD-042/043/045 + скилл `synth-hybrid`; K3s (37) → скилл; публикация/npm-2026/Docker/Helm (102) → `docs/PUBLISHING.md` + скиллы; GitVerse MCP (35) → скилл; цикл (107 → 30). **Грабли GitVerse CI и порядок сборки оставлены в файле** (дорого забывать).
  - Восстановлены два потерянных факта: dev-провайдеры `itphx`/`ollama` → раздел в `docs/LLM_PROVIDERS.md`; учётки Keycloak и `secrets/keycloak-accounts.md` → раздел 5 в `docs/KEYCLOAK.md`.
- **Проверки (оркестратор):** битых ссылок нет (AGENTS.md, README, ad-036, KEYCLOAK, LLM_PROVIDERS); `### AD-0XX`-прозы в AGENTS.md — 0; дублей заголовков — 0; debug-ключи 4/4, порты 7/7, инварианты 14; `micro-benchmark.mjs` — уже в `docs/DEVELOPMENT.md`/AD-035.
- **Коммиты:** `97bc068` (вынос AD), `78d26b8` (сжатие AGENTS.md + 2 docs), этот коммит (журнал).
- **Замечания:** `packages/core/AGENTS.md` (405) и `packages/backend/AGENTS.md` (599) тоже раздуты и дублируют docs — решено править отдельной задачей. Открыт вопрос: заводить ли AGENTS.md остальным пакетам (shared/ui/runner/synth).

## 2026-09-18 — пакетные AGENTS.md, docs/API_V2.md, правило актуализации инструкций
- **Задача:** «Предложи правки AGENTS.md в packages. И не следует ли добавить такие файлы во все пакеты?» Решения: делать по одному пакету с проверкой; вынести API-спеку в `docs/API_V2.md`; добавить файлы `ui` и `shared`, `runner`/`synth` не трогать. Дополнительно: убрать из документации историю/легаси, зафиксировать правило актуализации AGENTS.md и оформить его скиллом.
- **Тип:** docs / refactor (инструкции агента)
- **Исполнитель:** @orchestrator → @explore ×2 / @fixer ×11
- **Результат:** PASS
- **Что сделано:**
  - **Аудит:** `core`/`backend` AGENTS.md на 70–80% дублировали корень/`docs/` или противоречили коду; у `ui` (261 файл / ~53 500 строк) файла не было; `runner`/`synth` — тонкие, файл не нужен.
  - **Файлы:** `backend` 599 → 146; `core` 405 → 151; созданы `ui` (120) и `shared` (44). Удалены фантомы: `RunnerRegistry`, `WS /ws/chat`, `SessionEventBus`, `requireUser`/`verifyApiKey`, `bin/cli.ts`, `engine/tsm.ts`, `InMemoryQueue`/`RemoteStore`/`RemoteQueue`, env `LOCAL_API_KEY` и др.
  - **`docs/API_V2.md`** (новый, 469): единый справочник API по коду — 25 групп, ~162 эндпоинта, RBAC, ошибки, транспорт, пометки `backend`/`core`/`оба`. В `backend/AGENTS.md` — карта, правила и ссылка; AD-017 переведён на справочник. Удалены раздел «Чего в API нет» и сравнения со старой спекой; пойман и убран фантомный `details`.
  - **Корень:** поправлена схема слоёв (`shared` — контракты + межупаковочная инфраструктура), обновлён список пакетов с `AGENTS.md`, добавлены ссылки на `docs/API_V2.md` в документации и триггерах; убраны строка AD-027 и заметка про `legacy/` и архив.
  - **Правило + скилл:** инвариант 15 и стадия 5 (Document) — держать `AGENTS.md` в актуальном состоянии, правки согласовывать с пользователем; создан скилл `.opencode/skills/synth-agents-md/SKILL.md` (48 строк); имя согласовано в AD-069 (`agents-md` → `synth-agents-md`).
  - **Ротация журнала:** записи 2026-08-31 … 2026-09-16 вынесены в `log.2.md`; в `log.md` осталось начиная с проработки роадмапа (2026-09-17).
- **Проверки (оркестратор):** фантомов нет, битых ссылок нет, дублей заголовков нет, размеры в целевых диапазонах. Постоянный контекст инструкций: было 2225 строк (root 1221 + core 405 + backend 599), стало 840 (root 379 + core 151 + backend 146 + ui 120 + shared 44) — −62%.
- **Коммиты:** см. коммиты сессии (docs).
- **Замечания:** реализация AD-046/AD-068/AD-069 не начата; открытый вопрос — приоритет `config.instructions` относительно merged chain.

## 2026-09-19 — AD-070: SystemPromptComposer, prompt-cache, статистика, прозрачность — проектирование и реализация (Ф1–Ф4)
- **Задача:** «Спроектировать и реализовать AD-070: консистентность системного промпта, prompt-cache (Anthropic/OpenAI), нормализованная статистика usage и прозрачность состава промпта».
- **Тип:** feature / refactor
- **Исполнитель:** @orchestrator → @researcher/@explore (исследование и сверка с прототипом hermes/t11) / @fixer (реализация и проверки Ф1–Ф4)
- **Результат:** PASS
- **Что сделано:**
  - **Ф1 — Composer, тиры, идемпотентность:** `SystemPromptComposer` (`engine/context/composer.ts`) + тиры `stable`/`context`/`volatile` (`prompt-blocks.ts`), идемпотентная пересборка из состояния. Режим/план/todo вынесены из system в durable chronological state-сообщения (`state-messages.ts`, обёртка `<system-state>` в LLM, скрыты в UI); политика режимов — блок `mode.policy`; `_filterToolsByMode` удалён — тулы постоянны по режиму и роли, ограничения через `unavailable(mode|role)` (`permission/availability.ts`) и security-промпты `tool-unavailable-*`; единый system prompt у саб-агентов.
  - **Ф2 — CachePolicy и promptState:** `SystemPromptPayload` (text/stablePrefix/cacheKey/cachePolicy) в провайдерах; Anthropic `cache_control` (≤4, tools→system→messages, два system-breakpoint'а); OpenAI/Remote `prompt_cache_key`; `promptStates`/`promptMeta` per-agent (`prompt-state.ts`), предсказание/валидация hit.
  - **Ф3 — Usage/статистика:** нормализация usage (`providers/usage.ts`), `stream_options.include_usage`, `prompt_tokens_details.cached_tokens`, cache read/write cost, `cacheHitRate` в сессии/API/UI.
  - **Ф4 — Прозрачность/debug:** `manifest()` + `PromptManifest`, `GET /api/v2/sessions/:id/prompt`, UI-секция «Состав промпта», `captureSystemPromptParts` оживлён через per-message `debugCollector`.
- **Проверки:** `pnpm typecheck` — 6/6 пакетов; `pnpm lint` — 0 errors; тесты: shared 73, core 1372, ui 169, backend 246. E2E на провайдере routerai (`qwen/qwen3.7-flash`): 43 тула в `act` и `plan`, `cacheReadTokens` 0 → 7469, `cacheHitRate` 0.499, `promptMeta.expected`/`validated` отрабатывают.
- **Ветка:** `feat/ad-070-system-prompt-composer`
- **Коммит:** нет (по правилу «коммит только по просьбе пользователя»).
- **Замечания:** реализация AD-069 отложена; открытые вопросы AD-070 зафиксированы в самом AD (раздел 7); dev-инстанс запущен через `./scripts/dev.sh`.

## 2026-09-19 — Баг: Anthropic-провайдер вырезал tool_result — модель перестала отвечать после вызова инструмента
- **Задача:** «Сессия "Столица Франции" после `web_search` перестала отвечать — пустой ответ, все последующие запросы тоже пустые».
- **Тип:** bug fix
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Симптом:** сессия «Столица Франции» (`mu7zvcuu-5-9hec30be`, провайдер `routerai-anthropic`): после `web_search` следующий ответ пустой («model response was empty»), все последующие запросы в сессии тоже пустые.
- **Root cause:** `packages/core/src/providers/anthropic.ts`, `_formatMessages`: множество `seenToolUseIds` наполнялось id'ами `assistant.tool_use`, из-за чего ветка `role: 'tool'` считала `tool_result` уже выданным и пропускала его. Anthropic получал `assistant(tool_use)` без `tool_result` → `invalid_request_error` («Can only get item pairs from a mapping»). Дополнительно: RouterAI отдаёт эту ошибку как HTTP 200 с телом-ошибкой; провайдер её не распознавал, возвращал пустой контент, а оркестратор подставлял `session.empty_response` — реальная ошибка маскировалась. Баг pre-existing (есть в HEAD, не из AD-070).
- **Fix:** отдельное множество `emittedToolResultIds` (дедуп только фактически выданных `tool_result`); склейка подряд идущих `tool_result` в один user-блок (требование Anthropic); парсинг `function.arguments` (JSON-строка → объект) для `tool_use.input`; распознавание error-body при HTTP 200 в `chat`/`chatAsync` и проброс `ProviderError` (AD-041) вместо пустого ответа.
- **Проверки:** unit — anthropic 13 passed; openai/remote/ollama (assistant tool_use + tool result, несколько tool_result, arguments строкой/объектом). Полный `pnpm test` — shared 73 / core 1388 / ui 169 / backend 246; `pnpm typecheck` 6/6; `pnpm lint` 0 errors. E2E `dev.sh all` на `routerai` (OpenAI-тип, `mu89i1be-5-frf0brxk`) и `routerai-anthropic` (`mu89iq2q-17-uw02kann`): multi-step цепочки `assistant(toolCalls) → tool → tool → assistant`; в теле Anthropic-запроса `assistant(tool_use,tool_use) → user(tool_result,tool_result)`, `input` — объект; исходная сессия снова отвечает «Париж».
- **Файлы:** `packages/core/src/providers/anthropic.ts`, `packages/core/src/providers/anthropic.test.ts` (new), `openai.test.ts`, `remote.test.ts`, `ollama.test.ts`.
- **Ветка:** `feat/ad-070-system-prompt-composer`
- **Коммит:** нет (по правилу «коммит только по просьбе пользователя»).
