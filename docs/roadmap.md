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

## Приоритетные цели релиза 0.13.0

> **Это приоритет релиза 0.13.0** — намерение и порядок работ, а не принятые решения. Нарезка идёт по **типу
> изменения**, а не по типу фичи: сначала то, что меняет контракты ядра, затем доведение начатого, затем UX.
> Гейт: этап закрывается релизом; следующий не начинается, пока предыдущий не выпущен.

### Этап 1 — контракты ядра

Сюда попадает только то, что меняет формат данных, семантику хода/очереди или топологию. Фичи, закрываемые
слоем плагинов ([ADR-090](./arch_decisions/adr-090-extension-api.md)), сюда не входят — их место в каталоге
(этап 2a.4).

| # | Цель | Документы | Критерий готовности |
|---|---|---|---|
| 1.1 | **Данные: мультимодальный `Part` и blob-порт** | [PROP-085](./arch_decisions/prop-085-multimodal-input.md), [PROP-106](./arch_decisions/prop-106-file-ports-to-sql.md) (часть: `blobs`/`packs`/legacy-`pipelines`) | сообщение с изображением/аудио проходит от API до провайдера; вложение лежит в порте хранения, а не пишется мимо него; второй миграции не потребуется |
| 1.2 | **Фоны: саб-агенты и процессы** | [PROP-096](./arch_decisions/prop-096-background-subagent-sessions.md), [PROP-097](./arch_decisions/prop-097-background-processes-registry.md), [ADR-104](./arch_decisions/adr-104-mid-turn-steering.md) (остаток: steering ребёнка) | дочерняя сессия/процесс живёт после ответа родителя, виден в реестре и в UI; реестр — через порты хранения, а не файлами |
| 1.3 | **`ask_user`: вопрос посреди хода** | [ADR-101](./arch_decisions/adr-101-pipeline-engine.md) (HITL-гейт), [ADR-104](./arch_decisions/adr-104-mid-turn-steering.md) (границы хода) | ход замирает до ответа, ответ приходит как `resume` с `output`, вопрос и ответ видны в журнале |
| 1.4 | **per-session cwd / worktrees** | [PROP-049](./arch_decisions/prop-049-git-worktrees.md), [ADR-075](./arch_decisions/adr-075-project-workspace-provisioning.md) | сессия работает в своём каталоге, инструменты и git не пересекаются между сессиями |
| 1.5 | **Остаток исполнителя** | [ADR-077](./arch_decisions/adr-077-runtime-toolchain.md) (шаги 7c–7d) | `simple-git` и MCP-stdio исполняются исполнителем, метрики `synth_executor_*` — в контракте [ADR-094](./arch_decisions/adr-094-observability-metrics.md) |

### Этап 2 — доведение начатого (2a → 2b)

Критерий этапа: **ни один ADR не остаётся `⚠️ Частично` с остатком, который не является заявленной отдельной
фичей.** Разрезан на два релиза, потому что целиком не закрывается: 2a — разблокировка поставки, 2b — зрелость.

**2a. Разблокировка поставки**

| # | Цель | Документы | Критерий готовности |
|---|---|---|---|
| 2a.1 | **Публикация `@itphx/synth-gateway-core` в npm** | [ADR-103](./arch_decisions/adr-103-gateway-core-channel-contract.md) | пакет в реестре; шлюзы зависят от версии, а не от `link:` или несуществующего `^0.1.0` |
| 2a.2 | **Шлюзы: VK → MAX** | [ADR-087](./arch_decisions/adr-087-gateways.md), [ADR-103](./arch_decisions/adr-103-gateway-core-channel-contract.md) | VK закоммичен, опубликован и проверен на живом сообществе; MAX — следом |
| 2a.3 | **Telegram на общий каркас** | [ADR-087](./arch_decisions/adr-087-gateways.md), [ADR-103](./arch_decisions/adr-103-gateway-core-channel-contract.md) | TG использует `@itphx/synth-gateway-core` (сейчас зависимости нет) + webhook-транспорт |
| 2a.4 | **Каталог: установка из индекса** | [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md), [ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md) | вкладка «Каталог» в «Аддонах»; установка/обновление/удаление из индекса для plugin/gateway/addon/storage; trust-levels и provenance (подписи — 2b.3) |
| 2a.5 | **Пайплайны: остаток движка** | [ADR-101](./arch_decisions/adr-101-pipeline-engine.md) | rollback/exit-стратегия, хранилище артефактов, дашборд; legacy-контур `/api/v2/pipelines` убран из UI |
| 2a.6 | **Гигиена `⚠️`-остатков** | [ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md), [ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md), [ADR-094](./arch_decisions/adr-094-observability-metrics.md), [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md), [ADR-102](./arch_decisions/adr-102-analytics-reports.md) | документы на портале, JSON-логи с `request_id`, hot-reload прокси/TLS, бюджеты аналитики, авто-возврат к БД |

