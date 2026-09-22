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

## 2026-09-19 — AD-070: прозрачность промпта — tools и слой истории, профиль пользователя, UI-статистика
- **Задача:** «Доработать AD-070: показать в статистике реальный состав промпта (слой инструментов и слой истории), починить попадание профиля пользователя в промпт и привести UI-статистику к единому виду».
- **Тип:** feature / fix
- **Исполнитель:** @orchestrator → @fixer ×4
- **Результат:** PASS
- **Что сделано:**
  - **Профиль пользователя (fix):** `session.userId` хранит username, а профиль ключуется по id-UUID — `_getProfilePrompt` и интервью не находили профиль. Добавлен фолбэк `loadProfile(userId) ?? getProfileByUsername(userId)` (`_resolveProfile`), `profilesStore` проброшен в standalone `ContextBuilder` (`server/app.ts`, `server/chat.ts`); интервью теперь тоже запускается по username-профилю.
  - **Манифест — слой `tools`:** запись `tools` (tier `stable`, `source: 'tools'`, `provenance: 'tools'`), `chars` = `JSON.stringify` реально отправляемых инструментов; учтена в `totalChars`/`estTokens`/`staticPrefixChars`, в текст `compose()` не входит. System-блоки идут в реальном порядке (`role` — первой), `tools` добавлен отдельным слоем в конец списка.
  - **Слой истории:** `GET /api/v2/sessions/:id/prompt` отдаёт `history: PromptHistoryInfo` — суммарные отправляемые сообщения (count/chars/estTokens), сгруппированные chronological state-сообщения (`mode_change`/`agent_switch`/`plan_updated`/`todos_updated`), исключённые (`disabled`/`hidden`/`info`), вложения (не-text части) и число плейсхолдеров секретов `⟦SYNTH_SECRET_N⟧`. Вычисляется зеркально `_sessionMessagesToLlm`. Request-параметры (model/temperature/maxTokens) в состав промпта не включаются — осознанно.
  - **UI:** в «Составе промпта» — строка «Описание инструментов» (`tools`) и секция «История» (раскрывающаяся таблица state-сообщений по типам + исключённые/вложения/секреты). Статистика: иконки/цвета/имена (агент — `resolveColor`, пользователь — `userColor`), колонки «Кэш»/«%», убраны «Скорость»/«Длительность» у агентов, единый поповер статистики, центрирование иконок.
- **Проверки:** `pnpm typecheck` — 6/6 пакетов; `pnpm lint` — 0 errors; тесты: shared 73 / ui 220 / core 1407 / backend 248; E2E — профиль в промпте (83 chars, notes «Зови меня Босс»), `tools` 19126 в `stable`, строки таблиц статистики корректны.
- **Ветка:** `feat/ad-070-system-prompt-composer`
- **Коммит:** нет (по правилу «коммит только по просьбе пользователя»).
- **Замечания:** открытые вопросы AD-070 зафиксированы в §7 самого AD; реализация AD-069 по-прежнему отложена.

## 2026-09-19 — Проверка и фикс сбора статистики/дебага при отмене и сбое стрима
- **Задача:** «Проверить и починить сбор статистики/дебага при отмене стрима и сбое провайдера (assistant-сообщение, usage, duration, cost, debug, агрегаты сессии, `stream.cancelled`/`stream.done`)».
- **Тип:** bug fix + verification
- **Исполнитель:** @orchestrator → @tester ×2, @fixer ×3
- **Результат:** PASS
- **Что сделано:**
  - **(1) сбой провайдера:** assistant-сообщение не сохранялось — терялись `status='error'`, usage, duration, cost и debug. Теперь при сбое сохраняется сообщение с `metadata.status='error'` и полной статистикой, без дублей.
  - **(2) отмена:** терялись `model`/`cost_usd` — модель бралась только из финального чанка. Введена fallback-цепочка `chunkModel || finalModel || provider.model || session.settings.model`.
  - **(3) `stream.cancelled`:** событие шло без usage/duration/cost. Теперь несёт usage, duration_ms и cost_usd.
  - **(4) отмена при usage=0 (OpenAI):** добавлена best-effort оценка (`_estimateUsage`, `chars/4`), проставляется `metadata.usage_estimated=true`, в UI стоимость/токены с префиксом `~`.
- **Проверки:** `pnpm typecheck` — 6/6 пакетов; `pnpm lint` — 0 errors; тесты: shared 73 / ui 239 / core 1421 / backend 249. E2E на трёх типах провайдеров (openai `routerai`, anthropic `routerai-anthropic`, ollama `omn`): abort — assistant-сообщение со status/usage(est)/duration/cost/debug и ненулевыми агрегатами, `stream.cancelled` с usage/duration/cost; сбой (недоступный URL + mocktimeout) — `status='error'`, без дублей; tool-chain без сирот; сессия пригодна после отмены.
- **Замечания:** `reasoning_tokens` на отмене = 0 (не оценивается); LOW-фикс cost при неизвестных ценах; `metadata.subagents` при task не покрыт.
- **Ветка:** `feat/ad-070-system-prompt-composer`
- **Коммит:** нет (по правилу «коммит только по просьбе пользователя»).

## 2026-09-19 — Оперативное (live) обновление стоимости и счётчиков в статистике
- **Задача:** «Обновлять стоимость и счётчики в панели статистики оперативно, как в opencode» (сравнение с `~/dev/opencode` / `~/dev/openchamber`).
- **Тип:** feature + bug fix + verification
- **Исполнитель:** @orchestrator → @researcher, @fixer ×6, @tester ×4
- **Результат:** PASS
- **Что выяснено (эталон):** в opencode usage приходит только на `step-finish`/`finish` (не per-token); TUI обновляет `session.cost` по шагу (`sync-v2.tsx:241`, `sidebar/context.tsx:17`), стоимость дочерней сессии — `subagent-footer.tsx:44`. OpenAI отдаёт usage только в финальном чанке (`include_usage`); Anthropic — `message_start` (input/cache) + `message_delta` (output); Ollama — `eval_count` по чанкам. Наша реализация точнее: per-chunk там, где провайдер даёт данные, иначе оценка.
- **Что сделано:**
  - **Ядро:** новое событие `stream.usage` (payload: `usage` camelCase cumulative, `cost_usd`/`cost_breakdown`, `model`, `provider`, `estimated`, `agent_role`, `iteration`) по существующему EventHub (AD-024). Троттлинг ~300 мс + дедуп по подписи. Точный usage — при `output>0`; при `input>0, output=0` (Anthropic) точные input/cache + оценённый output; при нулях (OpenAI) — оценка `chars/4`. Стартовая оценка input до первого чанка. Стоимость — `computeUsageCost` (без цен не пишется). Live не персистится.
  - **Провайдеры:** исправлен порядок накопления usage в `ollama.ts` (был на итерацию позже); `remote.ts` + Zod-схема backend-proxy — `stream_options.include_usage`.
  - **Сабагенты:** `subagent.progress` несёт live usage/cost/model/estimated; `stream.usage` публикуется в дочернюю сессию; `stream.ended` — терминальное событие child; child-сообщение теперь несёт `status`/`cost_usd`/`cost_breakdown`.
  - **UI:** `StreamState` + `updateStreamUsage`/`cancelStream` (usage/cost); live-строка под стримом (`stream-live-stats`) с `~` при оценке; `StatsTab` — live «Последний ответ»/«Сессия» + строка «Сабагенты» (parent и child); `finishStream` переносит top-level `cost_usd`/`duration_ms`/`usage_estimated` в metadata.
- **Исправленные при верификации баги:** (1) `EventHub` не подписывал клиента на child-сессии, созданные тулом `task` → `stream.usage` дропался (`EVENT LOST`); добавлена автоподписка по `session.created`/`child.*`. (2) У Anthropic не рос live output. (3) После `stream.done` пропадали стоимость/длительность/скорость без F5. (4) Child-сообщение без cost/status. (5) Отмена до первого токена не сохраняла «Остановлено». (6) Латентный фантом пустого child-сообщения (вложенный payload `message.added`).
- **Проверки:** `pnpm typecheck` — 6/6 пакетов; `pnpm lint` — 0 errors; тесты: shared 73 / ui 277 / core 1449 / backend 256. E2E: openai `routerai` — 72 `stream.usage`, интервал ≥300 мс, `estimated` true→false, финал совпал, cost есть; anthropic — live input + оценённый растущий output, финал точный; ollama `omn` — реальный `eval_count` по чанкам, cost отсутствует (нет цен); отмена — `stream.cancelled` с usage/cost и сохранением «Остановлено» даже без токенов; сабагенты — live «Сабагенты» у родителя, `stream.usage` в child, live в панели child, дублей нет. UI (Playwright): live-строка и панель растут, `~` при оценке, финальные значения без перезагрузки.
- **Замечания:** для OpenAI/Remote точная стоимость в процессе недоступна — только оценка «~» (как и в opencode, где цифры не растут до `step-finish`); `reasoning_tokens` на отмене не оценивается; `context_mode` дочерней сессии наследует историю родителя (наблюдение, требует уточнения ожиданий).
- **Ветка:** `feat/ad-070-system-prompt-composer`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-09-20 — AD-071: реализация (MCP-серверы: слои, уровни, скоуп, промпт)
- **Задача:** «Реализовать AD-071» (MCP отделить от встроенных, политика инструментов, уровни MCP, описания в промпте, таблицы статистики).
- **Тип:** feature (5 фаз) + bug fix + verification
- **Исполнитель:** @orchestrator → @fixer ×7, @tester ×1
- **Результат:** PASS. Ветка `feat/ad-071-mcp-tools-scope`, коммиты `67ae82a` (AD), `c2bb33c` (Ф1), `b810f2c` (Ф2), `8b518bd` (Ф3), `ff1fef9` (Ф4a), `a016d4d` (Ф4b), `80bd814` (Ф5a), `039716f` (Ф5b).
- **Что сделано:**
  - **Ф1:** `ToolDefinition.source` (builtin/mcp) + `mcpServer`; per-session выборка (MCP только активных серверов), устранена кросс-сессионная утечка (убран глобальный `_loadedMcpServers`); манифест `tools` (stable) + `mcp.tools` (volatile); кэш-брейкпоинт на последнем встроенном туле. Попутный фикс: `createSession` терял `settings.mcpServers`.
  - **Ф2:** `description` у MCP-сервера; `McpClient` захватывает `serverInfo`/`instructions`; блоки `mcp.servers` (stable) + `mcp.status` (volatile), показываются все серверы включая отключённые с причиной.
  - **Ф3:** политика `tools.policy` (`consistency`/`available`/`auto` + per-session override); `available` фильтрует тулы по доступности, добавляет `tools.guide`, `tools` в context; runtime API `GET/PUT /settings/tools-policy`.
  - **Ф4:** единый PostgreSQL-ready реестр `McpRegistryEntry` (`origin`/`author`/`trust`/`enabledByDefault`), seed из config; `stdio` — только ADMIN, HTTP — любой с фиксацией автора; `mcp.networkPolicy` (SSRF allow/deny); уровни `system`/`project`/`session` с резолвером `resolveMcpScope` и приоритетом имён; API `/mcp/registry`, `/projects/:id/mcp`, `/sessions/:id/mcp`; RBAC.
  - **Ф5:** таблицы «Встроенные инструменты» и «MCP» в статистике (live); UI управления — сессия (opt-out), проект (owner/lead, `defaultOn`), админка (реестр, stdio-ограничение, network policy).
  - **Попутный фикс окружения:** `loadConfig` игнорировал `SYNTH_CONFIG`; `dev.sh` теперь выставляет `SYNTH_CONFIG=packages/backend/config.yaml` → `mcp.servers` сеются в dev.
