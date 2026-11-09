# Roadmap

> Индекс ближайших работ и предложений со ссылками на документы — не история и не спецификация.
> Актуально на **2026-11-09**. Правила классов и статусов — [ARCH_DECISIONS.md](./ARCH_DECISIONS.md),
> каталог решений — [arch_decisions/README.md](./arch_decisions/README.md).

## 0.13.4 — стабилизация (выпущен)

Код и test — 0.13.4; 0.13.x опубликован как 0.13.4.
0.13.4 — стабилизационный публичный релиз: ADR-117, ADR-118 этапы 1–4, ADR-119, вложения, пагинация
и лёгкие списки вошли в релиз; задача релиза — выпустить и стабилизировать, а не дописать. Релиз выпущен.

| # | Цель | Документы | Критерий готовности | Статус |
|---|---|---|---|---|
| 1.1 | **Выпуск 0.13.4** | [PUBLISHING.md](./PUBLISHING.md), [MAINTENANCE.md](./MAINTENANCE.md), заметки `docs/releases/0.13.4.md`, запись аудита `docs/security/releases/0.13.4.json`, [security/README.md](./security/README.md) | notes-пара проверена гейтом `release-notes`; аудит записан, гейт `security-gate` зелёный; тег с `master`; npm (8 пакетов), образы, чарт, зеркало GitHub | **выпущен** (2026-11-05): тег `v0.13.4` запушен, 8 пакетов опубликованы, образы и чарт собраны, зеркало GitHub обновлено; бета-канал проверен. Находки аудита закрыты (M1–M4, Helm, зависимости high 0), запись и заметки на месте, CI зелёный |
| 1.2 | **ADR-118, этап 5** | [ADR-118](./arch_decisions/adr-118-message-stream-v2.md), [ADR-052](./arch_decisions/adr-052-public-api-platform.md), [ADR-103](./arch_decisions/adr-103-gateway-core-channel-contract.md) | SDK major выпущен; `message.added` удалён; шлюзы читают `step.finished`; webhook-подписки на новой модели; сервер, UI, шлюзы и SDK — одной волной | этапы 1–4 готовы |
| 1.3 | **Надёжность рестарта** (дешёвая часть HA) | [ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md) п. 7, [MAINTENANCE.md](./MAINTENANCE.md), `charts/synth` | graceful shutdown: перестать принимать → дождаться drain активного хода → выход; политика повторного запуска инструментов описана и покрыта тестом; PDB, `terminationGracePeriodSeconds`, стратегия раскатки | нет (рестарт обрывает ход) |
| 1.4 | **Эксплуатационный минимум** | [ADR-094](./arch_decisions/adr-094-observability-metrics.md), [OBSERVABILITY.md](./OBSERVABILITY.md), [ADR-120](./arch_decisions/adr-120-memory-budget.md) | JSON-логи с `request_id`/`session_id`; SLO-минимум (доступность, латентность хода, глубина очереди) с алертами из поставки; RSS-бюджет и нагрузочный регресс-тест (ADR-120) | метрики и алерты есть, логов и SLO нет |
| 1.5 | **Документация** | `docs/releases/0.13.4.md`, [AGENTS.md](../AGENTS.md) | заметки 0.13.4 на месте; AGENTS (корневой и пакетные) соответствуют коду; `pnpm adr:check` без расхождений | **готово**: пара `0.13.4.md` + `0.13.4.en.md`, ADR-076/119 и API/CONFIGURATION (RU+EN) обновлены, `adr:check` — 0 ошибок |
| 1.6 | **HA: зафиксировать решение** | раздел «HA — оценка» ниже, [PROP-104](./arch_decisions/prop-104-external-event-transport.md), [PROP-105](./arch_decisions/prop-105-multi-replica-coordination.md) | полный HA вынесен за 0.13.4; при одной реплике описан контракт «деплой прерывает ход»; дешёвая часть — в строке 1.3 | решение принято 2026-11-04 |
| 1.7 | **Бета-канал в Gitea** | [PUBLISHING.md](./PUBLISHING.md) §«Бета-версии (Gitea)», `scripts/publish-beta.sh`, `.gitverse/workflows/beta.yaml`, `scripts/beta-prune.sh` | publish-beta + beta.yaml + prune + docs; установка `@beta` проверена smoke | **готово**: публикация 8 пакетов в Gitea, `dist-tags.beta`, установка `@beta` и prune проверены (`0.13.3-beta.20261104093532`, `0.13.3-beta.20261104161904`) |