**2b. Зрелость эксплуатации**

| # | Цель | Документы | Критерий готовности |
|---|---|---|---|
| 2b.1 | **Мультиреплика** | [PROP-106](./arch_decisions/prop-106-file-ports-to-sql.md) (полностью) → [PROP-105](./arch_decisions/prop-105-multi-replica-coordination.md) → [PROP-104](./arch_decisions/prop-104-external-event-transport.md) | при `backend.replicaCount > 1` состояние единое, очередь не залипает, события доходят до любой реплики |
| 2b.2 | **HA шлюзов** | [ADR-087](./arch_decisions/adr-087-gateways.md), [ADR-103](./arch_decisions/adr-103-gateway-core-channel-contract.md) | leader election вместо `strategy: Recreate`; один активный экземпляр на тенанта |
| 2b.3 | **Подписи каталога** | [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md) | подпись пакета проверяется офлайн; ключи издателя хранятся, отзываются, проверяются в air-gapped |
| 2b.4 | **`synth-media` до постановки клиенту** | [ADR-086](./arch_decisions/adr-086-extensibility-plugins-editions.md), [ADR-089](./arch_decisions/adr-089-external-events-automation.md), [ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md) | портал в едином стиле и с единым входом (2b.5), установка пакетом, инструкция для клиента |
| 2b.5 | **Портал-платформа** | [PROP-110](./arch_decisions/prop-110-portal-platform.md) | токены/темы и контракт входа общие у Synth и `synth-media`; примитивы и оболочка выносятся по мере надобности |

### Этап 3 — UX

| # | Цель | Документы | Критерий готовности |
|---|---|---|---|
| 3.1 | **Встроенный терминал** | [PROP-064](./arch_decisions/prop-064-ui-browser-terminal.md), [ADR-024](./arch_decisions/adr-024-eventhub-transport.md) | PTY работает в UI; транспорт — расширение кадров существующего `/ws/events` (отдельный канал — только с обоснованием в ADR); права и аудит shell заданы |

### Вне горизонта 0.13.0

«Не сейчас», а не «отклонено»: решение пересматривается после 0.13 (для PROP-050 — в рамках PROP-109).

| ID | Тема | Почему не в горизонте |
|---|---|---|
| [PROP-050](./arch_decisions/prop-050-external-engines-runner.md) | Runner внешних движков | спроса нет; пересматривается как `kind: runner-engine` в [PROP-109](./arch_decisions/prop-109-agent-system-federation.md) |
| [PROP-053](./arch_decisions/prop-053-cli-tui.md) | CLI и TUI | паритет CLI не влияет на внедрение |
| [PROP-054](./arch_decisions/prop-054-kanban-backlog.md) | Kanban и backlog | надстройка над `project.plan` (ADR-039), ждёт спроса |
| [PROP-066](./arch_decisions/prop-066-doc-style-skills.md) | Doc-стандарты и docs-lint | дёшево, но ничего не блокирует |
| [PROP-083](./arch_decisions/prop-083-instance-customization-branding.md) | Кастомизация и брендинг | после портал-платформы ([PROP-110](./arch_decisions/prop-110-portal-platform.md)), иначе делать дважды |
| [PROP-093](./arch_decisions/prop-093-docs-versioning.md) | Версионирование документации | не блокирует поставку |

