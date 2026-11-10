# PROP-048: Self-help скиллы и admin-MCP для Synth

> **Статус:** 🧩 Предложение — остаток: deploy-тулы/status-MCP; срез self-help реализован → [ADR-131](./adr-131-self-management-tools.md)
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D3, идея 3 — dogfooding).
> **Связано:** [ADR-046](./adr-046-skills-and-slash-commands.md), [ADR-036](./adr-036-llm-gateway.md),
> [PROP-037](./prop-037-commit-security-step.md), [PROP-056](./prop-056-synth-mcp-server.md),
> [ADR-023](./adr-023-configuration.md), [ADR-029](./adr-029-granular-permissions.md),
> [ADR-079](./adr-079-local-home-independent-instances.md), [ADR-091](./adr-091-backup-restore-transfer.md),
> [ADR-092](./adr-092-instance-lifecycle-maintenance.md), [ADR-097](./adr-097-storage-provider-class.md),
> [ADR-131](./adr-131-self-management-tools.md).
> **Уточнение (2026-11-10):** срез self-help реализован — см. [ADR-131](./adr-131-self-management-tools.md);
> остаток — deploy-тулы/status-MCP и hybrid/credential.

**Решение:** использовать Synth для развёртывания и сопровождения самого Synth (**dogfooding**): админ
поднимает локальный Synth и **с его помощью** разворачивает сервер, управляет им и диагностирует проблемы.
Механизм доставки — продуктовые **runbook-скиллы** (deploy/admin/troubleshoot) + **read-only status-MCP**
Synth (здоровье, версии, состояние деплоя) + deploy-тулы, с **явным гейтингом ADMIN**.

Тот же dogfooding покрывает **эксплуатацию** ([ADR-091](./adr-091-backup-restore-transfer.md),
[ADR-092](./adr-092-instance-lifecycle-maintenance.md), хранилище — [ADR-097](./adr-097-storage-provider-class.md)):
ops-скиллы автоматизируют **через локальный Synth** первичную настройку, `doctor`/проверку,
бэкап/восстановление, экспорт/импорт, миграцию/откат (см. «Ops-скиллы» ниже).

## Контекст

### Что уже есть

- Admin API / RBAC / OIDC: `packages/backend/src/routes/*`; глобальные роли `ADMIN` / `USER` / `LEAD` /
  `AUDITOR` (`packages/shared/src/types/index.ts`). Отдельной роли `devops` нет.
- Helm-чарт `charts/synth/`; Fleet-деплой — отдельный репозиторий `synth-deploy/` (sibling репозитория
  `synth/`); скрипты `scripts/` (`build.sh`, `dev.sh`, `hybrid.sh`, `standalone.sh`, `publish.sh`).
- MCP в Synth — **только клиент** (`packages/core/src/engine/mcp/` — `client.ts`, `manager.ts`). Своего
  MCP-сервера нет (см. D11 / [PROP-056](./prop-056-synth-mcp-server.md)).

### Проблема

Развёртывание и эксплуатация Synth сегодня — ручные операции по внешним инструкциям. Знания (как развернуть,
что проверить при сбое, какие секреты задействованы) не формализованы как продукт и не отдаются агенту.
При этом сам Synth уже умеет выполнять действия — логично, чтобы он же и «помогал себе», но без утечки
секретов кластера в контекст LLM.

## Детали

### Runbook-скиллы

- Продуктовые скиллы (формат `SKILL.md`, механизм — [ADR-046](./adr-046-skills-and-slash-commands.md))
  для типовых задач: **deploy**, **admin**, **troubleshoot**.
- Скиллы несут пошаговый сценарий, ссылки на проверки/тулы и правила безопасной работы с секретами.

### Ops-скиллы (эксплуатация через локальный Synth)

Эксплуатационный контур ([ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md), хранилище — [ADR-097](./adr-097-storage-provider-class.md)) автоматизируется **через локальный Synth** (dogfooding): поднятый локально инстанс своими скиллами и утилитами проходит шаги сопровождения.

- **Первичная настройка** — bootstrap (данные/`--home`, ключи, провайдеры, workspace, первый вход).
- **`doctor`/проверка** — health, целостность данных, доступность ключей/мастера, провайдеры, write-доступ к `dataDir`, миграции; после `restore` — обязательна.
- **Бэкап/восстановление** — `synth backup`/`restore` по runbook, с проверкой результата.
- **Экспорт/импорт** — перенос проекта между инстансами.
- **Миграция/откат** — `synth migrate`, `synth update --to`, `helm rollback`.

Каждый ops-скилл = runbook-скилл ([ADR-046](./adr-046-skills-and-slash-commands.md)) + при необходимости вызов утилиты/скрипта; секреты не попадают в контекст LLM ([ADR-036](./adr-036-llm-gateway.md), [PROP-037](./prop-037-commit-security-step.md)). Так «Synth эксплуатирует Synth»: те же шаги, что для клиента, выполняются агентом под своим локальным инстансом ([ADR-079](./adr-079-local-home-independent-instances.md)).