## HA — оценка (2026-11-04)

| Вариант | Что даёт | Сложность | Вердикт |
|---|---|---|---|
| Полный control-plane HA | несколько реплик с общим состоянием (очередь, сессии, шина, лимиты, владение фоновыми прогонами) | 40–60 инженерных дней, высокий риск | вне 0.13.4; отдельный эпик после первого HA-клиента |
| HA шлюзов (leader election) | один активный экземпляр на тенанта | 6–9 дней | после 0.13.4 — когда шлюзы на общем каркасе [ADR-103](./arch_decisions/adr-103-gateway-core-channel-contract.md) |
| Failover шедулера | срабатывания без дублей и пропусков | 2–3 дня | после 0.13.4 |
| Boot-recovery lease | старт реплики не переигрывает чужое восстановление | 1–2 дня | предпосылка для более одной реплики |
| PDB + grace + стратегия раскатки | деплой не сносит поды разом | 0,5–1 день | **в 0.13.4** (строка 1.3) |

При одной реплике реальный риск — не HA, а **рестарт**: активный ход прерывается и после старта
переигрывается, поэтому инструменты могут выполниться повторно. В 0.13.4 входит только дешёвая часть
(PDB/grace/раскатка) и корректность рестарта; полный HA — после первого HA-клиента, отдельным эпиком;
для деплоя с одной репликой фиксируется контракт «деплой прерывает ход».

## 0.14 — поставка и внедрение

| # | Цель | Документы | Критерий готовности | Статус |
|---|---|---|---|---|
| 2.1 | **`@itphx/synth-gateway-core` в npm + каналы** | [ADR-103](./arch_decisions/adr-103-gateway-core-channel-contract.md), [ADR-087](./arch_decisions/adr-087-gateways.md) | пакет в реестре, шлюзы зависят версией; VK, MAX и email проверены на живом канале | пакет не опубликован |
| 2.2 | **Каталог: MVP** | [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md), [ADR-100](./arch_decisions/adr-100-extension-packs-pipelines.md) | вкладка «Каталог»: установка, обновление и удаление из индекса для plugin/gateway/addon/storage; provenance | нет |
| 2.3 | **Бюджеты и квоты по стоимости** | [ADR-102](./arch_decisions/adr-102-analytics-reports.md), новый ADR (лимиты расхода) | лимиты на пользователя/проект/сессию с hard stop, алерты и отчёт «кто сколько потратил» | нет (ADR-102 прямо исключает лимиты) |
| 2.4 | **Air-gapped: «один артефакт»** | [ADR-121](./arch_decisions/adr-121-offline-portable-distribution.md) | один архив на платформу без сети (внутри Node и ripgrep), `SHA256SUMS`, selftest; нативные пакеты — позже | portable-архивы собираются |
| 2.5 | **Пайплайны: остаток** | [ADR-101](./arch_decisions/adr-101-pipeline-engine.md), [PIPELINES.md](./PIPELINES.md) | rollback/exit-стратегия, дашборд прогонов, legacy-контур `/api/v2/pipelines` убран из UI | движок готов |
| 2.6 | **Память из коробки** | [ADR-122](./arch_decisions/adr-122-memory-product.md), [MEMORY.md](./MEMORY.md) | плагин включён по умолчанию, индексы и recall без ручной настройки; Gbrain/Obsidian — по спросу | ядро в коде |

## 1.0 — критерии готовности

1.0 — не дата, а набор проверяемых условий; пока они не выполнены, продукт остаётся в 0.x.

| # | Критерий | Проверка |
|---|---|---|
| 1 | Публичные контракты заморожены | API v2, события хода и SDK имеют версию и политику deprecation; ломающие изменения — только мажором |
| 2 | Обновление с откатом | `synth migrate`, `synth update`, `helm rollback` и матрица совместимости проверены на переходе с предыдущей поддерживаемой версии |
| 3 | Рестарт и деплой не рвут ход | drain активного хода, идемпотентность инструментов, PDB/grace; для одной реплики — явный контракт «деплой прерывает ход» |
| 4 | Эксплуатационный минимум | JSON-логи с `request_id`/`session_id`, SLO-минимум и алерты из поставки, метрики описаны контрактом |
| 5 | Контроль стоимости | бюджеты и квоты на пользователя/проект/сессию с hard stop, алерты и отчёт «кто сколько потратил» |
| 6 | Поставка в закрытый контур | один проверяемый артефакт (Node, ripgrep, образы, чарт), `SHA256SUMS`, self-test |
| 7 | Безопасность | аудит перед каждым релизом, secret-scan дерева и истории, ратчет зависимостей, негативная матрица авторизации |
| 8 | Поддержка | версионированная документация, объявленный cadence релизов, политика поддержки версий и known limitations |

