# ADR-146: Фильтрация контента инструментов — единый слой, правила в промпте и advisory-скан MCP

> **Статус:** ✅ Реализовано
> **Дата:** 2026-11-18
> **Связь:** PROP-061 — IPI-часть предложения зафиксирована здесь; файл предложения остаётся
> (лимиты, HITL, поиск по аудиту и неизменяемость — вне объёма этого решения).
> **Связано:** [ADR-036](./adr-036-llm-gateway.md) (Gateway, guard, аудит),
> [ADR-070](./adr-070-system-prompt-composer.md) (тиры и блоки промпта),
> [ADR-071](./adr-071-mcp-servers-prompt.md) (блок `mcp.servers`),
> [ADR-132](./adr-132-ui-terminal.md) (интерактивный терминал),
> [ADR-115](./adr-115-multimodal-input.md) (вложения — байты не сканируются),
> [ADR-094](./adr-094-observability-metrics.md) (метрики), [ADR-023](./adr-023-configuration.md) (конфиг).

## Контекст

Защита от Indirect Prompt Injection (IPI) существовала, но была рассредоточена: `wrapContent`
оборачивал результат тула в маркеры `[CONTENT | SOURCE: … | trust: …]`, `detectPromptInjection`
искал подозрительные паттерны по словарю `injection` (ru/en), `applyPolicy` применял
`flag`/`sanitize`/`block`, матрица доверия `getToolTrust` решала, доверенный ли источник. При этом:

1. **Правила для модели жили в ролевых файлах** (`prompts/roles/*`, `prompts/subagents/*`):
   дублировались в каждой роли, расходились формулировками и не выключались вместе с настройкой
   защиты.
2. **Обёртку применял только основной ход** оркестратора; цикл саб-агента (`task`) и агентский шаг
   пайплайна шли со своими копиями логики или без неё — правила между циклами расходились.
3. **Конверт ставил сам тул терминала** (`frameTerminalOutput`): тул знал про IPI, атрибуты
   маркера были вклеены в текст результата, метаданные — смешаны с содержимым.
4. **Подделка закрывающего маркера** (`[CONTENT END]` внутри вывода команды) закрывала блок
   раньше времени — остаток недоверенного текста модель читала как инструкцию вне данных.
5. **Описания MCP-серверов** — текст третьей стороны в системном промпте без какой-либо пометки.

## Проблема

Один класс угрозы (недоверенный текст в контексте модели) обрабатывался в нескольких местах с
разными правилами. Нужно было: одна точка фильтрации на все циклы Tool Use; правила защиты —
одним системным блоком, а не копиями в ролях; корректная семантика маркеров; настраиваемый порог
(включено/режим) без рестарта; и хотя бы сигнал о подозрительных описаниях MCP.

## Решение

1. **Правила защиты — отдельный системный блок.** `prompts/system/CONTENT_RULES.{ru,en}.md`
   подключается в `SystemPromptComposer` как `content.rules` (`tier: stable`, `order: 12`,
   `provenance: 'prompts/system/CONTENT_RULES'`) — сразу после `role`, до `additional`. Блок
   добавляется и при `session.settings.systemPrompt` override (он в `extraBlocks`). Гейт —
   `contentRulesEnabled` (= `security.promptInjection.enabled`; шаг пайплайна — из
   `securityContentFilter.getConfig()`): при выключенной защите блок снимается. Наличие
   инструментов в запросе гейтом **не** является — в основном ходе composer собирается до
   `select()`. Из `prompts/roles/*` и `prompts/subagents/*` правила **удалены** — роль их больше не
   дублирует. Загрузчик — `ContextConfig.getContentRules()` (порт контекстных файлов;
   `getRules()` оставлен `@deprecated`-алиасом).

