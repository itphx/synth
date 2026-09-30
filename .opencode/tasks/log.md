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

## 2026-09-22 (продолжение 9) — синхронизация цен/лимитов от провайдера, этап B
- **Задача:** этап B фичи валюты: получать цены и лимиты моделей прямо от провайдера, универсально для типов OpenAI/Anthropic/Ollama (учитывая, что реально отдаёт только RouterAI/OpenRouter-совместимые).
- **Тип:** feature (provider sync)
- **Исполнитель:** @orchestrator (research) → @fixer ×2 (B1 парсеры, B2 запись) → верификация @orchestrator
- **Результат:** PASS.
- **B1 (парсеры, core):**
  - `providers/base.ts`: новый `DetailedModelInfo` (`contextWindow?`, `maxOutputTokens?`, `input/output/cacheRead/cacheWritePrice?` уже за 1M, `priceUnit?`, `name?`, Ollama-метаданные), helper `parseTokenPricing` (строки/числа, только unit=`token`, ×1e6, иначе `undefined`).
  - `openai.ts`: `listModelsDetailed()` — `context_length` + `pricing`/`pricing_units` (RouterAI/OpenRouter); официальный OpenAI → `{id}`.
  - `anthropic.ts`: официальный Anthropic — `max_input_tokens`→context, `max_tokens`→max output, `display_name`→name (nullable); RouterAI-каталог (`pricing`/`context_length`) разбирается тем же парсером.
  - `ollama.ts`: контекст из `/api/tags`, fallback `POST /api/show` (первые 50 моделей, 10с, best-effort), метаданные size/parameter_size/quantization/capabilities; цен и max output у Ollama нет.
  - `gateway-provider.ts`: тип делегирования обновлён.
- **B2 (запись при sync, backend/UI):**
  - `ModelConfig.priceSource?: 'api'|'manual'|'unknown'` (shared).
  - `POST /models/fetch`: пишет `maxOutputTokens` (только из API и если ещё не задано) и токенные цены (`priceSource:'api'`), `currency` из провайдера (существующую явную валюту модели не перезаписывает). **Защита ручных данных:** `priceSource==='manual'` и старые цены без `priceSource` не перезаписываются.
  - Ответ расширен `priced`/`limited` (старые поля сохранены); UI `handleFetch` показывает цены/лимиты, ключи i18n в ru/en.
  - `POST /models` (backend и core) ставит `priceSource:'manual'` при наличии ценовых полей в теле; GET отдаёт `priceSource` аддитивно.
- **Проверки:** `pnpm typecheck` — 6/6 Done; `pnpm lint` — 0 errors; `pnpm build` — все пакеты + vite UI; `pnpm test` — shared 91, core **1636** (B1-тесты парсеров), backend **306** (+15 на fetch-мердж), ui 576 — все PASS.
- **Отмечено (follow-up):** в core (standalone) роута `/models/fetch` нет — синхронизация доступна только в managed backend. `currency` пробрасывается в runtime-конфиг провайдера как forward-compat, фабрикой пока не потребляется. `priceSource:'unknown'` зарезервирован. Не-token тарифы RouterAI (`request`/`second`/`image`) намеренно не маппятся.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** этот (этап B).

## 2026-09-22 (продолжение 10) — мультивалютные агрегаты стоимости, этап C + фикс падения UI
- **Задача:** этап C фичи валюты — агрегаты стоимости раздельно по валютам (решение пользователя), плюс визуальная проверка.
- **Тип:** feature (multi-currency) + bug fix (UI не монтировался)
- **Исполнитель:** @orchestrator (research) → @fixer ×3 (C1 ядро, C2a проброс UI, C2b панели, + фикс импорта) → верификация @orchestrator (в т.ч. браузер)
- **Результат:** PASS.
- **C1 (ядро):** `UsagePricing.currency?`/`UsageCost.currency` (`pricing.currency ?? 'USD'`); `metadata.cost_currency` рядом с `cost_usd`; `cost_currency` в `stream.usage/done/cancelled`, `subagent.progress`; агрегаты `/sessions/:id/stats` отдают `cost_by_currency` (+ прежний `cost_usd`); загрузчики цен валюту резолвят `model.currency → provider.currency → USD`. `cost_usd` сохранён (номинальная сумма) для обратной совместимости.
- **C2a (UI-проброс):** `formatCost(cost, currency?)`; `costCurrency`/`cost_by_currency` протянуты через `transportStore`/`chatStore`/`statsSegments`/`subagentStats`.
- **C2b (отображение):** `formatCostMap(map, fallbackUsd)` — мультивалютный вывод `$0.03 · ₽2.10` (порядок USD → RUB → CNY → прочие); `StatsTab` (сессия/агенты/пользователи + live), `MessageStats` (ход и сабагенты), `StreamingPlaceholder`; `AuditLogPanel` больше не хардкодит `$`.
- **Найденная и исправленная регрессия:** `packages/ui/src/lib/currency.ts` (этап A) делал **value-импорт из корня** `@itphx/synth-shared`, который через `config/loader` тянет `node:fs/promises` → Vite external → **UI не монтировался (пустой экран)**. Переключено на лёгкий сабпас `@itphx/synth-shared/types`; проверено — других value-импортов корня в UI нет, `grep node:fs/promises` по собранному бандлу = 0.
- **Проверки:** `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm test` — shared 91, core **1643**, ui **596**, backend 306 — PASS. **Визуально в браузере** (`:5002`): страница монтируется, консоль без ошибок и без warning `"$3.28" cannot be parsed`; порядок вкладок правой панели — Сессия, Проект, Контекст, Статистика; в админке «Модели» кнопка валюты открывает поповер `₽ Рубль / $ Доллар / ¥ Юань`, инлайн-инпуты цен — числа без `$`; стоимость в «Статистике» отображается.
- **Отмечено (follow-up):** `cost_usd` — номинальная сумма разных валют (для совместимости), для отображения использовать `cost_by_currency`; `AuditEntry` валюту не хранит (аудит всегда USD); `Session.inputCost/...` валюту не несут (вне рамок); у моделей routerai цены пока 0 и валюта `$`, пока у провайдера не задана валюта и не выполнен sync.
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** `bd84b7f` (фикс импорта), этот (этап C).

## 2026-09-22 (продолжение 11) — валюта провайдера: поле по умолчанию USD
- **Задача:** «Выбранная валюта не сохраняется в карточке провайдера; и пусть поле не будет пустым — всегда значение по умолчанию, в списке USD помечено по умолчанию, без отдельного пункта.»
- **Тип:** UX-правка (UI) + диагностика
- **Исполнитель:** @orchestrator (диагностика) → @fixer → верификация @orchestrator (браузер)
- **Результат:** PASS.
- **Диагностика «не сохраняется»:** код сохранения корректен. Причина — **dev-бэкенд запущен старым**: `scripts/dev.sh` поднимает `tsx packages/backend/src/main.ts` **без `--watch`**, процесс работал с 21 сен и не подхватил поля `currency` (этапы A/B/C). Проверено на свежем инстансе (порт 5055): `POST /providers {currency:'RUB'}` → сохранён в `data/providers/routerai.json` и возвращается в GET. **Чтобы новые поля заработали, backend нужно перезапустить** (`./scripts/dev.sh backend` пересобирает core и стартует заново).
- **Сделано (UX):** `ProvidersPanel` — `currency` всегда `'USD'` (новый и при отсутствии сохранённой); в body уходит `form.currency` без `|| null`; из селекта убран пункт «Не задано», `USD` помечен «(по умолчанию)». i18n: удалён `admin.providers.currencyNone`, добавлен `admin.providers.currencyDefault` (ru/en). Тесты обновлены.
- **Проверки:** `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm test` — shared 91, core 1643, ui **600**, backend 306 — PASS. Браузер: в карточке routerai поле «Валюта по умолчанию» = `USD`, список — `₽ Рубль / $ Доллар (по умолчанию) / ¥ Юань`, пункта «Не задано» нет.
- **Отмечено:** в `data/providers/routerai.json` в ходе проверки (на свежем инстансе) проставлена `currency: "RUB"` — корректно для RouterAI; при желании можно сменить в UI. Рекомендация на будущее: добавить `tsx watch` в `scripts/dev.sh` для бэкенда, чтобы правки не требовали ручного перезапуска (правка окружения — по согласованию).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** этот.

## 2026-09-22 (продолжение 12) — формат стоимости: символ после числа
- **Задача:** «на вкладке Статистика везде где есть цены писать не `~₽0.0627`, а `~ 0.0627 ₽`».
- **Тип:** UI-правка формата
- **Исполнитель:** @fixer → верификация @orchestrator (браузер)
- **Результат:** PASS.
- **Сделано:** `formatCost` собирает `~ ` + число + ` ` + символ; `formatCostMap` — склейка `~ 0.03 $ · ~ 2.10 ₽`. Обновлены doc-примеры (`formatStats.ts`, `statsSegments.ts`, `MessageStats.tsx`) и ожидания тестов (`formatStats.test.ts`, `StatsTab.test.tsx`, `MessageStats.test.tsx`, `StreamingPlaceholder.test.tsx`). `formatMoney`/`formatTokens` не тронуты.
- **Проверки:** `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm test` — shared 91, core 1643, ui 600, backend 306 — PASS. Браузер: в «Статистике» `~ 0.0343 $`, `~ 1.16 ₽`, `~ 0.2087 ₽` (мультивалютная разбивка работает).
- **Ветка:** `feat/ad-071-mcp-tools-scope`
- **Коммит:** этот.

## 2026-09-23 — сборка и деплой 0.7.0 на K3s (test)
- **Задача:** «Собери и задеплой на K3s». Решение пользователя: количество изменений тянет на **0.7.0** (minor), оба образа (backend + ui).
- **Тип:** build + deploy (release)
- **Исполнитель:** @orchestrator (ops)
- **Результат:** PASS.
- **Что сделано:**
  - **Bump:** `./scripts/version-bump.sh minor` 0.6.1 → **0.7.0** (`version.ts` + 6 `package.json` + `charts/synth/Chart.yaml`); коммит `1a18020 chore: bump version to v0.7.0` в ветке, тег `v0.7.0` локально (в gitverse origin не пушили — K3s-деплой этого не требует).
  - **Сборка:** `./scripts/build.sh` — shared → core → ui (vite, `index-C8j09cBO.js` / `index-ZHR84O4u.css`) → synth; всё успешно.
  - **Docker:** собраны из исходников и запушены в Gitea-реестр `git.itphx.ru/itphx/synth-backend:0.7.0` (`sha256:f4310922…`) и `git.itphx.ru/itphx/synth-ui:0.7.0` (`sha256:da564809…`) через `docker/Dockerfile.backend` / `docker/Dockerfile.ui`.
  - **Деплой:** теги в `synth-deploy/values.yaml` 0.6.1 → 0.7.0; `helm lint` OK; коммит `77f11e1 release: bump synth-ui/backend images to v0.7.0`, push `main` (`ee2e79f..77f11e1`) → Fleet.
- **Проверки:** Fleet GitRepo `synth` (fleet-local) синхронизировался на `77f11e1`, bundle Ready 1/1; `synth-backend` и `synth-ui` раскатаны на 0.7.0, новые поды `1/1 Running`; `https://synth.k3s.itphx.loc/` → HTTP 200, `/health` → `{"status":"healthy","version":"0.7.0"}`, `index.html` → `cache-control: no-cache`, отдаются ассеты свежей сборки; логи backend без ошибок (штатный 401 на `/api/v2/events` без аутентификации).
- **Замечания:** push ветки/тега `synth` в gitverse origin и npm-публикация не выполнялись (не входили в задачу). `synth-backend` перезапущен — сессии сохранены на PVC. Ветка: `feat/ad-071-mcp-tools-scope`.

## 2026-09-23 (продолжение) — аудит кода master..HEAD: дубли, мёртвый код, костыли, антипаттерны
- **Задача:** «Провести подробное исследование кода на предмет дублей, мёртвого/неоптимального кода, костылей и антипаттернов; особенно среди последних изменений относительно master».
- **Тип:** research (code audit)
- **Исполнитель:** @orchestrator → 5 параллельных исследовательских потоков (core A/B, backend+shared, ui/components, ui/stores+lib) + перепроверка находок высокой важности.
- **Результат:** PASS (отчёт). Диапазон `origin/master..HEAD` — 102 коммита, 317 файлов, +38 820/−4 243 строк.
- **Нарушений жёстких инвариантов не выявлено**; главная системная проблема — **дублирование backend↔core, которое уже расходится**.
- **Высокая важность (подтверждено мной):**
  1. **Дрейф сериализации** backend/lib/serialize.ts vs core/server/serialize.ts: backend теряет `session.todos`, `origin:'local'`, `message.id/seq/parts`, `project.origin` → на managed-backend UI не получает todos/мультимодальные parts/ids.
  2. **Runtime-политика network MCP не применяется при старте**: `mergeMcpNetworkPolicy` (`core/storage/runtime-settings.ts:108`) не вызывается; `GET /settings/mcp-network-policy` отдаёт runtime, а менеджер исполняет config → рассинхрон безопасности после рестарта.
  3. **Двойная обёртка GatewayProvider** на пути роутера: `ProviderPool.getProvider`→`_applyGateway` + `_routeProvider`→`_wrapWithGateway` (`orchestrator.ts:3326`) → двойной rate-limit/guard/аудит, внутренний аудит с пустыми sessionId/userId.
  4. **`askTimeoutMs` читается из `synth.security`** через `as unknown as` (`backend/app.ts:572`), а поле — в `permission` (`shared/types/permission.ts:29`) → всегда `undefined`.
  5. **`task-resume` теряет MCP-скоуп и `modelPriceLoader`**: `getToolsForAgent(agentDef.id)` без серверов, в `SubagentResumeDeps` нет полей (нарушение AD-071 §2.1).
  6. **Legacy MCP `/servers`** пишет в `YamlMcpConfigStore` в обход реестра `McpRegistryStore`; `syncManagerConfig` затирает правки; UI legacy-методы не вызывает.
  7. **UI: две расходящиеся реализации форматирования денег** (`formatMoney` vs `formatCost`), неизвестная валюта маскируется под `$`, `formatMoney` без тестов; live-агрегат сабагентов складывает разные валюты и показывает `$`.
  8. **UI: двойной источник локали** (`useUIStore.locale` неперсистентный vs `useI18nStore` персистентный) + ручная синхронизация в 4 местах.
  9. **UI: `MicroFirstDefaults` пишет в localStorage-ключ, который никто не читает** (write-only панель).
 10. **UI: прямой `fetch` в обход `synthApi`** (`SessionsPanel.tsx:29`) и 14 мест с литеральным `/api/v2` через `fetchJSON` в админке.
- **Средняя/низкая (сводно):** 4 копии `parseCurrency`, дублирование роутеров sessions/providers/models backend↔core, `isInternalOrigin` дублирует и ослабляет core network-policy, N+1 в `McpRegistryStore` (5 чтений JSON на мутацию), последовательные 50× `POST /api/show` в Ollama, `clearTimeout` не в `finally`, ~60 строк дублей `getPromptInfo`↔`_processMessage`, двойной подсчёт `_getAssistantSecrets`, `key={index}` в редактируемых списках, debounce-таймеры без cleanup, дубли MCP-панелей, мёртвые экспорты/методы (`filterByCapabilities`, legacy `synthApi.getMcpServers*`, `addStreamError`/`errorBySession`, мёртвые пропсы Kit, `TaskExtra.sessionSettings`, `McpScopeDecision.enabledByDefault`, `getServerInfo`, `buildSystemPrompt`, `PayloadLogger`-класс и др.), хардкод `[CLASSIFICATION]`/`/4`/60-120/`toLocaleString('ru')`, `as unknown as`/`as never`/`!`.
- **Признано НЕ проблемой:** `backend/events/hub.ts` vs core `EventBus` (разные роли), RBAC vs tool-permissions, `resolveMcpScope` переиспользуется из core, `McpRegistryStore` пишет атомарно (AD-005), обфускация/guard не обходятся, идемпотентность `compose()` корректна.
- **Коммит:** нет (изменений кода не вносилось).

