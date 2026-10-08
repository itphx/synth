# AD-061: Многослойная безопасность LLM

> **Статус:** ⏳ Не реализовано (проект)
> **Дата:** 2026-10-08
> **Источник:** перенесено из `AD-DRAFTS.md` (D16; черновик 2026-09-16); Roadmap Фаза 2.
> **Связано:** [AD-025](./ad-025-plan-act-toggle.md), [AD-029](./ad-029-granular-permissions.md),
> [AD-036](./ad-036-llm-gateway.md), [AD-037](./ad-037-commit-security-step.md),
> [AD-073](./ad-073-client-integrity-hybrid.md), [AD-074](./ad-074-soft-delete-retention.md),
> [AD-081](./ad-081-hybrid-policy-leak-protection.md).

**Решение:** дополнить LLM Gateway ([AD-036](./ad-036-llm-gateway.md)) до **многослойной**
безопасности:

- **Сканер промптов** — инъекции, утечки, запрещённые паттерны.
- **Сканер вывода** — проверка ответа модели (расширение Output Guard AD-036).
- **Лимиты** — токены / итерации / время.
- **Human-in-the-loop (HITL)** перед опасными действиями (git push, deploy, delete).
- **Аудит сессий с поиском.**
- **Запрет очистки истории аудита** (неизменяемость).

Пересекается с [AD-036](./ad-036-llm-gateway.md) (Gateway) и
[AD-037](./ad-037-commit-security-step.md) (security step перед коммитом).

## Контекст

AD-036 реализован и покрывает: детекцию секретов, обфускацию (`⟦SYNTH_SECRET_N⟧`/block), rate limit и
аудит JSONL. Плюс в core уже есть **защита от Indirect Prompt Injection (IPI)** и защита путей —
см. «Статус реализации» ниже. AD-061 закрывает оставшиеся слои: лимиты, HITL перед опасными
действиями, поиск по аудиту и неизменяемость.

**Почему многослойно.** Один барьер обходится: обфускация не ловит prompt injection, rate limit не
спасает от опасного `git push`, а без HITL агент выполняет необратимое действие автономно. Слои
закрывают разные классы угроз.

## Детали

### 1. Сканер промптов (input)

Проверка входящего контента/сообщений на:

- prompt injection (в т.ч. indirect — из tool-результатов);
- попытки утечки секретов/системных инструкций;
- запрещённые паттерны.

Реализовано **частично** (IPI, см. ниже); AD-061 уточняет оставшийся объём.

### 2. Сканер вывода (output)

Расширение Output Guard AD-036: подозрительные URL/команды и запрещённые паттерны, а не только
секреты.

### 3. Лимиты

| Лимит | Назначение |
|---|---|
| Токены | ограничение расхода/бюджета |
| Итерации | защита от зацикливания агента |
| Время | ограничение длительности прогона |

Согласуется с Termination Guards циклов ([AD-057](./ad-057-loop-engine.md)).

### 4. Human-in-the-loop перед опасными действиями

Обязательное подтверждение человеком перед необратимыми/опасными операциями: `git push`, `deploy`,
`delete`. **Где ставить** — на уровне тулов ([AD-029](./ad-029-granular-permissions.md)) или Gateway —
открытый вопрос. Гейт может опираться на permission-слой (`ask`) и режимы сессии
([AD-025](./ad-025-plan-act-toggle.md), [AD-028](./ad-028-plan-build-strictness.md)).

### 5. Аудит сессий с поиском

Просмотр аудита уже есть (см. ниже); AD-061 добавляет **поиск** по аудиту сессий/действий, а не
только фильтры по времени/пользователю.

### 6. Неизменяемость аудита

Запрет очистки истории аудита. Аудит должен быть append-only на уровне API (нет эндпоинта удаления)
и, в идеале, на уровне хранилища (WORM). Согласуется с [AD-074](./ad-074-soft-delete-retention.md)
(скрытие вместо удаления, read-only для ADMIN/AUDITOR).

## Статус реализации в коде

**Частично реализовано** (в объёме AD-036 + IPI). Проверено по репозиторию (grep по `packages/**`,
исключая `dist/` и `node_modules/`):