2. **Единый слой фильтрации** — `packages/core/src/engine/security/tool-content.ts`,
   `applyToolContentFilter`. Порядок: защита выключена → без изменений; системный/неизвестный тул
   (`getToolTrust` вернул `null`) → без изменений; экранирование маркеров (всегда); словарная
   детекция ru+en → `applyPolicy(mode)`; `blocked` → текст `security.injection_blocked` +
   `isError: true`; иначе контент (экранированный) в конверт при `wrapContent`, а в режиме `flag`
   при совпадениях — WARN-строка **перед** блоком. Слой применяют **все три цикла**:
   - основной ход — `engine/orchestrator.ts`;
   - цикл саб-агента — `engine/tools/task/run-cycle.ts`;
   - агентский шаг пайплайна — `engine/pipelines/executors/agent-step.ts`
     (`PipelineSecurityContentFilter`, живой `{ getConfig, dictionaryStore }`).
   Второй копии логики быть не должно: иначе правила расходятся между циклами.

3. **Покрытие — все источники контента.** builtin-тулы (файлы/git/shell/search/web/`task`), MCP,
   тулы плагинов, терминал. `isError`-результаты проходят слой наравне с обычными (текст отказа
   тоже может нести недоверенный фрагмент: аргументы вызова, эхо команды). Не фильтруются
   **системные** тулы (`plan_enter`, `plan_exit`, `todo_write`, `classify_conversation`) — их
   результат формирует ядро.

4. **Матрица доверия — в `getToolTrust`** (`engine/security/trust.ts`), см. таблицу ниже. Ветка
   плагинов стоит **до** MCP (плагин не может «выдать себя» за MCP-инструмент), уровень доверия —
   из `ToolDefinition.pluginTrust` (`builtin`/`verified`/`trusted` → `trusted`; `community`/не
   задан → `untrusted`, fail-closed). Атрибуты терминала тул кладёт в `metadata`, в открывающий
   маркер попадает только белый список (`terminal_id`, `status`, `seq`, `bytes`, `run`, `exit`, …).

5. **Экранирование маркеров** — `escapeContentMarkers` в `engine/security/prompt-injection.ts`:
   `[CONTENT` и `[/CONTENT]` в теле становятся `\[CONTENT` (регистронезависимо, идемпотентно —
   уже экранированное не трогается). Конверт сам экранирует тело (`wrapContentDetailed`), поэтому
   вызывающий не может «забыть» это сделать. Подделка маркера **помечается**
   (`injection_marker_escaped`, `injection_suspicious` в `metadata`), но **не блокирует** контент.

6. **Настройка — runtime `security.promptInjection`** (`enabled`, `mode`), раздел UI
   «Безопасность» (`SecuritySettings.tsx`), default `enabled: true`. Приоритет **env > runtime >
   config.yaml > default** (`resolvePromptInjection`, `shared/src/config/security.ts`); env
   `SYNTH_SECURITY_PROMPT_INJECTION_ENABLED` / `SYNTH_SECURITY_PROMPT_INJECTION_MODE`; env-фиксация
   проверяется **по полю** — `PUT`/`DELETE` → `409 ENV_LOCKED` с `fields`, ничего не применяется.
   `wrapContent` — **только** `config.yaml` (deployment-политика обёртки, runtime её не
   перекрывает). Изменения применяются live (`restartRequired: false`), сброс — к `config.yaml`.
   `GET` отдаёт `source`/`envLocked`/`envLockedFields`/`defaults`.

7. **MCP — advisory-скан описаний.** При регистрации тулов `McpManager` прогоняет словарный
   детектор (ru+en) по `server.description`, `server.instructions`, `tool.description` и имени
   тула. Вердикт **advisory**: в блоке `mcp.servers` перед описанием/`Instructions`/пунктом списка
   ставится `[WARN]`-строка, тул остаётся доступен, схемы не мутируются. Счётчик —
   `synth_content_filter_hits_total{source,kind}` (`source`: `mcp_server`|`mcp_tool`, `kind`:
   `description`|`instructions`|`name`), лог — без текста описаний.

