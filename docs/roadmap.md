# Roadmap предложений

> Индекс, а не документы: одна строка на предложение со ссылкой на файл ADR/PROP. Правила классов и статусов —
> [ARCH_DECISIONS.md](./ARCH_DECISIONS.md); реализованные решения — [arch_decisions/README.md](./arch_decisions/README.md).
> Собирается и проверяется вручную (`pnpm adr:check` предупредит, если actionable-предложение без `Решение до:`).

Как читать:

- **Статус** — канонический токен из файла ADR/PROP ([ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §4).
- **Решение до** — дата, к которой предложение обязано получить вердикт: **принять** (становится ADR),
  **icebox** (`🧊 Icebox` — «не сейчас, но не забыто») или **отклонить** (`🗑 Отклонено`). Продление срока
  допустимо, но оформляется новой датой, а не молчанием.
- Пока предложение не принято, оно живёт только здесь и в своём файле; код по нему не пишется.

## Предложения к решению (31)

| ID | Тема | Статус | Решение до | Заметка |
|---|---|---|---|---|
| [PROP-031](./arch_decisions/prop-031-verification-agent.md) | Verification синт (`verifier`) после реализации | 🧩 Предложение | 2026-11-14 | зависит от хуков ADR-030 и цикла ADR-028 |
| [PROP-032](./arch_decisions/prop-032-history-storage-postgresql.md) | Хранение истории сессий в PostgreSQL | 🧩 Предложение | 2026-11-14 | блокирует PROP-077; логическая модель уже в JSON (ADR-005/ADR-033) |
| [PROP-037](./arch_decisions/prop-037-commit-security-step.md) | Security step перед коммитом (hook + маркер-хеш) | 🧩 Предложение | 2026-11-14 | опирается на ADR-029/ADR-036 |
| [PROP-048](./arch_decisions/prop-048-self-help-skills-admin-mcp.md) | Self-help скиллы и admin-MCP (dogfooding) | 🧩 Предложение | 2026-11-14 | read-only status-MCP + deploy-тулы, гейтинг ADMIN |
| [PROP-049](./arch_decisions/prop-049-git-worktrees.md) | Git worktrees: тулы, per-session cwd, UI | 🧩 Предложение | 2026-11-14 | усиливает ADR-075/ADR-076 |
| [PROP-050](./arch_decisions/prop-050-external-engines-runner.md) | Runner внешних движков (opencode/cline) | 🧩 Предложение | 2026-11-14 | закрывает остаток ADR-018/ADR-022 |
| [PROP-053](./arch_decisions/prop-053-cli-tui.md) | CLI и TUI: паритет CLI, клиент API v2 | 🧩 Предложение | 2026-11-14 | — |
| [PROP-054](./arch_decisions/prop-054-kanban-backlog.md) | Kanban-доска и глобальный backlog | 🧩 Предложение | 2026-11-14 | поверх `project.plan` (ADR-039) |
| [PROP-056](./arch_decisions/prop-056-synth-mcp-server.md) | MCP-сервер Synth для внешних агентов | 🧩 Предложение | 2026-11-14 | опирается на ADR-052/ADR-089 |
| [PROP-062](./arch_decisions/prop-062-context-optimization.md) | Умная оптимизация контекста | 🧩 Предложение | 2026-11-14 | расширяет `ContextOptimizer`, пересекается с PROP-047 |
| [PROP-064](./arch_decisions/prop-064-ui-browser-terminal.md) | Встроенные в UI браузер и терминал | 🧩 Предложение | 2026-11-14 | PTY/WS-терминал + webview |
| [PROP-065](./arch_decisions/prop-065-ui-docs-plan-todo.md) | Просмотр документации, планов и ToDo в UI | 🧩 Предложение | 2026-11-14 | docs-браузер, Obsidian Bridge |
| [PROP-066](./arch_decisions/prop-066-doc-style-skills.md) | Doc-стандарты и docs-lint | 🧩 Предложение | 2026-11-14 | скиллы оформления документации (ADR-046) |
| [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md) | Реестр и каталог скиллов и агентов | 🧩 Предложение | 2026-11-14 | остаток ADR-046 (backend-админка каталога) |
| [PROP-073](./arch_decisions/prop-073-client-integrity-hybrid.md) | Целостность клиента в гибриде | 🧩 Предложение | 2026-11-14 | enforcement на сервере; сигналы — опционально |
| [PROP-074](./arch_decisions/prop-074-soft-delete-retention.md) | Soft-delete и аудит-режим | 🧩 Предложение | 2026-11-14 | restore/purge — ADMIN |
| [PROP-077](./arch_decisions/prop-077-runtime-toolchain.md) | Toolchain/executor (thin backend + executor, S3) | 🧩 Предложение | 2026-11-14 | после PROP-032; ближайший шаг — PROP-082 |
| [PROP-080](./arch_decisions/prop-080-managed-hybrid-modes.md) | Управляемый гибрид: режимы-полюса | 🧩 Предложение | 2026-11-14 | сужает ADR-045 |
| [PROP-081](./arch_decisions/prop-081-hybrid-policy-leak-protection.md) | Политики гибрида и защита от утечек | 🧩 Предложение | 2026-11-14 | опирается на PROP-073 |
| [PROP-082](./arch_decisions/prop-082-full-images-deployment.md) | Flavor-образы с toolchain | 🧩 Предложение | 2026-11-14 | практический шаг до PROP-077 |
| [PROP-083](./arch_decisions/prop-083-instance-customization-branding.md) | Кастомизация инстанса и брендинг | 🧩 Предложение | 2026-11-14 | приветственное окно, ватермарка; позже — locked settings |
| [PROP-085](./arch_decisions/prop-085-multimodal-input.md) | Мультимодальный ввод (звук/изображения/видео) | 🧩 Предложение | 2026-11-14 | контракт `Part`; зависит от PROP-032/PROP-077 |
| [PROP-088](./arch_decisions/prop-088-http-proxy.md) | Единый egress-слой (прокси, CA, Kerberos) | 🧩 Предложение | 2026-11-14 | требуется для корпоративных контуров |
| [PROP-090](./arch_decisions/prop-090-extension-api.md) | Extension API v1 (плагины, загрузчик) | 🧩 Предложение | 2026-11-14 | остаток ADR-030/ADR-086; trust/scan — PROP-068 |
| [PROP-091](./arch_decisions/prop-091-backup-restore-transfer.md) | Бэкап, восстановление и перенос данных | 🧩 Предложение | 2026-11-14 | `synth backup`/`restore`; онлайн-консистентность — после PROP-032 |
| [PROP-092](./arch_decisions/prop-092-instance-lifecycle-maintenance.md) | Обслуживание инстанса (обновление, миграции, удаление) | 🧩 Предложение | 2026-11-14 | `schemaVersion` + `synth migrate`; пример новых правил ведения AD |
| [PROP-093](./arch_decisions/prop-093-docs-versioning.md) | Версионирование документации портала | 🧩 Предложение | 2026-11-14 | вариант A (nginx) или B (`mike`) |
| [PROP-094](./arch_decisions/prop-094-observability-metrics.md) | Наблюдаемость и эксплуатационные метрики | 🧩 Предложение | 2026-11-14 | `/metrics`, `/ready`, структурные логи, SLO |
| [PROP-096](./arch_decisions/prop-096-background-subagent-sessions.md) | Фоновые сессии саб-агентов (не блокируют основную) | 🧩 Предложение | 2026-11-14 | аналог `subagent background` в OpenCode; общий реестр с PROP-097 |
| [PROP-097](./arch_decisions/prop-097-background-processes-registry.md) | Фоновые процессы: реестр + контроль через UI | 🧩 Предложение | 2026-11-14 | аналог `shell background` в OpenCode; панель «Процессы», stop, live-лог |
| [PROP-098](./arch_decisions/prop-098-mid-turn-steering.md) | Форсированная отправка сообщения во время хода (steering) | 🧩 Предложение | 2026-11-14 | `mode: queue\|steer\|interrupt` у `/prompt`; отдельно от «Стоп» |

## Vision (9)

Долгосрочные идеи: не решаем в ближайшие месяцы, срок не ставится. Решение — перевести в «Предложения
к решению» (с датой) или в `🧊 Icebox`/`🗑 Отклонено`.

| ID | Тема | Статус | Заметка |
|---|---|---|---|
| [PROP-047](./arch_decisions/prop-047-memory-gbrain.md) | Память Synth (Gbrain + композиция) | 🧩 Предложение (vision) | RAG по памяти/коду, Obsidian bridge; пересекается с PROP-062 |
| [PROP-055](./arch_decisions/prop-055-instance-exchange.md) | Обмен между инстансами Synth | 🧩 Предложение (vision) | идемпотентный upsert/дельта, peer-auth, live-сессии |
| [PROP-057](./arch_decisions/prop-057-loop-engine.md) | Loop Engine и Loop Design Wizard | 🧩 Предложение (vision) | outer loop, Verification Rubric; включает PROP-031 |
| [PROP-058](./arch_decisions/prop-058-service-agents-council.md) | Служебные агенты и консилиум (Council) | 🧩 Предложение (vision) | panel/consensus/debate/verifier/judge |
| [PROP-059](./arch_decisions/prop-059-pipeline-automation.md) | Pipeline Automation | 🧩 Предложение (vision) | цепочки loops, HITL, мониторинг; остаток ADR-051 |
| [PROP-060](./arch_decisions/prop-060-multi-contour-bridge.md) | Мультиконтурная архитектура (Contour Bridge) | 🧩 Предложение (vision) | шлюз между контурами, обезличивание, аудит |
| [PROP-061](./arch_decisions/prop-061-llm-security-layers.md) | Многослойная безопасность LLM | 🧩 Предложение (vision) | сканеры, лимиты, HITL, неизменяемый аудит |
| [PROP-063](./arch_decisions/prop-063-user-learning-metrics.md) | Обучение пользователя и метрики | 🧩 Предложение (vision) | анализ сессий, дашборд без рейтингов |
| [PROP-067](./arch_decisions/prop-067-org-guidelines-defaults.md) | Организационные гайдлайны → дефолты инстанса | 🧩 Предложение (vision) | ingestion, scope, версионирование/аудит |

## Декомпозиция god-объектов ([ADR-095](./arch_decisions/adr-095-god-object-decomposition.md))

Принятый подход «вынос по швам» (фасад + модули, один шов — один коммит, под зелёными тестами).
Порядок — от низкого риска к высокому; `orchestrator` — последним.

| Шаг | Объект | Статус | Заметка |
|---|---|---|---|
| 1 | `ui/lib/api/synthApi.ts` (2 596) → `lib/api/<домен>.ts` + barrel | ✅ | 2 596→161; 32 домена; контрактный тест; ui 132/1176 зелёные |
| 2 | `shared/types/index.ts` (1 452) → `types/<домен>.ts` + barrel | ✅ | 1 452→51; 12 модулей; экспорты `shared` идентичны (531/531) |
| 3 | `ui/components/panels/LeftPanel.tsx` (2 230) → подкомпоненты + хуки | ✅ | 2 230→59; `left-panel/*`; поведение/экспорт сохранены |
| 4 | `core/server/app.ts` (2 014) + `backend/app.ts` (1 738) → вынести монтирование/провижининг | ✅ | 4a: `core/server/app.ts` 2 014→380 + 7 модулей; 4b: `backend/app.ts` 1 738→286 + 5 модулей |
| 5 | `core/engine/tools/task.ts` (1 926) → подмодули тула | ✅ | 1 926→29; `engine/tools/task/*` (7 модулей); экспорты 1:1 |
| 6 | `core/engine/orchestrator.ts` (5 393; `_processMessage` 1 668) → `engine/orchestrator/phases/*` | ⏳ | максимальный риск; 19 тест-файлов |

## Частично реализовано (остаток как предложение)

Принятое ядро уже в коде; ниже — то, что осталось (остаток живёт в теле AD, отдельного срока у него пока нет).
ADR-018 и ADR-046 — принятые ADR со смешанным статусом (`✅ … ⏳ остаток`), поэтому индекс относит их сюда же;
их остаток вынесен в предложения PROP-050 и PROP-068 соответственно.

| ID | Тема | Статус | Остаток |
|---|---|---|---|
| [ADR-018](./arch_decisions/adr-018-session-engine-selection.md) | Выбор AI-движка на уровне сессии | ✅ поле/плумбинг | механика движков (EngineManager/адаптеры) → PROP-050 |
| [ADR-030](./arch_decisions/adr-030-hooks-agent-events.md) | Hooks для событий агента | ⚠️ Частично | Plugin SDK/загрузка плагинов → PROP-090 |
| [ADR-046](./arch_decisions/adr-046-skills-and-slash-commands.md) | Скиллы и slash-команды | ✅ Фазы 1–3 | install/trust/подписи и backend-админка каталога → PROP-068 |
| [ADR-051](./arch_decisions/adr-051-scheduler-pipelines.md) | Шедулер | ⚠️ Частично | пайплайны → PROP-059, размещение в гибриде, K8s Lease/PG advisory lock |
| [ADR-086](./arch_decisions/adr-086-extensibility-plugins-editions.md) | Расширяемость (зонтик) | ⚠️ Частично | Plugin SDK → PROP-090, editions, contribution flow |
| [ADR-087](./arch_decisions/adr-087-gateways.md) | Шлюзы (gateways) | ⚠️ Частично | HA/leader election, webhook-транспорт, второй канал |
| [ADR-089](./arch_decisions/adr-089-external-events-automation.md) | Платформа внешних событий | ⚠️ Частично | Plugin SDK → PROP-090, пайплайны → PROP-059, остаток ADR-087, стриминг ответа наружу |

Итого: ADR — 37 (из них 35 со статусом `✅ Реализовано` и 2 со смешанным статусом — ADR-018, ADR-046),
частичных ADR-класса (принятое ядро + остаток-предложение) — 5 (030, 051, 086, 087, 089), предложений — 37
(28 actionable + 9 vision), legacy — 1. Раздел «Частично» в сгенерированном индексе содержит 7 файлов —
ADR-018, ADR-030, ADR-046, ADR-051, ADR-086, ADR-087, ADR-089 (сводка — [arch_decisions/README.md](./arch_decisions/README.md)).
