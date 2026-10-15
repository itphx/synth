# AD-031: Verification синт

> **Статус:** 🧩 Предложение — Verification синт (`verifier`) после реализации — опирается на хуки AD-030 и цикл AD-028
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-17
> **Парные документы:**
> - [AD-030](./ad-030-hooks-agent-events.md) «Hooks для событий агента» — verifier запускается хуком `plan_approved` (в фоне), без системы хуков автозапуск невозможен;
> - [AD-028](./ad-028-plan-build-strictness.md) «Настраиваемая строгость цикла Plan → Build» — verification встраивается в цикл plan → build как независимая проверка после реализации.

## Решение

Встроенный синт `verifier`, запускаемый автоматически после завершения реализации. Аналог VerificationAgent из Claude Code, адаптированный под архитектуру Synth.

---

## Контекст

**Почему не просто тесты:** тесты для реализации пишет та же LLM. Verification синт — независимая вторая пара глаз со свежим контекстом.

---

## Детали

### Поведение

- Запускается через hook `plan_approved` или вручную пользователем
- **Read-only** — не модифицирует проект (edit → deny, можно писать только в `/tmp`)
- Проверяет: билд, тесты, линтеры, typecheck
- Применяет **адверсальные пробы**: граничные значения, конкурентные запросы, идемпотентность
- Выносит вердикт: `VERDICT: PASS` / `FAIL` / `PARTIAL`
- `PARTIAL` — только когда проверка физически невозможна (нет тестов, сервер не стартует)

### Стандартный промпт

(адаптирован из Claude Code)

```
Ты verification specialist. Твоя задача — НЕ подтвердить что всё работает,
а ПОПЫТАТЬСЯ СЛОМАТЬ.

1. Прочитай план реализации из project.plan — это критерий успеха
2. Запусти build, полный test suite, linter, typecheck
3. Примени стратегию проверки под тип изменений:
   - Frontend: подними dev server → проверь через браузер → curl API
   - Backend: curl/fetch endpoints → проверь response shapes → error handling
   - Bug fix: воспроизведи баг → проверь фикс → регрессия
4. Адверсальные пробы (выбери подходящие):
   - Конкурентность: параллельные запросы → дубликаты? потерянные записи?
   - Граничные значения: 0, -1, "", очень длинные строки, unicode
   - Идемпотентность: повтори мутирующий запрос → дубликат создался?
5. Каждый чек: Command run + Output observed + Expected vs Actual
6. Финальная строка: VERDICT: PASS | FAIL | PARTIAL

Ты не подтверждаешь что код работает. Ты доказываешь что он НЕ работает.
```

---

## Интеграция

Интеграция в цикл:

```
plan_exit (план утверждён)
  │
  ├─→ hook: plan_approved
  │     └─→ spawn verifier (background)
  │
  ├─→ исполнитель начинает работу по плану
  │
  └─→ verifier завершается
        ├─ PASS → результат принят
        ├─ FAIL → уведомление + возврат исполнителю
        └─ PARTIAL → только то что смогли + список не покрытого
```

---

## Статус реализации в коде

**Не реализовано, кода нет.**

Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- Промпта/агента `verifier` нет: в `packages/core/src/engine/agents/definitions/` только `admin.json`, `analyst.json`, `assistant.json`, `auditor.json`, `developer.json`, `devops.json`, `explore.json`, `general.json`, `pm.json`, `qa.json`, `title.json`.
- Строки `verifier` / `VERDICT` в коде не встречаются. Единственные совпадения на `verification` — `verificationUri` device-flow (`packages/core/src/remote/device-flow.ts:24–25`, `packages/core/src/remote/session.ts:25`, `packages/core/src/server/routes/auth.ts:329–331`), к verification-синту отношения не имеют.
- Автозапуск через hook `plan_approved` невозможен — система хуков не реализована (см. [AD-030](./ad-030-hooks-agent-events.md)).
- Отдельного инструмента/команды verification, read-only-профиля с записью только в `/tmp` для него нет.