**Уже есть:**

- **LLM Gateway** ([AD-036](./ad-036-llm-gateway.md)): обфускация секретов
  (`⟦SYNTH_SECRET_N⟧`/block), деобфускация в точках потребления, Output Guard (секреты/URL/команды),
  rate limit (`RateLimiter`), аудит JSONL append-only.
- **Защита от Indirect Prompt Injection** — `packages/core/src/engine/security/prompt-injection.ts`:
  `wrapContent` (маркеры `[CONTENT | SOURCE … | trust …]`), `detectPromptInjection` (по словарю
  `injection`, ru/en), `applyPolicy` (`flag`/`sanitize`/`block`); матрица доверия —
  `packages/core/src/engine/security/trust.ts` (`getToolTrust`).
- **Защита путей/shell** — `protected-paths.ts` (+ `protected-paths-store.ts`), `shell-guard.ts`.
- **Permissions** — `packages/core/src/engine/permission/evaluator.ts` (AD-029).
- **Конфиг** — `security.promptInjection` (`enabled` по умолчанию `true`, `wrapContent`, `mode`:
  `flag`/`sanitize`/`block`), `security.protectedPaths`
  (`packages/shared/src/config/types.ts`).
- **Просмотр аудита** — `GET /api/v2/audit` (RBAC ADMIN/AUDITOR, фильтры userId/sessionId/since/until/
  limit) плюс `POST /api/v2/audit/revealed` (`packages/backend/src/routes/audit.ts`).

**Не реализовано (объём AD-061):**

- Лимиты по токенам/итерациям/времени (rate limit — про частоту запросов, не про бюджет прогона).
- HITL перед опасными действиями — совпадений `HITL`/`requiresApproval`/`dangerous` в коде нет.
- Поиск по аудиту (есть только фильтры-запросы по времени/пользователю/сессии).
- Гарантированная неизменяемость аудита (эндпоинта/механизма удаления нет, но и WORM-гарантии нет).
- Расширенный сканер вывода за пределы секретов Output Guard.
- AD-037 (security step перед коммитом) не реализован
  ([AD-037](./ad-037-commit-security-step.md)).

### Требует перепроверки

- Черновик указывал защиту от prompt injection как отсутствующую — **на момент переноса она
  реализована** (в `packages/core/src/engine/security/`). Перед реализацией AD-061 сверить актуальный
  объём IPI с требуемым, чтобы не дублировать.
- Список типов записей аудита AD-036 (`obfuscated`/`blocked`/`revealed`/`rate_limited`/`output_guard`)
  может быть расширен записями AD-061.

## Открытые вопросы

- Правила сканера промптов — статические паттерны (словарь, как сейчас) или LLM-классификатор?
- Где ставить HITL — на уровне тулов ([AD-029](./ad-029-granular-permissions.md)) или Gateway?
- Неизменяемость аудита — WORM-хранилище или достаточно append-only + RBAC?
- Лимиты — на уровне сессии, пользователя или прогона?
- Как поиск по аудиту согласуется с [AD-074](./ad-074-soft-delete-retention.md) (read-only режим)?
- Как слои безопасности сочетаются с политиками гибрида
  ([AD-081](./ad-081-hybrid-policy-leak-protection.md), [AD-073](./ad-073-client-integrity-hybrid.md))?

## Связи

- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — база (обфускация, rate limit, аудит, Output Guard);
  AD-061 дополняет.
- [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions» — `ask`/`deny`/`allow`, гейт
  для HITL.
- [AD-037](./ad-037-commit-security-step.md) «Security step перед коммитом» — отдельный слой
  гарантии на уровне git.
- [AD-025](./ad-025-plan-act-toggle.md), [AD-028](./ad-028-plan-build-strictness.md) — режимы
  сессии/строгость, точки HITL.
- [AD-074](./ad-074-soft-delete-retention.md) «Скрытие вместо удаления» — retention и read-only режим
  аудита.
- [AD-073](./ad-073-client-integrity-hybrid.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md) —
  целостность/политики и защита от утечек в гибриде.
- [AD-057](./ad-057-loop-engine.md) «Loop Engine» — Termination Guards (лимиты итераций).