- **Проверки:** build/typecheck 6/6, lint 0 errors, тесты shared 86 / ui 297 / core 1543 / backend 286. E2E: манифест `tools`/`mcp.tools`/`mcp.servers`/`mcp.status` с тирами; `consistency` vs `available`; connected/opt-out/defaultOn; админ-реестр (origin/trust/author, stdio-ограничение); live-обновление таблиц.
- **Замечания:** `auto` определяет локальность по типу провайдера (`ollama`); runtime-политика сети в standalone-core берёт дефолт (fallback из config не прокинут); `instructions` dev-сервер не отдаёт (блок формируется без строки «Инструкции»).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** да (фазы закоммичены по ходу).

## 2026-09-20 — AD-071 Ф6–Ф7: токены тулов, калибровка, tools.disabled, UI
- **Задача:** «Свернуть таблицы инструментов/MCP под Подробнее/Скрыть; токены по тулам; поменять вкладки Статистика/Контекст; MCP-переключатели в Контексте; разделить настройки MCP; админ-отключение встроенных инструментов; поправить AD под скиллы».
- **Тип:** feature + docs
- **Исполнитель:** @orchestrator → @fixer ×4
- **Результат:** PASS. Коммиты `5b2a94d` (Ф6 ядро/доки), `9c3cdfd` (Ф7 UI).
- **Что сделано:**
  - **Токены:** `toolsDetail`/`/sessions/:id/mcp` несут `chars`/`estTokens`/`ratio`; дефолт `chars/4`; калибровка per-model из `usage.inputTokens` (`ratio = promptChars/inputTokens`, EWMA α=0.3, границы 2..8, порог ≥500), persist в runtime-настройках; `manifest.ratio`.
  - **`tools.disabled`** (instance-wide, admin): группы + отдельные тулы, жёсткое исключение из запроса независимо от `tools.policy`, пометка `admin_disabled`, `runtime` неотключаем; runtime API `GET/PUT /settings/tools-disabled`.
  - **UI:** сворачивание таблиц + колонка токенов; обмен вкладок («Контекст» первой); таблица MCP с переключателями в «Контексте»; разделение настроек MCP на пользовательскую и админ-категорию; админ-UI `tools.disabled`.
  - **Docs:** AD-071 §2.6/§2.8/§2.9, AD-046 §4.5 (уровни скиллов), AD-068 §8.1, API_V2.md, CONFIGURATION.md.
- **Проверки:** build/typecheck 6/6, lint 0 errors, тесты shared 87 / ui 313 / core 1572 / backend 286. E2E (Playwright + API): порядок вкладок, сворачивание, токены, MCP-переключатель, отключение `git_read` → git_read-тулы исчезли (43→37 builtin) без рестарта, `runtime` защищён (400).
- **Замечания:** калибровка ограничена 2..8 — у `omn.qwen3.8:27b` наблюдаемый ratio ≈11.7 не сохранился; нужно решить, расширять ли границы и/или считать `promptChars` по полному запросу (включая историю).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** да.

## 2026-09-20 — AD-071: завершение (две политики, UI, калибровка, документация)
- **Задача:** довести AD-071 до конца: разделить политику, привести UI настроек, расширить калибровку, обновить инструкции.
- **Тип:** feature + UI + docs
- **Исполнитель:** @orchestrator → @fixer ×5
- **Результат:** PASS. Коммиты: `15c2fb4` (две политики), `23809dd`/`117132e` (UI), `ad23b6f` (AGENTS/README), `8db2183` (калибровка).
- **Что сделано:**
  - **Две независимые политики:** `tools.policy` (встроенные) и `mcp.policy` (MCP), дефолт `auto`; API `/settings/tools-policy` и `/settings/mcp-policy`; session override обеих; фильтрация слоёв независима; `tools.guide` при любой `available`.
  - **MCP-блоки всегда `volatile`** (`mcp.servers`/`mcp.tools`/`mcp.status`), не в `staticPrefixChars`; порядок `tools → mcp.servers → mcp.tools → mcp.status`.
  - **UI:** отдельная админ-категория «Встроенные инструменты» (политика встроенных + отключение инструментов, галочка = включено); обе MCP-категории названы «MCP-серверы»; политика MCP в админ-секции MCP; sticky-шапки; единая кнопка сохранения (`PolicySettingsCard`); per-session override обеих; полировка по `better-ui`/`better-accessibility`.
  - **Калибровка:** диапазон `chars-per-token` расширен `2..8` → `1.5..16`; калибровка сохраняется для эффективных токенизаторов (`omn.qwen3.8:27b` ≈13.3).
  - **Docs:** AD-071 (две политики, MCP volatile, порядок, дефолт auto, §2.8), AD-046 §4.5, AD-068 §8.1, API_V2.md, CONFIGURATION.md; AGENTS.md (AD-071 ✅, `SYNTH_CONFIG` в dev, runtime-API), README AD, backend/AGENTS.md.
- **Проверки:** build/typecheck 6/6, lint 0 errors, тесты shared 91 / core 1589 / ui 331 / backend 286. E2E: независимость политик, volatile/порядок MCP, калибровка, UI-разделы.
- **Ветка:** `feat/ad-071-mcp-tools-scope` (18 коммитов).
- **Коммит:** да.

## 2026-09-20 — AD-071 Ф8: админ-группа «Встроенные инструменты» + UI-полировка
- **Задача:** «Отдельная админ-группа инструментов; починить инверсию переключателей (галочка = включено); применить UI-скилл».
- **Тип:** feature + UI polish
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS. Коммит `4dfc4c5`.
- **Что сделано:** отдельная админ-категория «Встроенные инструменты» (управление вынесено из «MCP (админ)»); инверсия исправлена (checked = включён, снятие → в `tools.disabled`); `runtime` всегда включён; проверена семантика всех новых переключателей; полировка по скиллам `better-ui`/`better-accessibility` (концентрические радиусы, `transition` конкретных свойств, `active:scale-[0.96]`, focus-visible, таргет ≥40px, aria-label, role="alert", состояния, currentColor-иконки); i18n.
- **Проверки:** build/typecheck 6/6, lint 0 errors, тесты shared 87 / ui 316 / core 1572 / backend 286. E2E: галочки стоят; снятие `git_read` → тулы исчезли; в «MCP (админ)» секции инструментов нет.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** да.