## Предложения к решению (31)

| ID | Тема | Статус | Решение до | Заметка |
|---|---|---|---|---|
| [PROP-031](./arch_decisions/prop-031-verification-agent.md) | Verification синт (`verifier`) после реализации | 🧩 Предложение | 2026-11-14 | зависит от хуков ADR-030 и цикла ADR-028 |
| [ADR-097](./arch_decisions/adr-097-storage-provider-class.md) | Класс расширения «хранилище»: БД-backend (PostgreSQL) за единым слоем | ⚠️ Частично | 2026-11-14 | волны 1–5 в коде: драйвер `@itphx/synth-storage-postgres` (все 30 портов, контрактный suite против живой БД, `SYNTH_TEST_POSTGRES_DSN`), async-каскад сборки, БД-локи, обслуживание (`migrate`/`doctor`/`backup`/`uninstall --purge-db`), перенос `synth storage migrate`, деградированный режим ([ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md)); TLS/CA соединения с БД — [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md); остаток — авто-возврат к БД без рестарта, документы |
| [PROP-037](./arch_decisions/prop-037-commit-security-step.md) | Security step перед коммитом (hook + маркер-хеш) | 🧩 Предложение | 2026-11-14 | опирается на ADR-029/ADR-036 |
| [PROP-048](./arch_decisions/prop-048-self-help-skills-admin-mcp.md) | Self-help скиллы и admin-MCP (dogfooding) | 🧩 Предложение | 2026-11-14 | read-only status-MCP + deploy-тулы, гейтинг ADMIN |
| [PROP-049](./arch_decisions/prop-049-git-worktrees.md) | Git worktrees: тулы, per-session cwd, UI | 🧩 Предложение | 2026-11-14 | усиливает ADR-075/ADR-076 |
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
| [PROP-080](./arch_decisions/prop-080-managed-hybrid-modes.md) | Управляемый гибрид: режимы-полюса | 🧩 Предложение | 2026-11-14 | сужает ADR-045 |
| [PROP-081](./arch_decisions/prop-081-hybrid-policy-leak-protection.md) | Политики гибрида и защита от утечек | 🧩 Предложение | 2026-11-14 | опирается на PROP-073 |
| [PROP-082](./arch_decisions/prop-082-full-images-deployment.md) | Flavor-образы с toolchain | 🧩 Предложение | 2026-11-14 | all-in-one образ (control plane + toolchain + исполнитель) и образы worker'ов `synth-executor`; flavor'ы `slim`/`core`/`dev`/`devops`/`browser`/`full` (alpine + debian); переключатель топологии — `execution.mode` (ADR-077); тяжёлые flavor'ы — Docker Hub (лимит ~500 МБ в gitverse/GHCR) |
| [PROP-083](./arch_decisions/prop-083-instance-customization-branding.md) | Кастомизация инстанса и брендинг | 🧩 Предложение | 2026-11-14 | приветственное окно, ватермарка; позже — locked settings |
| [PROP-085](./arch_decisions/prop-085-multimodal-input.md) | Мультимодальный ввод (звук/изображения/видео) | 🧩 Предложение | 2026-11-14 | контракт `Part`; зависит от ADR-096/ADR-077 |
| [PROP-093](./arch_decisions/prop-093-docs-versioning.md) | Версионирование документации портала | 🧩 Предложение | 2026-11-14 | вариант A (nginx) или B (`mike`) |
| [PROP-096](./arch_decisions/prop-096-background-subagent-sessions.md) | Фоновые сессии саб-агентов (не блокируют основную) | 🧩 Предложение | 2026-11-14 | аналог `subagent background` в OpenCode; общий реестр с PROP-097 |
| [PROP-097](./arch_decisions/prop-097-background-processes-registry.md) | Фоновые процессы: реестр + контроль через UI | 🧩 Предложение | 2026-11-14 | аналог `shell background` в OpenCode; панель «Процессы», stop, live-лог |
| [PROP-099](./arch_decisions/prop-099-memory-footprint-optimization.md) | Оптимизация потребления памяти | 🧩 Предложение | 2026-11-14 | цель релиза 0.11; RSS-бюджет, bounded-кэши, лёгкие листинги; связано с ADR-096/ADR-094 |
| [PROP-100](./arch_decisions/prop-100-ssrf-dns-rebinding.md) | SSRF: TOCTOU/DNS-rebinding — привязка проверенного адреса к соединению | 🧩 Предложение | 2026-11-14 | дефекты 1–3 закрыты 2026-10-17 (единый `engine/net/egress-guard.ts`); прокси реализован (proxied-режим); остаток — пиннинг для direct/`noProxy`-хостов, наблюдаемость; класс SSRF/egress аудита |
| [PROP-101](./arch_decisions/prop-101-local-installers-platforms.md) | Локальные инсталляторы и платформенная дистрибуция (Win/mac/Linux) | 🧩 Предложение | 2026-12-31 | реализация — до 1.0.0; CI Linux-only (нативные раннеры + подписи/нотаризация — пререквизиты); flatpak/snap не берём; этапы 0–3 |
| [PROP-104](./arch_decisions/prop-104-external-event-transport.md) | Внешний транспорт событий: публикация между репликами control plane | 🧩 Предложение | 2026-11-14 | шина `EventBus` — in-process, при `backend.replicaCount > 1` события и стримы теряются между репликами; доменная шина остаётся интерфейсом, доставка выносится в pub/sub; в транспорт уходит **сигнал**, а не payload; рабочая гипотеза — `LISTEN/NOTIFY` PostgreSQL (лимит payload < 8 КБ, без фильтрации, at-most-once), выбор открыт с критериями; sticky-сессии — промежуточная мера |
| [PROP-105](./arch_decisions/prop-105-multi-replica-coordination.md) | Координация в нескольких репликах: сессии, очередь, общее состояние | 🧩 Предложение | 2026-11-14 | у очереди `pendingMessages` нет claim-семантики, `SessionManager.withLock` — в процессе ⇒ залипание сообщений при падении реплики и риск дубля; предлагается таблица `queue_claims` с условным upsert (по образцу `PgDedupRepository.tryClaim`) + TTL-протухание вместо ручного resume; общие rate limit'ы и live-настройки; классификация «общее / локально by design»; первый шаг — `scheduler.leaderElection: postgres` (1 строка конфига) |
| [PROP-106](./arch_decisions/prop-106-file-ports-to-sql.md) | Файловые порты инстанса в SQL: единое состояние при нескольких репликах | 🧩 Предложение | 2026-11-14 | `packs`/`skills`/`blobs`/`contextFiles`/legacy-`pipelines` остаются файловыми даже под PostgreSQL ⇒ расходятся между репликами; в `StorageContext` — 36 портов, из них 5 файловых; общий RWX-том `data` — промежуточная мера; приоритет 1 — `packs` + legacy `pipelines` (пишет установщик пакета одной операцией), далее `blobs`+`skills`, затем `contextFiles` |
| [PROP-109](./arch_decisions/prop-109-agent-system-federation.md) | Централизация внешних агентных систем (федерация) | 🧩 Предложение | 2027-01-31 | `AgentSystem` как управляемый peer: реестр, `capabilities`, права ([ADR-106](./arch_decisions/adr-106-authority-layer.md)), маршрутизация задач, общий журнал; Runner — один из `kind`; реализация — после 0.13 |
| [PROP-110](./arch_decisions/prop-110-portal-platform.md) | Портал-платформа: общий UI-kit, единый вход, шаблон портала | 🧩 Предложение | 2026-12-31 | `@itphx/synth-ui-kit` (токены/примитивы) + `@itphx/synth-portal` (оболочка, вход, settings-kit); этап 2b; первый потребитель — `synth-media` |

