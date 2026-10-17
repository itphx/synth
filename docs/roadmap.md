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

## Приоритетные цели релиза 0.11

> **Это приоритет релиза 0.11** — намерение и порядок работ, а не принятые решения. Состав может
> уточняться по ходу релиза: формулировки целей и критериев — рабочие, документы (ADR/PROP) — источник
> деталей. Цели ниже не заменяют общий список предложений; они лишь задают фокус ближайшего релиза.

| # | Цель | Документы | Критерий готовности |
|---|---|---|---|
| 1 | **Хранилище: два варианта (файлы и БД) за единым слоем** | [ADR-096](./arch_decisions/adr-096-storage-layer.md), [ADR-097](./arch_decisions/adr-097-storage-provider-class.md), [ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md), [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md), [PROP-032](./arch_decisions/prop-032-history-storage-postgresql.md) | Единый слой (доменные порты + контрактный suite + `StorageContext`) ✅ сделан; БД-backend **реализован поэтапно** (PROP-032, волны 1–5: конфиг, драйвер и все 27 портов, `listLight`, БД-локи, CI-гейт, обслуживание, перенос данных, деградированный режим — [ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md); TLS/CA соединения с БД — [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md)); остаток — авто-возврат к БД без рестарта, документы |
| 2 | **Эксплуатация: утилиты, руководства и ops-скиллы** | [ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md), [ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md), [PROP-048](./arch_decisions/prop-048-self-help-skills-admin-mcp.md) | Ops-MVP (`backup`/`restore`/`doctor`/`migrate`/`update`/`uninstall`) ✅ реализован ([ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md)/[ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md)); CLI + admin-API (`/api/v2/maintenance`) + UI-раздел «Обслуживание» ✅; остаток — руководства на портале, ops-скиллы (PROP-048) |
| 3 | **Оптимизация потребления памяти** | [PROP-099](./arch_decisions/prop-099-memory-footprint-optimization.md) | RSS-бюджет на N активных сессий и отсутствие неограниченного роста кэшей |

Пометка: это приоритет **0.11**; состав целей и их порядок могут уточняться.

## Предложения к решению (31)

