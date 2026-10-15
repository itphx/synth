# AD-048: Self-help скиллы и admin-MCP для Synth

> **Статус:** 🧩 Предложение — Self-help: dogfooding-развёртывание, runbook-скиллы, read-only status-MCP, deploy-тулы (ADMIN)
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D3, идея 3 — dogfooding).
> **Связано:** [AD-046](./ad-046-skills-and-slash-commands.md), [AD-036](./ad-036-llm-gateway.md),
> [AD-037](./ad-037-commit-security-step.md), [AD-056](./ad-056-synth-mcp-server.md),
> [AD-023](./ad-023-configuration.md), [AD-029](./ad-029-granular-permissions.md),
> [AD-079](./ad-079-local-home-independent-instances.md).

**Решение:** использовать Synth для развёртывания и сопровождения самого Synth (**dogfooding**): админ
поднимает локальный Synth и **с его помощью** разворачивает сервер, управляет им и диагностирует проблемы.
Механизм доставки — продуктовые **runbook-скиллы** (deploy/admin/troubleshoot) + **read-only status-MCP**
Synth (здоровье, версии, состояние деплоя) + deploy-тулы, с **явным гейтингом ADMIN**.

## Контекст

### Что уже есть

- Admin API / RBAC / OIDC: `packages/backend/src/routes/*`; глобальные роли `ADMIN` / `USER` / `LEAD` /
  `AUDITOR` (`packages/shared/src/types/index.ts`). Отдельной роли `devops` нет.
- Helm-чарт `charts/synth/`; Fleet-деплой — отдельный репозиторий `synth-deploy/` (sibling репозитория
  `synth/`); скрипты `scripts/` (`build.sh`, `dev.sh`, `hybrid.sh`, `standalone.sh`, `publish.sh`).
- MCP в Synth — **только клиент** (`packages/core/src/engine/mcp/` — `client.ts`, `manager.ts`). Своего
  MCP-сервера нет (см. D11 / [AD-056](./ad-056-synth-mcp-server.md)).

### Проблема

Развёртывание и эксплуатация Synth сегодня — ручные операции по внешним инструкциям. Знания (как развернуть,
что проверить при сбое, какие секреты задействованы) не формализованы как продукт и не отдаются агенту.
При этом сам Synth уже умеет выполнять действия — логично, чтобы он же и «помогал себе», но без утечки
секретов кластера в контекст LLM.

## Детали

### Runbook-скиллы

- Продуктовые скиллы (формат `SKILL.md`, механизм — [AD-046](./ad-046-skills-and-slash-commands.md))
  для типовых задач: **deploy**, **admin**, **troubleshoot**.
- Скиллы несут пошаговый сценарий, ссылки на проверки/тулы и правила безопасной работы с секретами.

### Read-only status-MCP

- MCP-сервер Synth (в перспективе — общий с [AD-056](./ad-056-synth-mcp-server.md)), в self-help-варианте
  **read-only**: здоровье, версии, состояние деплоя, конфигурация (без секретов).
- Транспорт — stdio (локально) и/или HTTP.

### Deploy-тулы и гейтинг

- Тулы, выполняющие действия развёртывания/диагностики (при необходимости — вызовы K8s/Helm/скриптов).
- **Явный гейтинг ADMIN**: доступ к deploy-тулам и status-MCP — только роли ADMIN, через permission-слой
  ([AD-029](./ad-029-granular-permissions.md)), без хардкода проверок в телах тулов.

### Безопасность

- Согласовать с [AD-036](./ad-036-llm-gateway.md) (guard, обфускация, rate limit, аудит) и
  [AD-037](./ad-037-commit-security-step.md) (security-step): секреты кластера/токены не должны попадать
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
- Как не отдать секреты кластера в контекст LLM ([AD-036](./ad-036-llm-gateway.md))?
- Нужна ли отдельная роль `devops`?

## Связи

- [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — механизм доставки runbook-скиллов (D1).
- [AD-056](./ad-056-synth-mcp-server.md) «MCP-сервер Synth» — общая основа для status-MCP (D11).
- [AD-036](./ad-036-llm-gateway.md) / [AD-037](./ad-037-commit-security-step.md) — секреты, guard, security-step.
- [AD-023](./ad-023-configuration.md) — конфигурация инстанса; [AD-029](./ad-029-granular-permissions.md) — гейтинг ADMIN.
- [AD-079](./ad-079-local-home-independent-instances.md) — изолированные локальные инстансы для dogfooding.
- Смежные черновики: D11/AD-056 (MCP-сервер), D28/AD-086 (contribution flow — dogfooding тем же Synth).