Пометка: строка ADR-097 — принятый ADR (`⚠️ Частично` в индексе), в таблице он стоит ради своего
остатка (авто-возврат к БД без рестарта, документы) и срока `2026-11-14`; остальные 30 строк —
предложения.

Пометка: `PROP-108` решением **2026-10-23** переведён в
[ADR-106](./arch_decisions/adr-106-authority-layer.md) (Authority-слой: грант «действие × цель», `effective` —
пересечение осей, «нет гранта — нет права», принципал фиксируется при приёме ввода, одноразовое подтверждение
по `(principal, turn, action, target, digest)`, роли/действия/цели/агенты — контент `provides.authority`) — из
списка предложений снят; остаток (flavor-роли, PROP-082) живёт в теле ADR-106 и в разделе «Частично реализовано» ниже;
устройство подсистемы — [docs/AUTHORITY.md](./AUTHORITY.md).

Пометка: `PROP-098` решением **2026-10-23** переведён в
[ADR-104](./arch_decisions/adr-104-mid-turn-steering.md) (steering: режимы `queue`/`steer`/`interrupt`
у `/prompt`, очередь инъекций `steerInbox`, прерывание генерации без завершения хода) — из списка
предложений снят; остаток (PROP-096 — фоновые саб-агенты) живёт в теле ADR-104 и в разделе
«Частично реализовано» ниже.