## 2026-09-20 — AD-071: MCP-серверы (уровни, скоуп, промпт) — проектирование
- **Задача:** «MCP-серверы уже реализованы, а места для их описания в промпте нет; отделить MCP от встроенных инструментов, добавить таблицы и политику включения инструментов, ввести уровни MCP».
- **Тип:** research + архитектурное решение (AD)
- **Исполнитель:** @orchestrator
- **Результат:** AD-071 создан (черновик → решения согласованы), статус ⏳ Не реализовано.
- **Что выяснено:** (1) `context_mode=inherit` в child — не баг, модель сама передала `inherit` (подтверждено `metadata.args`); (2) MCP-тулы смешаны со встроенными в один `tools`-слой (`stable`), хотя MCP динамичен; (3) кросс-сессионная утечка: `registerTools` пишет в глобальный `ToolRegistry`, `getToolsForAgent()` отдаёт весь реестр, а активация per-session (`orchestrator._loadedMcpServers` — синглтон); (4) в AD MCP в промпте не описан (AD-029 — только режимы, AD-036 — обфускация); (5) в прототипе t11 MCP-тулы добавляются текстом в system prompt.
- **Решения AD-071:** разделение `tools`(stable)/`mcp.tools`(volatile) + брейкпоинт после встроенных; блок `mcp.servers` (имя, `description`, `instructions`, тулы, статус, уровень) с тиром по политике (split при `consistency`, `context` при `available`); политика `tools.policy` (`consistency`/`available`/`auto`, per-session override); уровни `system`(admin)/`project`(owner/lead)/`session`(user) с merge и приоритетом имён; единый PostgreSQL-ready реестр MCP (`McpRegistryEntry`, AD-032) с фиксацией автора (HTTP — любой пользователь, stdio — только admin, project-default — только owner/lead); admin-параметр сетевого доступа (SSRF allow/deny); approval-флоу не вводим; system-серверы можно отключать в сессии; отключённые серверы показываем с пометкой `disabled`; UI-таблицы «Встроенные инструменты» и «MCP».
- **Изменённые файлы:** `docs/arch_decisions/ad-071-mcp-servers-prompt.md` (новый), `docs/arch_decisions/README.md`, `AGENTS.md` (индекс + триггер).
- **Ветка:** `feat/ad-070-system-prompt-composer`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-09-21 — Разбор сообщений консоли браузера UI
- **Задача:** «Полазил по UI. Разберись что за сообщения валятся в консоль браузера».
- **Тип:** bug fix + research (perf)
- **Исполнитель:** @orchestrator → @fixer, @explore
- **Результат:** PASS. Вложенная кнопка исправлена; по тормозам — ранжированные гипотезы.
- **Разбор консоли:** (1) Vite HMR + React DevTools — норма dev; (2) `GET /auth/session → 401` — by design: `authStore.reauthenticate()` (`authStore.ts:46`) сначала пробует cookie-сессию, при 401 падает на `api.getStatus()` (`:55-63`); (3) двойной старт транспорта (`Switching auto→auto` → повторный `connect('ws')` после применения сохранённого режима) → `connect()` (`transportStore.ts:722`) всегда пересоздаёт клиент, поэтому первый сокет закрывается до handshake → «WebSocket is closed before the connection is established» (косметика, финально `Backend ready: ws`); (4) `[Violation] Forced reflow` + `click handler 300–500ms` — производительность, см. исследование; (5) **реальный баг**: `SubagentPart.tsx:155 In HTML, <button> cannot be a descendant of <button>`.
- **Фикс:** `packages/ui/src/components/chat/SubagentPart.tsx` — внешний `<button>`-заголовок заменён на `<div role="button" tabIndex={0} aria-expanded>` + `onKeyDown` (Enter/Space); внутренняя кнопка «Открыть сессию» осталась настоящим `<button type="button">` с `stopPropagation`; классы/иконки/i18n сохранены. В `SubagentPart.error.test.tsx` добавлены 4 регресс-теста (нет вложенных кнопок; «Открыть» открывает вкладку и не toggle; клик/Enter по заголовку toggle).
- **Verification:** typecheck PASS, lint 0 errors (33 pre-existing warnings), ui tests 335/335 PASS.
- **Perf-исследование (гипотезы, фикс не делался):** Г1 — массовые `useUIStore()`/`useChatStore()` без селекторов (`App.tsx:85`, `Header.tsx:33,53`, `ChatTab.tsx:53`, `StatsTab.tsx:137`) → любой клик ре-рендерит всё дерево; Г2 — `React.memo` ChatMessage сломан инлайн-колбэками `chatMsgProps` (`MessageList.tsx:156-189,218,227`) + новыми `{}`/`Set` (`ChatTab.tsx:56-57,85`); Г3 — `TitleTooltipBridge` (глобальные capture-слушатели + мутация `title` предков + измерение в layout-эффекте) даёт forced reflow. Минимальные безрисковые правки: точечные селекторы + стабильные пустые референсы; затем memo-контракт.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-09-21 — Perf-правки 1–2: селекторы + стабильные пустые референсы
- **Задача:** «Поправь 1 и 2» (из perf-исследования: точечные zustand-селекторы и стабильные пустые ссылки).
- **Тип:** refactor (производительность, без изменения поведения)
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS. Коммит не делался (инвариант 13).
- **Что сделано:** (1) убраны whole-store подписки: `App.tsx:85-95` — 11 селекторов `useUIStore`; `Header.tsx:28-42,61-64` — 14 селекторов `useUIStore` + `useAuthStore(s=>s.user)` + `useChatStore(s=>s.messagesBySession)` + 2 `useProvidersStore` (была ещё whole-store подписка, не указанная в исследовании); `ChatTab.tsx:29-53` — 23 селектора `useChatStore`; `StatsTab.tsx:137,144` — селекторы `useChatStore`/`useSessionsStore`. (2) в `ChatTab.tsx` модульные константы `EMPTY_MESSAGES: MessageData[]`, `EMPTY_STREAMS: Record<string, StreamState>`, `EMPTY_PENDING: QueuedMessage[]`, `EMPTY_STICKY: StickyNoteData[]`, `EMPTY_INDICES: Set<number>` заменили `|| []`, `|| {}`, `?? new Set()` (семантика `||`/`??` сохранена).
- **Проверки:** typecheck PASS, lint 0 errors (33 pre-existing warnings в LeftPanel, новых нет), ui tests 43 files / 335 tests PASS.
- **Не в скоупе (найдено):** ещё whole-store подписки в `App.tsx:39` (DefaultsSync) и ~30 компонентах (LeftPanel, ProjectsTabToolbar, RightPanel, SettingsModal и др.) — кандидаты на отдельную задачу. Г2 (memo ChatMessage) и Г3 (TitleTooltipBridge) не трогались.
- **Риск:** `EMPTY_*` — общие мутабельные референсы; мутаций нет, но в будущем их нельзя мутировать (иначе протечёт между сессиями).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-09-21 — Полное устранение проблем консоли (perf-продолжение)
- **Задача:** «Закоммить и продолжай до полного устранения проблем».
- **Тип:** bug fix + perf + refactor
- **Исполнитель:** @orchestrator → @fixer ×5, @explore
- **Результат:** PASS. Консоль браузера чистая (0 errors / 0 warnings), единственный WS-коннект.
- **Сделано:**
  1. **Г2 — memo ChatMessage** (`MessageList.tsx`, `ChatMessage.tsx`, новый `ChatMessage.memo.test.tsx`): `chatMsgProps` с per-render замыканиями удалён; колбэки `ChatMessage` принимают `msg`/`index`, локальные `useCallback`-биндинги внутри; `ChatMessage` снова байлаутится, при стриме перерисовывается только изменившееся сообщение. Коммит `d724850`.
  2. **Г3 — TitleTooltipBridge** (`TitleTooltipBridge.tsx`, новый тест): измерение в `rAF`/`useEffect` вместо `useLayoutEffect`, отмена кадров, ранний выход `hide()`, skip на `(pointer: coarse)` — устранён `Forced reflow`. Коммит `35ce61b`.
  3. **Транспорт** (`transportStore.ts`, новый `transportStore.connect.test.ts`): идемпотентный `connect()` по эффективному транспорту (`activeKind`), сброс на `onDisconnect`/`disconnect`/HMR; auto→ws больше не пересоздаёт CONNECTING-сокет → нет «closed before the connection is established». Коммит `75a7504`.
  4. **Остальные whole-store подписки**: 45 call-site в 28 компонентах → 168 точечных селекторов (`App/DefaultsSync`, `LeftPanel`, `RightPanel`, `Sidebar`, `ProjectsTabToolbar`, `FilesTabToolbar`, `GitTabToolbar`, settings/auth/chat и др.). Финальный Grep `useXStore()` — 0 совпадений. Коммит `966d45f`.
  5. **401 `/auth/session`**: `authStore.reauthenticate` переведён на `GET /auth/status` (200 всегда, те же user/deployment); `profileService.initialize()` — только при `authenticated`. 3 новых теста. Коммит `ede5e96`.
  6. **meta warning**: добавлена `<meta name="mobile-web-app-capable">` в `packages/ui/index.html`. Коммит `d25acba`.
- **Проверки:** `pnpm build` — PASS; `pnpm typecheck` — 6/6; `pnpm lint` — 0 errors (147 pre-existing warnings); `pnpm test` — shared/core 1589, ui 352, backend 286, runner 0 (нет тестов) — все PASS.
- **Браузерная проверка (Playwright, dev :5002):** до фиксов `GET /auth/session 401`, `[TransportStore] Connecting auto` → `Disconnected: manual` → повторный connect, `<button> in <button>`, 1 deprecation warning. После: 0 errors / 0 warnings; `/auth/session` не вызывается; транспорт — один `Connecting ws` → `WS Connected` → `Backend ready`; открытие сессии с блоками саб-агента и раскрытие блока ошибок не дают.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммиты:** `918af7f`, `e0b103e`, `42075fa`, `d724850`, `35ce61b`, `75a7504`, `966d45f`, `ede5e96`, `d25acba`.
- **Остаточное (не проблема консоли):** дублирующиеся `GET /auth/status` (3×) и `/auth/users` (2×) на старте — StrictMode/dev-эффекты, 200 OK, на консоль не влияют.