## 2026-09-23 (продолжение) — исправление дефектов по итогам аудита (4 потока + верификация)
- **Задача:** «Внести отчёт в лог и начать исправление всех проблем. Не ленись — не полумеры, делай как правильно. Не забудь протестировать».
- **Тип:** bug fix + refactor + dead-code cleanup (по всему монорепо)
- **Исполнитель:** @orchestrator → @fixer ×6 (зоны: ядро/движок; backend+shared+core-server/storage/remote; UI; core/providers; UI-остаток; network-policy helper) + оркестратор (верификация).
- **Результат:** PASS. **125 файлов изменено, +2888/−3563** (нетто −675 строк), 14 новых файлов.
- **Исправлено (ключевое):**
  1. **Сериализация:** удалён устаревший `backend/src/lib/serialize.ts` (терял `todos`, `origin`, `message.id/seq/parts`) — backend импортирует core-сериализатор; устранён дрейф managed↔standalone.
  2. **Runtime network-policy MCP:** на старте backend и core применяется `mergeMcpNetworkPolicy(config, runtime)` (helper экспортирован и стал единым источником; inline-дубль убран); добавлен интеграционный тест + unit-тесты helper.
  3. **Двойная обёртка `GatewayProvider`:** `_routeProvider` не оборачивает повторно, если провайдер уже `GatewayProvider`; регрессионный тест.
  4. **`askTimeoutMs`:** читается из `synth.permission` (был `security` через `as unknown as` → всегда `undefined`).
  5. **`task-resume`:** прокинуты `mcpServers` и `modelPriceLoader` (наследование MCP-скоупа по AD-071 §2.1 + учёт стоимости).
  6. **Legacy MCP `/servers*`:** переписаны как тонкие адаптеры над `McpRegistryStore`; удалены `McpConfigStore`/`YamlMcpConfigStore`-путь (второго источника истины нет).
  7. **`McpRegistryStore` N+1:** добавлен `toManagerMaps()` (одно чтение на мутацию), переиспользован в backend app + syncManagerConfig.
  8. **Дубли валидации/утилит:** `isCurrency/parseCurrency/hasPriceInput/renderIcon/getFaviconUrl/createResolveAuthorName` вынесены в shared и переиспользованы; невалидная валюта → `VALIDATION_ERROR` (вместо тихого игнора).
  9. **`isInternalOrigin`:** заменён на core `evaluateMcpNetworkAccess`/CIDR (с DNS-резолвом и более полными диапазонами).
  10. **Дубли констант/схем:** единый `[...DEFAULT_MCP_PRIVATE_CIDRS]`; `createToolsDisabledSchema`; канонические `projectMcpUpdateSchema`/`sessionMcp*` в shared; удалены мёртвые `projectMcpSettingsSchema`, `ToolsDisabledRequest`, `StreamUsagePayload`.
  11. **RBAC/доступ:** `/prompt`, `/stats`, `/status` закрыты guard'ом владелец/ADMIN; `isAdmin` → `hasRole`.
  12. **`events/hub`:** типизированные payload-интерфейсы вместо магических ключей `unknown`.
  13. **Ядро/движок:** удалены мёртвые `filterByCapabilities`, `TaskExtra.sessionSettings`, `McpScopeDecision.enabledByDefault`, `getNetworkPolicy`/`getServerInfo`/`McpServerInfo`, `ContextBuilder.buildSystemPrompt`, класс `PayloadLogger`; сняты лишние публичные экспорты `network-policy`; вынесены `tool-execution.ts` (`buildDenyResult`/`executeToolDef`), `_poolGatewayFactory`, `_resolveMcpServerStatus`, `_buildToolSelection`/`_buildComposerContext`, общий `estimatePromptChars`; `dataDir`-заглушка, `_classifyError`, неиспользуемый `_publishChunk`, двойной каст `reasoning` убраны; `doomCount` → `MAX_DOOM_LOOP_COUNT`; кеширование `_estimatePromptChars`/`_computeMessageCost`/`_loadTokenRatio` за ход; `/4` → `estimateTokens(ratio)`; `[CLASSIFICATION]` вынесен в prompt-ассеты; проект читается один раз и передаётся в Composer.
  14. **Провайдеры:** Ollama-пробы контекста — батчи по 6 с общим дедлайном 20 с (вместо 50 последовательных); `clearTimeout` в `finally` во всех местах; общий `fetchModelsCatalog` в `base.ts`.
  15. **UI:** единый `formatMoney`/`formatCostMap` (неизвестная валюта — кодом, не `$`); live-сабагенты считаются `costByCurrency` (без смешивания валют); единый источник локали (`useI18nStore`); удалён write-only `MicroFirstDefaults`; весь API через `synthApi` (в т.ч. 14 мест `/api/v2` литералами); `SessionSettingsTab` — i18n + Kit-контролы; дедуп MCP-панелей (`McpRegistryForm`+`useMcpRegistryEditor`); `key={index}`→стабильные ключи; debounce/timer cleanup; `ProviderIcon`→`describeProviderIcon`; прямые мутации zustand→экшены; мёртвые методы `synthApi`, Kit-пропсы и экспорты удалены; i18n ошибок сторов; parity-тест en↔ru; общие `InfoSection`/`InfoField`/`ModelPairSelect`/`ExpandToggle`; `resetChatStore` тест-хелпер.
- **Верификация (оркестратор, последовательно):**
  - `pnpm typecheck` — 6/6 пакетов Done, 0 ошибок.
  - `pnpm lint` — 0 ошибок (107/147/33 warning — предсуществующие `any` вcore/backend/ui).
  - `pnpm test` — shared 91, **core 1659**, **ui 602**, **backend 294**, runner без тестов — все PASS.
  - `pnpm build` — все 6 пакетов успешно (vite UI + tsup CLI).
- **Осталось (сознательно не сделано в этой итерации):**
  - **Полная дедупликация роутеров backend↔core** (`providers/models/sessions`) на уровне хендлеров — убраны утилиты/`resolveAuthorName`, но сами роуты остаются форками (риск для RBAC/контрактов; нужна отдельная задача с фабрикой `registerCore*Routes` и сохранением `requireAuth`/`requireAdmin`).
  - Обновление `AGENTS.md` пакетов `backend`/`core` (устаревшие упоминания `lib/serialize`, `lib/mcp-config-store`) — по инварианту 15 правки инструкций согласовываются с пользователем.
- **Коммит:** `27a0bc0` refactor: устранение дублей, мёртвого кода и дефектов по итогам аудита ветки AD-071 (142 файла, +3738/−3566). Ветка: `feat/ad-071-mcp-tools-scope`. Push в origin не выполнялся.

## 2026-09-23 (продолжение) — ТД-1: дедупликация роутеров backend ↔ core (providers/models/sessions)
- **Задача:** «Давай разберемся с тех. долгами» → закрыть единственный задокументированный техдолг ТД-1 (полная дедупликация роутеров `providers`/`models`/`sessions`; backend-роуты — тонкие обёртки над core-фабриками; RBAC и контракты `docs/API_V2.md` неизменны). Решение пользователя: делать обе фазы (A, затем B).
- **Тип:** refactor (дедупликация) + verification
- **Исполнитель:** @orchestrator → @explore ×3 (карта diff), @fixer ×4 (A: providers/models; RBAC-тесты; B1: core-фабрика sessions; B2: backend-обёртка), верификация @orchestrator.
- **Результат:** PASS. Итог: backend `sessions.ts` 941 → 467, `models.ts` 385 → 181, `providers.ts` 231 → 139; общая логика — в core-фабриках. `git diff --stat`: 15 файлов, +686/−972 (нетто −286; из них +151 — новые RBAC-тесты).
- **Фаза A — `providers`/`models`:**
  - Core-фабрики параметризованы (образец `createDictionaryRoutes`/`createSettingsRoutes`): структурный auth-контракт `{requireAuth: Middleware}`, `ProviderRoutesOptions` (`writeGuard`/`detailGuard`/`testEnabled`/`testGuard`/`testMiddleware`/`messages`), `ModelRoutesOptions` (+`writeGuard`/`providerCache`/`supportSetAsDefault`/`messages`), `ProviderRouteMessages`/`ModelRouteMessages` (функции `(c)=>string`; core — русские литералы, backend — `t()`).
  - `set_as_default` перенесён в core под флаг `supportSetAsDefault` (core — false, backend — true); backend-only `POST /providers/fetch-icon` и `POST /models/fetch` остались в backend.
  - Типовая совместимость хранилищ: `JsonStoreLike<T>` в core (backend/core — разные классы с приватным полем).
  - Добавлены постоянные RBAC-регресс-тесты (+11: `providers.test.ts` 7, `models.test.ts` 4; в т.ч. rate limit 5/60с → 429).
- **Фаза B — `sessions`:**
  - **B1:** core `createSessionRoutes(auth, deps, opts)` — deps-объект (`SessionRoutesDeps`, гибридный `getRemoteClient` внутри), опции `SessionRoutesOptions`: `resolveUserId`/`resolveOwner`/`forkWithOwner`/`canAccess`/`resolveAuthor`/`promptMessageId`/`publishRenamed`/`publishDeletedBefore`/`onSessionCreated`/`onSessionDeleted`/`onSessionForked`/`promptMiddleware`/`enableSessionEvents`/`messages`. Все remote/hybrid-ветки активны только при переданном `getRemoteClient` (managed backend их не получает). Поведение core не изменилось.
  - **B2:** backend `sessions.ts` — обёртка: `canAccess` = владелец|ADMIN, `resolveUserId/Owner/Author`, `promptMessageId:'stream'`, `publishRenamed:false`, `publishDeletedBefore:false`, EventHub-хуки, rate limit 30/60с, `enableSessionEvents:false`; backend-only (дословно) — MCP-скоуп сессии, secrets, export/import, debug-system-message, optimization ×4, notes ×4.
  - Найдено и исправлено при переносе: (1) core публиковал `session.created`/`session.fork.created` **до** EventHub-хуков → `EventBus` не буферизует, событие терялось (падал `backend/integration/hybrid.integration.test.ts`); порядок изменён на hook→publish (для core без хуков поведение неизменно); (2) backend `ProjectStore` несовместим по типу с core-классом → добавлен `ProjectStoreLike`; (3) `GET /:id/events` (core-only) гейтится `enableSessionEvents`, на backend не регистрируется.
  - `filterByProject` удалён: `SessionManager.listSessions({userId})` при заданном `userId` игнорирует `projectId`, поэтому backend `?project_id=` — фактический no-op; поведение сохранено (латентный баг не «чинили»).
- **Верификация (оркестратор):**
  - `pnpm typecheck` 6/6; `pnpm lint` 0 errors (warnings предсуществующие); `pnpm build` 6/6; тесты: shared 91, core 1659, ui 602, backend 305 — зелёные. (`task-resume.test.ts` периодически флакует при параллельном прогоне монорепо — изолированно и повторно зелёный, к правкам не относится.)
  - **API-сравнение старого backend (:5000, старый код) и нового (temp :5055, новый код), общий data dir:** список сессий 275=275; 5 сессий × 13 эндпоинтов (`GET /:id`, status, messages, children, tree, references, prompt, stats, optimization, notes, mcp, export, events) — статусы и тела (jq-normalized) идентичны; `GET /:id/events` = 404 на обоих; RBAC идентичен (noauth 401; secrets user 403 / auditor 200 / admin 200; mcp не-владелец 403); error-пути (resume-subagent 400, merge/refs validation 400, mcp unknown 400) идентичны; `POST /` и `POST /:id/fork` — shape идентичен. Временные verify-сессии удалены (count вернулся к 275), temp-backend остановлен, основной dev :5000 не тронут.
  - **Зафиксированный малый дрейф:** `POST /sessions` на managed backend теперь отдаёт `owner_id = user.id` (было `null`, т.к. `SessionManager.createSession` игнорировал `ownerId`); core-фабрика выставляет владельца явно. Функционально эквивалентно (доступ по `ownerId ?? userId`), тесты не завязаны; зафиксировано в журнале.
- **Не сделано/отложено:** обновление `AGENTS.md` (снять ТД-1, отметить паттерн core-фабрик в backend/core) — по инварианту 15 согласуется с пользователем.
- **Ветка:** `feat/ad-071-mcp-tools-scope`. **Коммит:** `349aab2d` refactor(routes): дедупликация backend↔core (ТД-1) и настраиваемый агент по умолчанию (общий коммит: ТД-1 и агент связаны общими файлами `app.ts`/`sessions.ts`).

## 2026-09-23 (продолжение) — Баг: reasoning не отображался у OpenAI-совместимого провайдера (RouterAI)
- **Задача:** «Перестали отображаться размышления» при работе с провайдером типа OpenAI; у Anthropic всё работает. Сессия «Ответ на загадку про трубу» (`mudn8wk5-2yw-r6nzkpnb`).
- **Тип:** bug fix
- **Исполнитель:** @orchestrator (диагностика) → @fixer → верификация @orchestrator (E2E).
- **Результат:** PASS.
- **Диагностика (доказано):**
  - В сессии сообщения с provider `routerai` (type openai) имели `usage.reasoning_tokens` (155, 1349), но `reasoning` пуст; у `routerai-anthropic` reasoning 1924 символа. По всей истории (279 сессий) у `routerai` reasoning **никогда** не сохранялся; reasoning есть только у `itphx` (`type: openai`, DeepSeek/qwen через `reasoning_content`), `omn`, `routerai-anthropic`.
  - Прямая проверка SSE RouterAI (`https://routerai.ru/api/v1`): reasoning приходит в **`delta.reasoning`** (формат OpenRouter), а `openai.ts` читал только **`delta.reasoning_content`** (формат DeepSeek). Текст терялся, `reasoning_tokens` считался из `usage` — отсюда расхождение.
  - **Не регрессия ТД-1:** `openai.ts` не менялся нашими правками (reasoning-парсинг не менялся с 27 авг); совпадение по времени — из-за перезапуска dev (старый процесс с 21 сен не подхватывал изменения ветки). Вероятная причина «перестало» — RouterAI сменил поле ответа на `reasoning`.
- **Fix (`packages/core/src/providers/openai.ts`):** стриминг читает оба поля — приоритет `reasoning_content` (сохранён DeepSeek/`itphx`, включая quirk-фильтр `.`/`.\n`), иначе `reasoning` (RouterAI/OpenRouter, без фильтра); пустые `""` пропускаются; `firstChunkReceived`/`clearTimeout` выставляются на первом reasoning-чанке. Non-stream `_parseResponse`: `message.reasoning_content ?? message.reasoning`. Echo-back `reasoning_content` в `_formatMessages` не тронут.
- **Проверки:** `pnpm typecheck` 6/6; `pnpm lint` 0 errors; core **1666** тестов (+7 новых: RouterAI-стрим, DeepSeek-регресс, пустой reasoning, приоритет полей, точка в `reasoning`, non-stream оба формата) — зелёные (флак `task-resume` при параллельном прогоне, изолированно/повторно зелёный). **E2E** (dev :5000, новый код): временная сессия `routerai`/`qwen/qwen3.7-flash` → prompt «2+2?» → 12 reasoning-событий в SSE, сохранено `reasoning_len=97`, `reasoning_tokens=25`, ответ «4»; сессия удалена. Dev перезапущен (`dev.sh all`), :5000/:5002/:4300 = 200.
- **Замечание:** `remote.ts` (гибрид) не трогали — backend LLM Proxy нормализует `chunk.reasoning` → `delta.reasoning_content`.
- **Ветка:** `feat/ad-071-mcp-tools-scope`. **Коммит:** `89497403` fix(providers): reasoning у OpenAI-совместимых провайдеров (RouterAI/OpenRouter).

## 2026-09-23 (продолжение) — Агент: фикс сброса выбора + настраиваемый агент по умолчанию
- **Задача:** «после первого сообщения выбранный агент (Ассистент) заменяется на Разработчика; почему Разработчик стал агентом по умолчанию; где задаётся». Решения пользователя: (1) фикс UI; (2) добавить настройку в раздел «Агенты» (dropdown, дефолт при первом развёртывании — Ассистент, по правилам Settings Kit).
- **Тип:** bug fix + feature (настройка)
- **Исполнитель:** @orchestrator (диагностика) → @fixer ×3 (UI-фикс; core/backend; UI-контрол) → верификация @orchestrator (API/E2E).
- **Результат:** PASS.
- **Диагностика:** дефолт жёстко зашит `DEFAULT_AGENT_ID='developer'` (`engine/agents/index.ts`), отдаётся `GET /agents` как `default_agent` (session_id игнорируется). Сброс выбора — три давних бага: `AgentModeSelector` сохранял `settings.agent_role` (snake_case) вместо `agentRole` (camelCase) → PATCH не менял агента; `ChatTab` восстанавливал из `s.agent_role` (нет такого поля); `agentsStore.loadAgents` каждый раз ставил `activeAgentId=default_agent`, а `ChatInput` после первого сообщения перемонтируется (две ветки рендера) → селектор возвращался к дефолту. Плюс «сброс» искал хардкод `'assistant'`. Не связано с ТД-1.
- **Фикс UI:** `AgentModeSelector` — `settings.agentRole`, `defaultAgent` по `defaultAgentId` из стора; `ChatTab` — чтение `s.agentRole`; `agentsStore.loadAgents` — `activeAgentId: s.activeAgentId ?? default_agent` (не затирает выбор). +6 тестов.
- **Настройка (core/backend):** `RuntimeSettingsStore.defaultAgent` + get/set/clear; `GET/PUT/DELETE /api/v2/settings/default-agent` (fallback `DEFAULT_AGENT_ID`); `DEFAULT_AGENT_ID` → **`'assistant'`**; `createAgentRoutes` принимает `getDefaultAgentId`; `createSessionRoutes` — `opts.resolveDefaultAgent` для создания сессии; wiring в core/backend `app.ts`; `chat.ts` (CLI) берёт эффективный дефолт. +24 теста. `docs/API_V2.md` дополнен.
- **Настройка (UI):** `synthApi.getDefaultAgentInfo/setDefaultAgent/resetDefaultAgent`; в админ-разделе «Агенты» — `SettingsSection` «Агент по умолчанию» (`SelectField` primary-агентов + `SettingsActions` Save/Cancel/Reset по AD-072, без автосохранения, Reset серый при `isDefault`); после save/reset — `loadAgents()` (обновляет `defaultAgentId` в чате); i18n ru/en. +8 тестов.
- **Проверки:** `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm build` 6/6; тесты shared 91, core 1683, ui 616, backend 312 — зелёные. **E2E** (dev :5000): `GET /settings/default-agent` → `assistant`; `GET /agents.default_agent` → `assistant`; `POST /sessions` без agentRole → `agentRole='assistant'`; `PUT 'developer'` → agents/сессия используют `developer`; `DELETE` → restore `assistant`; невалидный id → 400. **UI (Playwright, :5002, admin):** в разделе «Агенты» блок «Агент по умолчанию» — combobox `assistant`, список primary-агентов (Аналитик/Ассистент/Аудитор/Разработчик/DevOps/PM/QA); при дефолте Reset/Save/Отмена неактивны, после выбора другого — активируются, «Отмена» возвращает `assistant`. Dev перезапущен (`dev.sh all`), :5000/:5002/:4300 = 200.
- **Документация:** корневой `AGENTS.md` — строка `/settings/default-agent` в таблице runtime-настроек.
- **Замечание:** `DEFAULT_AGENT_ID` сменён `developer`→`assistant` (решение пользователя, отменяет дефолт из `82bfdbe2`). Настраиваемое значение — runtime-настройка, config.yaml-поля пока нет.
- **Ветка:** `feat/ad-071-mcp-tools-scope`. **Коммит:** `349aab2d` (общий с ТД-1).