8. **Терминал — атрибуты в `metadata`, конверт в общем слое.** `terminal_read`/`terminal_snapshot`/
   `terminal_run` возвращают **сырой нормализованный текст**, атрибуты (`terminal_id`, `status`,
   `seq`, `bytes`, `exit`, …) кладут в `metadata`; конверт
   `[CONTENT | SOURCE: terminal | … | trust: untrusted]` ставит `applyToolContentFilter`. Служебные
   сообщения — уведомление о завершении фонового запуска (`engine/terminal/runs.ts`) и контекст
   терминала в промпте (`engine/terminal/context-message.ts`) — формируют конверт сами
   (`formatBackgroundContent`, свой маркер `[CONTENT key=value …]`) с экранированием тела:
   результаты тулов и служебные сообщения — разные вещи, общий конверт к ним не применяется.
   `frameTerminalOutput` — `@deprecated`-алиас `formatBackgroundContent`.

## Матрица доверия

| Источник | Доверие | Условие |
|---|---|---|
| Файлы внутри рабочего каталога / `allowedRoots` | `trusted` | путь внутри периметра (ADR-114: worktree + корень проекта) |
| Файлы вне периметра | `untrusted` | `source: file`, путь в маркере |
| git-тулы (`git_*`, `project_repo_clone/init/fetch`) | `trusted` | — |
| Проектные тулы (`get_project_info`, `list_repos`, `project_*`, `ssh_keys_list`) | `trusted` | — |
| web (`web_fetch`, `web_search`) | `untrusted` | URL/запрос в маркере |
| shell (`execute_shell`) | `untrusted` | — |
| `task`, `read_session_reference` | `untrusted` | `task` — без атрибутов; у ссылки — `SESSION_ID` в маркере |
| MCP (capability `mcp`) | `untrusted` | — |
| Терминал (`terminal_*`, capability `terminal`) | `untrusted` | атрибуты из `metadata` (белый список) |
| Плагин (`source: plugin`) | по `pluginTrust` | `builtin`/`verified`/`trusted` → `trusted`; иначе `untrusted` (fail-closed) |
| Системные (`plan_enter`, `plan_exit`, `todo_write`, `classify_conversation`) | — | не оборачиваются (`null`) |

## Экранирование: почему не блокируем по маркеру

Соблазн — считать любой `[CONTENT` в результате атакой и блокировать. Это ломает продукт:
документация, код и тесты самого Synth содержат маркеры блока (этот ADR — тоже), а агент,
читающий репозиторий, обязан их видеть. Поэтому маркер — **сигнал**, а не приговор: экранирование
защищает структуру конверта (подделка `[CONTENT END]` больше не закрывает блок), факт помечается в
`metadata` (`injection_marker_escaped`/`injection_suspicious`), а блокировка остаётся только за
словарной детекцией (`injection.{ru,en}`) в режиме `block` — как и раньше.

## Advisory-скан MCP

Описания MCP-серверов и инструментов — данные, которые приносит третья сторона и которые попадают
в системный промпт (`mcp.servers`, ADR-071). Вырезать или блокировать их нельзя: сервер без
описания бесполезен модели. Поэтому вердикт — `[WARN]`-строка перед подозрительным фрагментом плюс
метрика; решение остаётся за моделью и человеком. Скан выполняется при регистрации/перерегистрации
состава (`registerTools`), повторный вызов перезаписывает флаги сервера целиком — старые не
залипают. Тексты описаний и имена серверов в метрику и лог не попадают (ADR-094 п. 5: закрытые
наборы значений, без взрыва серий).

## Альтернативы

- **Nonce-маркеры** (`[CONTENT #a1b2]`) — отклонено: конверт должен быть читаем и диффопригоден,
  а секрет nonce всё равно утекает в историю; экранирование даёт ту же защиту структуры без
  состояния.
- **Блокировать контент по маркеру** — отклонено: нельзя прочитать документацию/код, где маркер
  упоминается; ложные срабатывания на собственном репозитории.
