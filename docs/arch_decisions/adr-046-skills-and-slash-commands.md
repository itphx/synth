# ADR-046: Скиллы и slash-команды

> **Статус:** ⚠️ Частично — механизм скиллов, slash-команды/bundles, scope-уровни и UI реализованы (Фазы 1–3, часть); остаток — install/доверие/подписи/`lock.json` и backend-админка каталога ([PROP-068](./prop-068-skills-agents-registry.md)).
> **Дата:** 2026-09-17 (as-built вынесено в spec — 2026-10-15).
> **Парные документы (as-built):** [ARCHITECTURE.md](../ARCHITECTURE.md) «Скиллы и slash-команды» · [API_V2.md](../API_V2.md) §5.17–§5.17.2 · [CONFIGURATION.md](../CONFIGURATION.md) (`skills`/`commands`) · `packages/{core,ui,shared}/AGENTS.md`.
> **Связано:** [ADR-025](./adr-025-plan-act-toggle.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-035](./adr-035-micro-model-first.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-039](./adr-039-plan-in-project.md), [ADR-041](./adr-041-llm-error-taxonomy.md), [ADR-042](./adr-042-hybrid-mode.md), [ADR-045](./adr-045-hybrid-server-profiles.md), [ADR-069](./adr-069-project-instructions-agents-md.md), [ADR-070](./adr-070-system-prompt-composer.md), [ADR-071](./adr-071-mcp-servers-prompt.md); контент-платформа — [PROP-068](./prop-068-skills-agents-registry.md).
> **Карта подразделов (прежняя нумерация §) → spec-дом:** §3 формат `SKILL.md` → `packages/core/AGENTS.md`, `packages/shared/AGENTS.md`; §4 discovery/скоупы/trust → [CONFIGURATION.md](../CONFIGURATION.md), [ARCHITECTURE.md](../ARCHITECTURE.md); §4.5 уровни/включение → [API_V2.md](../API_V2.md) §5.17.2; §5 доставка → [ARCHITECTURE.md](../ARCHITECTURE.md); §6 invocation/binding → `packages/core/AGENTS.md`; §7 команды/bundles → [CONFIGURATION.md](../CONFIGURATION.md), [API_V2.md](../API_V2.md) §5.17.1; §8 права/аудит → `packages/core/AGENTS.md`; §9 API/UI/CLI → [API_V2.md](../API_V2.md) §5.17, `packages/ui/AGENTS.md`.

## Контекст

Процедурное знание («как ревьюить API», «как писать миграции») не переиспользуется: текст вставляют в сообщение вручную либо кладут все инструкции в role-промпт агента — промпт раздувается для всех сессий. Проблемы: раздувание промпта телами скиллов; безопасность проектного контента (подмена инструкций через `git pull`); единство входа `/`-команд (UI/CLI/гибрид); capability-несоответствие (скилл требует `shell`, которого у read-only агента нет); изменение `SKILL.md` не должно требовать рестарта процесса. Референсы: `~/dev/opencode` (`skill({name})`, discovery), `~/dev/hermes-agent` (progressive disclosure, trust-гейт, bundles), прототип `~/dev/aic/t11` (хардкод-команды).

## Решение

- **Скиллы — инструкции, а не тулы.** Скилл — папка с `SKILL.md` (+ supporting-файлы `references/`/`scripts/`/`assets/`); своих тулов не регистрирует. Единственный core-тул — `skill({name, file_path?})` (глобально отключается через `tools.disabled`).
- **Progressive disclosure.** В системный промпт идёт только **каталог** (`name` + обрезанный `description` ~60–100 символов, группировка по категории); тело — по явному `/name` или вызову `skill`; supporting-файлы — по требованию. Каталог — отдельный слой промпта с тирами (ADR-070): system/project → `stable` (не инвалидирует prompt-cache), session-динамика и маркеры `unavailable` → `volatile`.
- **Единый резолвинг `/`-команд в core** (UI/CLI/гибрид — тонкие клиенты). Виды: встроенные продуктовые (`/help`, `/skills`, `/commands`, `/summary`, `/init`; `/compact`, `/review` отложены), шаблонные `.md` (`$ARGUMENTS`/`@file`), скиллы-как-команды. Bundles: `/bundle-name` грузит N скиллов одним сообщением; bundle **побеждает** одноимённый skill.
- **Trust по умолчанию (project-trust).** Проектные скиллы недоверенного каталога (`skills.trustedProjectDirs`) **видны в реестре, но не грузятся** (не попадают в каталог/тул/автокомплит); ре-скан по mtime/size закрывает подмену через `git pull`. Внешние каталоги (`.opencode`, `.claude`, `.agents`, `~/.config/opencode`) — read-only discovery; `skills.urls` — read-only индексация (`trusted:false`).
- **Capability-aware.** При нехватке `requires_capabilities`/`requires_toolsets` скилл остаётся видимым («агент осведомлён о процессе»), но помечен `unavailable`, а `skill({name})` возвращает делегирование через `task`. Права — как у тулов: `permission.rules.skill`/`permission.rules.command` (allow/deny/ask + glob, ADR-029), `deny` **скрывает**; наследуется саб-агентами.
- **Уровни и включение (модель ADR-071 §2.4).** `system`/`project`/`session`, per-item, дефолт **opt-in (off)**: hard-gate (`system.disabled`, `project.skills.enabled`) — **live** (действует и на старые сессии); дефолты (`disabledForNewProjects`, `project.defaultOn`, снапшот `skillsDefaultOn`) — **snapshot** (смена дефолта не трогает созданные проект/сессию). `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; merge `system > project > session`; отключённый скилл не исчезает — виден с причиной. Тул `skill` уважает scope (`skill.scope_disabled`).
- **Доставка (уровни 2–3).** Тело — `ToolResult` `<skill_content>` + base dir (`file://…`) + ≤10 путей supporting-файлов; обрезка `ToolOutputStore` (50 KB / 2000 строк). Каталог — основной сессии (Composer) и саб-агентам (`task`; binding родителя, capabilities саб-агента). События `skill.invoked`/`command.invoked` — в шину сессии.
- **Read-only до явного действия.** Inline shell (`` !`cmd` ``) — прямой RCE-вектор — выключен по умолчанию (`skills.inlineShell: false`); при включении — только через `execute_shell` + `PermissionEvaluator` (ADR-029), timeout/лимит/аудит; недоверенный проектный контент не исполняется и при флаге. Instance-скиллы пишутся только через ADMIN API (`SkillService`/`SkillStore`, атомарная запись); builtin `skill-creator` — **скилл-инструкция в коде** (без ассетов на ФС), проектные скиллы создаются file-тулами.
- **Совместимость формата.** Frontmatter **толерантен к неизвестным ключам** (совместимость с Anthropic/opencode/Claude Code); поддержаны `user-invocable`/`disable-model-invocation` (→ `invocation`), Claude-поля (`when_to_use`, `model`, `agent`, `argument-hint`) и `metadata.synth.*`; `allowed-tools` — **advisory** (в права не транслируется). Формат — spec `packages/core/AGENTS.md`.