## 2026-09-21 — UI-замечания к панели настроек: границы, скролл, порядок блоков, кнопки
- **Задача:** «Замечания к разделам панели управления: MCP-серверы (user/admin), Безопасность, Встроенные инструменты — лишние границы, скролл не на всю область, порядок блоков, кнопки Добавить/Сохранить/Отмена».
- **Тип:** feature + UI refactor (унификация)
- **Исполнитель:** @orchestrator → @fixer ×3
- **Результат:** PASS. Коммита нет (инвариант 13).
- **Корневая причина «непокрашенных» кнопок:** классы `bg-interactive-accent`, `text-interactive-accent-foreground`, `bg-interactive-input`, `border-interactive-accent` нигде не определены (нет в `design-system.css`/`cssGenerator`); заведены коммитом `117132e` как «единые кнопки» — фактически мёртвые. Канон — `admin/AgentsPanel.tsx:275,278` (`bg-primary`).
- **Сделано:**
  1. Новый примитив `components/ui/button.tsx` (`Button`: `primary/ghost/outline/danger` × `sm/md`, `type="button"`, focus-visible ring).
  2. `settings-layout.tsx`: sticky-вариант → панельный каркас `flex flex-col h-full min-h-0` + `shrink-0`-шапка **без `border-b`** + `flex-1 overflow-y-auto` тело + слот `actions`. Non-sticky не затронут.
  3. `McpUserSettings`: «+ Добавить» → в шапку (primary).
  4. `McpSettings` (админ): порядок `форма → Реестр → Доступность инструментов → Политика MCP → Сетевой доступ`; «Добавить» в шапку; Save/Cancel в каждом блоке; Save/Cancel «Доступности» — внизу; убран `max-h-64`; откат черновика.
  5. `ToolsDisabledSettings`: убран `max-h-72`; Save/Cancel; политика **ниже** блока инструментов.
  6. `PolicySettingsCard`: primary Save + Cancel от черновика (`savedValue`).
  7. `SecuritySettings`: каркас + перевод кнопок на `Button` (Save уже оранжевый).
  8. Унификация всей панели настроек: `Profile` (Save был не оранжевым), `Routing`, `Appearance`, `Defaults`, `Debug` + админ-категории `Agents/Projects/Providers/Models/Users/Context/Sessions`.
  9. Мёртвые токены — 0 совпадений по `packages/ui/src`.
- **Проверки:** `pnpm typecheck` 6/6 PASS; `pnpm lint` 0 errors (предсуществующие warnings); `pnpm test` core 1589 / ui 360 / backend 286 PASS; `pnpm build` PASS. Визуально (Playwright, dev :5002, admin): все 4 раздела — шапка без границы, кнопка в шапке, скролл на всю область (panel body sh1670/ch454), порядок блоков и Save/Отмена на месте; регрессий в «Проектах» нет.
- **Не в скоупе:** вкладки правой панели (`ContextTab`/`SessionSettingsTab`, w-full-кнопки) — отдельной задачей; обновление `packages/ui/AGENTS.md` (новый примитив `Button`) — согласовать.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `d447482` (код), `93775e3` (журнал).

## 2026-09-21 — AD-072: Settings UI Kit (Ф1 — коллекция)
- **Задача:** «Зафиксировать стили/принципы панели настроек, выделить UI-элементы в коллекцию (save/restore/reset), исправить мобильные проблемы; сначала Kit, коммит, потом остальное».
- **Тип:** feature (UI-кит) + исследование
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS. Коллекция создана, стандарт зафиксирован.
- **Диагностика мобильных проблем (Playwright, viewport 390):** у MCP admin карточки 555px при теле 320 (`body.scrollWidth 555`), у Security 375; причина — `grid gap-4 sm:grid-cols-2` без базового `grid-cols-1` (неявный трек `auto` раздувается по max-content) + `min-width:auto` у flex/grid-детей + фиксированные контролы (native `<select>`, `w-20`, `shrink-0`); `overflow-y-auto` вычисляет `overflow-x:auto` → горизонтальный скролл. Плюс асимметричный `pr-2` («не по центру») и недействительный `overscroll-behavior-contain` (0 селекторов в dist).
- **Сделано:** коллекция `components/ui/settings/` — `SettingsPanel` (один скролл, фиксированная шапка, центрирование `max-w-3xl`, `fixed`/`sticky` футер, `overflow-x-hidden`), `SettingsSection`, `SettingsField`, `SettingsRow`, `SettingsActions`, `DefaultsBadge`, контролы (`TextField`/`NumberField`/`TextArea`/`SelectField`/`ToggleField`/`ListField`), `useSettingsDraft` (dirty/saved/isDefault/save/revert/resetToDefault), barrel коллекции; `overscroll-behavior-contain` → `overscroll-contain` (10 файлов, вкл. `logviewer/LogsModal.tsx`); i18n `settings.kit.defaultsBadge`.
- **Документация:** `docs/arch_decisions/ad-072-settings-ui-kit.md` (⚠️ Частично — коллекция готова, миграция разделов впереди), `docs/arch_decisions/README.md`, корневой `AGENTS.md` (индекс + триггер), `packages/ui/AGENTS.md`.
- **Проверки:** typecheck PASS; lint 0 errors (33 предсуществующих warning в `LeftPanel`); ui tests 50 файлов / 385 тестов (+25 новых).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `88b1a2e` (код+docs), `a877bde` (журнал).

## 2026-09-21 — AD-072 Ф2: reset/defaults runtime-настроек (backend)
- **Задача:** «Правим бэк где это необходимо» — честный «сброс к умолчанию» для настроек.
- **Тип:** feature (API)
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS.
- **Сделано:**
  - `RuntimeSettingsStore`: `clearWorkspace/clearMcpSettings/clearLlmGatewaySettings/clearSecuritySettings/clearToolsPolicy/clearMcpPolicy/clearToolsDisabled/clearMcpNetworkPolicy` (удаляют только своё поле).
  - Роуты `settings.ts`: единый контракт — GET `{ field, isOverridden, defaults }`, новые `DELETE` с `{ status:'restored', field, isOverridden:false, defaults }` и live-применением дефолта (`on*Change`) для: workspace, mcp, llm-gateway, security, tools-policy, mcp-policy, mcp-network-policy, tools-disabled. GET `/llm-gateway` и `/security` теперь отдают эффективное значение (runtime поверх config-дефолтов).
  - `app.ts` (core и backend): переданы `fallbackLlmGateway`/`fallbackSecurity` из config.yaml.
  - UI `synthApi`: 8 методов `reset*` (возвращают восстановленное значение); GET-обёртки не менялись.
  - `docs/API_V2.md`: контракты GET/DELETE + отсутствовавший `mcp-network-policy`.
- **Проверки:** core 113 файлов / 1607 тестов (новый `runtime-settings.test.ts`); ui 51 / 393 (новый `synthApi.settings-reset.test.ts`); backend 286; `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm build` PASS.
- **Замечание:** один прогон `task-resume.test.ts` флакнул при параллели с тестами (тайминги), изолированно и повторно — зелёный; к изменениям не относится.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `7d8d7b9` (код+docs), `8a3a97b` (журнал).

## 2026-09-21 — AD-072 Ф3a: миграция MCP + Built-in tools на Kit
- **Задача:** перевести MCP user/admin, «Встроенные инструменты» и `PolicySettingsCard` на коллекцию `components/ui/settings/`.
- **Тип:** refactor (UI)
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS.
- **Сделано:** `PolicySettingsCard` → `SettingsSection`+`SelectField`+`SettingsActions` (+`onReset`/`isDefault`); `McpUserSettings`/`McpSettings`/`ToolsDisabledSettings` → `SettingsPanel`/`SettingsSection`/Kit-контролы/`useSettingsDraft`; `ServerAvailabilityCard` без `max-h`; сетевой доступ — `SelectField` + `ListField chips`; reset-ы через `synthApi.reset*`; `SettingsActions` получил `*TestId`; `Toggle` — `disabled`. Сохранены все `data-testid`; добавлены `*-reset`/`mcp-network-save`.
- **Проверки:** ui typecheck/lint/build PASS; 51 файл / 402 теста (+9). Мобильная проверка (Playwright, 390px): тело MCP-админки `scrollWidth=clientWidth=356`, карточки 308 по центру — горизонтального переполнения нет (было 555).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `2f5ca39` (код), `4a82c9d` (журнал).

## 2026-09-21 — AD-072 Ф3b: миграция SecuritySettings на Kit
- **Тип:** refactor (UI)
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS.
- **Сделано:** `SecuritySettings` → `SettingsPanel` + три `SettingsSection`; `useSettingsDraft` для шлюза (`Save/Cancel/Reset` через `resetLlmGatewaySettings`); паттерны — `TextField`/`flex-wrap` + `SettingsActions`; защищённые пути — `ToggleField`/`NumberField`/4×`ListField` вместо `StringListEditor`; `DefaultsBadge`; удалены нативные `<select>`/`w-20`, `StringListEditor`, `grid` без `grid-cols-1`. Два Save защищённых путей объединены в один (последовательно `saveSecuritySettings` + `saveProtectedPaths`).
- **Проверки:** ui typecheck/lint PASS; 51 файл / 406 тестов. Мобильно (390px): тело `scrollWidth=clientWidth=361`, номер-поля на всю ширину, действия внизу секции.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `c8987b4` (код), `098c286` (журнал).

## 2026-09-21 — AD-072 Ф4a: пользовательские секции настроек на Kit
- **Тип:** refactor (UI)
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS.
- **Сделано:** `Profile`, `Appearance` (+`appearance-controls`), `Notifications`, `Chat`, `MicroFirst`, `Routing` → `SettingsPanel`/`SettingsSection`/Kit-контролы/`Button`; черновики через `useSettingsDraft`; Reset для Appearance (`resetPreferences`+ConfirmDialog), MicroFirst (локальные дефолты), Routing (редактор словаря). Убраны legacy `SettingsPage`/`SettingsCard`, `grid` без `grid-cols-1`, `pr-2`. Новые тесты: 6 файлов / 21 тест.
- **Проверки:** ui typecheck/lint PASS; 57 файлов / 427 тестов.
- **Замечания:** `SegmentedControl` оставлен из legacy (в Kit нет) — кандидат на Kit-контрол; `MicroFirst` confidence переведён со слайдера на `NumberField` (требование «числа → NumberField») — кандидат на отдельный `SliderField`; `RoutingSettings.handleReset` использует `window.confirm` (pre-existing).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `98e1450` (код), `b1b57ba` (журнал).

