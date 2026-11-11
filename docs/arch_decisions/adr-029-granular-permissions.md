# ADR-029: Гранулярные permissions

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

**Решение:** права доступа на основе модели OpenCode — allow/deny/ask для каждого инструмента с поддержкой glob-паттернов для файлов.

**Контекст:** у Claude Code система прав — `disallowedTools` (простой список запрета). У OpenCode — allow/deny/ask на каждый инструмент + паттерны файлов с разрешением на glob-уровне. Модель OpenCode **строго лучше** — даёт точный контроль без оверхеда.

```yaml
permission:
  # Глобальные правила
  "*": "allow"                    # всё разрешено по умолчанию
  doom_loop: "ask"                # подозрительные циклы — переспросить
  question: "deny"                # саб-агентам нельзя переспрашивать пользователя
  plan_enter: "deny"              # саб-агентам нельзя входить в план
  plan_exit: "deny"               # саб-агентам нельзя выходить из плана

  # Внешние директории
  external_directory:
    "*": "ask"                    # любые внешние файлы — спросить
    "/tmp/*": "allow"             # кроме tmp

  # Чтение файлов
  read:
    "*": "allow"
    "*.env": "ask"                # .env — всегда спрашивать
    "*.env.example": "allow"      # .env.example — можно
    "**/credentials.*": "deny"    # credentials файлы — никогда

  # Редактирование (переопределяется в plan mode)
  edit:
    "*": "deny"                   # plan mode: ничего не трогаем
```

**Три уровня действия (action):**

| Action | Поведение | Пример |
|---|---|---|
| `allow` | Выполняется без спроса | `read: "*": "allow"` |
| `deny` | Блокируется с пояснением причины | `edit: "*.env": "deny"` |
| `ask` | Показывается пользователю на подтверждение | `external_directory: "*": "ask"` |

**Fail-closed для внешних директорий (ADR-075).** Путь **вне** рабочего каталога проекта (`workingDir`) не разрешается молча даже при отсутствии правил. Правило `permission.rules.external_directory` приоритетнее групповых и `*` (явное `allow`/`deny` переопределяет дефолт); если правило не задано или внешний путь не покрыт ни одним паттерном — дефолт `ask` (требуется явное подтверждение), а в `plan` / `strict` без утверждённого плана — `deny`. Абсолютные пути и разворачивание `~`/`$HOME`/`$PWD` (`resolvePath`) подпадают под то же правило; пути внутри `workingDir` не затрагиваются. Тулы с `cwd` (`execute_shell`) проверяются по эффективному `cwd`.

**Наследование саб-агентами:** саб-агент получает permissions родительской сессии + свои deny-правила (edit-ограничения от plan mode родителя) + блокировку `question`, `plan_enter`, `task`. Реализуется через `deriveSubagentSessionPermission()` по аналогии с OpenCode.

**«Разрешить в сессии» (once:false):** при ответе пользователя на `ask` с `once:false` в сессию добавляется allow-правило для тула — повторные вызовы не спрашивают. `once:true` — разрешение только на один вызов.

**Deny от пользователя:** при отказе (ask → deny) тул не исполняется, промежуточные результаты сохраняются в истории; отказ возвращается модели как `tool_result` с причиной, и ход **продолжается** (модель может выбрать другой инструмент).

> **Обновлено 2026-10-29.** Ранее deny (и пользовательский, и ролевой `role.unavailable`, и запрет политики) обрывал обработку: публиковалось `stream.done.stopped_by_deny`, финальный текст — `session.stopped`. Теперь **любой deny не останавливает ход**: `tool_result` с причиной уходит модели, следующая LLM-итерация запускается. Защита от зацикливания — doom-loop, лимит шагов/итераций и счётчик одинаковых deny-вызовов (5 подряд → ход завершается фоллбек-текстом `session.denied_blocked`). Поля `stopped_by_deny`/`deny_reason` в `stream.done` больше не публикуются; `session.role_tool_blocked` — только фоллбек при пустом финальном ответе модели. То же поведение у саб-агента `task` (`task.stopped_by_deny` — только фоллбек).