## 2026-09-23 (продолжение) — Визуальные правки: панели «Сессия»/«Проект» и раздел «Агенты»
- **Задача:** 5 визуальных правок: (1) правая панель, вкладка «Сессия» — выбор политик выпадающим списком; (2) настройки → «Агенты» — в селекте агента по умолчанию отображать имя; (3) там же — toggle не переносится на новую строку, текст (имя+id) может переноситься, мобильный не сломан; (4) правая панель, «Сессия» — добавить имя проекта, ID показывать полностью; (5) панели «Сессия»/«Проект» — добавить создателя и дату/время создания.
- **Тип:** feature (UI)
- **Исполнитель:** @orchestrator (investigate) → @fixer ×1 → верификация @orchestrator (typecheck/lint/test + Playwright).
- **Результат:** PASS.
- **Правки (`packages/ui`):**
  - (1) `SessionSettingsTab.tsx` — per-session `toolsPolicy`/`mcpPolicy` переведены с `SegmentedControl` на `SelectField` + `SelectContent/SelectItem` (AD-072), `ariaLabel` сохранён.
  - (2) `ui/select.tsx` + `ui/settings/controls/SelectField.tsx` — добавлен необязательный проп `items` (пробрасывается в Base UI `Select.Root`); `AgentsPanel.tsx` — селекту агента по умолчанию передан `items` primary-агентов → триггер показывает `display_name` («Ассистент»), а не id. Причина: без `items` Base UI `Select.Value` не резолвит label и рендерит сырое value.
  - (3) `AgentsPanel.tsx` — шапка карточки: убран `flex-wrap`, `items-start`, левый блок `min-w-0 flex-1` (имя `break-words`, id `break-all`), блок Toggle `shrink-0` — переключатель не уезжает на новую строку.
  - (4) `SessionSettingsTab.tsx` — ID без обрезки; имя проекта резолвится из `useProjectsStore` (с догрузкой `getProject` при отсутствии), fallback — `project_id`/«—». `ui/settings/InfoField.tsx` — длинные значения переносятся (`items-start gap-2 min-w-0 break-words text-right`).
  - (5) `lib/formatDate.ts` — хелпер `formatDateTime(iso, locale)`; `SessionSettingsTab`/`ProjectTab` — поля «Создатель» (`user_id||owner_id` / `owner_id`) и «Создан» (дата+время). i18n ru/en: `rightPanel.params.creator/created`, `projectTab.info.creator/created`.
- **Тесты:** переписан describe per-session политик в `SessionSettingsTab.test.tsx` (radiogroup → Base UI `selectOption` через `[role="option"]` в portal, образец `McpSettings.test.tsx`).
- **Проверки (оркестратор):** `pnpm --filter @itphx/synth-ui typecheck` — OK; `lint` — 0 errors (warning предсуществующие `any` в `LeftPanel.tsx`); `test` — **76 файлов / 616 тестов PASS**. **UI (Playwright, :5002, admin):** политики — combobox «Как в глобальной»; селект агента по умолчанию показывает «Ассистент»; у всех 14 карточек toggle в одной строке с именем и внутри карточки (в т.ч. «Банковский ассистент (Adv)»); мобильный 390px — одна колонка, toggle в строке, без горизонтального overflow; вкладка «Сессия» — полный ID, «Проект: Тестовый проект», «Создатель: admin», «Создан: 06.08.2026, 07:14»; вкладка «Проект» — «Имя: Тестовый проект», полный ID, «Создатель: admin», «Создан: 21.05.2026, 15:11».
- **Замечания:** коммит не делался (нет явной просьбы пользователя). `SegmentedControl` оставлен (используется в других местах).

## 2026-09-23 (продолжение) — Имя сессии над ID в правой панели
- **Задача:** в правой панели на вкладке «Сессия» не отображалось имя сессии; по аналогии с проектами показывать имя над ID.
- **Тип:** feature (UI) · **Исполнитель:** @fixer → верификация @orchestrator · **Результат:** PASS.
- **Правки (`packages/ui`):** `SessionSettingsTab.tsx` — первым полем секции «Сессия» добавлено `Field label={t('rightPanel.params.name')} value={session.name || '—'}` перед ID; i18n ru/en — ключ `rightPanel.params.name` («Имя»/«Name»); `SessionSettingsTab.test.tsx` — +2 теста (имя над ID через `compareDocumentPosition`; `name: null` → «—»).
- **Проверки:** typecheck OK; lint 0 errors; test 618/618. Playwright: `Имя: llm-gw-2` → `ID: msgvufwl-37d-llddm7h1` → Проект → Создатель → Создан → Движок.

## 2026-09-23 (продолжение) — Live-статистика стрима: инлайн → кнопка с попапом
- **Задача:** пока стримится ответ, в области ответа появлялась инлайн-строка статистики — убрать её и добавить кнопку, открывающую попап со статистикой, аналогичную кнопке в законченных ответах.
- **Тип:** feature (UI) · **Исполнитель:** @fixer → верификация @orchestrator · **Результат:** PASS.
- **Правки (`packages/ui`):**
  - новый `components/chat/StatsPopoverButton.tsx` — поповер с кнопкой-иконкой `chart-line` (title `chat.messageStats.toggle`) и `PopoverContent` с эталонными классами (`side="top" sideOffset={12} align="start" min-h-[34px] …`);
  - `MessageActions.tsx` — инлайн-поповер статистики заменён на `StatsPopoverButton` (убраны `useState`/импорты `Popover*`), поведение готовых ответов не изменилось;
  - `StreamingPlaceholder.tsx` — удалён инлайн-ряд `stream-live-stats`; в футере стрима перед Stop добавлена кнопка `StatsPopoverButton` (при `liveSegments.length > 0`), содержимое попапа — те же сегменты (`buildUsageSegments`) с `data-testid="stream-live-stats"`; retry-ветка не тронута;
  - `StreamingPlaceholder.test.tsx` — тесты: инлайна нет, есть кнопка `button[title="Response stats"]`, контент ищется в `document.body` после клика; без usage/cost — кнопки нет.
- **Проверки (оркестратор):** `typecheck` OK; `lint` 0 errors (33 предсуществующих warning); `test` **76 файлов / 618 тестов PASS**. **UI (Playwright, :5002):** 0 console errors; регресс-проверка общего поповера на готовых сообщениях — клик по 13 кнопкам `Статистика ответа` рендерит `message-stats` («2.6k вх·213 исх·0% кэш») в portal (`data-align=start`, `data-side=top`). Живой стрим LLM не гоняли (политика Verify — без явной просьбы); поведение стрима покрыто компонентными тестами `StreamingPlaceholder`.
- **Замечания:** коммит не делался (нет явной просьбы). В рабочем дереве также незакоммиченное изменение «Имя сессии над ID» (см. выше).

## 2026-09-23 (продолжение) — Регресс отображения: tool-вызов появлялся только после завершения инструмента
- **Задача:** во время стрима блок вызова инструмента появлялся лишь когда инструмент завершится; ожидалось — сразу по вызову модели.
- **Тип:** bug fix (UI) · **Исполнитель:** @orchestrator (investigate) → @fixer → верификация @tester · **Результат:** PASS.
- **Причина:** `StreamingPlaceholder` (рисует live `stream.toolCalls`) монтируется только для стримов из фильтра `isStreaming && hasContent` (`MessageList.tsx:108`), а `hasContent` выставлялся лишь в `chatStore.updateStreamChunk` при непустом тексте/reasoning. `tool_call.started` → `addToolCall` добавлял вызов, но `hasContent` не трогал → при вызове инструмента без предшествующего текста/reasoning плейсхолдер не монтировался, блок «всплывал» только с приходом следующего текста (уже после инструмента). Регресс внесён `c11ece3f` («крутилка только после первого chunk»).
- **Правки (`packages/ui`):** `stores/chatStore.ts` — в `addToolCall` выставляется `hasContent: true` (+ обновлён JSDoc поля); `stores/chatStore.test.ts` — +3 теста; `stores/transportStore.subagent.test.ts` — +1 тест на диспетчер `tool_call.started`.
- **Проверки:** `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm test` shared 91, core 1683, ui 622, backend 312 — зелёные. Доказательство: со stash правки источника 4 новых теста падают, после возврата — проходят; дерево восстановлено (sha256 diff совпал). usage-only StreamState, дедупликация по callId, `finishStream`/`cancelStream` не сломаны.
- **Замечания:** коммит не делался (нет явной просьбы).

## 2026-09-23 (продолжение) — bump 0.7.1 + сборка + деплой на test (K3s)
- **Задача:** «Бампни версию до 0.7.1, собери все и залей на test оба образа».
- **Тип:** build + deploy (release) · **Исполнитель:** @orchestrator (ops) · **Результат:** PASS.
- **Bump:** `./scripts/version-bump.sh 0.7.1` 0.7.0→0.7.1 (`version.ts` + 6 `package.json` + `charts/synth/Chart.yaml`); коммит `27827a8 chore: bump version to v0.7.1`.
- **Сборка:** `./scripts/build.sh` — shared → core → ui (vite, `index-DmwzjNcL.js` / `index-9mOsvnNb.css`) → synth; версия бандла 0.7.1.
- **Docker:** собраны из исходников и запушены в Gitea `git.itphx.ru/itphx/synth-backend:0.7.1` (digest `sha256:0c8be594…`, 290 МБ) и `git.itphx.ru/itphx/synth-ui:0.7.1` (digest `sha256:8a6a11f5…`, 116 МБ) через `docker/Dockerfile.backend` / `docker/Dockerfile.ui`.
- **Деплой:** `synth-deploy/values.yaml` теги 0.7.0→0.7.1; `helm lint` OK; коммит `3649d6f release: bump synth-ui/backend images to v0.7.1`, push `main` (`77f11e1..3649d6f`) → Fleet.
- **Проверки:** Fleet GitRepo `synth` (fleet-local) синхронизирован на `3649d6f` (~40с), bundle Ready 1/1; `synth-backend` и `synth-ui` раскатаны на 0.7.1, новые поды 1/1 Running, старые удалены; `https://synth.k3s.itphx.loc/` → HTTP 200, `/health` → `{"status":"healthy","version":"0.7.1"}`, `index.html` → `cache-control: no-cache`, отдаётся ассет `index-DmwzjNcL.js` свежей сборки; логи backend — штатные `GET /health 200`.
- **Замечания:** push ветки/тега `synth` в gitverse origin и npm-публикация не выполнялись (не входили в задачу). `synth-backend` перезапущен — сессии на PVC сохранены.

## 2026-09-23 (продолжение) — выкат 0.7.2 на test (гибрид: reasoning + попап)
- **Задача:** «Выкати на test» — два незакоммиченных фикса (reasoning в LLM Proxy гибрида + «убегающий» попап создания сессии). Решение пользователя: 0.7.2, посторонние AD-073/074 не трогать.
- **Тип:** build + deploy (release) · **Исполнитель:** @orchestrator (ops) · **Результат:** PASS.
- **Коммиты (ветка feat/ad-071-mcp-tools-scope):** `a1a8408 fix(backend): reasoning стримится по чанкам в LLM Proxy гибрида` (3 файла); `f9a811c fix(ui): не терять якорь попапа создания сессии при наведении` (2 файла); `9ee2a88 chore: bump version to v0.7.2`.
- **Сборка:** `./scripts/build.sh` — shared → core → ui (vite, `index-Ctzk1c2F.js`) → synth; версия 0.7.2.
- **Docker:** запушены в Gitea `git.itphx.ru/itphx/synth-backend:0.7.2` (digest `sha256:3e01b666…`, 291 МБ) и `git.itphx.ru/itphx/synth-ui:0.7.2` (digest `sha256:a897879a…`, 116 МБ).
- **Деплой:** `synth-deploy/values.yaml` теги 0.7.1→0.7.2; `helm lint` OK; коммит `578bfd2 release: bump synth-ui/backend images to v0.7.2`, push `main` (`3649d6f..578bfd2`) → Fleet.
- **Проверки:** Fleet GitRepo синхронизирован на `578bfd2` (~30с), bundle Ready 1/1; оба деплоя на 0.7.2, новые поды 1/1 Running, старые удалены; `https://synth.k3s.itphx.loc/` → HTTP 200, `/health` → `{"status":"healthy","version":"0.7.2"}`, `index.html` → `cache-control: no-cache`, отдаётся `index-Ctzk1c2F.js` (совпадает с локальной сборкой).
- **Замечания:** посторонние `AGENTS.md`, `docs/arch_decisions/README.md`, untracked `ad-073-*`/`ad-074-*` намеренно не коммитились. npm-публикация и push ветки/тега `synth` в gitverse origin не выполнялись. `synth-backend` перезапущен — сессии на PVC сохранены.

## 2026-09-23 (продолжение) — мерж в master с --no-ff и релиз v0.7.2 (npm + GitVerse Release)
- **Задача:** «В dev и test всё выглядит неплохо. Сливай в master с `--no-ff` и выкатываем релиз. Собери информацию из журнала и описаний коммитов для Release note».
- **Тип:** release/ops · **Исполнитель:** @orchestrator · **Результат:** частично PASS (npm/Helm/GitVerse Release — да; Docker-образы — FAIL).
- **Проверка перед мержем:** `typecheck` 6/6; `lint` 0 errors (warnings предсуществующие); тесты shared 91 / core 1684 / backend 313 / ui 626 — PASS.
- **Мерж:** `merge --no-ff feat/ad-071-mcp-tools-scope` → merge-commit `bb77f51f` (родители `b24e304f`, `06cd0743`); push `origin master` (`b24e304f..bb77f51f`); аннотированный тег `v0.7.2` на `bb77f51f`, push тега → Release run #85 (`1624569`).
- **CI (run 1624569):** «CI проверки» ✅, «Сборка релизных артефактов» ✅, «Генерация CHANGELOG» ✅, «npmjs.org» ✅ (6 пакетов 0.7.2, `latest=0.7.2`), «GitVerse Package Registry» ✅, «Helm-чарт» ✅ (0.7.2).
- **FAIL 1 — Docker образ:** шаг «Сборка и публикация Docker образа synth (kaniko)» упал: `PATCH https://gitverse.ru/v2/itphx/synth/blobs/uploads/... → 413 Request Entity Too Large` (QRATOR). backend/ui пропущены (skipped). Образ synth собирается из глобального `npm install -g @itphx/synth` (крупный слой).
- **FAIL 2 — GitVerse Release:** шаг «Создать релиз» (`actions/create-release@v1`) упал: `403 Forbidden` при `get release by tag v0.7.2` (та же проблема была на v0.6.1). Обход: релиз создан/обновлён вручную через GitVerse API (MCP) — `Release v0.7.2`, id `548813190`, https://gitverse.ru/itphx/synth/releases/tag/v0.7.2; тело обновлено curated-заметками из журнала/коммитов. API отдаёт `draft: true` (снять draft через MCP не удалось — возможно, публикация через UI).
- **Release note:** полная версия — `tmp/release-notes-v0.7.2.md`; в тело релиза вошла сокращённая (WAF блокирует крупные POST к MCP).
- **Открытые вопросы:** Docker-образы 0.7.2 в gitverse отсутствуют; preprod-деплой (Helm + образы) без них неполон. Варианты: (а) перезапустить Docker-джобу в UI (413 может быть транзиентным); (б) уменьшить образ synth (multi-stage/prune); (в) публиковать только backend/ui (например, в `git.itphx.ru`).
- **Замечания:** master запушен; ветка `feat/ad-071-mcp-tools-scope` не удалялась. Коммит журнала не делался (только правка файла).

## 2026-09-23 (продолжение) — фикс Docker-слоя 413: multi-stage + чанкование зависимостей
- **Задача:** «Ошибка та же (413 при перезапуске Docker-джобы). Давай разбивать слои на более мелкие».
- **Тип:** fix (Docker/infra) · **Исполнитель:** @fixer → верификация @orchestrator (docker) · **Результат:** PASS (сборка/слои/рантайм), push не проверялся (нет кредов).
- **Диагностика:** текущий `docker/Dockerfile` (single-stage) — `RUN npm install -g @itphx/synth@${SYNTH_VERSION}` даёт **один слой 280 МБ** (135.4 МБ `node_modules` + 129.2 МБ `/root/.npm`); kaniko пушит его одним blob'ом → `413 Request Entity Too Large` (QRATOR). `synth-backend`/`synth-ui` при этом skipped.
- **Фикс (`docker/Dockerfile`, только он):** multi-stage. Builder ставит пакет (`npm install -g … && npm cache clean --force`) и раскладывает top-level `node_modules` по `/chunks/1..6` по глобам `[a-f]*`,`[g-p]*`,`[q-z]*`,`@[a-f]*`,`@[g-p]*`,`@[q-z]*`; runtime (`node:22-alpine`) получает `package.json` + `dist` + 6 отдельных `COPY --from=builder /chunks/N/` + симлинк `/usr/local/bin/synth`; `ENV/EXPOSE/VOLUME/ENTRYPOINT` без изменений.
- **Проверки:** `docker build` успешно; max. новый слой **33.4 МБ** (было 280 МБ), все < 50 МБ; `synth --version` → `0.7.2`; состав `node_modules` идентичен старому образу (170 пакетов, 135.4 МБ); `synth --help` OK; smoke `ENTRYPOINT` → `GET /health 200 {"version":"0.7.2"}`; размер образа 579 → 401 МБ. Не копируются `.bin` (16K) и `.package-lock.json` — рантайм их не использует (проверено).
- **Файл:** `docker/Dockerfile` (изменён, **не закоммичен** — по решению пользователя коммитить только по явной просьбе).
- **Next:** для образа 0.7.3 нужен commit + bump 0.7.2→0.7.3 + tag/release (решение пользователя).