## 2026-09-21 — AD-072 Ф4b: админ-категории на Kit + финализация
- **Тип:** refactor (UI) + cleanup
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS.
- **Сделано:**
  - Kit: добавлен `SliderField`; `MicroFirst` confidence возвращён на слайдер.
  - Админ-категории (`Dashboard`, `Sessions`, `Debug`, `Defaults`, `Projects`, `Providers`, `Models`, `Agents`, `Context`, `Users`) → `SettingsPanel`/`SettingsSection`/Kit-контролы/`SettingsActions`.
  - `DefaultsPanel` — `useSettingsDraft` + `SettingsActions` + `footerVariant="fixed"` (реальный пример фиксированного футера), Reset через `profileService.getDefaults()`+`ConfirmDialog`.
  - `RoutingSettings.handleReset` → `confirm()` из `@/lib/confirm`; остальные админ-панели также переведены на `confirm()` (был bare `window.confirm`).
  - Уборка: удалено временное A/B-демо `SettingsFooterDemo` (и его i18n), `SegmentedControl` перенесён в Kit, удалён legacy `components/settings/settings-layout.tsx` (`SettingsPage`/`SettingsCard` не использовались).
  - Документация: AD-072 → ✅ Реализовано, индекс AD, `packages/ui/AGENTS.md`, `docs/arch_decisions/README.md`.
- **A/B футера (Playwright, 390px):** «Оформление» (`footerVariant="fixed"`) — действия `Сбросить/Сохранить` прижаты к низу панели, отделены `border-t`, не уезжают при скролле; для сравнения — `Debug`/MCP без футера (Save в конце карточки). Решение по стандарту — за пользователем.
- **Проверки:** ui typecheck/lint PASS; 62 файла / 476 тестов; `pnpm typecheck` 6/6; `pnpm build` PASS; ссылок на `settings-layout`/`SettingsFooterDemo`/`admin.debug.demo` не осталось.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `c7ebf30` (код+docs), `4e626fe` (журнал).

## 2026-09-21 — AD-072: финальная мобильная проверка
- **Проверка (Playwright, viewport 390, admin):** прокликаны все 20 категорий настроек; у каждой тело панели `scrollWidth == clientWidth` (`over: 0`) — горизонтального переполнения нет ни в одной (было: MCP admin 555→356, Security 375→320).
- **A/B футера:** «Оформление» (`footerVariant="fixed"`) — `Сбросить/Сохранить` прижаты к низу панели, отделены `border-t`, не уезжают при скролле; «Отладка»/MCP — без футера (Save в конце карточки). Решение по стандарту — за пользователем.
- **Остаток:** решение по варианту футера (fixed/sticky/none) для односохранных панелей; прочие дефекты не зафиксированы.

## 2026-09-21 — AD-072: доработки по фидбеку (Kit + секции + backend)
- **Задача:** «футер — точно нет; в Debug нет Save/Cancel/Reset в каждой секции; вкладки в Context на теле; свернуть шапку наверх; единый слайдер; затенение скролла».
- **Тип:** feature/refactor (UI) + backend-фикс
- **Исполнитель:** @orchestrator → @fixer ×3
- **Результат:** PASS.
- **Kit:**
  - `SliderField` переписан на `.ui-range` + `--ui-range-fill` (как в «Внешний вид»), с `onReset`/`stacked`; `UiScaleControl` теперь обёртка над Kit-слайдером — слайдер один.
  - Новый `controls/Tabs.tsx` (`segmented`/`underline`), мобильно-устойчивый (`flex-1 min-w-0`, выравнивание, при переполнении X-скролл с затенением); реэкспорт из Kit.
  - `SettingsPanel`: `collapsibleHeader` — на теле при скролле описание сворачивается (`grid-rows-[0fr]`/opacity), остаются заголовок и кнопка; тело получило класс `settings-scroll-container` и `data-scroll-shadow` (top/bottom/top-bottom) с CSS-mask (`--scroll-shadow-size: 1.5rem`).
- **Секции:**
  - `DefaultsPanel` — фиксированный футер убран, `SettingsActions` в конце тела.
  - `DebugPanel` — `DebugCategorySection` на `useSettingsDraft`; Save/Cancel/Reset в каждой секции (`debug-save-<category>`), partial-save.
  - `ContextPanel` — самописные вкладки → Kit `Tabs`.
- **Backend:** `POST /admin/debug/config` переведён на `setGroups` (merge) вместо `setAllGroups` (replace) — per-section Save больше не затирает другие категории; `setGroups` добавлен в core logger и экспорт; `docs/API_V2.md`.
- **Проверки:** `pnpm typecheck` 6/6; core 114/1613, ui 66/502, backend 24/291, shared 91; lint 0 errors. Мобильно (390px): слайдер MicroFirst = `.ui-range` (fill 60%), Context — `role=tablist` `flex-1 min-w-0`, шапка сворачивается (`opacity 0`), `data-scroll-shadow` bottom→top-bottom→top.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** этот.

## 2026-09-21 — AD-072: убран футер в Profile/Appearance/MicroFirst
- **Задача:** «Профиль, Внешний вид, Быстрые ответы — всё ещё есть футер».
- **Тип:** bug fix (UI)
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS. `grep footer=` по settings/admin — пусто.
- **Сделано:** в `ProfileSettings`, `AppearanceSettings`, `MicroFirstDefaults` убран проп `footer` у `SettingsPanel`; `SettingsActions` перенесены в конец тела (пропсы не менялись). Добавлены регресс-тесты «действия внутри скролл-тела, не fixed-футер». AD-072 и `packages/ui/AGENTS.md`: `footer`/`footerVariant` — доступны, но не используются.
- **Проверки:** ui typecheck/lint/505 тестов PASS.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** этот.

## 2026-09-21 — AD-072: кнопки сброса/отмены + фикс схлопывания шапки
- **Задача:** «Уведомления и Чат — кнопки сброса; Профиль — Отмена; в шапке текст пропадает, но место не уменьшается; Маршрутизация — не хватает кнопок».
- **Тип:** feature/bug fix (UI)
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS.
- **Сделано:**
  - `SettingsPanel`: у `<p>` описания добавлены `min-h-0 overflow-hidden` — при сворачивании (`grid-rows-[0fr]`) высота реально становится 0. Проверено в браузере (390px): header `143px → 24px`, description `119px → 0`, тело списка `475 → 601` (+126px), наверх — `143px`.
  - `NotificationSettings` — `SettingsActions` только с `onReset` (`notifications-reset`); в `notificationStore` добавлен `resetCategories()`.
  - `ChatSettings` — reset (`chat-reset`) → `intermediateTextDisplay = 'inline'`.
  - `ProfileSettings` — `Cancel` (`profile-cancel`) с откатом к снапшоту, disabled без изменений.
  - `RoutingSettings` — переведён с автосохранения на `useSettingsDraft` + `SettingsActions` Save/Cancel/Reset (`routing-save/-cancel/-reset`), индикатор несохранённых изменений.
  - i18n `settings.kit.unsavedChanges`; AD-072 (§2.9).
- **Проверки:** ui typecheck/lint, `66 файлов / 511 тестов` PASS; в браузере подтверждены все новые кнопки.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `bb61089` (код), `4e71a74` (журнал).

## 2026-09-21 — AD-072: no autosave, meta-счётчики, контурный Reset
- **Задача:** «Внешний вид/Уведомления/Чат — Save+Отмена; утвердить: никаких автосохранений, только кнопки; закрытие окна = Отмена; Reset — контур в цвет Save; кнопка в шапке на одной строке с заголовком на мобильном; счётчики не скрывать при скролле (отдельно от описания)».
- **Тип:** feature/refactor (UI)
- **Исполнитель:** @orchestrator → @fixer ×3
- **Результат:** PASS.
- **Kit:** `SettingsPanel` — слот `meta` (всегда виден) отдельно от `description` (сворачивается); шапка: title+actions в одной flex-строке (в т.ч. на теле); `Button` — вариант `outline-primary`; `SettingsActions` Reset по умолчанию `outline-primary` (контур/текст primary, без заливки), `resetVariant` настраиваемый.
- **Секции:** убрано автосохранение в `Appearance`/`Notifications`/`Chat` → черновик + `SettingsActions` Save/Cancel/Reset; закрытие/размонтирование = отмена (Appearance с live-preview и откатом к снапшоту); `notificationStore.setAllCategories`; `UiScaleControl` — контролируемый режим. Счётчики перенесены из `description` в `meta` (Sessions/Projects/Providers/Models/Users/Agents/Context); текстовые описания остались сворачиваемыми. `DefaultsPanel` — добавлена Отмена.
- **Проверки:** ui typecheck/lint, `66 файлов / 524 теста` PASS; в браузере (390px): Models — `meta` виден при скролле (header collapsed 51px), actions в строке с заголовком; Notifications/Chat/Appearance — Save/Cancel/Reset; Reset-класс `border border-primary text-primary hover:bg-primary/10` (без сплошной заливки).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `4b068e5` (код), `ec06abc` (журнал).