### Read-only status-MCP

- MCP-сервер Synth (в перспективе — общий с [PROP-056](./prop-056-synth-mcp-server.md)), в self-help-варианте
  **read-only**: здоровье, версии, состояние деплоя, конфигурация (без секретов).
- Транспорт — stdio (локально) и/или HTTP.

### Deploy-тулы и гейтинг

- Тулы, выполняющие действия развёртывания/диагностики (при необходимости — вызовы K8s/Helm/скриптов).
- **Явный гейтинг ADMIN**: доступ к deploy-тулам и status-MCP — только роли ADMIN, через permission-слой
  ([ADR-029](./adr-029-granular-permissions.md)), без хардкода проверок в телах тулов.

### Безопасность

- Согласовать с [ADR-036](./adr-036-llm-gateway.md) (guard, обфускация, rate limit, аудит) и
  [PROP-037](./prop-037-commit-security-step.md) (security-step): секреты кластера/токены не должны попадать
  в контекст LLM и в аудит.
- Credentials — в `secrets/` вне git-репозитория `synth/` (инвариант корневого `AGENTS.md`).

## Принятый к реализации срез (2026-11-10)

Срез реализован по [ADR-131](./adr-131-self-management-tools.md): встроенный скилл
`synth-instance` + instance/MCP/project/session-инструменты, auto-reconnect MCP-сессии,
CLI `synth mcp`, redaction `synth config show`. Остаток — deploy-тулы и read-only
status-MCP (см. «Открытые вопросы»); детали и гейтинг — в ADR-131.

## Статус реализации в коде

Срез self-help реализован ([ADR-131](./adr-131-self-management-tools.md)); deploy/status-MCP не реализованы.

Есть:

- capability `instance`, группы read/write и встроенный скилл `synth-instance` (`/instance`, auto);
- `synth_info` и `synth_mcp_list|test|add|update|remove|enable|reconnect` (in-process, без секретов);
- `list_projects`, `get_project`, `list_sessions`, `get_session_info`, `session_rename`;
  `project_attach` по `projectId` или точному имени (кандидаты при неоднозначности);
- auto-reconnect MCP-сессии в `McpClient`; CLI `synth mcp *`; redaction `synth config show`;
- read-only hybrid discovery проектов/сессий (`origin`, `remote:` id, `remote_offline`/`remote_truncated`) и
  cross-instance attach guard (`project.cross_instance`/`project.hybrid_ambiguous`);
- HTTP/UI реестра MCP (ADR-071), `mcpNetworkPolicy`, `synth doctor`, `attachSessionToProject`.

Нет:

- K8s/Helm deploy-тулы и операции с кластером;
- внешний read-only status-MCP (PROP-056);
- cross-world move и remote MCP merge/management — **не критично**, остатки ADR-131;
- credential-auth в инструментах (остаток ADR-131).

## Открытые вопросы

- Deploy-скиллы и deploy-тулы: только инструкции или реальные тулы с доступом к K8s/Helm?
  **Остаётся открытым** (вне среза).
- Нужен ли внешний read-only status-MCP поверх тех же данных, если in-process-инструменты уже
  отвечают на вопросы агента?
- **Не критично:** cross-world move (p.2) и remote MCP merge/management (p.3); read-only hybrid
  discovery уже реализован в ADR-131. Остаётся credential-auth в инструментах.

## Связи

- [ADR-046](./adr-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — механизм доставки runbook-скиллов (D1).
- [PROP-056](./prop-056-synth-mcp-server.md) «MCP-сервер Synth» — общая основа для status-MCP (D11).
- [ADR-036](./adr-036-llm-gateway.md) / [PROP-037](./prop-037-commit-security-step.md) — секреты, guard, security-step.
- [ADR-023](./adr-023-configuration.md) — конфигурация инстанса; [ADR-029](./adr-029-granular-permissions.md) — гейтинг ADMIN.
- [ADR-071](./adr-071-mcp-servers-prompt.md) — единый реестр MCP (уровни, скоуп, представление в промпте).
- [ADR-105](./adr-105-external-credentials.md) — credentials: запрет plaintext-заголовков, секреты вне контекста LLM.
- [ADR-106](./adr-106-authority-layer.md) — authority-слой: ADMIN-гейтинг write-операций.
- [ADR-131](./adr-131-self-management-tools.md) — реализованный срез self-help-инструментов инстанса/MCP.
- [ADR-079](./adr-079-local-home-independent-instances.md) — изолированные локальные инстансы для dogfooding.
- Смежные черновики: D11/PROP-056 (MCP-сервер), D28/ADR-086 (contribution flow — dogfooding тем же Synth).

## История

- 2026-11-10 — срез self-help реализован → [ADR-131](./adr-131-self-management-tools.md) (skill + instance/MCP/project/session tools, auto-reconnect, CLI, redaction); остаток — deploy/status-MCP.