| ID | Тема | Статус | Решение до | Заметка |
|---|---|---|---|---|
| [PROP-031](./arch_decisions/prop-031-verification-agent.md) | Verification синт (`verifier`) после реализации | 🧩 Предложение | 2026-11-14 | зависит от хуков ADR-030 и цикла ADR-028 |
| [PROP-032](./arch_decisions/prop-032-history-storage-postgresql.md) | Второй вариант хранения — БД (PostgreSQL) за единым слоем | 🧩 Предложение | 2026-11-14 | волны 1–5 в коде: драйвер `@itphx/synth-storage-postgres` (все 27 портов, контрактный suite против живой БД, `SYNTH_TEST_POSTGRES_DSN`), async-каскад сборки, БД-локи, обслуживание (`migrate`/`doctor`/`backup`/`uninstall --purge-db`), перенос `synth storage migrate`, деградированный режим ([ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md)); TLS/CA соединения с БД — [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md); остаток — авто-возврат к БД без рестарта, документы; блокирует PROP-077 |
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
| [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md) | Реестр и каталог скиллов и агентов | 🧩 Предложение | 2026-11-14 | остаток ADR-046 (backend-админка каталога); §12 — формат портала распространения (маркетплейс), реализация — отдельным проектом позже |
| [PROP-073](./arch_decisions/prop-073-client-integrity-hybrid.md) | Целостность клиента в гибриде | 🧩 Предложение | 2026-11-14 | enforcement на сервере; сигналы — опционально |
| [PROP-074](./arch_decisions/prop-074-soft-delete-retention.md) | Soft-delete и аудит-режим | 🧩 Предложение | 2026-11-14 | restore/purge — ADMIN |
| [PROP-077](./arch_decisions/prop-077-runtime-toolchain.md) | Toolchain/executor (thin backend + executor, S3) | 🧩 Предложение | 2026-11-14 | после PROP-032; ближайший шаг — PROP-082 |
| [PROP-080](./arch_decisions/prop-080-managed-hybrid-modes.md) | Управляемый гибрид: режимы-полюса | 🧩 Предложение | 2026-11-14 | сужает ADR-045 |
| [PROP-081](./arch_decisions/prop-081-hybrid-policy-leak-protection.md) | Политики гибрида и защита от утечек | 🧩 Предложение | 2026-11-14 | опирается на PROP-073 |
| [PROP-082](./arch_decisions/prop-082-full-images-deployment.md) | Flavor-образы с toolchain | 🧩 Предложение | 2026-11-14 | практический шаг до PROP-077 |
| [PROP-083](./arch_decisions/prop-083-instance-customization-branding.md) | Кастомизация инстанса и брендинг | 🧩 Предложение | 2026-11-14 | приветственное окно, ватермарка; позже — locked settings |
| [PROP-085](./arch_decisions/prop-085-multimodal-input.md) | Мультимодальный ввод (звук/изображения/видео) | 🧩 Предложение | 2026-11-14 | контракт `Part`; зависит от PROP-032/PROP-077 |
| [PROP-088](./arch_decisions/prop-088-http-proxy.md) | Единый egress-слой (прокси, CA, Kerberos) | ⛔ Заменено | — | надстроен [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md): TLS/CA + mTLS (per-host профили, UI «Доверенные CA»), адресная политика и прокси D1+D2+runtime-UI (HTTP/HTTPS/SOCKS5, Basic, `no_proxy`, «Сеть → Прокси») реализованы; остаток — NTLM/Negotiate/Kerberos (приёмка с AD/KDC), runtime-reload без рестарта, CA к цели через SOCKS5 (строка сохранена для трассируемости) |
| [PROP-090](./arch_decisions/prop-090-extension-api.md) | Extension API v1 (плагины, загрузчик) | 🧩 Предложение | 2026-11-14 | остаток ADR-030/ADR-086; trust/scan — PROP-068 |
| [PROP-093](./arch_decisions/prop-093-docs-versioning.md) | Версионирование документации портала | 🧩 Предложение | 2026-11-14 | вариант A (nginx) или B (`mike`) |
| [PROP-094](./arch_decisions/prop-094-observability-metrics.md) | Наблюдаемость и эксплуатационные метрики | 🧩 Предложение | 2026-11-14 | `/metrics`, `/ready`, структурные логи, SLO |
| [PROP-096](./arch_decisions/prop-096-background-subagent-sessions.md) | Фоновые сессии саб-агентов (не блокируют основную) | 🧩 Предложение | 2026-11-14 | аналог `subagent background` в OpenCode; общий реестр с PROP-097 |
| [PROP-097](./arch_decisions/prop-097-background-processes-registry.md) | Фоновые процессы: реестр + контроль через UI | 🧩 Предложение | 2026-11-14 | аналог `shell background` в OpenCode; панель «Процессы», stop, live-лог |
| [PROP-098](./arch_decisions/prop-098-mid-turn-steering.md) | Форсированная отправка сообщения во время хода (steering) | 🧩 Предложение | 2026-11-14 | `mode: queue\|steer\|interrupt` у `/prompt`; отдельно от «Стоп» |
| [PROP-099](./arch_decisions/prop-099-memory-footprint-optimization.md) | Оптимизация потребления памяти | 🧩 Предложение | 2026-11-14 | цель релиза 0.11; RSS-бюджет, bounded-кэши, лёгкие листинги; связано с PROP-032/PROP-094 |
| [PROP-100](./arch_decisions/prop-100-ssrf-dns-rebinding.md) | SSRF: TOCTOU/DNS-rebinding — привязка проверенного адреса к соединению | 🧩 Предложение | 2026-11-14 | дефекты 1–3 закрыты 2026-10-17 (единый `engine/net/egress-guard.ts`); прокси реализован (proxied-режим); остаток — пиннинг для direct/`noProxy`-хостов, наблюдаемость; класс SSRF/egress аудита |
| [PROP-101](./arch_decisions/prop-101-local-installers-platforms.md) | Локальные инсталляторы и платформенная дистрибуция (Win/mac/Linux) | 🧩 Предложение | 2026-12-31 | реализация — до 1.0.0; CI Linux-only (нативные раннеры + подписи/нотаризация — пререквизиты); flatpak/snap не берём; этапы 0–3 |

Пометка: `PROP-088` переведён в `⛔ Заменено` (надстроен [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md)):
TLS/CA + mTLS, адресная политика и прокси (HTTP/HTTPS/SOCKS5, Basic, `no_proxy`, runtime-UI) реализованы;
остаток — NTLM/Negotiate/Kerberos, runtime-reload и CA к цели через SOCKS5; строка оставлена
для трассируемости и в счёт actionable-предложений не входит.

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
| 6 | `core/engine/orchestrator.ts` (5 393; `_processMessage` 1 668) → `engine/orchestrator/phases/*` | ✅ | 6a: 5 393→4 375 (9 модулей); 6b-1: 4 375→3 777, `_processMessage` 1 668→~980; остаток 6b-2 (цикл Tool Use) — осознанно отложен, см. [ADR-095](./arch_decisions/adr-095-god-object-decomposition.md) |

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
| [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md) | Единый egress-слой: TLS/CA (mTLS, per-host профили) + адресная политика + прокси (config/UI) | ⚠️ Частично | NTLM/Negotiate/Kerberos и hot-reload прокси/TLS → PROP-088, пиннинг адреса → PROP-100, метрики → PROP-094, per-host CA и несколько default-сертов, перепроверка встроенного `fetch` на Node 22 |

Итого: ADR — 49 (из них 37 со статусом `✅ Реализовано` и 12 со статусом `⚠️ Частично`, в т.ч. 6 —
«принятое ядро + остаток-предложение»: 030, 051, 086, 087, 089, 099), предложений — 40 (31 actionable + 9 vision),
legacy — 1. Раздел «Частично» в сгенерированном индексе содержит 12 файлов — ADR-018, ADR-030, ADR-046,
ADR-051, ADR-086, ADR-087, ADR-089, ADR-091, ADR-092, ADR-097, ADR-098, ADR-099 (сводка — [arch_decisions/README.md](./arch_decisions/README.md)).