## 2026-09-21 — AD-072: переключатель фильтра «Агентов» под шапку
- **Задача:** «На вкладке Агенты кроме кнопки вверх переехал переключатель вкладок — он должен был остаться на месте». По решению: переключатель — отдельной строкой под шапкой, в шапке только «+ Добавить».
- **Тип:** bug fix (UI)
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS.
- **Сделано:** `AgentsPanel` — `actions` = только «+ Добавить»; фильтр «Все/Агенты/Сабагенты/Системные» вынесен в начало тела (над формой/списком) через Kit `Tabs`, гейт `hasSubOrSystem`, локальный `renderFilterTabs` удалён. `meta` (счётчик) и фильтрация не менялись. Новый `AgentsPanel.test.tsx` (3 кейса).
- **Проверки:** ui typecheck/lint, `67 файлов / 527 тестов` PASS; визуально (desktop): шапка «Агенты + 14 агентов + Добавить», ниже — полноширинный сегмент-переключатель.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** этот.

## 2026-09-22 — AD-072: MCP-счётчик под шапку, скролл моб. меню настроек, высота пунктов левой панели
- **Задача (3 пункта):** 1) «В MCP-серверы и в пользовательской, и в админской секциях счётчик сделай под шапкой компонентом из кита»; 2) «В десктопной версии немного уменьши высоту обрамления пунктов в левой панели — обрамление выбранного и подсветка пункта под курсором сливаются»; 3) «В мобильном варианте если я выбираю Администрирование, надо смещать скрол на Панель управления — она выбирается, но скрол в самом начале».
- **Тип:** bug fix (UI ×3)
- **Исполнитель:** @orchestrator → @fixer (3 параллельно + 1 добор)
- **Результат:** PASS.
- **Сделано:**
  - **MCP-счётчик → `meta`.** `McpSettings.tsx:395` и `McpUserSettings.tsx:108` — `meta={registry ? t('mcp.count', {count}) : undefined}`; у секции списка удалён проп `actions` (шапки у секции больше нет вовсе). Счётчик теперь как у Sessions/Projects/Models/Users/Agents/Context — по Kit-слоту под заголовком, остаётся видимым при сворачивании описания. Тесты: `settings-header-meta` в `McpSettings.test.tsx`/`McpUserSettings.test.tsx`.
  - **Мобильное меню настроек.** `SettingsModal.tsx` — `navRef` + `activeRef` + `useEffect([settingsPage, isPhone, isSettingsDialogOpen])` сдвигает `nav.scrollLeft` (зазор 8px) к активной кнопке без `scrollIntoView` (чтобы не дёрнуть вертикальный скролл). Desktop/tablet не затронуты. Новый `SettingsModal.mobile.test.tsx`.
  - **Левая панель.** `TreeNode.tsx:151` — `py-1 → py-0.5` (высота пункта 36 → 32px). Проверка в браузере показала, что одного паддинга мало: подсветки по-прежнему соприкасались (`top=100,h=32` / следующий `top=131`), поэтому добавлен реальный зазор — `TreeChildren.tsx:115` `space-y-0.5` (2px; ветка `totalCount===0` и виртуализация не тронуты).
- **Проверки:** ui typecheck/lint (0 errors, 33 предсуществующих warning в `LeftPanel.tsx`), ui `68 файлов / 530 тестов`; корневые `pnpm typecheck` и `pnpm test` — shared 91, core 1613, ui 530, backend 291, все PASS. В браузере: mobile 390×844 — после «Администрирование» полоса категорий прокручена и «Панель управления» видна как активная; desktop — замер зазора 2px между подсветками соседних пунктов; MCP user `0 серверов` / admin `1 серверов` в `meta` под заголовком.
- **Отмечено:** `mcp.count` не плюрализуется («1 серверов») — существующее поведение i18n, не менялось (как и `admin.sessions.count`).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `fda6d06` (настройки), `0c7e243` (левая панель), этот.

## 2026-09-22 (продолжение) — AD-072: меню настроек, порядок шапки; откат правки дерева
- **Задача (фидбек по скриншоту):** 1) «на скриншоте видно, как сливаются обрамления: один пункт выбран, на другой навёл курсор» — это **меню категорий окна настроек**, а не дерево левой панели; 2) мобильный скролл: вкладка «Панель управления» должна оказаться в **левой** части экрана, а не в правой; 3) «если в шапке есть и описание, и счётчики — счётчики должны быть ниже описания; зафиксировать как стандарт».
- **Тип:** bug fix (UI ×2) + стандарт/доки
- **Исполнитель:** @orchestrator → @fixer (×2, один с добором)
- **Результат:** PASS.
- **Сделано:**
  - **Откат моего неверного диагноза.** В прошлом заходе правка ушла в дерево левой панели (`TreeNode` `py-0.5`, `TreeChildren` `space-y-0.5`) — пользователь имел в виду меню настроек. Правка откачена коммитом `cf7d42e` (`git checkout 6935f47 -- tree/`), дерево вернулось к исходному виду.
  - **Меню настроек (`SettingsModal.tsx`).** Корневая причина «слипания»: у `nav` был только `flex-col` без класса `flex` → `display: block`, поэтому `gap-1` **не применялся вовсе** (замер: `nav.display="block"`, кнопки встык при `rowGap: 4px` в computed). Добавлен `flex` в desktop-ветку, кнопкам — безусловный `shrink-0` (иначе при `display:flex` в колонке с `overflow-y-auto` они сжимались, `min-height: 0`), высота пункта `py-2 → py-1.5` (36 → 32px). Замер после фикса: `display: flex`, зазор 4px, пункты 32px, меню по-прежнему скроллится (773 > 715).
  - **Скролл мобильного меню.** Вместо «подтянуть в зону видимости» — выравнивание активной вкладки по левому краю: `delta = btnRect.left - navRect.left - PAD` (PAD 8), clamp `[0, scrollWidth - clientWidth]`. Добавлен второй проход через `setTimeout(200)` — первый замер попадал в анимацию входа `DialogContent` (`transition-all duration-150`) и оставлял смещение ~13px; после второго прохода замер ровно `8.4px`. rAF/таймаут чистятся, guard `isPhone` сохранён.
  - **Стандарт шапки.** `SettingsPanel` — порядок `title` (+`actions`) → `description` → `meta` (счётчики ниже описания); `meta` по-прежнему не сворачивается. Тест: `desc.compareDocumentPosition(meta)` + порядок детей `header` + проверка, что после сворачивания описания `meta` виден. Стандарт зафиксирован в `docs/arch_decisions/ad-072-settings-ui-kit.md` (§2.5, §2.10, строка реализации Ф5f) и `packages/ui/AGENTS.md`.
- **Проверки:** корневые `pnpm typecheck` и `pnpm test` — shared 91, core 1613, ui **531** (+1 новый тест), backend 291, все PASS; ui lint 0 errors (33 предсуществующих warning). В браузере: desktop — зазор 4px между «Внешний вид» (выбран) и «Уведомления» (hover), пункты 32px; mobile 390×844 — «Панель управления» у левого края (8.4px), контент «Дашборд»; MCP-шапка — «MCP-серверы» → описание → «1 серверов».
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `cf7d42e` (откат), `8a325d8` (меню/скролл), `2013d10` (стандарт шапки + доки), этот.

## 2026-09-22 (продолжение 2) — плюрализация счётчиков + контур у кнопок отмены
- **Задача:** 1) «Сделай плюрализацию» (счётчики давали «1 серверов»); 2) «добавь контур к кнопкам отмены, цвет такой же как сейчас у текста кнопки».
- **Тип:** feature (i18n) + UI-правка
- **Исполнитель:** @fixer ×2 (+док) → верификация @orchestrator
- **Результат:** PASS.
- **Сделано:**
  - **Плюрализация (мини-ICU, без новых зависимостей).** Новый `lib/i18n/plural.ts`: `pluralCategory(locale, count)` по CLDR-лайт (ru: one/few/many с учётом 11–14 и 21/22/25; en: one/other; дробные → other, отрицательные — по модулю). `formatMessage(dictionary, key, params, locale)` получил 4-й параметр `locale` и поддержку `{count, plural, one {# сервер} few {# сервера} many {# серверов}}`: балансировка `{}` (свой парсер, не регулярка), `#` → число внутри формы, обычные `{param}` и вложенные plural-блоки, fallback форм `other → many → one → few → zero → two`. `locale` прокинут в `t()` (`context.tsx`), `resolveI18n`/`useResolveI18n`, `i18nText` в `sessionsStore`/`projectsStore`.
  - **Словари:** 12 ключей переведены на plural в ru и en — `mcp.count`, `admin.sessions.count`, `admin.sessions.messageCount`, `admin.projects.count`, `admin.projects.memberCount`, `admin.projects.statusCount`, `admin.providers.count`, `admin.models.count` (два независимых plural-блока: модель по `total`, провайдер по `providers`), `admin.users.count`, `admin.agents.count`, `admin.agents.filter.subagents_count`, `admin.context.count`. Прочие `{count}`-строки (предложения, «показать ещё») намеренно не трогали — механизм поддержит их позже.
  - **Контур у «Отмены».** `Button` — новый вариант `outline-muted` (`border border-muted-foreground text-muted-foreground` + прежний hover ghost); `SettingsActions` Cancel `ghost → outline-muted`; в `ConfirmDialog` сырой Cancel-`<button>` получил `border border-muted-foreground` (цвет = цвет текста). Прочие инлайн-отмены (`LeftPanel`, `ChatTab`, `Publish/ForkProjectDialog`) с залитым фоном и `text-foreground` не трогали.
  - **Доки:** `packages/ui/AGENTS.md` (раздел «API и i18n») — зафиксирован plural-синтаксис, `#`, выбор формы по локали и fallback.