1.0 не отменяет 0.14; это следующий контракт зрелости. Критерии проверяются на релизном
кандидате и фиксируются в `docs/releases/<version>.md` и записи аудита; невыполненный пункт
блокирует присвоение мажорной версии, но не блокирует релизы 0.x.

## Горизонт

Без дат: направления, к которым возвращаемся после 0.14.

| ID | Направление | Суть |
|---|---|---|
| [PROP-110](./arch_decisions/prop-110-portal-platform.md) | Портал-платформа | общий UI-kit, единый вход и оболочка портала; первый потребитель — `synth-media` |
| [PROP-109](./arch_decisions/prop-109-agent-system-federation.md) | Федерация | внешняя агентная система как управляемый peer: реестр, права, маршрутизация |
| [PROP-055](./arch_decisions/prop-055-instance-exchange.md) | Обмен инстансами | идемпотентный upsert/дельта, peer-auth |
| [PROP-057](./arch_decisions/prop-057-loop-engine.md) / [PROP-058](./arch_decisions/prop-058-service-agents-council.md) | Loop и Council | внешний цикл с рубрикой; служебные агенты и консилиум |
| [PROP-060](./arch_decisions/prop-060-multi-contour-bridge.md) | Contour Bridge | шлюз между контурами, обезличивание, аудит |
| [PROP-074](./arch_decisions/prop-074-soft-delete-retention.md) | Soft-delete | скрытие вместо удаления, read-only аудит, restore/purge |
| [PROP-073](./arch_decisions/prop-073-client-integrity-hybrid.md) / [PROP-080](./arch_decisions/prop-080-managed-hybrid-modes.md) / [PROP-081](./arch_decisions/prop-081-hybrid-policy-leak-protection.md) | Политики гибрида | недоверенный клиент, режимы-полюса, защита от утечек |

## Icebox и вне горизонта

- [PROP-050](./arch_decisions/prop-050-external-engines-runner.md) — Runner внешних движков (пересматривается в рамках PROP-109).
- [PROP-053](./arch_decisions/prop-053-cli-tui.md) — CLI и TUI.
- [PROP-056](./arch_decisions/prop-056-synth-mcp-server.md) — MCP-сервер Synth для внешних агентов.
- [PROP-066](./arch_decisions/prop-066-doc-style-skills.md) — doc-стандарты и docs-lint.
- [PROP-083](./arch_decisions/prop-083-instance-customization-branding.md) — кастомизация и брендинг (после PROP-110).
- [PROP-093](./arch_decisions/prop-093-docs-versioning.md) — версионирование документации портала.

## Предложения к решению