- **Фильтрация в каждом туле** — отклонено: правила расходятся между циклами и тулами (уже
  случилось: терминал ставил конверт сам), а новые тулы забывали бы слой. Единая точка — условие
  корректности.
- **Блокировать MCP-тул с подозрительным описанием** — отклонено: описание не является кодом,
  блокировка ломает рабочие серверы; advisory-пометка информирует, не отнимая инструмент.
- **Правила IPI в ролях** — отклонено: дублирование в каждой роли, расхождение формулировок,
  невозможность выключить вместе с настройкой.

## Последствия

**Плюс:** одна точка фильтрации на все циклы; правила живут в одном блоке и выключаются вместе с
защитой; структура конверта защищена от подделки; терминал вернул себе «сырой текст + metadata»;
настройка правится из UI без рестарта и честно сообщает источник значения; подозрительные описания
MCP видны в промпте и в метрике.

**Минус/риски:** слой добавляет обход словаря на каждый результат тула (словарь читается через
порт); экранирование меняет байты контента (агент, читающий файл с маркером, увидит `\[CONTENT` —
приемлемая цена); advisory-вердикт MCP — эвристика по словарю, возможны ложные пометки; аудит
изменения настройки ограничен логом (см. остатки).

## Остатки / вне объёма

- **Бинарные вложения не сканируются** — это байты (ADR-115), слой работает с текстом.
- **Описания встроенных тулов не сканируются** — они из поставки, а не от третьей стороны.
- **Шаг пайплайна не получает флаги описаний MCP-серверов** — блок `mcp.servers` собирает
  оркестратор сессии, у шага своя сборка промпта.
- **Аудит изменения настройки — только лог**: подходящего `scope` в `SECURITY_AUDIT_SCOPES` нет,
  расширять перечень ради одной настройки не стали; запись в журнал не ведётся.

## Статус в коде

- **Слой:** `packages/core/src/engine/security/tool-content.ts` (`applyToolContentFilter`),
  `engine/security/{prompt-injection,trust}.ts`.
- **Точки вызова:** `engine/orchestrator.ts`, `engine/tools/task/run-cycle.ts`,
  `engine/pipelines/executors/agent-step.ts` (`PipelineSecurityContentFilter`);
  сборка — `server/app/deps.ts` и `backend/app/deps.ts`.
- **Промпт:** `prompts/system/CONTENT_RULES.{ru,en}.md`; блок — `engine/context/composer.ts`
  (`content.rules`, order 12), загрузчик — `engine/context/config.ts` (`getContentRules`).
- **MCP:** `engine/mcp/manager.ts` (`_scanContentFlags`, `getContentFlags`), метрика
  `synth_content_filter_hits_total`.
- **Терминал:** `engine/terminal/{output,runs,context-message}.ts`.
- **Настройка:** `shared/src/config/security.ts` (`resolvePromptInjection`),
  `shared/src/config/types.ts` (`promptInjectionConfigSchema`),
  `server/routes/settings.ts` (`/api/v2/settings/security`),
  UI `packages/ui/src/components/settings/SecuritySettings.tsx`, `lib/api/security.ts`.
- **Тесты:** `engine/security/{tool-content,prompt-injection,trust}.test.ts`,
  `engine/context/composer.test.ts`, `engine/mcp/manager-content-flags.test.ts`.

Контракты и настройки: [docs/API_V2.md](../API_V2.md) §5 (`/settings/security`),
[docs/CONFIGURATION.md](../CONFIGURATION.md) §`security.promptInjection`,
[docs/OBSERVABILITY.md](../OBSERVABILITY.md) §«Контент MCP (advisory)»,
[docs/TOOLS.md](../TOOLS.md) §«Терминалы».

## История

- 2026-11-18 — принято: единый слой фильтрации на три цикла, блок `content.rules`, runtime-настройка
  `security.promptInjection` с env-lock по полю, экранирование маркеров, advisory-скан MCP,
  обрамление терминала перенесено в общий слой (поглощена IPI-часть PROP-061).