- **Проверки:** корневые `pnpm typecheck` и `pnpm test` — shared 91, core 1613, ui **546** (69 файлов; +14 тестов `plural.test.ts`, +1 `SettingsActions`), backend 291, все PASS; ui lint 0 errors (33 предсуществующих warning). В браузере (ru): MCP-шапка — «1 сервер» (было «1 серверов»); Cancel в «Уведомлениях» — `border: 1px solid rgb(119,126,134)` = цвет текста; ConfirmDialog «Удалить провайдера?» — «Отмена» с контуром; провайдеры не пострадали (7, включая itphx).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `8b8860a` (i18n plural), `5a9e9d8` (контур отмены), этот (+ доки `AGENTS.md`).

## 2026-09-22 (продолжение 3) — Reset серый при дефолте, Save/Cancel по dirty
- **Задача:** «В админской вкладке MCP-серверы в блоке Политика MCP кнопки Сбросить/Сохранить/Отмена почему-то всегда активны. В принципе кнопка Сбросить везде должна быть цветной только если параметры отличаются от дефолтных; если параметры по дефолту — кнопка должна быть серая.»
- **Тип:** bug fix (UI) + стандарт/доки
- **Исполнитель:** @orchestrator → @fixer ×3 (Kit+политики → остальные разделы → серверные дефолты) → верификация @orchestrator
- **Результат:** PASS.
- **Диагноз (замер в браузере):** `mcp-policy-save` — `disabled:false` всегда (`saveDisabled={loading}`); `mcp-policy-reset` — `disabled:false` и класс `border-primary` при политике `auto` = дефолт; `mcp-policy-cancel` уже был корректен. Причина: Kit не знал о равенстве дефолту, `PolicySettingsCard` не считал `dirty`, а API выбрасывал `defaults`/`isOverridden`.
- **Сделано:**
  - **Kit `SettingsActions`.** Новый проп `isDefault`: Reset → `outline-muted` + `disabled` (цветная `outline-primary` только при отличии от дефолта). Правило зафиксировано в AD-072 (Ф5g, §2.6, §2.9) и `packages/ui/AGENTS.md`.
  - **`PolicySettingsCard`.** Появился `dirty = value !== savedValue`: Save `saveDisabled={loading || !dirty}`, Cancel `cancelDisabled={loading || !dirty}`, Reset `isDefault` (prop использовался только для `DefaultsBadge`).
  - **Серверные дефолты вместо хардкода.** `synthApi`: `getMcpPolicyInfo`/`getToolsPolicyInfo` (`{policy,isOverridden,defaults}`), `getMcpNetworkPolicyInfo`, `getLlmGatewaySettingsInfo`, `getToolsDisabledInfo`; `mcpStore` хранит `networkPolicyDefaults`/`toolsDisabledDefaults`. Сетевая политика MCP сравнивалась с `{mode:'deny',list:[]}`, а серверный дефолт содержит 8 приватных CIDR → Reset оставался цветным при `isOverridden:false`; gateway сравнивался с хардкодом `DEFAULT_SETTINGS`; tools-disabled — с `EMPTY_DISABLED`.
  - **Остальные разделы.** `isDefault` прокинут в Notification/Chat/Appearance/Routing/MicroFirst/admin.Debug (там были `resetDisabled={draft.isDefault}`), Security (gateway `gateway.isDefault`, patterns `!isOverridden`, protected `!policyOverridden`), MCP (политика, доступность — через вычисленный `availabilityDefault`, сетевая политика), «Встроенные инструменты» и tools-policy. У gateway Save стал `loading || !gateway.dirty`. `DefaultsPanel` (per-item reset) не тронут — другая семантика.
- **Проверки:** корневые `pnpm typecheck` (0 ошибок) и `pnpm test` — shared 91, core 1613, ui **557** (69 файлов), backend 291, все PASS; ui lint 0 errors (33 предсуществующих warning). В браузере (ru, admin): MCP-политика на дефолте — Reset серый+disabled, Save/Cancel disabled, бейдж «По умолчанию»; выбор `available` — Reset цветная+активна, Save/Cancel активны; «Отмена» вернула `auto`. Аналогично проверены: доступность MCP, сетевая политика, tools-disabled, tools-policy, Уведомления (toggle → цветная, Cancel → снова серая), Внешний вид (цветная — тема `ayu` ≠ дефолт `flexoki`), Безопасность (gateway цветная — `enabled:true` ≠ дефолт `false`; patterns/protected серые при `isOverridden:false`).
- **Отмечено:** Save у textarea-разделов Security (patterns/protected paths) остаётся активным всегда — там нет черновика/`dirty` (вне рамок задачи).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `bd48308` (код+тесты), `af6a32e` (доки), этот.

## 2026-09-22 (продолжение 4) — иконка провайдера itphx в форме редактирования
- **Задача:** «У провайдера itphx какая-то беда с иконкой: если открыть редактирование, там отображается какой-то base64 код. У других провайдеров такого нет.»
- **Тип:** bug fix (UI)
- **Исполнитель:** @orchestrator → @fixer → верификация @orchestrator
- **Результат:** PASS.
- **Диагноз:** `providers/itphx.json` → `"icon": "data:image/png;base64,…"`, длина **28 910** символов (у остальных — `brand:minimax`, `ri:flask`, `brand:ollama`, пусто). `ProviderIcon` такие data-URL рендерит корректно (в списке иконка выглядит нормально), но форма редактирования печатала значение сырым текстом: `ProvidersPanel.tsx:233` — `<span className="… break-all">{form.icon}</span>`. Замер в браузере: `<span>` содержал все 28 910 символов.
- **Сделано:**
  - `ProviderIcon`: `describeProviderIcon(icon)` → `{ kind: none|remixicon|brand|image|url|unknown, value }` (единая точка знания о форматах: `ri:`, `brand:`, `data:image/` → MIME, `http…` → host).
  - `ProvidersPanel`: подпись вместо сырого значения — `image` → «Изображение (base64)» (MIME в `title`), `url` → host (полный URL в `title`), `remixicon`/`brand` → имя как раньше, `unknown` → обрезка до 40 символов + `…`; `break-all` → `truncate`. Превью и кнопка «Сбросить» не тронуты.
  - i18n: `admin.providers.iconImage` (ru «Изображение (base64)» / en 'Image (base64)'); +3 теста (data-URL, `brand:ollama`, `https://openrouter.ai/api/v1`).
- **Проверки:** корневые `pnpm typecheck` (0 ошибок) и `pnpm test` — shared 91, core 1613, ui **560** (69 файлов), backend 291, все PASS; ui lint 0 errors. В браузере: `itphx` → превью PNG + «Изображение (base64)» (`title=image/png`), сырого data-URL в разметке нет (длиннейшая строка 38 символов); `brand:minimax`/`brand:ollama` — как раньше.
- **Отмечено (данные не менялись):** 29 КБ base64 в `providers/itphx.json` отдаются в каждом `GET /providers` — оверхед на ответ API/UI-списки. Разумно отдельной задачей перейти на короткую ссылку (`brand:*`/`ri:*` или `/api/v2/providers/:name/icon`) + миграция данных; UI к URL-иконкам уже готов.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `14b825d`, этот.

## 2026-09-22 (продолжение 5) — сжатие favicon провайдера + миграция иконки itphx
- **Задача:** «сделай» (к заметке из прошлой задачи: 29 КБ base64 в `providers/itphx.json` едут в каждом `GET /providers`).
- **Тип:** feature/perf (UI) + миграция данных
- **Исполнитель:** @orchestrator → @fixer ×3 (реализация → сброс хинта → семантика хинта) → верификация + миграция @orchestrator
- **Результат:** PASS.
- **Решение (и почему не endpoint):** бинарный endpoint `GET /providers/:name/icon` отклонён — `<img src>` не отправляет Bearer-токен, иконки пришлось бы открывать без авторизации (и усложнять гибрид). Вместо этого — сжатие в браузере до маленького PNG data-URL.
- **Сделано:**
  - `lib/imageIcon.ts`: `isOversizedIcon(value, limit=8192)` и `downscaleIconDataUrl(dataUrl, size=64)` — canvas-PNG с прозрачностью, `createImageBitmap` с fallback на `HTMLImageElement.decode()`, при любой ошибке/недоступности canvas/если результат не короче — возврат входа; SSR/jsdom-safe (`typeof document === 'undefined'`).
  - `ProvidersPanel`: сжатие в `handleFetchIcon` (превью и применяемое значение) и в `applyFetchedIcon` (страховка); при открытии формы тяжёлая иконка сжимается в черновике, обычное «Сохранить» мигрирует запись; единый `setIcon(value)` синхронизирует значение и флаг `iconUncompressed`; честный хинт `admin.providers.iconUncompressed` («Не удалось сжать иконку — сохранится как есть») показывается только когда сжать реально не удалось (напр. ICO не декодируется), без мигания при открытии.
  - i18n ru/en; `docs/API_V2.md` — уточнено, что `POST /providers/fetch-icon` отдаёт сырой data-URL, а UI сохраняет сжатый.
  - Тесты: +11 (`imageIcon.test.ts` — пороги/fallback; `ProvidersPanel.test.tsx` — успешное и неуспешное сжатие, brand/reset сбрасывают хинт).