| ID | Тема | Решение до | Заметка |
|---|---|---|---|
| [ADR-097](./arch_decisions/adr-097-storage-provider-class.md) | Хранилище: остаток класса расширения | 2026-11-14 | принят; остаток — авто-возврат к БД без рестарта, документы |
| [PROP-037](./arch_decisions/prop-037-commit-security-step.md) | Security step перед коммитом | 2026-11-14 | hook и маркер-хеш, опирается на ADR-029/ADR-036 |
| [PROP-048](./arch_decisions/prop-048-self-help-skills-admin-mcp.md) | Self-help скиллы и admin-MCP | 2026-11-14 | read-only status-MCP и deploy-тулы под ADMIN |
| [PROP-053](./arch_decisions/prop-053-cli-tui.md) | CLI и TUI | 2026-11-14 | паритет CLI; кандидат в icebox |
| [PROP-056](./arch_decisions/prop-056-synth-mcp-server.md) | MCP-сервер Synth для агентов | 2026-11-14 | MCP над API v2, auth, права |
| [PROP-062](./arch_decisions/prop-062-context-optimization.md) | Оптимизация контекста | 2026-11-14 | `archive_context`, авто-суммаризация; пересекается с ADR-119 |
| [PROP-064](./arch_decisions/prop-064-agent-browser.md) | Браузер под управлением агента | 2026-11-14 | серверный headless уже есть; пользовательский headed — только local/hybrid |
| [PROP-065](./arch_decisions/prop-065-ui-docs-plan-todo.md) | Docs/план/ToDo в UI | 2026-11-14 | docs-браузер, Obsidian Bridge |
| [PROP-066](./arch_decisions/prop-066-doc-style-skills.md) | Doc-стандарты и docs-lint | 2026-11-14 | дёшево, ничего не блокирует |
| [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md) | Реестр и каталог расширений | 2026-11-14 | остаток ADR-046; каталог-MVP — в 0.14 |
| [PROP-073](./arch_decisions/prop-073-client-integrity-hybrid.md) | Целостность клиента в гибриде | 2026-11-14 | enforcement на сервере, сигналы опционально |
| [PROP-074](./arch_decisions/prop-074-soft-delete-retention.md) | Soft-delete и аудит-режим | 2026-11-14 | restore/purge — ADMIN |
| [PROP-080](./arch_decisions/prop-080-managed-hybrid-modes.md) | Управляемый гибрид: режимы-полюса | 2026-11-14 | сужает ADR-045 |
| [PROP-081](./arch_decisions/prop-081-hybrid-policy-leak-protection.md) | Политики гибрида и утечки | 2026-11-14 | опирается на PROP-073 |
| [PROP-083](./arch_decisions/prop-083-instance-customization-branding.md) | Кастомизация и брендинг | 2026-11-14 | после портал-платформы (PROP-110) |
| [PROP-093](./arch_decisions/prop-093-docs-versioning.md) | Версионирование документации | 2026-11-14 | подкаталоги под nginx или `mike` |
| [PROP-100](./arch_decisions/prop-100-ssrf-dns-rebinding.md) | SSRF: пиннинг проверенного адреса | 2026-11-14 | прокси есть; остаток — direct/`noProxy` и наблюдаемость |
| [PROP-104](./arch_decisions/prop-104-external-event-transport.md) | Транспорт событий между репликами | 2026-11-14 | шина in-process; рабочая гипотеза — `LISTEN/NOTIFY` |
| [PROP-105](./arch_decisions/prop-105-multi-replica-coordination.md) | Координация реплик control plane | 2026-11-14 | claim-семантика очереди, общее состояние; основа оценки HA |
| [PROP-109](./arch_decisions/prop-109-agent-system-federation.md) | Федерация агентных систем | 2027-01-31 | `AgentSystem` как peer; после 0.14 |
| [PROP-110](./arch_decisions/prop-110-portal-platform.md) | Портал-платформа | 2026-12-31 | UI-kit и оболочка; первый потребитель — `synth-media` |
| [PROP-126](./arch_decisions/prop-126-input-surface-mentions-snippets.md) | Поверхность ввода: `/`, `@`, `$`, `#`, `!` | 2026-12-06 | `/compact` — остро; `@` — файлы/агенты/пользователи (`@user` — доставка без хода); `$` — скиллы; `#` — сниппеты (instance/project/user); goal — в PROP-057 |
| [PROP-131](./arch_decisions/prop-131-external-dependency-mirrors.md) | Зеркала внешних зависимостей сборки | 2026-12-08 | инцидент GitHub 2026-11-08; Gitea Generic + манифест + sha256; базовые образы и npm — отдельными решениями |
| [PROP-132](./arch_decisions/prop-132-ui-terminal.md) | Встроенный терминал в UI | 2026-12-31 | PTY/WS, панель терминала; `!`-режим — в PROP-126 |

**Триаж до 2026-11-14:** принять / icebox / отклонить / перенести (перенос — новой датой, а не молчанием).
Принятое становится ADR, файл PROP удаляется; поглощённое — удаляется с записью «Поглощено»; снятое — в icebox/отклонено.

## Vision

Долгосрочные идеи без срока: либо переводятся в «Предложения к решению» с датой, либо в icebox.

- [PROP-055](./arch_decisions/prop-055-instance-exchange.md) — Обмен между инстансами
- [PROP-057](./arch_decisions/prop-057-loop-engine.md) — Loop Engine
- [PROP-058](./arch_decisions/prop-058-service-agents-council.md) — Служебные агенты и Council
- [PROP-060](./arch_decisions/prop-060-multi-contour-bridge.md) — Contour Bridge
- [PROP-061](./arch_decisions/prop-061-llm-security-layers.md) — Многослойная безопасность LLM
- [PROP-063](./arch_decisions/prop-063-user-learning-metrics.md) — Обучение пользователя и метрики
- [PROP-067](./arch_decisions/prop-067-org-guidelines-defaults.md) — Орг. гайдлайны → дефолты инстанса
