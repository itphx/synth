# Roadmap предложений

> Индекс, а не документы: одна строка на предложение со ссылкой на файл AD. Правила классов и статусов —
> [ARCH_DECISIONS.md](./ARCH_DECISIONS.md); реализованные решения — [arch_decisions/README.md](./arch_decisions/README.md).
> Собирается и проверяется вручную (`pnpm adr:check` предупредит, если actionable-предложение без `Решение до:`).

Как читать:

- **Статус** — канонический токен из файла AD ([ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §4).
- **Решение до** — дата, к которой предложение обязано получить вердикт: **принять** (становится ADR),
  **icebox** (`🧊 Icebox` — «не сейчас, но не забыто») или **отклонить** (`🗑 Отклонено`). Продление срока
  допустимо, но оформляется новой датой, а не молчанием.
- Пока предложение не принято, оно живёт только здесь и в своём файле; код по нему не пишется.

## Предложения к решению (28)

| AD | Тема | Статус | Решение до | Заметка |
|---|---|---|---|---|
| [AD-031](./arch_decisions/ad-031-verification-agent.md) | Verification синт (`verifier`) после реализации | 🧩 Предложение | 2026-11-14 | зависит от хуков AD-030 и цикла AD-028 |
| [AD-032](./arch_decisions/ad-032-history-storage-postgresql.md) | Хранение истории сессий в PostgreSQL | 🧩 Предложение | 2026-11-14 | блокирует AD-077; логическая модель уже в JSON (AD-005/AD-033) |
| [AD-037](./arch_decisions/ad-037-commit-security-step.md) | Security step перед коммитом (hook + маркер-хеш) | 🧩 Предложение | 2026-11-14 | опирается на AD-029/AD-036 |
| [AD-048](./arch_decisions/ad-048-self-help-skills-admin-mcp.md) | Self-help скиллы и admin-MCP (dogfooding) | 🧩 Предложение | 2026-11-14 | read-only status-MCP + deploy-тулы, гейтинг ADMIN |
| [AD-049](./arch_decisions/ad-049-git-worktrees.md) | Git worktrees: тулы, per-session cwd, UI | 🧩 Предложение | 2026-11-14 | усиливает AD-075/AD-076 |
| [AD-050](./arch_decisions/ad-050-external-engines-runner.md) | Runner внешних движков (opencode/cline) | 🧩 Предложение | 2026-11-14 | закрывает остаток AD-018/AD-022 |
| [AD-053](./arch_decisions/ad-053-cli-tui.md) | CLI и TUI: паритет CLI, клиент API v2 | 🧩 Предложение | 2026-11-14 | — |
| [AD-054](./arch_decisions/ad-054-kanban-backlog.md) | Kanban-доска и глобальный backlog | 🧩 Предложение | 2026-11-14 | поверх `project.plan` (AD-039) |
| [AD-056](./arch_decisions/ad-056-synth-mcp-server.md) | MCP-сервер Synth для внешних агентов | 🧩 Предложение | 2026-11-14 | опирается на AD-052/AD-089 |
| [AD-062](./arch_decisions/ad-062-context-optimization.md) | Умная оптимизация контекста | 🧩 Предложение | 2026-11-14 | расширяет `ContextOptimizer`, пересекается с AD-047 |
| [AD-064](./arch_decisions/ad-064-ui-browser-terminal.md) | Встроенные в UI браузер и терминал | 🧩 Предложение | 2026-11-14 | PTY/WS-терминал + webview |
| [AD-065](./arch_decisions/ad-065-ui-docs-plan-todo.md) | Просмотр документации, планов и ToDo в UI | 🧩 Предложение | 2026-11-14 | docs-браузер, Obsidian Bridge |
| [AD-066](./arch_decisions/ad-066-doc-style-skills.md) | Doc-стандарты и docs-lint | 🧩 Предложение | 2026-11-14 | скиллы оформления документации (AD-046) |
| [AD-068](./arch_decisions/ad-068-skills-agents-registry.md) | Реестр и каталог скиллов и агентов | 🧩 Предложение | 2026-11-14 | остаток AD-046 (backend-админка каталога) |
| [AD-073](./arch_decisions/ad-073-client-integrity-hybrid.md) | Целостность клиента в гибриде | 🧩 Предложение | 2026-11-14 | enforcement на сервере; сигналы — опционально |
| [AD-074](./arch_decisions/ad-074-soft-delete-retention.md) | Soft-delete и аудит-режим | 🧩 Предложение | 2026-11-14 | restore/purge — ADMIN |
| [AD-077](./arch_decisions/ad-077-runtime-toolchain.md) | Toolchain/executor (thin backend + executor, S3) | 🧩 Предложение | 2026-11-14 | после AD-032; ближайший шаг — AD-082 |
| [AD-080](./arch_decisions/ad-080-managed-hybrid-modes.md) | Управляемый гибрид: режимы-полюса | 🧩 Предложение | 2026-11-14 | сужает AD-045 |
| [AD-081](./arch_decisions/ad-081-hybrid-policy-leak-protection.md) | Политики гибрида и защита от утечек | 🧩 Предложение | 2026-11-14 | опирается на AD-073 |
| [AD-082](./arch_decisions/ad-082-full-images-deployment.md) | Flavor-образы с toolchain | 🧩 Предложение | 2026-11-14 | практический шаг до AD-077 |
| [AD-083](./arch_decisions/ad-083-instance-customization-branding.md) | Кастомизация инстанса и брендинг | 🧩 Предложение | 2026-11-14 | приветственное окно, ватермарка; позже — locked settings |
| [AD-085](./arch_decisions/ad-085-multimodal-input.md) | Мультимодальный ввод (звук/изображения/видео) | 🧩 Предложение | 2026-11-14 | контракт `Part`; зависит от AD-032/AD-077 |
| [AD-088](./arch_decisions/ad-088-http-proxy.md) | Единый egress-слой (прокси, CA, Kerberos) | 🧩 Предложение | 2026-11-14 | требуется для корпоративных контуров |
| [AD-090](./arch_decisions/ad-090-extension-api.md) | Extension API v1 (плагины, загрузчик) | 🧩 Предложение | 2026-11-14 | остаток AD-030/AD-086; trust/scan — AD-068 |
| [AD-091](./arch_decisions/ad-091-backup-restore-transfer.md) | Бэкап, восстановление и перенос данных | 🧩 Предложение | 2026-11-14 | `synth backup`/`restore`; онлайн-консистентность — после AD-032 |
| [AD-092](./arch_decisions/ad-092-instance-lifecycle-maintenance.md) | Обслуживание инстанса (обновление, миграции, удаление) | 🧩 Предложение | 2026-11-14 | `schemaVersion` + `synth migrate`; пример новых правил ведения AD |
| [AD-093](./arch_decisions/ad-093-docs-versioning.md) | Версионирование документации портала | 🧩 Предложение | 2026-11-14 | вариант A (nginx) или B (`mike`) |
| [AD-094](./arch_decisions/ad-094-observability-metrics.md) | Наблюдаемость и эксплуатационные метрики | 🧩 Предложение | 2026-11-14 | `/metrics`, `/ready`, структурные логи, SLO |

## Vision (9)

Долгосрочные идеи: не решаем в ближайшие месяцы, срок не ставится. Решение — перевести в «Предложения
к решению» (с датой) или в `🧊 Icebox`/`🗑 Отклонено`.

| AD | Тема | Статус | Заметка |
|---|---|---|---|
| [AD-047](./arch_decisions/ad-047-memory-gbrain.md) | Память Synth (Gbrain + композиция) | 🧩 Предложение (vision) | RAG по памяти/коду, Obsidian bridge; пересекается с AD-062 |
| [AD-055](./arch_decisions/ad-055-instance-exchange.md) | Обмен между инстансами Synth | 🧩 Предложение (vision) | идемпотентный upsert/дельта, peer-auth, live-сессии |
| [AD-057](./arch_decisions/ad-057-loop-engine.md) | Loop Engine и Loop Design Wizard | 🧩 Предложение (vision) | outer loop, Verification Rubric; включает AD-031 |
| [AD-058](./arch_decisions/ad-058-service-agents-council.md) | Служебные агенты и консилиум (Council) | 🧩 Предложение (vision) | panel/consensus/debate/verifier/judge |
| [AD-059](./arch_decisions/ad-059-pipeline-automation.md) | Pipeline Automation | 🧩 Предложение (vision) | цепочки loops, HITL, мониторинг; остаток AD-051 |
| [AD-060](./arch_decisions/ad-060-multi-contour-bridge.md) | Мультиконтурная архитектура (Contour Bridge) | 🧩 Предложение (vision) | шлюз между контурами, обезличивание, аудит |
| [AD-061](./arch_decisions/ad-061-llm-security-layers.md) | Многослойная безопасность LLM | 🧩 Предложение (vision) | сканеры, лимиты, HITL, неизменяемый аудит |
| [AD-063](./arch_decisions/ad-063-user-learning-metrics.md) | Обучение пользователя и метрики | 🧩 Предложение (vision) | анализ сессий, дашборд без рейтингов |
| [AD-067](./arch_decisions/ad-067-org-guidelines-defaults.md) | Организационные гайдлайны → дефолты инстанса | 🧩 Предложение (vision) | ingestion, scope, версионирование/аудит |

## Частично реализовано (остаток как предложение)

Принятое ядро уже в коде; ниже — то, что осталось (остаток живёт в теле AD, отдельного срока у него пока нет).
AD-018 и AD-046 — принятые ADR со смешанным статусом (`✅ … ⏳ остаток`), поэтому индекс относит их сюда же;
их остаток вынесен в предложения AD-050 и AD-068 соответственно.

| AD | Тема | Статус | Остаток |
|---|---|---|---|
| [AD-018](./arch_decisions/ad-018-session-engine-selection.md) | Выбор AI-движка на уровне сессии | ✅ поле/плумбинг | механика движков (EngineManager/адаптеры) → AD-050 |
| [AD-030](./arch_decisions/ad-030-hooks-agent-events.md) | Hooks для событий агента | ⚠️ Частично | Plugin SDK/загрузка плагинов → AD-090 |
| [AD-046](./arch_decisions/ad-046-skills-and-slash-commands.md) | Скиллы и slash-команды | ✅ Фазы 1–3 | install/trust/подписи и backend-админка каталога → AD-068 |
| [AD-051](./arch_decisions/ad-051-scheduler-pipelines.md) | Шедулер | ⚠️ Частично | пайплайны → AD-059, размещение в гибриде, K8s Lease/PG advisory lock |
| [AD-086](./arch_decisions/ad-086-extensibility-plugins-editions.md) | Расширяемость (зонтик) | ⚠️ Частично | Plugin SDK → AD-090, editions, contribution flow |
| [AD-087](./arch_decisions/ad-087-gateways.md) | Шлюзы (gateways) | ⚠️ Частично | HA/leader election, webhook-транспорт, второй канал |
| [AD-089](./arch_decisions/ad-089-external-events-automation.md) | Платформа внешних событий | ⚠️ Частично | Plugin SDK → AD-090, пайплайны → AD-059, остаток AD-087, стриминг ответа наружу |

Итого: ADR — 37 (из них 35 со статусом `✅ Реализовано` и 2 со смешанным статусом — AD-018, AD-046),
частичных ADR-класса (принятое ядро + остаток-предложение) — 5 (030, 051, 086, 087, 089), предложений — 37
(28 actionable + 9 vision), legacy — 1. Раздел «Частично» в сгенерированном индексе содержит 7 файлов —
AD-018, AD-030, AD-046, AD-051, AD-086, AD-087, AD-089 (сводка — [arch_decisions/README.md](./arch_decisions/README.md)).