## Альтернативы

- **Тела скиллов в промпт** — отклонён: раздувает промпт всех сессий (progressive disclosure вместо).
- **Отдельные тулы на скилл / autoload `scripts/`** — отклонён: скиллы — инструкции; один тул `skill`.
- **Резолвинг `/`-команд в UI** — отклонён: расхождение UI/CLI/гибрида.
- **Автодоверие «своему» репозиторию** — отклонён: trust выдаётся явно, не по факту `.git`/`git pull`.
- **Доверие к внешним каталогам и `skills.urls`** — ограничено read-only индексацией; install/подписи — [PROP-068](./prop-068-skills-agents-registry.md).

## Последствия

- (+) Процедурное знание переиспользуется без раздувания промпта; единый вход `/`-команд во всех клиентах; проектный контент исполняется только после явного доверия.
- (−) Два уровня доверия (бинарный project-trust механизма vs trust-уровни источников PROP-068) нужно не путать; inline shell — осознанный opt-in.
- Вне объёма: install/доверие/подписи/`lock.json`, backend-админка каталога — [PROP-068](./prop-068-skills-agents-registry.md).

## Статус реализации

Реализовано (Фазы 1–3, часть): механизм скиллов (`engine/skills/*`: формат `SKILL.md`, discovery/приоритет/`shadowed`, trust, тул `skill`, каталог stable/volatile, per-skill permissions), slash-команды и bundles (`engine/commands/*`, резолвинг в core, `command.invoked`), scope-API (system/project/session, снапшоты, миграция `migrateSessionScopeSnapshots`), внешние каталоги и `skills.urls` (read-only), builtin `skill-creator`, UI (настройки/панели/статистика/`/`-автокомплит`). Формат `SKILL.md` и `invocation` — spec в `packages/core/AGENTS.md`; эндпоинты/RBAC — [API_V2.md](../API_V2.md) §5.17–§5.17.2; конфиг — [CONFIGURATION.md](../CONFIGURATION.md).
Остаток: install/доверие/подписи/`lock.json`, backend-админка каталога ([PROP-068](./prop-068-skills-agents-registry.md)).

## Открытые вопросы

Формат `skills.urls` (opencode `index.json` vs git/архивы); `requires_toolsets` — фиксированный словарь или config-маппинг; кэш/офлайн удалённых каталогов; приоритет bundle над встроенными командами; UI недоверенных скиллов (метаданные vs read-only тело); наследование binding в саб-агентах; `allowed-tools` — advisory vs авто-deny. Детали — [PROP-068](./prop-068-skills-agents-registry.md).

## История

- 2026-10-15 — сжатие до одной страницы: as-built вынесено в spec ([ARCHITECTURE.md](../ARCHITECTURE.md), [API_V2.md](../API_V2.md) §5.17–§5.17.2, [CONFIGURATION.md](../CONFIGURATION.md), `packages/{core,ui,shared}/AGENTS.md`).
- 2026-09-30 — единая per-item модель включения (мастер hard-gate + дефолты-снапшоты).
- 2026-09-24 — Фаза 3 (часть): внешние каталоги, `skills.urls` read-only, builtin `skill-creator`.
- 2026-09-23 — Фазы 1–2: механизм скиллов, команды/bundles, scope-API, UI.
- 2026-09-17 — решение принято.