Пометка: `PROP-107` решением **2026-10-23** переведён в
[ADR-105](./arch_decisions/adr-105-external-credentials.md) (внешние доступы: сущность
`ExternalCredential`, шифрование at-rest `enc:v1:`, порт `ExternalCredentialRepository`, OAuth-клиент с
PKCE/refresh/revoke, host-binding секретных заголовков) — из списка предложений снят; остаток (Ф3–Ф4)
живёт в теле ADR-105 и в разделе «Частично реализовано» ниже.

Пометка: отдельное предложение о «работе через HTTP-прокси» **удалено** — вещество перенесено в
[ADR-099](./arch_decisions/adr-099-egress-tls-trust.md): TLS/CA + mTLS, адресная политика и прокси
(HTTP/HTTPS/SOCKS5, Basic, `no_proxy`, runtime-UI) реализованы; доменная аутентификация
(NTLM/Negotiate/Kerberos) — **вне scope** приложения → промежуточный egress-шлюз (ADR-099 п. 25),
SOCKS5 — best-effort (п. 26); остаток — runtime-reload прокси/TLS без рестарта (ADR-099,
«Статус в коде» → «Нет (остаток)»).

Пометка: `PROP-090` решением **2026-10-23** принят как
[ADR-090](./arch_decisions/adr-090-extension-api.md) — Extension API v1: полный in-process SDK **+** два
режима исполнения (`inline` / `out-of-process`), три точки расширения (`promptBlocks`, `llmFilters`,
`tools`), модель доверия, install/activate и полный контур API/CLI/UI; фазы Ф0–Ф7 закрыты, слой
развёрнут в test — из списка предложений снят. Остаток (Уровень 3 — attestation клиента в гибриде;
память как плагин — [PROP-047](./arch_decisions/prop-047-memory-gbrain.md)) живёт в теле ADR-090;
устройство подсистемы — [docs/PLUGINS.md](./PLUGINS.md). Прежняя пометка об отложении 2026-10-19 и
возврате в работу 2026-10-22 снята — она противоречила новому статусу.

## Vision (8)

Долгосрочные идеи: не решаем в ближайшие месяцы, срок не ставится. Решение — перевести в «Предложения
к решению» (с датой) или в `🧊 Icebox`/`🗑 Отклонено`.