## 2026-09-23 (продолжение) — релиз v0.7.3 (фикс Docker-слоёв) — PASS
- **Задача:** «Да, выпускаем 0.7.3» (после подтверждённого 413 при перезапуске Docker-джобы).
- **Тип:** release/ops · **Исполнитель:** @orchestrator · **Результат:** PASS.
- **Коммиты (master):** `19b0a02 fix(docker): разбить слои образа synth (multi-stage + чанки) — устранён 413`; `c687cbf chore: bump version to v0.7.3`. Push `master` (`bb77f51..c687cbf`), аннотированный тег `v0.7.3`, push тега → Release run #87 (`1625474`).
- **CI (run 1625474):** «CI проверки» ✅, «Сборка релизных артефактов» ✅, «Генерация CHANGELOG» ✅, «npmjs.org» ✅ (`@itphx/synth@0.7.3`, `latest=0.7.3`), «GitVerse Package Registry» ✅, **«Docker образ» ✅** — собраны и запушены `gitverse.ru/itphx/synth:0.7.3` + `:latest`, `synth-backend`, `synth-ui` (413 устранён), «Helm-чарт» ✅.
- **Единственный FAIL:** «GitVerse Release» — `403 Forbidden` на `actions/create-release@v1` (`get release by tag v0.7.3`). Автосоздание релиза по-прежнему не работает (та же проблема, что на 0.6.1/0.7.2).
- **Обход:** релизы созданы/обновлены через GitVerse API (MCP): `Release v0.7.3` (id `548813429`, **опубликован**, `draft:false`) с заметками о Docker-фиксе; `Release v0.7.2` (id `548813190`) — тело с заметками 0.7.x установлено, но API оставляет `draft:true` (снять через MCP не удалось; при необходимости — вручную в UI).
- **Проверки:** локальный `docker build` нового Dockerfile — макс. слой 33.4 МБ (было 280 МБ), `synth --version` → 0.7.2, состав 170 пакетов/135.4 МБ, `/health` 200; CI-публикация Docker подтвердила на 0.7.3.
- **Замечания:** журнал не коммитится (решение пользователя). Ветка `feat/ad-071-mcp-tools-scope` не удалялась.

## 2026-09-23 (продолжение) — GV_TOKEN заменён: джоба GitVerse Release позеленела
- **Задача:** «Сохранил значение в GV_TOKEN» (использовать рабочий токен MCP `opencode-v2`, 40 hex, префикс `4b21…`).
- **Тип:** CI/ops · **Исполнитель:** пользователь (secret) + @orchestrator (проверка).
- **Что выяснено:** токен из `~/.config/opencode/opencode.jsonc` (запись `opencode-v2` в `secrets/tokens`) имеет права: Releases ✅ (MCP), Docker registry ✅ (tags list 200), GitVerse npm ✅ (view 0.7.3), git HTTPS ✅. Значение сохранено в `secrets/gitverse-mcp-token` (вне репо, mode 600).
- **Проверка:** полный re-run Release run #87 (`1625474`) → **status: success** (все джобы). В логе `GitVerse Release`: `✅ Release 'Release v0.7.3' (Title: 548813429) is ready` — 403 устранён, автосоздание/поиск релиза работает.
- **Остаточный баг workflow (не токен):** шаг «Создать релиз» выполняется в checkout без сборки, `packages/synth/dist/cli.js` отсутствует (`dist/` в gitignore) → `⚠️ No files matched the given patterns. Skipping upload.` Ассет `cli.js` к релизу **не приложен** (`assets: []`). Бандл лежит в артефакте `synth-bundle` (кладёт билд-джоба), но release-джоба качает только `changelog`. Для обновления существующего релиза body тоже не перезаписывается (для v0.7.3 осталось тело, установленное вручную).
- **Next (предложено):** в `create-release` добавить `actions/download-artifact@v4` (name: `synth-bundle`, path: `packages/synth/dist`) перед шагом релиза — тогда `files:` матчится и `cli.js` прикладывается.
- **Замечания:** журнал не коммитится. `Release v0.7.2` остаётся draft (следствие тестового вызова автора); `Release v0.7.3` published.

## 2026-09-23 (продолжение) — фикс: cli.js прикладывается к GitVerse Release (`release.yaml`)
- **Задача:** «Да, поправить release.yaml» — отдельный баг workflow: ассет `cli.js` не прикладывался к релизу (не связано с токеном).
- **Тип:** fix (CI) · **Исполнитель:** @fixer → верификация @orchestrator · **Результат:** PASS (YAML/конфиг), end-to-end не проверялся (тестовый релиз не делали по решению пользователя).
- **Причина:** job `create-release` работает в checkout **без сборки**; `packages/synth/dist/cli.js` в `.gitignore`, поэтому `files:` не матчился (`⚠️ No files matched the given patterns. Skipping upload.`), у релиза `assets: []`. Собранный бандл лежит в артефакте `synth-bundle` (грузит job `build`), но release-джоба скачивала только `changelog`.
- **Фикс:** `.gitverse/workflows/release.yaml`, job `create-release` — добавлен шаг `actions/download-artifact@v4` (`name: synth-bundle`, `path: packages/synth/dist`) перед «Собрать тело релиза». +6 строк, больше ничего не менялось.
- **Проверка:** YAML парсится (js-yaml), 9 джоб; шаги `create-release` в порядке (checkout → версия → changelog → cli-бандл → тело → релиз); имя артефакта совпадает с `build`, итоговый путь `packages/synth/dist/cli.js` совпадает с `files`.
- **Коммит (локально, без push):** `8e4b8da7` `ci(release): приложить cli.js к релизу (download-artifact synth-bundle)`.
- **Осталось:** end-to-end проверить на следующем релизе (0.7.4 или штатном); body существующего релиза экшен не обновляет (для будущих тегов — проверить/при необходимости добавить шаг обновления тела).

## 2026-09-23 (продолжение) — AD-046 Фаза 1: скиллы и core-тул `skill` — PASS
- **Задача:** реализовать AD-046 «Скиллы и slash-команды», Фаза 1 (ядро). Решение пользователя: объём — только Фаза 1; внешние источники только instance/project/config.paths; каталог саб-агентов — по binding родителя; реализация «одним заходом»; ветка `feat/ad-046-skills-phase-1`.
- **Тип:** feature · **Исполнитель:** @explore (investigate) → @fixer ×3 → @tester ×2 (verify) · **Результат:** PASS.
- **Отклонения от исходного AD-046 (согласованы):** (1) толерантный frontmatter-парсер в `shared` на уже имеющемся `js-yaml` (в core его нет; новых зависимостей не добавляли); (2) ленивая mtime-инвалидация + `POST /api/v2/skills/reload` вместо FS-watch; (3) отдельного `tools.skill` нет — отключение через `tools.disabled` (AD-071); (4) каталог двумя блоками `skills.catalog` (stable, order 35) + `skills.catalog.session` (volatile, order 55), при override `session.settings.systemPrompt` не добавляется; (5) саб-агентам каталог приклеен к `llmSystemPrompt` (`task.ts`/`task-resume.ts`) по binding родителя, без рефактора на Composer.
- **Состав:** shared — `types/skills.ts`, `skills/frontmatter.ts`, схемы, `skillsConfigSchema` (+дефолты/env), i18n, `EventType` + `skill.invoked`/`command.invoked`, `SessionSettings.skills*`, `AgentDefinition.groups?`; core — `engine/skills/{types,scope,trust,parser,discovery,watcher,registry,catalog,loader,service}.ts`, `storage/skill-store.ts`, `engine/tools/skill.ts`, интеграция в `composer.ts`/`orchestrator.ts`/`task.ts`/`task-resume.ts`/`permission/{evaluator,derive}.ts`/`events`, `server/routes/skills.ts` + монтирование, backend RBAC ADMIN на запись; docs — `API_V2.md` (§5.17), `AGENTS.md`, `ad-046` (статус + блок отклонений).
- **Верификация:** `typecheck` 6/6; `lint` 0 errors; `test` — **2807 тестов, 0 падений** (shared 102 · core 1766 · ui 626 · backend 313). Runtime: 401 без токена, CRUD/`files`/`reload` ок, скилл попадает в манифест `skills.catalog`, reload у `developer` → 403. **Найден и исправлен дефект (medium):** `GET/PATCH/DELETE /skills/:name` с невалидным именем → 500; guard `isValidSkillName` во всех 7 `:name`-роутах → 404, +15 регрессионных тестов; round 2 верификации — PASS.
- **Ветка/коммит:** `feat/ad-046-skills-phase-1`; коммит `2db826b3` (после согласования правок AGENTS.md). master не пушился (локально опережает origin на 2 коммита).
- **Дальше:** Фаза 2 (резолвер `/`-команд, bundles, CLI/UI-автокомплит), затем AD-069 (проектные инструкции). Открытые вопросы §14(2,4,5,7) AD-046 (requires_toolsets, приоритет bundle vs builtin, UI недоверенных, `allowed-tools`) — решить в Фазе 2/3.