- **Миграция данных (dev):** открыл `itphx` в форме и сохранил — `providers/itphx.json` **29 131 → 1 943 байта**, `icon` **28 910 → 1 722** символа (PNG 64×64, `naturalWidth=64`, логотип рендерится); `GET /api/v2/providers` **~31 КБ → 2 908 байт**. Прочие поля провайдера (apiKey, baseUrl, defaultModel, timeout, enabled) не пострадали.
- **Проверки:** `pnpm typecheck` 0 ошибок; `pnpm test` — shared 91, ui **573** (70 файлов), backend 291, core 1613 PASS (в первом прогоне упал известный флак `core/task-resume.test.ts` по таймингам — повторный прогон всего core зелёный); ui lint 0 errors. В браузере: форма `itphx` — сжатая иконка 1 722 символа, хинта нет; список провайдеров — иконки на месте.
- **Отмечено:** если favicon — ICO, который canvas не декодирует, сжатия не будет (безопасный fallback, иконка останется тяжёлой, хинт об этом честно сообщит). Порог 8192 на вход и выход один: для сложной многоцветной иконки 64×64 результат может превысить порог — тогда она снова сожмётся при следующем сохранении (идемпотентно).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `4a9fcc9`, этот.

## 2026-09-22 (продолжение 6) — MCP: убран дублирующий блок из «Контекста», разложено по вкладкам
- **Задача:** «Слишком много контролов MCP серверов и на разных вкладках. Включение/выключение на уровне сессии — только на вкладке Сессия; на уровне проекта — вкладка Проект; статистика/стоимость — вкладка Статистика. Вроде так будут все необходимые функции и без дублирования.»
- **Тип:** refactor (UI) + правка доки
- **Исполнитель:** @orchestrator (исследование) → @fixer → верификация @tester
- **Результат:** PASS.
- **Исследование (что подтвердилось):** блок MCP на «Контексте» не был полным дублем «Статистики» (там таблица read-only без тумблеров), но session-toggle дублировался с вкладкой «Сессия» (`SessionSettingsTab`, `updateSessionMcp`), а проектный уровень и метрики уже жили на «Проекте»/«Статистике». Раскладка «Сессия — управление сессией, Проект — уровнем проекта, Статистика — метрики/стоимость, Контекст — только состав/оптимизация» закрывает все функции без дублирования.
- **Сделано:**
  - `ContextTab.tsx`: удалён весь MCP-блок (JSX, состояние `mcpServers/mcpLoading/mcpToggling/mcpError`, `streamFinishTick`/`toolsDisabledTick`, useEffect загрузки, `handleToggleMcpServer`, `formatMcpTokens`) и ставшие неиспользуемыми импорты `McpServerEffective`, `cn`, `DEFAULT_CHARS_PER_TOKEN`. `Toggle`/`Icon`/`synthApi` оставлены (используются остальной логикой).
  - i18n: удалены 5 ключей `rightPanel.context.mcp.*` (title/empty/colEnabled/toggleError/hint) из `ru.ts`/`en.ts`; общие ключи (`rightPanel.stats.*`, `mcpLevel/mcpStatus/mcpReason`, `mcp.enable/disable`) не тронуты.
  - `ContextTab.test.tsx`: содержал только MCP-тесты — удалены MCP-describe, моки `getSessionMcpEffective`/`updateSessionMcp` и `SYS_SERVER`; добавлен smoke-тест (блоки оптимизации рендерятся, `context-mcp-list` отсутствует), чтобы файл не остался без тестов.
  - `docs/arch_decisions/ad-071-mcp-servers-prompt.md`: §2.6 (стр. ~115/~122), §3 фаза 6, §4 вопрос 8 — session-level MCP-тумблеры перенесены на вкладку «Сессия», «Контекст» оставлен только за составом/оптимизацией, project — «Проект», метрики — «Статистика».
- **Проверки:** `pnpm typecheck` — 6 пакетов Done, exit 0; `pnpm lint` — 0 errors (33 предсуществующих warning в ui, по изменённым файлам чисто); `pnpm test` — shared 91, core 1613, ui 572 (70 файлов), backend 291, runner без тестов, все PASS. Верификация @tester (grep + независимый прогон) — регрессий нет: `updateSessionMcp` остался единственным потребителем на «Сессии», `ProjectMcpBlock` и `stats-mcp-servers` на месте.
- **Отмечено:** покрытие `ContextTab` сузилось до smoke-теста (интерактив оптимизации ранее не был покрыт MCP-тестами); при желании — отдельной задачей добавить тесты на `updateOptimization`/тумблеры. Визуальная проверка вкладок в браузере не выполнялась (правка чисто удаляющая, UI-разметка вкладок не менялась).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `0e2b11a`.

## 2026-09-22 (продолжение 7) — порядок вкладок правой панели: Сессия, Проект, Контекст, Статистика
- **Задача:** «Поменяй местами вкладки на правой панели в верхнем ряду. Должно быть в таком порядке Сессия, Проект, Контекст, Статистика. И закоммить.»
- **Тип:** refactor (UI) + правка доки
- **Исполнитель:** @orchestrator → @fixer → верификация @orchestrator
- **Результат:** PASS.
- **Сделано:**
  - `RightPanel.tsx`: `RIGHT_TABS` переставлен в `params, project, context, stats, references, scheduler` → верхний ряд (`slice(0,4)`) = «Сессия, Проект, Контекст, Статистика», второй = `references, scheduler` (+ `secrets` для ADMIN/AUDITOR добавляется в конец). Логика `slice`, роль-гейтинг и нормализация `secrets → context` не тронуты. Обновлён комментарий.
  - `RightPanel.tabs.test.tsx`: ожидаемый порядок и `describe`/`it` приведены к новому; тест дефолта `'context'` без изменений.
  - `useUIStore.ts`: поправлен только комментарий (`«Контекст» идёт первой` → `дефолтная вкладка — «Контекст»`); значение `rightPanelTab: 'context'` не менялось.
  - `docs/arch_decisions/ad-071-mcp-servers-prompt.md`: §2.6 (стр. 115) и §4 п.8 (стр. 206) — раскладка приведена к «верхний ряд: Сессия, Проект, Контекст, Статистика».
- **Проверки:** `pnpm typecheck` — 6 пакетов Done; `pnpm lint` — 0 errors (33/107/150 предсуществующих warning); `pnpm test` — shared 91, core 1613, ui 572, backend 291, runner без тестов — все PASS. Точечно `RightPanel.tabs.test.tsx` — 2 passed.
- **Отмечено:** дефолтная активная вкладка осталась «Контекст» (пользователь просил поменять только порядок). Визуально в браузере не смотрели.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** этот.

## 2026-09-22 (продолжение 8) — валюта цены модели, этап A (данные + UI) + фикс warning «$3.28»
- **Задача:** «Добавить фичу — выбор валюты для цен у каждой модели отдельно. Кнопка с единственным символом валюты, попап выбора. Базовые валюты: RUB, USD, CNY. И изучить получение цен/лимитов от провайдера (routerai).» Решения: агрегаты — раздельно по валютам; синхронизация — цены+лимиты, универсально (OpenAI/Anthropic/Ollama); валюта — полем у провайдера. Порядок — поэтапно A → B → C.
- **Тип:** feature (multi-currency) + bug fix (console warning)
- **Исполнитель:** @orchestrator (research ×4) → @fixer → верификация @orchestrator
- **Результат:** PASS (этап A). Этапы B (синхронизация цен/лимитов) и C (мультивалютные агрегаты) — следующие.
- **Причина warning:** `ModelsPanel.formatPrice` возвращал `"$3.28"`, и строка попадала в `value` четырёх `<input type="number">` (цены in/out/cache read/cache write) до фокуса — браузер отклонял значение (цена вообще не отображалась).
- **Сделано:**
  - **Shared:** `CURRENCIES = ['RUB','USD','CNY']` + `type Currency`; `ProviderConfig.currency?`, `ModelConfig.currency?` (приоритет модель → провайдер → USD).
  - **Backend/Core:** `currency` в GET/POST провайдеров и моделей (+helper `parseCurrency` с валидацией; `null`/`''` очищает, невалидное игнорируется).
  - **Гибрид:** `RemoteModelInfo`/`RemoteProviderInfo.currency`, `asCurrency()`, проброс в `remote/client.ts` и `server/app.ts` (extraModels + зеркалируемый провайдер).
  - **UI:** новый `lib/currency.ts` (`formatMoney` через `Intl.NumberFormat`, символы `₽/$/¥`); новый `components/admin/CurrencyPicker.tsx` (кнопка-символ + Popover, активная помечена `<Icon name="check"/>`); `ModelsPanel` — `value` инпутов цен теперь сырое число (фикс warning), валюта резолвится `model → provider → USD`, `formatPrice` валюто/локаль-зависим (только title), `setCurrency` → `POST /models`; `ProvidersPanel` — селект валюты провайдера (+«не задано»).
  - **i18n:** ключи `admin.providers.currency*`, `admin.models.currency*`; подписи `$/1M` сделаны валюто-нейтральными.
  - **Тесты:** новый `ModelsPanel.test.tsx` (value инпутов без `$` — регрессия warning, переключение валюты, fallback от провайдера), `backend/routes/providers.test.ts` и `models.test.ts` (сохранение/очистка/игнор невалидной валюты), `ProvidersPanel.test.tsx` (сохранение валюты в body POST).
- **Проверки:** `pnpm typecheck` — 6 пакетов Done; `pnpm lint` — exit 0, 0 errors; `pnpm test` — shared 91, core 1613, ui **576**, backend **297** — все PASS. Fixer подтвердил, что тест ловит регрессию: с баговым `value` падает, после фикса зелёный.
- **Отмечено:** агрегаты стоимости (`cost_usd`, StatsTab/MessageStats/AuditLogPanel) намеренно НЕ тронуты — это этап C; отображение стоимости ходов/сессий пока остаётся с `$`. Функциональность этапа B (синк цен/лимитов: routerai `/models`+`/endpoints` → RUB; anthropic `max_input_tokens`/`max_tokens`; ollama контекст из `/api/show`; openai только id) ещё не реализована.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** этот (этап A).