| ID | Тема | Статус | Заметка |
|---|---|---|---|
| [PROP-047](./arch_decisions/prop-047-memory-gbrain.md) | Память Synth (Gbrain + композиция) | 🧩 Предложение (vision) | RAG по памяти/коду, Obsidian bridge; пересекается с PROP-062; **переписывается под слой плагинов** ([ADR-090](./arch_decisions/adr-090-extension-api.md), **реализован**): `MemoryProvider` — контракт, доставляемый плагином, а не подсистемой ядра |
| [PROP-055](./arch_decisions/prop-055-instance-exchange.md) | Обмен между инстансами Synth | 🧩 Предложение (vision) | идемпотентный upsert/дельта, peer-auth, live-сессии |
| [PROP-057](./arch_decisions/prop-057-loop-engine.md) | Loop Engine и Loop Design Wizard | 🧩 Предложение (vision) | outer loop, Verification Rubric; включает PROP-031 |
| [PROP-058](./arch_decisions/prop-058-service-agents-council.md) | Служебные агенты и консилиум (Council) | 🧩 Предложение (vision) | panel/consensus/debate/verifier/judge |
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
их остаток вынесен в предложения PROP-109 (через icebox PROP-050) и PROP-068 соответственно. ADR-101 (движок пайплайнов) — `✅
Реализовано`, в сгенерированном индексе в «Частично» не значится, но указан здесь ради остатка визионного
предложения о Pipeline Automation.