**Саб-агенты:** проходят permission-check; `ask` публикуется в родительскую сессию (`permission.asked`), ответ пользователя применяется к дочерней сессии.

**MCP-инструменты:** доступность по режимам plan/act — `SessionSettings.mcpToolSettings[server].default|tools[tool] = { plan, act }` (настройки в UI). В текущем режиме недоступный тул → deny.

> **Обновлено 2026-11-11. Сессионный shell-грант строится по сегменту-виновнику (сверка с opencode и hermes-agent).**
> «Разрешить в сессии» для `execute_shell` больше не предлагает командный паттерн «на всю команду»:
> грант считается по **сегменту-виновнику** (`shellGrantPlan` в `engine/security/shell-guard.ts`).
>
> - **План гранта.** `shellGrantPlan(command, trigger, { cwd })` → `{ commands, patterns, directories }`:
>   `commands` — все исполняемые сегменты команды (тот же разбор `splitShellSegments`, что у
>   `shellSavePatterns`; trim, служебные строки heredoc/комментарии/shebang отброшены) — они
>   показываются человеку; `patterns` — паттерны правила `execute_shell: { "<cmd> *": "allow" }`;
>   `directories` — каталоги для правила `external_directory: "<dir>/*"`.
> - **`askKind: 'dynamic'`** (непроверяемый glob/динамика) — командный паттерн **не выдаётся никогда**
>   (`patterns: []`): он шире конкретной команды. Вместо него предлагается каталог виновника
>   (`grantDirectoryForToken`: токен с `/` → его каталог-часть; bare-glob (`*.js`) → `cwd` сегмента;
>   `$VAR`/`$(...)`/backtick → каталог не определяется). Снятие ask требует, чтобы **все** фактические
>   совпадения glob'а (`ShellCheckResult.askPaths`, абсолютные пути реальных совпадений из `checkShellCommand`)
>   были внутри периметра или под **явным** `allow` правила `external_directory` (`evaluator.ts`,
>   ветка `liftedByDirectoryGrant`); дефолтный `external_directory: ask` снятием не считается.
> - **`protected`/`mutation`/`cwd`/`deny`** — жёсткий слой выше правил: не снимаются ни командным
>   паттерном, ни каталогом (`save: []`, `saveDirectories` пуст). Карточка показывает «Только один раз».
> - **Провод.** `permission.asked` и DTO `GET /api/v2/sessions/:id/permissions` несут аддитивные
>   `commands?: string[]` (точные сегменты), `save?: string[]` (паттерны; `[]` — грант не предлагается)
>   и `saveDirectories?: string[]` (каталоги; в payload — camelCase, как исторически). Выдача гранта
>   пишется в аудит (`scope:'permission'`, `action:'grant'`) через `OrchestratorOptions.onPermissionGrant`;
>   `_grantSessionToolAllow` без `trigger` (восстановленное после рестарта ожидание) идёт legacy-путём
>   `shellSavePatterns`.
> - **Сверка с opencode.** `packages/core/src/shell/parse.ts` (`ARITY`/`prefix`) разбирает команду на
>   сегменты так же, как наш `splitShellSegments`; в `session-permission-dock.tsx` показываются
>   `resources` запроса (аналог наших `commands`); `cd`-цели в `file-access.ts` трактуются как
>   `external_directory` — отсюда форма гранта каталогом (`<dir>/*`), а не «разрешить весь shell».
> - **Сверка с hermes-agent.** `tools/approval.py` выдаёт гранты **по классам опасности**, а
>   `tools/approval_floors.py` явно **не** применяет `command_allowlist` к составным командам —
>   подтверждение нашего правила «составная команда не получает командный паттерн целиком; динамика
>   покрывается только каталогом/точечным подтверждением».