## 2026-09-23 (продолжение) — AD-046 Фаза 2, commit 1: slash-команды в core — PASS
- **Задача:** Фаза 2 «Команды и bundles», часть 1 (core + API + CLI, без UI). Решения пользователя: builtins `/help` (статика), `/skills`, `/commands`, `/summary`; `/compact` и `/review` отложены; конфликт имён — настройка (`bundle-wins` default / `conservative` / `namespace`); `allowed-tools` advisory; `requires_toolsets` через конфиг; permission-ключ `rules.command`; результаты локальных команд видимы, но `ephemeral` (исключены из LLM-контекста); UI — отдельным commit 2.
- **Тип:** feature · **Исполнитель:** @explore (investigate) → @fixer ×4 → @tester ×3 · **Результат:** PASS.
- **Состав:** shared — `types/commands.ts`, `Message.ephemeral`, `commandsConfigSchema` (`paths`, `bundlesPath`, `conflict`, лимиты), `skillsConfigSchema.toolsets`, Zod-схемы, i18n `command.*`; core — `engine/commands/{types,parser,template,discovery,registry,bundles,builtin,resolver,service}.ts`, `storage/skill-bundle-store.ts`, ранний резолвинг в `_processMessage` до LLM, `_publishLocalCompletion` (`stream.chunk`/`stream.done`), `command.invoked`, `ephemeral`-фильтры в оптимизаторе, `pathToFileURL`/`<file>…</file>` (фикс Фазы 1); API — `routes/{commands,skill-bundles,skill-scope}.ts` (sessions/projects/settings skills + effective), монтирование core/backend; CLI — `/`-команды через `runSingleChat` без LLM.
- **Верификация:** typecheck 6/6; lint 0 errors; тесты shared 103 · core **1831** (136 файлов) · ui 626 · backend **318**. Runtime: SSE закрывается для `/help` (`stream.chunk`+`stream.done`), `/commands`,`/skills`,`/nope` — локально без LLM; `ephemeral` в API и не в контексте; bundle CRUD (201/200/400/409/delete); scope-API + RBAC; конфликт-режимы (unit).
- **Найденные и исправленные дефекты:** (1) HIGH — SSE не закрывался для локальных команд (`text`/`done` вместо `stream.*`); (2) medium-high IDOR — `sessions/:id/skills` без проверки доступа (чужой USER правил сессию) → `canAccess` 403; (3) project-skills PUT только ADMIN → выровнено с MCP (owner/LEAD/admin); (4) мёртвый код/ключи, `ephemeral` не сериализовался, CLI `/summary` не запускал суммаризацию.
- **Коммит:** `d520c1f2` (61 файл, +4010/−50). Ветка `feat/ad-046-skills-phase-1`. master и ветка не пушились.
- **Дальше:** commit 2 — UI (настройки user/admin по аналогии с MCP, тумблеры на вкладках «Сессия»/«Проект», секции статистики, `/`-автокомплит), затем AD-069.
## 2026-09-23 (продолжение) — AD-046 Фаза 2, commit 2 (UI): скиллы/команды в интерфейсе — PASS
- **Задача:** UI-слой Фазы 2 — настройки пользователя/админа (по аналогии с MCP), тумблеры скиллов в правой панели, таблицы статистики, `/`-автокомплит. Решения: пользователь не создаёт скиллы (просмотр + session-вкл/выкл); `/compact`/`/review` вне объёма; счётчики из live-событий.
- **Тип:** feature (UI) · **Исполнитель:** @fixer ×3 (настройки/стор → панели/статистика/автокомплит → фикс импорта + docs) → верификация @orchestrator (Playwright) · **Результат:** PASS.
- **Состав:** `synthApi` (skills/commands/bundles/scope), `stores/skillsStore.ts` + события в `transportStore`, `components/settings/{SkillsUserSettings,SkillsAdminSettings,SkillEditorForm,CommandsSettings}.tsx`, категории `settings.category.{skills,skillsAdmin,commands}` в `SettingsModal`; правая панель — секция скиллов в `SessionSettingsTab` и `ProjectSkillsBlock` в `ProjectTab`; `StatsTab` — секции «Скиллы»/«Команды»; `components/chat/CommandAutocomplete.tsx` + интеграция в `ChatInput`; i18n ru/en. +12 тест-файлов (66 тестов), ui 692.
- **Инцидент и фикс (важно):** два **value-импорта** констант из корня `@itphx/synth-shared` (`CommandsSettings`, `SkillsAdminSettings`) протянули `shared/config/loader` (node:fs) в браузерный бандл → приложение не рендерилось. Переведены на subpath `@itphx/synth-shared/schemas`. Правило зафиксировано в `packages/ui/AGENTS.md`: runtime-импорты shared — только через subpath (`/types`, `/schemas`, `/i18n`, `/version`); `import type` из корня безопасен.
- **Верификация (Playwright, :5002, admin):** чистовая загрузка — 0 ошибок консоли; настройки — user «Скиллы» (просмотр, «доступных нет»), admin «Скиллы» (создание `qa-ui-skill` → 1 скилл, «Изменить/Удалить», system enable/disable, политика `auto`), admin «Команды» (5 команд: `/commands`,`/help`,`/qa-ui-skill`,`/skills`,`/summary`; bundles); «Сессия» — секция скиллов с тумблером, «Проект» — два тумблера на скилл, «Статистика» — секции СКИЛЛЫ/КОМАНДЫ; `/`-автокомплит — kind-бейджи, выбор вставляет `/help `. Тестовый скилл удалён; dev-стек :5000/:5002/:4300 работает.
- **Коммиты:** `6331be2` — `feat(ui): AD-046 Фаза 2 — UI скиллов/команд…` (29 файлов, +5067/−13); ранее `d520c1f` — commit 1 (core+API+CLI). Ветка `feat/ad-046-skills-phase-1`, master/ветка не пушились. Документация: корневой `AGENTS.md` (AD-046 — Фаза 1+2 ✅, остаток Фаза 3), `packages/ui/AGENTS.md`, `docs/arch_decisions/ad-046-*.md`.
- **Дальше:** Фаза 3 AD-046 (inline shell opt-in, `skill-creator`, `skills.urls`/удалённые каталоги, backend-админка каталога/AD-068); AD-069 (проектные инструкции) — зависит от AD-046.
## 2026-09-23 (продолжение) — fix: ответы системных команд в UI — PASS
- **Задача:** ответ на локальную системную команду (`/help`, `/skills`, `/commands`, `/summary`-нотис) отображался как ответ агента. Решения пользователя: inline system-блок (A), объединять команду+вывод, оставить только «Копировать», `/summary` — нотис + обычный SUMMARY, отдельный коммит.
- **Тип:** bug fix (UI/core) · **Исполнитель:** @fixer ×2 → верификация @orchestrator (Playwright) · **Результат:** PASS.
- **Причина:** `_finishLocalCommand` создавал ответ как обычное `assistant`-сообщение с `agentRole` и `metadata.command:true`, но UI не использовал признак → рендерил бейдж агента/статистику; user-команда не помечалась. Плюс `stream.done` локальной команды не нёс `message_index/message_id` → fallback `finishStream` давал assistant тот же index, что user → React key-warnings и дубли; `addMessage` не дедуплицировал.
- **Правки core:** `_finishLocalCommand` — `model/provider='command'`, `metadata { command:true, commandName, commandArgs }` (и `i18nKey` для `/summary`), метаданные едут в `stream.done`; user-команда помечается `metadata.commandPrompt=true`; `stream.done` несёт `message_index`/`message_id`; повторный `message.added` user-команды с `commandPrompt` (скрытие live-пузыря). Ветка template/skill/bundle не тронута.
- **Правки UI:** новый `components/chat/CommandMessage.tsx` — нейтральный system-блок (`> /name args`, вывод, только «Копировать», без бейджа агента/статистики/retry); `ChatMessage` — ветка `metadata.command`; `messageVisibility` — скрывает `commandPrompt`; `chatStore.addMessage` — upsert по index/id, `finishStream` — index из события + защита от коллизии; `transportStore` — `message_id`; i18n `chat.command.*`.
- **Верификация (Playwright, :5002):** live-отправка `/help` — 0 user-пузырей, 1 командный блок, **0 console errors** (до фикса — 5 key-warnings на отправку); после перезагрузки — user-команда скрыта, блок на месте, консоль чистая; в блоке только «Копировать», бейджа агента нет. Тесты: shared 103 · core 1833 · ui 705 · backend 318 — зелёные; typecheck 6/6; lint 0 errors.
- **Коммит:** `a1b29ce` `fix(ui): ответы системных команд — system-блок, скрытие команды, устранение дублей`. Ветка `feat/ad-046-skills-phase-1`.
- **Дальше:** Фаза 3 AD-046 (inline shell, skill-creator, skills.urls, AD-068) или AD-069.
## 2026-09-23 (продолжение) — refactor: единый Notice для служебных сообщений — PASS
- **Задача:** привести служебные сообщения к единому виду: общий компонент, блок по центру (текст слева), шапка (иконка+подпись), кнопка «Копировать»; ревизия command/summary/debug/error/info. Решения пользователя: вариант B (общий `Notice`), ревизия всех, у команды — только copy, у summary/debug сохранить существующие действия.
- **Тип:** refactor (UI) · **Исполнитель:** @fixer → верификация @orchestrator (Playwright) · **Результат:** PASS.
- **Семейство до правки:** `summary`/`debug`/`error`/`info` — центрированы, но разной разметкой (`MessageHeader`/без шапки); `command` — свой лево-ориентированный `CommandMessage`; `state`/`tool_chain` — скрыты.
- **Правки:** новый `components/chat/Notice.tsx` (варианты command/summary/debug/error/info; центрированный wrapper, box `max-w-[85%] text-left`, шапка иконка+label+meta, футер «Копировать» + доп. actions; hover/touch); `CommandMessage` переведён на `Notice` (сохранены `commandHeader`, `SecretMarkdown`, resolveI18n, секреты); `ChatMessage` — summary/debug/error/info через `Notice`, reasoning/tool/subagent-блоки переданы children, сохранён `SessionReferenceCard` и `selectionMode`; `MessageHeader` — аддитивный `metaOnly`; `MessageActions` — `embedded`/`showCopy`; `Icon` — `information`; i18n `chat.notice.*`.
- **Без потерь:** summary/debug — meta модель/время(+quality) и полные `MessageActions`; info — `text-xs` и `SessionReferenceCard`; error/info — copy. Осознанно: у notice `disabled` → `opacity-50`; в meta сводки/отладки нет origin/agent-бейджей.
- **Верификация:** ui-тесты **90 файлов / 723** (+18); shared 103, core 1833, backend 318 — зелёные; typecheck 6/6; lint 0 errors. Playwright: командный блок `> /help` центрирован (`items-center`), консоль 0 ошибок. Вариант info покрыт юнит-тестами (в дереве UI сессию не нашёл).
- **Коммит:** `c27da02` `refactor(ui): единый Notice для служебных сообщений (command/summary/debug/error/info)`.
- **Дальше:** Фаза 3 AD-046 (inline shell, skill-creator, skills.urls, AD-068) или AD-069.
## 2026-09-24 — AD-046 Фаза 3 (inline shell, skills.urls, skill-creator) — PASS
- **Задача:** закрыть автономную часть Фазы 3 AD-046. Решения пользователя: `skill-creator` — встроенный скилл-инструкция; `skills.urls` — read-only индексация; install/trust — AD-068.
- **Тип:** feature/security · **Исполнитель:** @fixer ×4 → верификация @orchestrator (tests + API + dev-restart) · **Результат:** PASS.
- **3.1 `536f51c` — security:** trust-гейт проектных `.synth/commands/*.md` (был пробел: команды грузились без `skills.trustedProjectDirs`). `CommandOrigin/Source/TemplateCommand.trusted`, диагностика `untrusted`, кэш учитывает trust, недоверенные не попадают в каталог/резолвер/`/`-автокомплит`; проброс `trustedProjectDirs` в core app/chat/backend.
- **3.2 `2fc2f5c` — inline shell:** `skills.inlineShell` (по умолчанию off) сквозь `CommandRuntimeConfig`; `renderTemplate` подставляет `` !`cmd` `` (regex по токену, лимит 50 KB, диагностики); раннер строит оркестратор: `PermissionEvaluator.check({toolName:'execute_shell',…})`, **allow-only** (`deny`/`ask` → отказ без интерактива), helper `engine/commands/inline-shell.ts` (timeout 30 c, maxBuffer, abort); аудит-событие `command.inline_shell`; i18n.
- **3.3 `738fd4d` — skills.urls/внешние каталоги:** конфиг `skills.urls`; discovery внешних read-only (`opencode/.claude/.agents`, `~/.config/opencode`) с trust по правилам; `engine/skills/remote.ts` — fetch `index.json`+`SKILL.md` в `{dataDir}/skills-cache/urls/<hash>` (SSRF-guard: http/https, блок private/loopback/ULA, ручные редиректы с проверкой каждого хопа, timeout 5 c, лимиты 1 MB/200/50 KB, атомарная запись). Url-скиллы — **`trusted:false`** (видны в реестре, не в каталоге модели) до AD-068.
- **3.4 `0bd94b5` — skill-creator:** builtin-скилл (`instance/system`, trusted) как TS-константа (`engine/skills/builtin.ts`), инжектится первым в `SkillRegistry.list` (не перекрывается проектом); `metadata.synth.command: skill-creator`, `requires_capabilities: [file_read,file_write]`; EN-инструкция по созданию проектного скилла в `.synth/skills/<name>/SKILL.md`; виден в `/skills`, каталоге и как `/skill-creator`.
- **Verify:** shared 104 · core 1914 · ui 723 · backend 318 — зелёные; typecheck 6/6; lint 0 errors. Live (dev-restart all, пересборка core): `GET /api/v2/skills` содержит `skill-creator` (instance/system, trusted, userInvocable); `GET /api/v2/commands` содержит `skill-creator` (kind skill). Замечание: API-листинг `/commands` без capabilities помечает capability-гейтнутые скиллы `available:false` (в сессии с `assistant` доступен) — pre-existing пробел роутов, кандидат в тех.долг.
- **Docs:** `docs/CONFIGURATION.md` — раздел «Скиллы (`skills.*`)»; `AGENTS.md` — строка AD-046; статус в AD-046.
- **Дальше:** AD-069 (инструкции AGENTS.md + `/init`), bump generation при смене инструкций.
## 2026-09-24 — AD-069 Проектные инструкции (AGENTS.md) и /init — PASS
- **Задача:** реализовать AD-069 полностью (Ф1–Ф3). Решения пользователя: `config.instructions.sources` — список с `position: before|after`; URL — fetch при старте + TTL-кэш без таймера; кап динамический от окна модели; глобальные файлы не читать (identity-тир уже покрывает); generation bump при смене инструкций; все 3 фазы.
- **Тип:** feature · **Исполнитель:** @fixer ×6 → верификация @orchestrator (tests + API + Playwright) · **Результат:** PASS.
- **Ф1 `cf5faf1`:** shared-схема `instructions`; `engine/context/instructions.ts` (git root→cwd merged chain, приоритет файлов, sha256-дедуп, head/tail-обрезка, threat-scan AD-036, provenance, динамический кап `clamp(ratio*окно,20k,500k)`, окно через `_resolveModelContextWindow`, fallback 128k); блок `instructions` в composer (context order 15, не при override); generation bump (per-agent promptStates, `isBlockChanged`).
- **Ф2a `13c6a08`:** `config.instructions.sources` (path/glob/`~/`/abs, before/after), URL fetch+TTL-кэш `{dataDir}/instructions-cache`, общие SSRF-хелперы вынесены в `engine/net/fetch.ts` (переиспользованы `skills/remote.ts`), project-trust гейт, install-tree guard, excludeProjects, расширенная диагностика статусов.
- **Ф2b `999dce6`:** прокидка инструкций в саб-агенты (`task.ts`/`task-resume.ts`, флаг `skip_context_files`), `lazy-instructions.ts` (по file/shell-тулам, ≤5 предков, границы workspace, excludeDirs, дедуп loaded+sha256, один раз на сообщение, кап 8k, threat-scan, маркер `[Subdirectory context discovered: …]`), событие `context.instructions_loaded`.
- **Ф2c-API `26afdbf`:** `GET /api/v2/context/instructions?session_id|project_id`, RBAC (владелец|ADMIN; owner/LEAD/ADMIN), `no-project`, cap/status/scan; backend-роут identity переименован в `createContextFileRoutes`.
- **Ф2c-UI `eb98850`:** `instructionsStore` + `synthApi.getSessionInstructions`, секция «Проектные инструкции» в панели «Сессия» (сводка/список/статусы/скан), реактивность по WS-событию, i18n ru/en, мобильный адаптив.
- **Ф3 `7fbd552`:** новый статус команды `prompt` (не локальный → CLI не короткозамыкает); builtin `/init` (промпт AD-069 §8.1, без несуществующего тула `question`, `$ARGUMENTS`); builtin-скилл `synth-agents-md` (capability-aware, команда `/agents-md` — во избежание конфликта с builtin `/init`).
- **Verify:** shared 110 · core 2010 · ui 730 · backend 318 — зелёные; typecheck 6/6; lint 0 errors. Live (пересборка + dev-restart): `GET /commands` → `init` (builtin, available), `GET /skills` → `synth-agents-md`; `GET /context/instructions` → динамический cap 60000 для окна 1M, `no-project` для сессии без проекта; UI: секция «Проектные инструкции» отображается, 0 console errors.
- **Docs:** AD-069 статус ✅ (с отклонениями), `AGENTS.md` строка AD-069, `docs/CONFIGURATION.md` — раздел `instructions.*` + список builtin-команд.
- **Примечание:** project-trust по умолчанию пуст — проектные инструкции (как и проектные скиллы AD-046) грузятся только после добавления каталога в `skills.trustedProjectDirs`.

## 2026-09-24 (продолжение) — AD-075: автосоздание/выбор рабочего каталога проекта — PASS
- **Задача:** реализовать AD-075 (окружение проекта: рабочий каталог) — managed автосоздание, standalone ручной выбор, политика путей вне корня.
- **Тип:** feature · **Результат:** PASS (код написан; не закоммичено по указанию).
- **Состав:** shared — `storage.workspaceOutsideRoot` (+ env `SYNTH_WORKSPACE_OUTSIDE_ROOT`, резолвер `resolveWorkspaceOutsideRootPolicy`), типы/схемы, `utils/workspace.ts` (`slugifyWorkspaceName`/`uniqueWorkspaceName`), i18n; backend — `lib/workspace-resolver.ts` (нормализация managed), `routes/projects.ts` (авто-имя, `mkdir -p`, RBAC смены workspace), `routes/fs.ts` (`workspace-root*`), `app.ts` (runtime-override `settings/workspace` + `defaultWorkingDir` в оркестратор); core — `engine/orchestrator.ts` (`_resolveWorkingDir` mkdir), `engine/tools/project-manage.ts` (`project_create` mkdir), `server/routes/projects.ts` (нормализация/политика/`confirmOutsideRoot`), `server/routes/fs.ts` (`workspace-root*`), `server/routes/settings.ts` (`workspace-policy`, managed read-only), `storage/runtime-settings.ts`; ui — `DirectoryPickerDialog`, `WorkspacePolicySection`, read-only managed, обработка 409→подтверждение→повтор, i18n ru/en.
- **Поведение:** managed `workspace` автосоздаётся (`mkdir -p`); относительный — внутри `workspacesRoot`, абсолютный внутри root нормализуется в относительный, вне root → `403 WORKSPACE_OUTSIDE_ROOT_DENIED`; пустой → авто-имя `slugify(name)` + суффикс `-2/-3…` (атомарный `mkdir`); 422 «каталог не найден» убран; политика вне root `confirm`/`deny` (`storage.workspaceOutsideRoot` / `/settings/workspace-policy`, standalone — `confirm`, managed — `deny` read-only).
- **Верификация:** typecheck 6/6; lint 0 errors; тесты shared 122 · core 2043 · backend 350 · ui 750 — зелёные.
- **Известный остаток:** D5 — `PUT /api/v2/projects/:id` проверяет владение/роль только при смене поля `workspace`; остальные поля (`name`, `description`, `current_task`, `invariants`, `icon`, `color`, `plan`, `repos`) мутируются без проверки владения (предсуществовавшая дыра, вне объёма AD-075).
- **Ветка:** `feat/ad-075-workspace-provisioning`.
- **Дальше:** закрытие D5 отдельной задачей (или AD-074/AD-076/AD-077).

## 2026-09-24 (продолжение) — D5: горизонтальная авторизация projects — PASS
- **Задача:** закрыть D5 (известный остаток AD-075) — мутации `PUT/DELETE /api/v2/projects/:id` проверяли владение только при смене `workspace`.
- **Тип:** bug fix (security, IDOR) · **Результат:** PASS.
- **Правки:** `packages/backend/src/routes/projects.ts` — хелперы `canManageProject` (owner/LEAD/ADMIN) и `canEditProjectContent` (owner/EDITOR/LEAD/ADMIN); `PUT` — `workspace` owner/LEAD/ADMIN, контентные поля (`name`, `description`, `current_task`, `invariants`, `icon`, `color`, `repos`, `plan`) owner/EDITOR/LEAD/ADMIN; `DELETE` — owner/LEAD/ADMIN; VIEWER/посторонний → `403 FORBIDDEN`. Проверки до мутаций. Тесты `projects.test.ts` (+7 кейсов).
- **Верификация:** тесты backend — зелёные (по отчёту реализации).
- **Ветка:** `feat/ad-075-workspace-provisioning`; не закоммичено.
- **Дальше:** AD-074/AD-076/AD-077.

## 2026-09-24 (продолжение) — AD-075: standalone-скрипт, фикс путей, навигация в диалоге — PASS
- **Задача:** доработки AD-075 после базовой реализации: (а) D5, (б) фикс относительного `dataDir`/`workspacesRoot`, (в) `scripts/standalone.sh`, (г) навигация за корень в `DirectoryPickerDialog`, (д) ручная браузер-проверка standalone.
- **Тип:** bug fix + feature (dev-tooling/UI) · **Результат:** PASS.
- **(а) D5 закрыт:** `PUT/DELETE /api/v2/projects/:id` — горизонтальная авторизация (owner/EDITOR/LEAD/ADMIN для контента; owner/LEAD/ADMIN для `workspace` и delete); коммит `7cebeda` «fix: RBAC на изменение и удаление проектов (D5)».
- **(б) Фикс путей:** `packages/shared/src/config/resolve.ts` абсолютизирует `dataDir`/`workspacesRoot`/`defaultWorkspace`; core `createFsRoutes` и backend `WorkspaceResolver` нормализуют root — относительный `dataDir` больше не ломает containment (ложный «вне root»).
- **(в) `scripts/standalone.sh`:** сборка `shared→core→ui→synth`, `pnpm pack` (резолвит `workspace:*`), `npm install` 4 tgz в `tmp/standalone/install`, запуск `SYNTH_DATA_DIR=<data> node_modules/.bin/synth serve --no-auto-profile`; опции `--port/--host/--data-dir/--api-key/--prefix/--no-build/--rebuild-packs/--check/--keep-data/--clean`; логи `tmp/standalone-build.log`, `tmp/standalone.log`; `--check` — smoke (health, create project, workspace-root, workspace-policy).
- **(г) `DirectoryPickerDialog`:** навигация «Вверх» за корень при политике `confirm` (не read-only), подсказка «Вне рабочего корня», выбор вне корня через ConfirmDialog; i18n ru/en.
- **(д) Ручная браузер-проверка (Playwright, standalone):** создание папки в корне → 201, каталог появился; «Вверх» за корень при `confirm`; подсказка «Вне рабочего корня»; выбор вне корня через ConfirmDialog → PUT 200, workspace absolute.
- **Тесты:** shared 132 · core 2046 · ui 754 · backend 361; typecheck/lint зелёные.
- **Ветка:** `feat/ad-075-workspace-provisioning` (D5 — `7cebeda`; остальное — в рабочем каталоге, не закоммичено).
- **Docs:** `docs/DEVELOPMENT.md` — раздел `standalone.sh`; `AGENTS.md` — строка в блоке команд; `docs/arch_decisions/ad-075-*.md` — §8.
- **Дальше:** AD-074/AD-076/AD-077.

## 2026-09-24 (продолжение) — AD-075: закрытие хвостов (CLI data-dir, tool-level RBAC) — PASS
- **Задача:** закрыть два остаточных хвоста AD-075: относительный `--data-dir` и отсутствие проверки прав при записи проектных данных из core-тулов.
- **Тип:** bug fix (security/paths) · **Результат:** PASS.
- **`58f6934` — нормализация `--data-dir` на CLI-границах:** `ensureFirstRun` (shared) и все обработчики `options.dataDir`/`options['data-dir']` в `packages/synth/src/cli.ts` и `packages/core/src/main.ts` оборачивают путь в `path.resolve` → относительный `--data-dir` больше не даёт относительный `dataDir`/`workspacesRoot`, containment AD-075 не ломается. Тест в `resolve.test.ts` (`ensureFirstRun` relative → absolute).
- **`cae2f92` — RBAC на запись проектных данных из core-тулов:** новый `packages/core/src/engine/tools/project-access.ts` (`resolveSessionUserId`, `canEditProject`); `project_invariants_write`/`project_log_write` пишут только при owner/EDITOR (`project.ownerId` или `members[userId] ∈ {OWNER, EDITOR}`), иначе — `isError` `project.write_forbidden`, проект не меняется. Неидентифицируемый контекст (нет `userId` и пустой `ownerId`) — back-compat разрешён. `plan_write` намеренно не гейтится (комментарий/TODO в `plan.ts`) — строгий гейт ломает план-воркфлоу на неатрибутированных сессиях; остаточный риск зафиксирован.
- **Ограничение:** глобальные LEAD/ADMIN в core недоступны (роли — backend) — их носители не изменят `invariants`/`log` через чат, но могут через UI/API.
- **Тесты:** shared 133 · core 2052 · ui 754 · backend 361; typecheck/lint зелёные. Известный флейк — `task-resume`.
- **Ветка:** `feat/ad-075-workspace-provisioning` (коммиты `58f6934`, `cae2f92`; документация — не закоммичена).
- **Docs:** `docs/arch_decisions/ad-075-*.md` — §9 + остаточные риски; `docs/API_V2.md` — tool-level RBAC в §5.8.
- **Дальше:** AD-074/AD-076/AD-077.

## 2026-09-24 (продолжение) — AD-076: реестр git-репозиториев и SSH-ключи per-agent — PASS

- **Задача:** реализовать AD-076 — реестр git-репозиториев (несколько на проект) + SSH-ключи per-agent (шифрование at-rest).
- **Тип:** feature · **Результат:** PASS (код написан; не закоммичено по указанию).
- **Shared:** `GitRepoConfig` (`id?`/`name?`/`url?`/`type?`/`path`/`defaultBranch?`/`sshKeyId?`/`lastFetch?`), `normalizeGitRepoConfig`, union `repos` (legacy `string[]`); `SSHKey`/`SSHKeyMeta` (`agentIds: string[]`), `sshKeyCreate/UpdateSchema`; схемы git-роутов (`register`/`remove`/`fetch`, `init`/`clone` с `name?`/`sshKeyId?`); конфиг `security.secretKey` + env `SYNTH_SECRET_KEY` (`resolveSecretKey`); удалено мёртвое `AgentDefinition.sshKeys`; i18n `sshkey.*`/`git.*`/`projectctx.repo_*`.
- **Core:** `security/crypto.ts` (AES-256-GCM, `enc:v1:`, `resolveMasterKey` → `{dataDir}/secrets/master.key`); `storage/ssh-key-store.ts` (`JsonStore` `secrets/ssh-keys`, секреты шифруются, `reveal()` только для git); `git/git-service.ts` (перенос из backend, `fetchRepo`/`removeLocal`, `simple-git` — зависимость core) и `git/ssh-env.ts` (`GIT_SSH_COMMAND`, temp-ключ `0600`); `server/routes/git.ts` (`scan`/`init`/`clone`/`register`/`remove`/`fetch`/`log`/`commit`, clone/init регистрируют `project.repos`) и `server/routes/ssh-keys.ts` (flat + nested, `DELETE :keyId` = unlink); монтирование + `REMOTE_PROXY_PREFIXES` (`/git`, `/ssh-keys`); тулы — `repo_path` (containment) и SSH в `git_push`/`git_pull` (`git-ssh.ts`), `list_repos` из реестра.
- **Backend:** удалены локальные `routes/git.ts`/`lib/git-service.ts` (и `simple-git`); `/git` — core-фабрика с `authorizeProject` (`canEditProjectContent`), `/ssh-keys` — core-фабрики с `writeGuard: requireAdmin`.
- **UI:** Git-вкладка — реестр (destination/type/url/ssh-key/lastFetch), scan→register, clone/init (`name`/`path` + SSH-ключ), fetch/remove (`ConfirmDialog`); секция «SSH-ключи» в категории «Агенты» (CRUD, привязка к агентам); i18n ru/en.
- **Данные:** `$SYNTH_DATA_DIR/secrets/master.key`, `$SYNTH_DATA_DIR/secrets/ssh-keys/<id>.json`.
- **Ограничения:** passphrase не поддерживается (явная ошибка); nested `/agents/:id/ssh-keys` в гибриде не проксируется (только flat `/api/v2/ssh-keys`); `plan_write` без tool-RBAC (остаток AD-075); ротация мастер-ключа вне объёма.
- **Верификация:** typecheck 6/6; lint 0 errors; тесты shared 155 · core 2120 · ui 774 · backend 372. Curl `/git/repos/register|clone`, `/ssh-keys` (маскировка, RBAC 403 USER, nested unlink), браузер — Git-реестр и SSH-ключи.
- **Ветка:** `feat/ad-075-workspace-provisioning`; не закоммичено.
- **Docs:** AD-076 статус ✅ + «Реализация»/«Решено»/«Известные ограничения»; `docs/arch_decisions/README.md`; `AGENTS.md` (строка AD-076, `repo_path`, `secrets/`); пакетные `AGENTS.md` core/backend/shared/ui; `docs/API_V2.md` §5.15/§5.15.1; `docs/CONFIGURATION.md` (`security.secretKey`).
- **Дальше:** AD-074/AD-077 (или закрытие ограничений AD-076).

## 2026-09-24 (продолжение) — закрытие недоделок AD-075/AD-076 (4 фикса) — PASS

- **Задача:** закрыть остаточные ограничения AD-075/AD-076: `plan_write` без tool-RBAC + атрибуция сессий; nested SSH-прокси в гибриде; SSH-ключи с passphrase; ротация мастер-ключа.
- **Тип:** bug fix + feature (security/git) · **Результат:** PASS (не закоммичено).
- **1. `plan_write` tool-RBAC + атрибуция сессий:** `sessions/manager.ts` — `createSession` сохраняет `ownerId: data.ownerId || data.userId || ''` (раньше терялся); `forkSession` при отсутствии опций наследует `userId`/`ownerId` источника. `engine/tools/project-manage.ts` — `loadSessionProject` экспортирован и переиспользован; `engine/tools/plan.ts` — `plan_write` перед мутацией проверяет `canEditProject(session, project)` → `project.write_forbidden` (как log/invariants), TODO снят; `plan_read`/`plan_list` не гейтятся. Тесты: `plan.test.ts` (RBAC owner/fallback/EDITOR/VIEWER/не-участник/неатрибтированный/чтение), `manager.test.ts` (createSession/forkSession).
- **2. nested `/api/v2/agents/:agentId/ssh-keys` проксируется в гибриде:** `server/proxy.ts` — `REMOTE_PROXY_PATTERNS` = `[/^\/api\/v2\/agents\/[^/]+\/ssh-keys(?:\/|$)/]`, `matchesProxyPrefix` учитывает префиксы И паттерны (матчер экспортирован). `/agents`, `/agents/all`, `/agents/:id`, `/agents/:id/enabled` остаются локальными. Тесты `app.proxy.test.ts` (+4).
- **3. SSH-ключи с passphrase:** `git/ssh-env.ts` — при passphrase создаётся askpass-скрипт `0700` (base64 `base64 -d`), env `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`, `GIT_SSH_COMMAND` без `BatchMode=yes` и с `-o NumberOfPasswordPrompts=1`; без passphrase — как раньше. `SshEnvErrorCode='env_failed'`; маппинг `sshkey.env_failed` в `engine/tools/git-ssh.ts` и `server/routes/git.ts`; i18n (shared + core en + ui ru/en).
- **4. Ротация мастер-ключа:** `security/crypto.ts` (`masterKeyFilePath`/`readMasterKeyFile` без генерации/`decodeMasterKey`), `storage/ssh-key-store.ts` (`listRaw`, `rotateMasterKey` с preflight `preflight_failed`), `security/rotate.ts` (`rotateSecretsMasterKey`/`MasterKeyRotationError`); CLI `synth secrets rotate` в обоих CLI (`core/src/main.ts`, `synth/src/cli.ts`; `--data-dir --config --old-key --old-key-file --new-key --new-key-file --dry-run --yes`).
- **Верификация:** typecheck 6/6; lint 0 errors; тесты shared 155 · core 2144 · ui 774 · backend 372. Smoke CLI: отказ без `--yes`, dry-run без записей, реальная ротация, повторный прогон skipped.
- **Остаточные риски (задокументированы):** легаси-сессии без бэкфилла атрибуции; синтетический `project_create`+неатрибтированная сессия; passphrase — temp-plaintext/нет sshd e2e/GNU `base64 -d`; ротация — нет key-id/split-state/приоритет env-config.
- **Docs:** AD-075 (§7/§9/остатки); AD-076 (§2/§3/§8/§9/§10/ограничения); root `AGENTS.md`; `packages/{core,shared,ui,backend}/AGENTS.md`; `docs/API_V2.md`; `docs/CONFIGURATION.md`.
- **Дальше:** AD-074/AD-077 (или коммит).

## 2026-09-29 — Левая панель (context C), standalone ADMIN, env-доступность тулов, SSH «Тип» — PASS (не закоммичено)

- **Задача:** пакет из 5 пунктов: левая панель (workspace/git), выбор каталога в dev, standalone-админ, git-тулы без git, поле «Тип» SSH.
- **Тип:** feature + bug fix · **Результат:** PASS (код; не закоммичено — по инварианту 13).
- **#3 standalone ADMIN:** `core/src/auth/local.ts` — `localUser.roles = ['ADMIN']`, `teamRole = 'ADMIN'`; гибридный вход (cookie `kind:'server'`) не затронут. Обновлены `local.test.ts`, `server/routes/auth.test.ts`. core 2144 tests.
- **#5 SSH «Тип»:** убран из `SshKeysSettings.tsx` (EditorState/EMPTY_EDITOR/openEdit/payload/TextField/бейдж) + i18n `sshKeys.type`/`typeHint` (en/ru) + тест; shared-схема `SSHKey.type?`/`sshKeyCreateSchema.type?` оставлена для back-compat.
- **#4 env-доступность тулов:** новый `core/src/engine/tools/runtime-deps.ts` (git/rg/sh; пробинг `--version`, fail-open при не-ENOENT, кэш, `resetRuntimeDepsCache`); причина `'dependency'` в `availability.ts`/`evaluator.ts`/`PermissionDecision.unavailable`/`PromptToolDetail`; `ChatOrchestrator.runtimeDeps` + `setRuntimeDeps`, прокинут в availability/collectUnavailable/composer/toolsDetail/permission-check; детекция `await detectRuntimeDeps()` в core `server/app.ts`, `server/chat.ts`, backend `app.ts` (до создания оркестратора); сообщение модели — `state-messages.ts` + `composer.ts` (`tools.guide`), security-промпты `prompts/security/tool-unavailable-dependency.{ru,en}.md`; i18n `tool.binary_missing`, `permission.dep_unavailable`; защитные ENOENT-ошибки в `git.ts`/`shell.ts` (grep_files не трогали — уже был `search.rg_not_installed`). Не реализовано: UI-подпись `reason='dependency'` в StatsTab (generic fallback), runtimeDeps для саб-агентов (`task.ts`).
- **#2 не менялось** (решение пользователя): `dev.sh` = backend `managed`, ручной выбор каталога — только в standalone.
- **#1 левая панель (вариант C):** новый хук `hooks/useActiveProject.ts`; `ProjectScopeToggle` в `FilesTabToolbar`/`GitTabToolbar`; `onlyActiveProject` (persist) + `OTHER_PROJECTS_COLLAPSE_KEY='__others__'` в `useUIStore.ts`; в Files/Git — закреплённый «Текущий проект» (авто-раскрыт) + сворачиваемые «Другие проекты (N)», extract `renderFilesProject`/`renderGitProject`, `loadSessions()` подключён, фоллбеки (сессия без проекта / проект без workspace / нет контекста → плоский список, тумблер disabled).
- **Верификация:** typecheck 6/6; lint 0 errors (warnings предсуществующие); тесты shared 155 · core 2165 · ui 799 · backend 372; Vite HMR без ошибок; браузер (dev UI :5002, admin-key-123) — Git/Files: закреплённый «Тестовый проект» + «Другие проекты (12)», тумблер фильтрует до одного проекта.
- **Известное:** предсуществующий флак параллельных timing-тестов (`task-resume`/`orchestrator`); нерабочий expand-all в `GitTabToolbar` (`synth:git-expand-all` без слушателя) — вне задачи; `LeftPanel.tsx` большой diff из-за переноса тела рендера.
- **Скриншоты:** `tmp/leftpanel-git.png`, `tmp/leftpanel-git-only.png`, `tmp/leftpanel-files.png`.
- **Коммиты (ветка `feat/ad-075-workspace-provisioning`):** `8b6e647` (standalone ADMIN), `12be420` (SSH «Тип»), `8ef2eba` (env-доступность), `24d42d9` (левая панель).
- **Хвосты (закрыты):** рабочий expand-all в Git (`gitStore.expandAll` + тулбар без CustomEvent); подпись `dependency` в StatsTab (i18n `rightPanel.stats.toolUnavailableDependency`); `runtimeDeps` в permission-слое саб-агентов (`task.ts`/`task-resume.ts`/`orchestrator.ts`, `renderUnavailableTools` экспортирован, секция `[НЕДОСТУПНЫЕ ТУЛЫ]` для сабагента).
- **Smoke SSH (gitea):** fetch `.dots`/`trepo` OK; SSH-clone сначала падал `Use of "EDITOR" is not permitted without enabling allowUnsafeEditor` — баг: `git/git-service.ts:withEnv` мержит весь `process.env` + `GIT_SSH_COMMAND`, а simple-git 3.36 блокирует blocklist (`EDITOR`/`PAGER`/`PREFIX`/`SSH_ASKPASS`/любые `git*`) без `unsafe.allowUnsafe*`. Фикс: `sanitizeGitEnv` + `createGit({unsafe:{allowUnsafeSshCommand:true,allowUnsafeAskPass:true}})`, `GIT_TERMINAL_PROMPT=0`. Проверка: `tmp/smoke-ssh.mjs` с `EDITOR=vim PAGER=less GIT_PAGER=cat GIT_SSH=/bin/false` → `CLONE_OK`/`IS_REPO true`. Запущенный dev-backend держит старый core dist — нужен рестарт.
- **Docs:** новый `docs/arch_decisions/ad-078-runtime-dependency-availability.md` + правки root/package AGENTS.md + `docs/arch_decisions/README.md`.
- **Дальше:** рестарт dev-серверов для подхвата core-фикса SSH; при желании — e2e через UI.

## 2026-09-29 (продолжение) — standalone «как из npm» + рестарт dev + чистка — PASS

- **Задача:** standalone должен работать как «поставил npm-пакет и запустил бинарник» (все пути/параметры по умолчанию); плюс рестарт dev и чистка временных файлов.
- **Тип:** feature + chore · **Результат:** PASS (код+скрипт+docs закоммичены).
- **Баг:** `synth serve` без флагов печатал `API-ключ: (не задан)` → вход в UI невозможен (401); хост по умолчанию `0.0.0.0`; `SYNTH_HOST` игнорировался (commander-дефолт перебивал env).
- **Фикс:** новый `core/src/auth/local-key.ts` — `resolveOrCreateLocalApiKey` (устойчивый ключ `randomBytes(16).toString('hex')` в `{dataDir}/secrets/api-key`, `0600`/`0700`, идемпотентно); `synth serve` — приоритет `--api-key`/config > `SYNTH_API_KEY` > сохранённый > сгенерировать, печатает ПОЛНЫЙ ключ и путь; host по умолчанию `SYNTH_HOST || '127.0.0.1'`. `scripts/standalone.sh` по умолчанию запускает `serve` без переопределений (очистка `SYNTH_*`), флаги — переопределения, `--clean` только с явным `--data-dir`, эффективные значения парсит из вывода сервера.
- **Верификация:** typecheck 6/6; lint 0 errors; тесты core 2173 (+4), ui 804, backend 372; независимо: `env -i HOME=<iso> … serve --port 4321` → ключ 32 hex, файл `0600`, `no-key 401 / with-key 200`, host `127.0.0.1`; `HOME=<iso> ./scripts/standalone.sh --no-build --check` → OK.
- **Dev перезапущен** (`./scripts/dev.sh`, все сервисы 5000/5002/4300 = 200); smoke через API: SSH-clone `.dots` по ключу Synth → `{"path":"smoke-ssh-test","isRepo":true}`, затем `remove` c `deleteLocal` — каталог удалён.
- **Чистка:** удалены скриншоты и черновики из корня проекта (`*.png`, `dropdown-*.yml`, `state1.yml`, `snap-initial.md`), `.playwright-mcp/`, содержимое `tmp/` (родительского) и `synth/tmp` (оставлены только активные `backend.log`/`ui.log`/`core.log`). `AD-DRAFTS.md`, `rbac-design.md`, `data/`, `ws-default/` сохранены.
- **Docs:** `docs/DEVELOPMENT.md`, `docs/QUICKSTART.md`, `docs/CONFIGURATION.md`, корневой `AGENTS.md` (дефолты standalone).
- **Дальше:** при желании — e2e выделенного каталога в standalone-UI (порт 4300 занят dev-core).

## 2026-09-29 — AD-079: локальный home-каталог (`--home`/`SYNTH_HOME`) — PASS

- **Задача:** реализовать AD-079 «Локальный home-каталог и независимые локальные инстансы» (flat-раскладка config/data/profiles/credentials, приоритеты путей, изоляция standalone/hybrid).
- **Тип:** feature (CLI + конфиг-резолвинг) · **Исполнитель:** @orchestrator → @fixer (код+тесты), general (docs) · **Результат:** PASS.
- **Код:** `shared/config/resolve.ts` — `resolveHome`, `resolveProfilesPath`, `resolveCredentialsPath`, home-параметр у `resolveDataDir`/`resolveWorkspacesRoot`/`resolveDefaultWorkspace`/`findConfigPath`/`defaultConfigPath`/`ensureFirstRun`; `shared/config/loader.ts` — `LoadConfigOptions.home`; `core/profiles.ts` — `getProfilesPath(home)`; `core/remote/credentials.ts` — `defaultCredentialsPath(home)`; `core/server/app.ts` — `StandaloneConfig.profilesPath` (getHybridState/rememberServer); CLI (`packages/synth` + `core/src/main.ts`) — флаги `--home`/`--profiles`/`--credentials` на serve/connect/disconnect/project publish|fork/secrets rotate.
- **Скрипты:** `standalone.sh` — home по умолчанию `~/.local/share/synth-standalone` (по решению пользователя; фикс исходного бага: подхват `lastProfile` из общего `~/.config/synth`); `hybrid.sh` — опция `--home` (без неё прежнее XDG-поведение, чтобы не терять данные пользователя).
- **Приоритет:** `--data-dir`/`--config`/`--profiles`/`--credentials` (+ env-аналоги) > `--home` > `SYNTH_HOME` > XDG-дефолты; без home поведение не изменилось.
- **Верификация (независимо):** `pnpm build` OK; `pnpm typecheck` 6/6; `pnpm test` shared 170 · core 2175 · ui 804 · backend 372; `pnpm lint` 0 errors; smoke `serve --home <tmp> --port 4391` → `/health` 200, созданы `<home>/config.yaml` + `<home>/data/`, `/hybrid/status.knownServers` берёт `<home>/profiles.json` (изоляция подтверждена).
- **Docs:** AD-079 → ✅ Реализовано (+ раздел «Реализация»); корневой/shared/core AGENTS.md; docs/CONFIGURATION.md, docs/DEVELOPMENT.md.
- **Дальше:** AD-080 (режимы гибрида) — использует home одного инстанса.

## 2026-09-29 — Порты инстансов: hybrid 4300 / standalone 4400 — PASS

- **Задача:** развести порты скриптов запуска, чтобы standalone и hybrid поднимались одновременно.
- **Тип:** chore (скрипты+docs) · **Исполнитель:** @fixer · **Результат:** PASS.
- **Скрипты:** `standalone.sh` — `PORT=4400`, `--port` теперь передаётся ВСЕГДА (как `--home`), `effective_core_port` упрощён до `echo "$PORT"` (убран `config show`); `hybrid.sh` — 4300 (как было), в справке отмечено.
- **Docs:** `docs/DEVELOPMENT.md` (standalone 4400 + ремарка про одновременный запуск), `docs/arch_decisions/ad-079-...md` (порты скриптов).
- **Верификация:** `bash -n` OK; `./scripts/standalone.sh --help` → default 4400; smoke `--no-build --check --home /tmp/...` без `--port` → поднялся на `127.0.0.1:4400`, 5/5 `[OK]`, `Результат: OK`; режимы файлов 100755 не менялись.
- **Дальше:** AD-080.

## 2026-09-30 00:15 — Баг: standalone `POST /api/v2/models/fetch` → 404 «Маршрут не найден» — PASS

- **Задача:** в standalone добавили ollama-провайдера, тест проходит (модели видны), но «Синхронизировать модели» падает `Маршрут не найден: POST /api/v2/models/fetch`.
- **Тип:** bug fix (роутинг) · **Исполнитель:** @fixer (фикс+тесты), @orchestrator (приёмка) · **Результат:** PASS.
- **Первопричина:** логика `POST /fetch` жила только в backend-обёртке `packages/backend/src/routes/models.ts`, в core-фабрике `createModelRoutes` роута не было — standalone (core) не видел эндпоинт (UI вызывает его в обоих режимах). Нарушение инварианта «общая логика роутов — в core-фабриках, backend монтирует + RBAC/rate-limit/i18n».
- **Фикс:** `POST /fetch` перенесён в core-фабрику `createModelRoutes` 1:1 (фильтр `?provider=`, `enabled!==false`, `ProviderFactory.create`+`listModelsDetailed`, обогащение окна/`maxOutputTokens`/цен/`currency`, защита ручных цен, синхронизация `modelCache`); новые опции `fetchGuard`/`fetchMiddleware`/`messages.fetchError`. Backend стал тонкой обёрткой (`fetchGuard: kit.requireAdmin`, `fetchMiddleware: [createRateLimiter(3, 120_000)]`, i18n), ~200 строк дубля удалено.
- **Файлы:** `packages/core/src/server/routes/models.ts`, новый `packages/core/src/server/routes/models.fetch.test.ts` (5 тестов), `packages/backend/src/routes/models.ts`, `docs/API_V2.md`, `packages/backend/AGENTS.md`.
- **Верификация:** `pnpm build` OK; `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm test` — независимо перепроверено core 2180 PASS, backend 372 PASS (5/5 новых). Standalone curl (`dev.sh core`, :4300, `SYNTH_API_KEY`): без auth 401; `POST /models/fetch?provider=ollama` → 200 `{"fetched":9,...}` — не 404.
- **Не сделано:** коммит (по инварианту 13 — только по явной просьбе). Опционально — визуальная проверка кнопки синхронизации в UI.
- **Побочное (вне рамок):** `dev.sh core` запускает `core/dist/main.js serve` напрямую и не вызывает `resolveOrCreateLocalApiKey` — dev-core стартует с пустым ключом (лечится `SYNTH_API_KEY`). Кандидат в отдельную задачу.

## 2026-09-30 00:25 — Баг: после синхронизации модели не появляются в списке (standalone) — PASS

- **Задача:** по кнопке «Синхронизировать модели» сообщение «Синхронизировано N моделей», но модели в списке отсутствуют.
- **Тип:** bug fix (хранилище) · **Исполнитель:** @fixer (фикс+тесты), @orchestrator (приёмка) · **Результат:** PASS.
- **Первопричина:** расхождение реализаций `JsonStore.list()` core ↔ backend. Модели сохраняются с полным id `provider/model` → файл `models/<provider>/<model>.json`. Backend `list()` рекурсивный (`_collectItems`), а core `list()` читал только `.json` **верхнего уровня** и подкаталоги игнорировал → `GET /api/v2/models` в standalone не видел ни одной модели (`data/models` содержит только подкаталоги провайдеров). Баг латентный, выявился на кнопке синхронизации (не регрессия предыдущего фикса).
- **Фикс:** `packages/core/src/storage/json-store.ts` — `list()` сделан рекурсивным (по образцу backend, ключ вычисляется относительно корня subdir), + doc-комментарий о необходимости синхронизации с backend. Backend-класс не объединяли (отличаются `delete`/`exists`) — только doc. `load/save/delete/exists` и `JsonStoreLike<T>` не тронуты.
- **Файлы:** `packages/core/src/storage/json-store.ts`, новый `packages/core/src/storage/json-store.test.ts` (10 кейсов: вложенные/плоские/несколько подкаталогов, игнор `.tmp.*`/не-json/битого json, пустой каталог, traversal), `packages/backend/src/storage/json-store.ts` (doc).
- **Верификация:** `pnpm build` OK; `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm test` — независимо перепроверено core **2190 PASS**, backend **372 PASS**. E2E standalone (`dev.sh core` :4300): `GET /models?provider=ollama` → 9 моделей (было бы 0 до фикса), `POST /models/fetch?provider=ollama` → `{fetched:9,...}`, после — те же 9 моделей (`deepseek-coder-v2:16b`, `deepseek-r1:14b`, …). Плоские хранилища (`providers`, `agents`) не затронуты.
- **Не сделано:** коммит (инвариант 13). UI визуально не проверялся (API-доказательство есть).
- **Побочное (вне рамок):** `dev.sh core` не создаёт авто-ключ (`main.ts` берёт `config || env || ''`) — расходится с формулировкой корневого AGENTS.md про `{dataDir}/secrets/api-key`; кандидат в отдельную задачу.

## 2026-09-30 01:30 — Полный рефакторинг: устранение дублирования core↔backend — PASS

- **Задача:** устранить системное дублирование функционала между `@itphx/synth-core` и `@itphx/synth-backend`; цель — работающие managed/hybrid/standalone без дублей (по ранее принятым AD: AD-005/017/071/075/076). Заказчик: полный рефакторинг.
- **Тип:** refactoring (крупный, поэтапный) · **Исполнитель:** @orchestrator → @researcher (инвентаризация) + @fixer (этапы A–D) · **Результат:** PASS.
- **Первопричина/контекст:** рефакторинг на «тонкие обёртки над core-фабриками» был остановлен на полпути; `JsonStore`/`ProjectStore` и 6+ роутов существовали в двух разошедшихся копиях (именно расхождение `JsonStore.list()` дало баг с моделями `provider/model`).

### Этапы (все PASS)
- **A — хранилища:** backend импортирует `JsonStore`/`ProjectStore` из core; копии удалены (`backend/src/storage/*`), выровнены `exists()` (`load()!==null`) и `delete()` (чистка `_locks`), удалён мёртвый `ProjectStore.stats()`.
- **B — общие хелперы:** `syncProvidersFromEnv` вынесен в core (`core/src/providers/sync-from-env.ts`), backend переиспользует.
- **C1 — messages/queue:** backend-копии заменены обёртками над core-фабриками; `opts.messages` (i18n) + `opts.onMessagesChanged` (backend `recalc-can-summarize`); устранена гонка (без `await`), ликвидирован англ. литерал.
- **C2 — agents/mcp:** core `createAgentRoutes` расширен до надмножества backend (`writeGuard`/`allGuard`/`detailGuard`, `GET /:id`, `PATCH /:id/enabled`, `topK`, builtin-fallback, честный `is_builtin`); core `createMcpRoutes` — `/probe` (+`MCP_CONNECT_ERROR`), backend-only legacy/registry вынесены в `backend/src/routes/mcp-registry.ts`.
- **D1 — projects:** core `createProjectRoutes` — надмножество (RBAC-хуки `canManage`/`canEditContent`, `getCurrentUserId`, `messages`, `autoProvisionWorkspace`, `getMcpServers`→`/:id/mcp`, `sessionManager`→`/:id/stats`, `plan`); backend — обёртка (+`createProjectAccess` для git).
- **D2 — fs:** core `createFsRoutes` стал project-aware (AD-075): `getProjectWorkspace` (+`resolveProjectWorkspace`, `isTextFile` в `core/src/server/fs-workspace.ts`), `requireProjectId`, единая `FsError`-форма, `move`/`mkdir` 201/409, upload/download/maxDepth; удалены `backend/src/routes/fs.ts` и `backend/src/lib/workspace-resolver.ts` (+тесты, покрытие перенесено в core).
- **Docs:** обновлены корневой `AGENTS.md`, `packages/core/AGENTS.md`, `packages/backend/AGENTS.md` (таблица монтирования), `docs/API_V2.md`.

### Верификация (независимо, @orchestrator)
- `pnpm build` OK; `pnpm typecheck` 6/6; `pnpm lint` 0 errors.
- `pnpm test`: core **2250**, ui **804**, backend **341**, shared 170, runner — нет тестов. Все PASS.
- **Managed** (`dev.sh backend`, debug-auth): projects CRUD/RBAC/`stats`/`mcp`, project-aware FS (write/read/mkdir 201/409/traversal 403/no project_id 400), `models/fetch?provider=ollama` → `fetched:9`, `agents/all` admin 200 / developer 403, `mcp/registry` 200.
- **Standalone** (`standalone.sh`): provider+`models/fetch` → `fetched:14`, project-aware FS + fallback на root, `workspace-root`, agents.
- **Hybrid** (core `serve --connect` к локальному backend): `/hybrid/status` connected, агрегация проектов (`remote:`), **remote-ветки FS** (`fs`/`fs/read` проекта backend через hybrid) — 7/7 PASS.
- **LLM e2e (standalone):** сессия + prompt на модели `tobestyledintro/qwen3.8-9b-distill:latest` (ollama `http://omn.itphx.loc:11434`) → assistant ответил «Привет».
- **Не сделано:** коммит (инвариант 13 — только по явной просьбе). Скрипты smoke — в `tmp/` (не коммитятся).
- **Остаточное (вне scope):** `dev.sh core` без авто-ключа; core-тест remote-веток FS с моком `RemoteBackendClient` (покрыто e2e hybrid, юнита нет).

## 2026-09-30 02:20 — Релиз 0.8.0 + деплой на test — PASS

- **Задача:** бампнуть версию до 0.8.0, закоммитить, собрать, задеплоить на test (по явной просьбе пользователя).
- **Тип:** release + deploy · **Исполнитель:** @devops (скиллы `synth-release`/`synth-build-publish`/`synth-k3s-deploy`) · **Результат:** PASS.
- **Bump:** `./scripts/version-bump.sh 0.8.0` — `version.ts` + 6× `package.json` + `charts/synth/Chart.yaml` (0.7.3 → 0.8.0).
- **Коммиты `synth/` (ветка `feat/ad-075-workspace-provisioning`, запушена):** `f25e556` refactor (устранение дублирования core↔backend), `35759ee` `chore(release): 0.8.0`. Тег `v0.8.0` и npm-публикация **не** делались (релизный workflow preprod/prod вне задачи).
- **Docker:** собраны из исходников и запушены в `git.itphx.ru`: `synth-backend:0.8.0` (298 MB), `synth-ui:0.8.0` (116 MB); версия внутри образа проверена.
- **`synth-deploy` (main):** `values.yaml` image tags → 0.8.0, `helm lint`/`template` OK, коммит `96032d1` запушен → Fleet раскатал.
- **Верификация (независимо, @orchestrator):** `https://synth.k3s.itphx.loc/api/v2/health` → `{"status":"healthy","version":"0.8.0"}`; UI `/` → 200; `kubectl -n synth get deploy` — образы `:0.8.0`; поды backend/ui `1/1 Running`, RESTARTS 0; оба репозитория clean.
- **Осталось:** preprod/prod не трогались (нужен тег/`workflow_dispatch` или публикация Helm-чарта — отдельной задачей).

## 2026-09-30 09:07 — UI: кнопка «Удалить» под сообщением (нормальный цвет + красный hover) — PASS

- **Задача:** в ряду кнопок в нижней части ответа кнопка «Удалить» всегда выглядела ярче остальных; требовалось в обычном состоянии — как остальные, при наведении — красная подсветка.
- **Тип:** bug fix (UI, стили) · **Исполнитель:** @fixer · **Результат:** PASS.
- **Причина:** `packages/ui/src/components/chat/MessageActions.tsx` (`ActionBtn`, ветка `danger`) не задавала базовый цвет текста, в отличие от обычной ветки (`text-muted-foreground`) → кнопка наследовала яркий цвет контейнера. `danger` используется только у Delete.
- **Правка (1 строка):** `'hover:bg-destructive/10 hover:text-destructive'` → `'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'`.
- **Верификация (@orchestrator):** `git status` — изменён ровно 1 файл; `pnpm --filter @itphx/synth-ui typecheck` OK; `lint` 0 errors (30 pre-existing warnings, ни одного в MessageActions.tsx); `test` 804/804 PASS (в т.ч. `MessageActions.test.tsx` 4/4).
- **Не сделано:** коммит (инвариант 13 — только по явной просьбе), визуальная проверка в браузере (`dev.sh`) не запускалась.

## 2026-09-30 09:50 — UI: унификация MCP/Скиллов в правой панели + перенос «Плана» — PASS

- **Задача:** (1) описания скиллов — под скрывающийся блок; (2) «План» выше «Рабочего каталога»; (3) MCP и Скиллы — единый вид между «Сессией» и «Проектом»; (4) MCP и Скиллы похожи между собой (одинаковые переключатели, кат).
- **Тип:** refactor (UI) · **Исполнитель:** @fixer · **Результат:** PASS.
- **Согласованные развилки:** правки только во вкладке «Проект» для порядка секций; единая визуальная оболочка без смены семантики (Сессия — 1 тумблер, Проект — 2); под катом: у скиллов — описание (добавлено и в «Сессию»), у MCP — статус/systemHint; общий hint секции остаётся видимым внизу; кат — кнопка у каждого элемента.
- **Файлы:** новый `components/panels/ExpandableListRow.tsx` (`ExpandableListRow` + `RowBadge`, 4 тона); `ProjectTab.tsx` (порядок секций, MCP/Skills на примитиве); `SessionSettingsTab.tsx` (MCP/Skills на примитиве, подпись «Включён» у тумблеров); `i18n/messages/{ru,en}.ts` (`sessionSettings.{mcp,skills}.toggleLabel`); тесты: новый `ExpandableListRow.test.tsx` + обновления 4 существующих.
- **Верификация (@orchestrator):** `typecheck` OK; `lint` 0 errors (30 pre-existing warnings, в изменённых файлах — 0); `test` **103 файла / 811 тестов PASS**.
- **Визуально (dev :5002, браузер, admin/debug):** «Проект» — порядок ПРОЕКТ → ПЛАН ПРОЕКТА → РАБОЧИЙ КАТАЛОГ → ИНВАРИАНТЫ → MCP → СКИЛЛЫ; «Сессия» — MCP/Скиллы с бейджами, подписью «Включён» и тумблером, кат раскрывает описание/статус, hint остаётся видимым. Скриншоты: `tmp/right-panel-project-top.png`, `tmp/right-panel-project.png`, `tmp/right-panel-session.png` (не коммитятся).
- **Не сделано:** коммит (инвариант 13). Предложено обновление `packages/ui/AGENTS.md` (примитив строки + порядок секций) — ждёт согласования.

## 2026-09-30 10:30 — UI: единый каркас и ритм вкладок правой панели (PanelTab) — PASS

- **Задача:** разные вертикальные интервалы вкладок правой панели; нужен универсальный вариант как в «Проекте»; проверить остальные вкладки и унифицировать стили.
- **Тип:** refactor (UI) · **Исполнитель:** @fixer · **Результат:** PASS.
- **Согласовано:** канон — ритм вкладки «Проект» (корень `p-3`, между секциями 16px, внутри секции 8px, компактные списки `gap-1.5`); единый внутренний скролл во всех вкладках; объём — все вкладки правой панели; закрепление — компонент-обёртка + строка в `packages/ui/AGENTS.md`.
- **Было (замер):** паддинги 12/16/8, шаги 16/12/4, скролл то внутренний, то внешний; в `StatsTab` 14 `mt-*`/6 `mb-*`.
- **Стало:** новый `components/panels/PanelTab.tsx` (тело `flex-1 min-h-0 overflow-y-auto p-3 space-y-4` + фиксированный футер `shrink-0 border-t p-3 space-y-2`); `RightPanel` без внешнего `overflow-y-auto`; на `PanelTab` переведены «Сессия», «Проект», «Контекст», «Статистика», «Ссылки», «Безопасность», пустые состояния и «Шедулер»; вычищены ad-hoc `mt-*`/`mb-*` (Сессия `mb-2`/`mt-2`, Контекст `SectionHeader pt-1 pb-0`, Проект `mb-1`, Статистика 14 `mt-*`/6 `mb-*` → `space-y-*`/`gap-*`).
- **Файлы:** `PanelTab.tsx` (+тест, новый), `RightPanel.tsx`, `SessionSettingsTab.tsx`, `ProjectTab.tsx`, `ContextTab.tsx`, `StatsTab.tsx`, `ReferencesTab.tsx`, `SecretsTab.tsx`, `packages/ui/AGENTS.md`.
- **Верификация (@orchestrator):** `typecheck` OK; `lint` 0 errors (30 pre-existing warnings, в изменённых файлах — 0); `test` **104 файла / 814 тестов PASS** (в т.ч. новый `PanelTab.test.tsx`).
- **Визуально (dev :5002, admin):** замерено по всем вкладкам — паддинг 12px, интервал между секциями 16px, заголовок↔контент 8px, внешний скролл панели нигде не скроллится (нет двойных скроллбаров), футеры «Сессия»/«Контекст» фиксированы. Мобильный дровер (390×844, `device-phone`): тело скроллится, футер прижат к низу (749–844). Скриншоты: `tmp/panel-session.png`, `tmp/panel-stats.png`, `tmp/panel-mobile-drawer-session.png`.
- **Не сделано:** коммит (ждёт команды). Вне scope: левая панель и админка; `mt-0.5`-компенсации и `mb-2` у заголовков карточек оставлены осознанно.

## 2026-09-30 11:00 — UI: автокомплит `/`-команд — ширина, перенос, скролл, зазор над композером — PASS

- **Задача:** окно выбора команд не ограничено по ширине (длинные описания уезжают и обрезаются), описания не переносятся, нет ограничения высоты/скролла, окно примыкает к полю ввода.
- **Тип:** bug fix (UI) · **Исполнитель:** @fixer · **Результат:** PASS.
- **`CommandAutocomplete.tsx`:** корень — `flex flex-col overflow-hidden … max-h-[min(24rem,60vh)]`, ширина `32rem` + `maxWidth: 100%` (не шире композера); список — `flex-1 min-h-0 overflow-y-auto` (шапка и подсказка по клавишам больше не обрезаются, скроллится только список); описание — `whitespace-normal break-words` вместо `truncate`.
- **Зазор над полем ввода:** JS-замер `textarea.getBoundingClientRect().height` в обработчике `input` недостоверен (DOM ещё не устоялся: замерено 47–60px при итоговых 20px), поэтому позиционирование переведено на CSS: `bottom: calc(100% + 17px)` = 9px до рамки композера (border 1 + py-2 8) + 8px зазора. Применено и к `MentionPopup`; из `ChatInput` удалены константы/замеры высоты, пропс `position` сужен до `{ left }`.
- **Верификация (@orchestrator):** `typecheck` OK; `lint` 0 errors (30 pre-existing warnings вне изменённых файлов, в них — 0); `test` **104 файла / 817 тестов PASS**.
- **Визуально/замерами (dev :5002):** зазор 8px при textarea 1 строке и при 200px (многострочный); ширина: 213px при узком композере (231), 512px = ровно 32rem при широком (551) — без горизонтального переполнения; высота ограничена 384px, список скроллится, подсказка клавиш видна; длинное описание `/developer-documentation` переносится. Для `@`-упоминаний зазор тот же (8px). Скриншоты: `tmp/autocomplete-wide.png`, `tmp/autocomplete-fixed.png`.
- **Замечание инфраструктуры:** Vite иногда отдаёт устаревший transform после правок через симлинк `~/dev/Synth/synth` → устаревший модуль; лечится `touch` файла (сделано), HMR после этого корректный.
- **Не сделано:** коммит (ждёт команды). Опция на обсуждение: ограничить длину описания (`line-clamp-3`) — сейчас очень длинное описание занимает почти всю высоту списка.

## 2026-09-30 11:20 — UI: переформулированы подписи MCP/скиллов и политик в правой панели — PASS

- **Задача:** убрать жаргон «opt-out» и длинные подписи; лаконичные формулировки в одном стиле; опция «Как в глобальной» → «Глобальная (<актуальное значение>)»; подпись «Глобальная политика задаётся администратором».
- **Тип:** UI-тексты + небольшой фикс логики · **Исполнитель:** @fixer · **Результат:** PASS.
- **Согласовано с пользователем:** сессия — «Включение/отключение на уровне сессии. Переопределяет настройки проекта.» (MCP и скиллы); проект — «Состояние для новых сессий по умолчанию.» (MCP и скиллы); в селекте сессии — короткие имена значений, подпись «Политика для этой сессии. Глобальная политика задаётся администратором.».
- **Ключи i18n (ru+en):** `sessionSettings.{mcp,skills}.hint`, `projectTab.{mcp,skills}.hint`; новые `policy.short.{consistency,available,auto}`, `toolsPolicy.inheritUnknown`/`mcpPolicy.inheritUnknown`; изменены `toolsPolicy.inherit`/`mcpPolicy.inherit` («Глобальная ({policy})») и `*.sessionHelp`. Длинные подписи админских карточек (`*.consistency|available|auto|help`) не тронуты.
- **Логика (`SessionSettingsTab.tsx`):** добавлены `globalToolsPolicy`/`globalMcpPolicy` (`ToolsPolicy | null`) и запросы `getToolsPolicyInfo()`/`getMcpPolicyInfo()` (доступны любому авторизованному — проверено: 200 для admin и developer); хелпер `inheritLabel()` даёт «Глобальная (<короткое имя>)», при ошибке — фоллбек «Глобальная» (без скобки). Ошибка запроса не блокирует рендер и не показывает уведомлений.
- **Верификация (@orchestrator):** `typecheck` OK; `lint` 0 errors (30 pre-existing warnings вне изменённых файлов); `test` **104 файла / 818 тестов PASS**.
- **Визуально (dev :5002, ru):** оба селекта политик — «Глобальная (По провайдеру)» (глобальное значение `auto`), список опций — «Согласованность / Только доступные / По провайдеру»; подписи под селектами — «Политика для этой сессии. Глобальная политика задаётся администратором.» (×2); подсказки секций — новые формулировки (×2 в «Сессии», ×2 в «Проекте»). Скриншот: `tmp/labels-policy-open.png`.
- **Замечание:** из подсказки скиллов убрана оговорка «скиллы, отключённые администратором, включить здесь нельзя» (сократили по решению пользователя) — тумблер для таких скиллов остаётся disabled, но текстового пояснения рядом больше нет.
- **Не сделано:** коммит (ждёт команды).

## 2026-09-30 12:30 — Скиллы/MCP: единая модель вкл/выкл (система/проект/сессия) — PASS

- **Задача:** баг — в «Тестовом проекте» скиллы отключены, но в новой сессии включены; навести порядок и унифицировать логику с MCP.
- **Тип:** bug fix + refactor (shared/core/backend/ui/docs) · **Исполнитель:** @fixer + @tester.
- **Согласованная модель (per-item):** система — `enabled` (hard-gate: выкл → недоступно нигде) + `defaultForNewProjects` (сид новых проектов); проект — `enabled` (hard-gate, бьёт и по старым сессиям) + `defaultOn` (сид новых сессий); сессия — один тумблер. Дефолты — snapshot, гейты — live; база opt-in. Legacy: гейт активен только при наличии `project.skills`/`project.mcp`.
- **Реализация:** `resolveMcpScope`/`resolveSkillScope` (формула `systemOn && projectOn && configOn && !sessionOff && (snapshotOn || sessionOn)`), снапшот-поля `SessionSettings.skillsDefaultOn`/`mcpDefaultOn`, `McpRegistryEntry.enabled`, `/settings/skills.disabledForNewProjects`, seeding при создании проекта/сессии, идемпотентная миграция `session-scope-snapshots-v1`, тул `skill` уважает scope (`skill.scope_disabled`); UI — админка «две оси», «Проект» — 2 тумблера и для системных, «Сессия» — блокировка по system/project, «Статистика» — источник `project`.
- **Верификация (@orchestrator):** shared build OK; `pnpm typecheck` OK; `pnpm lint` 0 errors; тесты — core 2275, backend 341, shared 170, ui 825 PASS. (Флейк `core/src/server/app.remote.test.ts` по таймауту 5с в параллельном прогоне — не регрессия, отдельно зелёный.)
- **Ручная проверка (dev :5000/:5002, проект `mpfc00f0-1-hnu5bb93`):** проект `skills={enabled:[],defaultOn:[]}` → скиллы недоступны и в новой, и в старой сессии, `skills.catalog` в промпте отсутствует; легаси-проект без настройки — скиллы включены; добавление скилла в проект → появляется в каталоге новой сессии; MCP — новый флаг `enabled`, причина `config`. Скриншоты `tmp/qa-*.png`. Данные проекта возвращены в исходное состояние, тестовые сессии удалены.
- **Docs:** уточнены AD-046 §4.5, AD-071 §2.2/2.4/2.5, `docs/API_V2.md`, `packages/{core,shared,ui}/AGENTS.md`, корневой `AGENTS.md` (новый AD не создавался).
- **Не сделано:** коммит (инвариант 13 — ждёт команды).

## 2026-09-30 13:10 — Скиллы/MCP: фиксы курсора и MCP config-гейта — PASS

- **Задача:** (1) визуальный баг — при тумблере скилла/MCP в сессии курсор становился «запрет»; (2) project-allowed MCP нельзя включить в сессии.
- **Тип:** bug fix (ui + core/shared/docs) · **Исполнитель:** @fixer (2 параллельно) + @orchestrator.
- **Баг 1 — причина:** `Toggle` получал `disabled` на время in-flight (`skillToggling`/`mcpToggling`), а класс `disabled:cursor-not-allowed` давал курсор-запрет; «занят» и «недоступен» были смешаны. **Фикс:** `Toggle` получил проп `pending` (aria-busy + `opacity-60 cursor-progress`, без атрибута `disabled`); в `SessionSettingsTab` in-flight → `pending`, `disabled` — только при причине system/project; в `ProjectTab` транзиентный `disabled={saving}` → `pending`. Добавлены тесты `Toggle.test.tsx`, обновлены тесты сессии. Аудит прочих `cursor-not-allowed`: остальные — реально недоступные (нет прав/workspace/выключено), корректны; кандидат на follow-up — `PlanActModeToggle` (busy + недоступность смешаны).
- **Баг 2 — причина:** реестровый мастер `synth-mcp-local.enabled=true`, но `entry.config.enabled=false` из config.yaml работал **вторым** hard-gate (`configEnabled`) → причина `config`, сервер выключен навсегда. **Фикс:** убран `configEnabled`/причина `config`; системный мастер — только `McpRegistryEntry.enabled`; `McpServerConfig.enabled` — лишь сид (`seedFromConfig`); `McpManager.isServerSystemEnabled` fallback → `true`; обновлены shared-типы, i18n, тесты, AD-071/API_V2/AGENTS.
- **Верификация (@orchestrator):** shared build OK; `pnpm typecheck` OK; `pnpm lint` 0 errors; тесты — core 2276, backend 341, shared 170, ui 833 PASS.
- **Живой API (после рестарта backend+core):** `synth-mcp-local` в сессии — `not_default` и **включается** (`enabled:true`); реестровый мастер `enabled:false` → `system_disabled` (live-гейт), возврат `true` → снова включается. Временные проект/сессия/сервер удалены, данные не затронуты.
- **Не сделано:** коммит (ждёт команды).

## 2026-09-30 13:45 — UI: канон курсора тумблера + автосейв вкладки «Сессия» — PASS

- **Задача:** убрать курсор-«запрет» у тумблеров, единый стиль индикации сохранения; перевести вкладку «Сессия» на автосохранение и убрать кнопки внизу.
- **Тип:** UX/refactor (ui) · **Исполнитель:** @fixer (2 задачи) + @orchestrator.
- **Канон Toggle:** обычный — `cursor-pointer`; `pending` (идёт сохранение) — `cursor-progress` + `opacity-60` (`aria-busy`), без атрибута `disabled`; `disabled` (реально недоступно) — `cursor-default` + `opacity-40`, без not-allowed, причина текстом. Зафиксировано в `packages/ui/AGENTS.md`. `ContextTab`: тумблеры окна/суммаризации получили `pending={saving}`.
- **Автосейв «Сессии»:** убрана кнопка Save и футер; «Очистить сессию» перенесена в конец контента. Единый `buildSettingsBody` (та же логика, включая askTimeout/permission, routing/micro/embedding, policies), слепок значений и `dirtyKeys` (не сохраняет, если не отличается и при гидратации/смене сессии); триггеры: тумблеры/селекты — сразу, инпуты/слайдеры — debounce 500 мс; flush при смене сессии; `pending` только у изменённого контрола; provider/model по-прежнему через `ModelSelector` (без дублей). Удалены неиспользуемые i18n-ключи `sessionSettings.{saved,saving,notLoaded}`.
- **Верификация (@orchestrator):** `pnpm typecheck` OK; `pnpm lint` 0 errors; тесты — shared 170, core 2276, backend 341, ui **841** PASS.
- **Коммиты:** `2221f76` (канон курсора), ниже — автосейв «Сессии».

## 2026-09-30 14:15 — fix: 500 на GET /sessions/:id/skills при permission={} — PASS

- **Задача:** верификация автосейва выявила `GET /sessions/:id/skills` → 500 (сессия с `settings.permission = {}`).
- **Тип:** bug fix (core + ui) · **Исполнитель:** @fixer + @orchestrator.
- **Причина:** `resolveNamedRule` (`engine/permission/evaluator.ts`) делал `config?.rules[key]` — опциональная цепочка только на `config`, не на `rules`; при `permission={}` (пустой объект) бросал. Автосейв «Сессии» мог записать пустой `permission: {}`.
- **Фикс:** `config?.rules?.[key]` + защищённый геттер `_rules` (`_computeDecision`); автосейв не пишет пустой `permission` (исключён из spread, `undefined` при пустом). Тесты evaluator/skill-rule/command-rule/skill-scope (200 вместо 500) и UI (не пишет пустой permission, непустой override пишет).
- **Верификация:** `shared build`/`core build` OK; `pnpm typecheck` OK; `pnpm lint` 0 errors; тесты — shared 170, core **2282**, backend 341, ui **843** PASS. Живой dev: `GET /sessions/mt8b037e…/skills` → 200; backend+core перезапущены.
- **Коммит:** ниже.

## 2026-09-30 14:40 — UI: единый шаблон сохранения настроек правой панели — PASS

- **Задача:** success/error-уведомления для всех немедленных сохранений правой панели + откат UI при ошибке; единый шаблон.
- **Тип:** UX/refactor (ui) · **Исполнитель:** @fixer + @orchestrator.
- **Решения пользователя:** уведомлять при всех немедленных сохранениях; единый текст; троттлинг success-тостов; общий шаблон.
- **Реализация:** новый хук `hooks/usePanelSettingSave.ts` (`run({key, run, onSuccess, onError, errorKey, silentError})`, `isPending(key)`, `pendingKeys`): pending по контролу → throttled success-тост (1500 мс) → при ошибке всегда error-тост + `onError` для отката; спец-ошибки через `errorKey`/`silentError`. Переведены `ContextTab` (откат тумблеров при ошибке), `ProjectTab` (MCP/скиллы — pending по элементу, success/error, 403 — спец-текст; workspace/invariants — единый текст, 409 — диалог), `SessionSettingsTab` (скиллы/MCP + автосейв с откатом формы к серверному состоянию). i18n: `panel.saved`/`panel.saveError`. Доменные ключи удалены. Зафиксировано в `packages/ui/AGENTS.md` («Сохранение немедленных настроек панели»).
- **Также:** убрана кнопка «Очистить сессию» из панели «Сессия» (коммит `d885564`; очистка остаётся в левой панели и шапке).
- **Верификация:** `typecheck` OK; `lint` 0 errors; тесты — shared 170, core 2282, backend 341, ui **853** PASS. Живой UI: тост «Настройки сохранены» при переключении в «Контексте» и автосейве «Сессии»; состояния восстановлены.
- **Замечание:** при проверке всплыл известный баг Vite (stale-transform через симлинк) — «useNotification is not defined» до `touch` файлов; к коду не относится.

## 2026-09-30 15:00 — UI: убрана кнопка «Сохранить» на вкладке «Контекст» — PASS

- **Задача:** кнопка Save во вкладке «Контекст» избыточна после перехода на автосейв — убрать.
- **Тип:** UX/refactor (ui) · **Исполнитель:** @fixer + @orchestrator.
- **Сделано:** удалён footer/Save у `PanelTab` (режим выводится из тумблеров, все контролы уже автосохраняются). Вскрыт и исправлен латентный баг: `onChange`/`onSelect` вызывали `handleSave(mode)` с устаревшим значением из замыкания (`setState` асинхронна) — теперь изменённое значение передаётся явным `overrides`. Добавлен откат чисел/радио при ошибке (завершение шаблона — без «залипания»). Удалён неиспользуемый ключ `rightPanel.context.saving`.
- **Верификация:** `typecheck` OK; `lint` 0 errors; тесты — shared 170, core 2282, backend 341, ui **856** PASS.
- **Коммит:** ниже.

## 2026-09-30 15:31 — feat: инструменты управления проектом (workspace + git-репозитории) — PASS

- **Задача:** агенту не хватало тулов управления проектом: смена/настройка рабочего каталога, создание/регистрация/fetch/удаление git-репозиториев проекта.
- **Тип:** feature (core + shared + ui + docs) · **Исполнитель:** @fixer + @orchestrator.
- **Решения пользователя:** объём «всё сразу» (репозитории + workspace + правка проекта); отдельные гранулярные тулы; `remove` без `deleteLocal`; закрыть обход политики в `project_create` общим резолвером; RBAC в чате — `canEditProject` (owner/EDITOR).
- **Реализация:** новый `engine/workspace-provision.ts` (нормализация/containment/создание каталога; используется HTTP-роутом `projects.ts` и тулами), `engine/tools/project-repos.ts` (`project_repo_clone|init|add|fetch|remove`), `project_update`/`project_workspace_set` в `project-manage.ts`; SSH-хелпер `resolveSshEnvById` в `git-ssh.ts` (переиспользован `routes/git.ts`); `project_create` переведён на общий provisioning (обход `workspaceOutsideRoot`/`../` закрыт, workspace нормализуется); `gitService`/`workspaceManaged`/live-политика прокинуты в extra тулов; новое событие `project.updated` (EventType + `transportStore` → рефетч проектов и Git-вкладки); 14 i18n-ключей синхронно (shared/core en/ui ru+en); группы permissions (RUNTIME/GIT_WRITE) и trust (PROJECT_TOOLS/GIT_TOOLS).
- **Верификация (@orchestrator):** `pnpm typecheck` OK; `pnpm lint` 0 errors; тесты — shared 170, core **2298**, backend 341, ui **856** PASS; регресс `projects.test.ts`/`git.test.ts` без правок. Изменён существующий кейс `project_create` с абсолютным workspace вне root — он кодировал закрываемую дыру.
- **Замечание:** extra resumed-саб-агента (`task-resume.ts`) не содержит `projectStore`/`workspacesRoot`/`gitService` — проектные тулы там недоступны (не регрессия, поведение было и раньше; кандидат в отдельную задачу). `resolveSshEnv` при ошибке расшифровки ключа теперь отдаёт 404 `sshkey.not_found` вместо 500 (унификация с `resolveRepoGitEnv`).
- **Коммит:** `aefede7` — feat(core): инструменты управления проектом — workspace и git-репозитории.