| ID | Тема | Статус | Остаток |
|---|---|---|---|
| [ADR-018](./arch_decisions/adr-018-session-engine-selection.md) | Выбор AI-движка на уровне сессии | ✅ поле/плумбинг | механика движков (EngineManager/адаптеры) → [PROP-109](./arch_decisions/prop-109-agent-system-federation.md) (icebox PROP-050) |
| [ADR-030](./arch_decisions/adr-030-hooks-agent-events.md) | Hooks для событий агента | ⚠️ Частично | Plugin SDK/загрузка плагинов — **реализовано** ([ADR-090](./arch_decisions/adr-090-extension-api.md)); остаток — эмит `callback` (вне ядра) |
| [ADR-046](./arch_decisions/adr-046-skills-and-slash-commands.md) | Скиллы и slash-команды | ✅ Фазы 1–3 | install/trust/подписи и backend-админка каталога → PROP-068 |
| [ADR-051](./arch_decisions/adr-051-scheduler-pipelines.md) | Шедулер | ⚠️ Частично | пайплайны реализованы как декларация + учёт прогона ([ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md)); **движок пайплайна — [ADR-101](./arch_decisions/adr-101-pipeline-engine.md)** (реализован); остаток — rollback/дашборд (ADR-101), размещение в гибриде, K8s Lease/PG advisory lock |
| [ADR-077](./arch_decisions/adr-077-runtime-toolchain.md) | Инструментальное окружение исполнения (toolchain/executor) | ⚠️ Частично | порт `ExecutionPort` и режим `execution.mode` (inline/remote) — в коде, исполнитель — отдельный in-tree пакет `@itphx/synth-executor`; остаток — перенос `simple-git` и MCP-stdio в исполнитель (шаги 7c–7d плана) |
| [ADR-086](./arch_decisions/adr-086-extensibility-plugins-editions.md) | Расширяемость (зонтик) | ⚠️ Частично | доставка пакета расширения реализована ([ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md)); Plugin SDK — **реализован** ([ADR-090](./arch_decisions/adr-090-extension-api.md)); остаток — каталог/trust пакетов → PROP-068, editions, contribution flow |
| [ADR-087](./arch_decisions/adr-087-gateways.md) | Шлюзы (gateways) | ⚠️ Частично | HA/leader election, webhook-транспорт Telegram, общий каркас адаптеров каналов ([ADR-103](./arch_decisions/adr-103-gateway-core-channel-contract.md)), второй канал (VK — реализован: ждёт публикации, деплоя и проверки на живом сообществе), третий (MAX — в работе) |
| [ADR-089](./arch_decisions/adr-089-external-events-automation.md) | Платформа внешних событий | ⚠️ Частично | Plugin SDK — реализован ([ADR-090](./arch_decisions/adr-090-extension-api.md)), пайплайны — движок реализован ([ADR-101](./arch_decisions/adr-101-pipeline-engine.md)), остаток → ADR-101, остаток ADR-087, стриминг ответа наружу |
| [ADR-094](./arch_decisions/adr-094-observability-metrics.md) | Наблюдаемость: `/metrics`, `/ready`, дашборды и алерты | ⚠️ Частично | JSON-логи с `request_id`/`session_id`, OpenTelemetry-трейсинг, Alertmanager/SLO-страница (остальное — в коде) |
| [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md) | Единый egress-слой: TLS/CA (mTLS, per-host профили) + адресная политика + прокси (config/UI) | ⚠️ Частично | Kerberos/NTLM — вне scope → egress-шлюз (п. 25), SOCKS5 — best-effort (п. 26); hot-reload прокси/TLS без рестарта — остаток (см. ADR-099, «Статус в коде»), пиннинг адреса → PROP-100, метрики → ADR-094, per-host CA и несколько default-сертов, перепроверка встроенного `fetch` на Node 22 |
| [ADR-101](./arch_decisions/adr-101-pipeline-engine.md) | Pipeline Engine (движок пайплайнов) | ✅ Реализовано | остаток визионного предложения о Pipeline Automation: rollback/exit-стратегия, мониторинг-дашборд, отдельное хранилище артефактов — §«Открытые вопросы» ADR-101 |
| [ADR-102](./arch_decisions/adr-102-analytics-reports.md) | Аналитика и отчётность инстанса | ⚠️ Частично | порт `AnalyticsRollupRepository`, API `GET /api/v2/analytics/*`, экспорт CSV/JSON, backfill `synth analytics rebuild` — в коде; остаток — бюджеты, лимиты и алерты, отдельная отчётность по промптам/решениям |
| [ADR-104](./arch_decisions/adr-104-mid-turn-steering.md) | Вмешательство в ход посреди генерации (steering) | ✅ Реализовано | режимы `queue`/`steer`/`interrupt`, `steerInbox`, граница шага, `interrupt` без завершения хода, приоритет инъекций, правила `ask`/`plan`, гибрид (`mode_applied`); остаток вне объёма — steering фонового ребёнка (PROP-096) |
| [ADR-105](./arch_decisions/adr-105-external-credentials.md) | Внешние доступы (OAuth-коннекторы) | ✅ Реализовано | сущность и порт (file/memory/PG), OAuth-клиент, host-binding, токен в MCP-транспорте, запрет plaintext, каталог `oauth.providers`, права, `/api/v2/oauth`, журнал, ротация (SSH+доступы+вебхуки), бэкап, UI «Доступы». Ограничения: standalone `bind` не перезагружает живой клиент, PG-контракт — в CI |
| [ADR-106](./arch_decisions/adr-106-authority-layer.md) | Authority-слой (полномочия как контент) | ⚠️ Частично | Ф0–Ф5 реализованы: модель и порты (file/memory/PG), резолвер, shadow, принуждение с потолком сессии и `yolo`, подтверждения по `(principal, turn, action, target, digest)`, `Turn.principal`, участники и потолок хода, `PATCH mode`, активация `provides.authority` с trust-floor, PG-порты (миграции `014`/`015`), UI «Полномочия»; остаток — flavor-роли (PROP-082) |
Итого: документов — 100 (ADR — 60: 43 со статусом `✅ Реализовано` и 17 со статусом `⚠️ Частично`,
1 legacy; предложений — 30, vision — 8, icebox — 1).
В разделах roadmap: «Предложения к решению» — 31 строка (30 предложений + строка ADR-097
с остатком), «Vision» — 8, «Вне горизонта 0.13» — 6 (в т.ч. icebox PROP-050), «Частично реализовано» — 13
(ADR-018, ADR-030, ADR-046, ADR-051, ADR-077, ADR-086, ADR-087, ADR-089, ADR-094, ADR-099, ADR-101,
ADR-102, ADR-106). Раздел «Частично»
в сгенерированном индексе содержит 17 файлов — ADR-018, ADR-030, ADR-046, ADR-051, ADR-077, ADR-086,
ADR-087, ADR-091, ADR-092, ADR-094, ADR-097, ADR-098, ADR-099, ADR-100, ADR-102, ADR-103, ADR-106 (сводка — [arch_decisions/README.md](./arch_decisions/README.md)).
