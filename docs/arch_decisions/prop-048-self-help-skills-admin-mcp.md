# PROP-048: Self-help скиллы и admin-MCP для Synth

> **Статус:** 🧩 Предложение — Self-help: dogfooding-развёртывание, runbook-скиллы, read-only status-MCP, deploy-тулы (ADMIN)
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D3, идея 3 — dogfooding).
> **Связано:** [ADR-046](./adr-046-skills-and-slash-commands.md), [ADR-036](./adr-036-llm-gateway.md),
> [PROP-037](./prop-037-commit-security-step.md), [PROP-056](./prop-056-synth-mcp-server.md),
> [ADR-023](./adr-023-configuration.md), [ADR-029](./adr-029-granular-permissions.md),
> [ADR-079](./adr-079-local-home-independent-instances.md), [PROP-091](./prop-091-backup-restore-transfer.md),
> [PROP-092](./prop-092-instance-lifecycle-maintenance.md), [PROP-032](./prop-032-history-storage-postgresql.md).

**Решение:** использовать Synth для развёртывания и сопровождения самого Synth (**dogfooding**): админ
поднимает локальный Synth и **с его помощью** разворачивает сервер, управляет им и диагностирует проблемы.
Механизм доставки — продуктовые **runbook-скиллы** (deploy/admin/troubleshoot) + **read-only status-MCP**
Synth (здоровье, версии, состояние деплоя) + deploy-тулы, с **явным гейтингом ADMIN**.

Тот же dogfooding покрывает **эксплуатацию** ([PROP-091](./prop-091-backup-restore-transfer.md),
[PROP-092](./prop-092-instance-lifecycle-maintenance.md), хранилище — [PROP-032](./prop-032-history-storage-postgresql.md)):
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

Эксплуатационный контур ([PROP-091](./prop-091-backup-restore-transfer.md), [PROP-092](./prop-092-instance-lifecycle-maintenance.md), хранилище — [PROP-032](./prop-032-history-storage-postgresql.md)) автоматизируется **через локальный Synth** (dogfooding): поднятый локально инстанс своими скиллами и утилитами проходит шаги сопровождения.

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

## Статус реализации в коде

**Не реализовано.**

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- Admin API/RBAC/OIDC — реализованы (`packages/backend/src/routes/*`, роли `ADMIN`/`USER`/`LEAD`/`AUDITOR`).
- Helm-чарт `charts/synth/` присутствует; `synth-deploy/` — внешний репозиторий; скрипты в `scripts/` на месте.
- MCP представлен только клиентом (`packages/core/src/engine/mcp/`); серверных MCP-регистраций нет.
- Runbook-скиллов deploy/admin/troubleshoot, status-MCP, deploy-тулов и роли `devops` нет.

## Открытые вопросы

- Деплой-скиллы — только инструкции или реальные тулы с доступом к K8s/Helm?
- Как не отдать секреты кластера в контекст LLM ([ADR-036](./adr-036-llm-gateway.md))?
- Нужна ли отдельная роль `devops`?

## Связи

- [ADR-046](./adr-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — механизм доставки runbook-скиллов (D1).
- [PROP-056](./prop-056-synth-mcp-server.md) «MCP-сервер Synth» — общая основа для status-MCP (D11).
- [ADR-036](./adr-036-llm-gateway.md) / [PROP-037](./prop-037-commit-security-step.md) — секреты, guard, security-step.
- [ADR-023](./adr-023-configuration.md) — конфигурация инстанса; [ADR-029](./adr-029-granular-permissions.md) — гейтинг ADMIN.
- [ADR-079](./adr-079-local-home-independent-instances.md) — изолированные локальные инстансы для dogfooding.
- Смежные черновики: D11/PROP-056 (MCP-сервер), D28/ADR-086 (contribution flow — dogfooding тем же Synth).
