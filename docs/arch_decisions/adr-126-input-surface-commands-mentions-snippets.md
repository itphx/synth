# ADR-126: Поверхность ввода и скиллы — `/`-команды, `$`-скиллы, `@`-упоминания, `#`-сниппеты, `!`-скрипты и механика скиллов

> **Статус:** ⚠️ Частично — команды, `$`/`#`/`@`, механика скиллов и подсветка ввода реализованы; остаток — реализация `!`-запуска скриптов проекта (§5, решение зафиксировано), install/подписи/`lock.json` и backend-админка каталога скиллов ([PROP-068](./prop-068-skills-agents-registry.md)).
> **Дата:** 2026-11-14 (объединение с механикой скиллов — 2026-11-16; `!` закрыт решением — 2026-11-16).
> **Источник:** PROP-126 (файл удалён после принятия); механика скиллов перенесена из [ADR-046](./legacy/adr-046-skills-and-slash-commands.md) (заменён).
> **Связано:** [ADR-115](./adr-115-multimodal-input.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-024](./adr-024-eventhub-transport.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-069](./adr-069-project-instructions-agents-md.md), [ADR-070](./adr-070-system-prompt-composer.md), [ADR-071](./adr-071-mcp-servers-prompt.md), [ADR-104](./adr-104-mid-turn-steering.md), [ADR-118](./adr-118-message-stream-v2.md), [ADR-119](./adr-119-context-compaction.md), [PROP-057](./prop-057-loop-engine.md), [PROP-068](./prop-068-skills-agents-registry.md), [PROP-132](./prop-132-ui-terminal.md)

## Контекст

В opencode/openchamber поверхность ввода состоит из `/`-команд, `@`-упоминаний, `$`-скиллов,
`#`-сниппетов и `!`-shell. В Synth был только `/`-реестр (`builtin`/`template`/`skill`/`bundle`) и
`@agent` с регуляркой `@(\w+)`, которая уже конфликтовала с `@src/index.ts` и email. Сниппетов не
было; `$` не было; `!` не было. Копировать TUI-навигацию в web-`/` нельзя — это элементы UI и
транспортных шлюзов, а не промпт-команды.

Отдельно существовала механика скиллов (бывший ADR-046): процедурное знание («как ревьюить API»,
«как писать миграции») не переиспользовалось — текст вставляли в сообщение вручную либо клали все
инструкции в role-промпт агента, раздувая промпт для всех сессий. Нужны были progressive
disclosure, безопасность проектного контента (подмена инструкций через `git pull`) и
capability-соответствие. Два документа описывали одну поверхность и начали расходиться: ADR-046
говорил «скилл — это `/name`», ADR-126 — «основной вызов `$name`». Решение ниже — **один**
активный ADR: вызов скилла остался только `$name`, `/` — только команды, а механика скиллов
перенесена сюда.

## Решение

1. **`/` — только команды.** В `/`-каталоге живут встроенные продуктовые команды, шаблонные
   `.md`-команды и bundles. Скиллы в `/`-каталог **не входят** — ни как `name`, ни как
   `metadata.synth.command`, ни как `<bundle>:<skill>`.
   - Встроенные: `/help`, `/skills`, `/commands`, `/summary`, `/compact`, `/init`, `/review`.
   - `/compact` (компактизация, ADR-119) и `/review` (ревью изменений кода; без аргумента —
     незакоммиченные изменения, аргумент — commit/branch/PR) реализованы; `/summary` остаётся
     суммаризацией, `/init` — prompt-командой.
   - `/skills` — **список скиллов для `$`-вызова** (`$name`), а не список `/`-команд.
   - TUI-команды (`/new`, `/undo`, `/redo`, `/sessions`, `/models`, `/connect`) **не переносятся**:
     это UI-контролы/API, для мессенджеров — отдельный слой транспортных команд.
2. **`@` — файлы, агенты, пользователи.** Единый лексер в core (`engine/input-surface/parser.ts`),
   структурированное поле `mentions` в `POST /sessions/:id/prompt`, `Message.mentions`.
   - `@file` — текст внутри workspace (≤5 МиБ), блок `<file path>`; бинарь/вне периметра → 400.
   - `@user` — первое упоминание делит сообщение: до — агенту, от — user-directed сообщение
     (`metadata.userDirected`) без хода + `message.mentioned`; контекстный фильтр по `ord`/`seq`/`createdAt`.
   - `@agent` — прежняя сегментация; UI-пикер показывает агентов/пользователей/файлы.
3. **`$` — единственный пользовательский вызов скилла.** `$name` в тексте обычного сообщения
   (не `/`-шаблона: `$ARGUMENTS` не токен) резолвится по **имени скилла**; тело
   `<skill_content>` добавляется в user-сообщение, публикуется `skill.invoked`.
   Гейты те же, что у механики скиллов: trust, scope, привязка к агенту, `user-invocable`,
   `permission.rules.skill`, capabilities. Недоступный скилл не грузится и попадает в
   `unavailable`. `/skill-name` **больше не поддерживается** — ни резолвером, ни
   `/`-автокомплитом; `GET /commands` скиллов не отдаёт.
4. **`#` — сниппеты, три уровня.** `instance` / `project` / `user`; приоритет `user > project > instance`;
   канон важнее алиаса. Хранение — **файлы markdown**: `{dataDir}/snippets`,
   `{project.workspace}/.synth/snippets`, `{dataDir}/snippets/users/<userId>`. Проектные сниппеты —
   **всегда `project.workspace`**, не worktree сессии: это уровень проекта, а не ветки. Раскрытие — в
   `POST /prompt` до очереди; лимиты 15/64 КБ, без рекурсии, code-блоки не трогаются. Trust — по
   каталогу источника (как у проектных скиллов/команд); недоверенный project-сниппет виден, но не
   раскрывается.
5. **`!` — запуск объявленного скрипта проекта.** `!name [args]` в обычном сообщении
   резолвится по реестру скриптов и запускает его **фоновым процессом** (ADR-113).
   Raw shell через `!` не поддерживается: интерактив — это терминал
   ([PROP-132](./prop-132-ui-terminal.md), PTY), произвольная команда агента —
   `execute_shell`. Резолвинг — в core (`orchestrator/phases/process-early.ts`,
   рядом с `/` и `$`), а не в UI: иначе разойдутся CLI, гибрид и шлюзы.
   - **Реестр.** `.synth/scripts/<name>.md` (project) > `{dataDir}/scripts` (instance) >
     `config.scripts.paths`; trust-гейт, приоритет и диагностика — те же, что у команд и
     скиллов (§9): недоверенный проектный каталог виден, но не запускается. Имя —
     `^[a-z0-9]+(-[a-z0-9]+)*$`, совпадает с именем файла.
   - **Формат — декларация, а не сам скрипт.** Markdown + tolerant frontmatter
     (`shared/src/skills/frontmatter.ts`): обязательные `description` и `run`,
     опциональные `args` (`false` — аргументы не принимаются, лишние → ошибка),
     `cwd` (относительно workspace, containment периметра), `background`
     (по умолчанию `true`; `false` — ждать завершения до `timeout` и вернуть хвост
     лога в ленту), `timeout` (фон — `0`, ожидание — 120 с), `requires[]`, `env`,
     `shell`, `ready`. Тело — описание действия для человека и агента; в системный
     промпт оно **не** уходит.
     ```md
     ---
     description: Поднять backend (:5000) и UI (:5002)
     run: ./scripts/dev.sh
     background: true
     requires: [bash]
     ---
     Локальная отладка без сборки пакетов. Останов — «Процессы» → dev.
     ```
     Исполняемый файл остаётся обычным файлом репозитория (`scripts/dev.sh`,
     `tools/release.py`): интерпретатор и аргументы — **данные декларации**, а не догадка
     по расширению. Единый паттерн `.synth/*` даёт общий discovery/trust/диагностику/кэш;
     запускаемый файл без декларации — диагностика «объявите скрипт», но **не**
     исполняемая запись.
   - **Исполнение — единственный путь.** `ProcessService.spawn` через
     `ExecutionPort.spawnBackground`: запись `kind:'process'`, лог в `BlobStore`, `stop`,
     события `process.*`, `fs.changed`. Файл-скрипт запускается формой `argv`
     (`ProcessSpawnInput.argv`, [ADR-124](./adr-124-remote-ssh-access.md)): аргументы
     пользователя разбирает лексер в argv, конкатенации в shell нет. `shell: true` —
     `run` как shell-строка, проходит `checkShellCommand` (ADR-029/ADR-136), а аргументы
     приходят через `SYNTH_ARGS`/`SYNTH_ARG_<n>`, не подстановкой в строку. Ожидание
     (`background: false`) не создаёт отдельного пути исполнения: тот же процесс, но
     ответ ждёт `process.exited` и показывает хвост лога.
   - **Права.** `permission.rules.script` (allow/deny/ask + glob по имени, как `skill`);
     `deny` скрывает скрипт; `cwd` — внутри периметра сессии; человек запускает и
     останавливает по `canEditProjectContent` (`VIEWER` только видит список, инвариант 21);
     в `plan` — только список; аудит `script.run` (имя, origin, кто, код возврата).
     HTTP — в контуре сессии (`GET /:id/scripts`, `POST /:id/scripts/:name/run`), доступ
     решает граничный guard (инвариант 16).
   - **Лента и уведомления.** Запуск человеком (`origin:'user'`) **не будит агента**:
     терминальный переход не инжектит USER-сообщение и не ставит автоход (отличие от
     запуска агентом, ADR-113 §4); в ленте — локальная запись (`Message.ephemeral`) со
     ссылкой на карточку и лог. Нужно аддитивное `origin`/`notify` в `ProcessSpawnInput`.
   - **UI и агент.** Автокомплит `!` и подсветка токена; карточка в «Фоновых процессах»
     (`ProcessesTab`) с «Открыть лог / Остановить / Запустить снова». Агенту —
     `script_list`/`script_run` (capability `shell`; в плане — только список), запуск
     агентом идёт обычной семантикой фонового процесса.
   - **Вне объёма.** `ready`-детект (порт/паттерн готовности), автодискавери
     `package.json`/`Makefile` (только подсказки, исполняемыми не становятся), `!` из
     мессенджеров — **не** исполняется (действие человека в UI; ограничение по источнику
     сообщения, не по тексту).
6. **Goal — не команда.** Это outer loop [PROP-057](./prop-057-loop-engine.md); UI целится туда, а не
   в реестр `/`.

### Скиллы: механика (перенесено из ADR-046)

7. **Скиллы — инструкции, а не тулы.** Скилл — папка с `SKILL.md` (+ supporting-файлы
   `references/`/`scripts/`/`assets/`); своих тулов не регистрирует. Единственный core-тул —
   `skill({name, file_path?})` (глобально отключается через `tools.disabled`).
8. **Progressive disclosure.** В системный промпт идёт только **каталог** (`name` + обрезанный
   `description` ~60–100 символов, группировка по категории); тело — по явному `$name` или вызову
   `skill`; supporting-файлы — по требованию. Каталог — отдельный слой промпта с тирами
   (ADR-070): system/project → `stable`, session-динамика и маркеры `unavailable` → `volatile`.
9. **Discovery и trust.** Приоритет (first-wins): `{project.workspace}/.synth/skills` (project) >
   `{dataDir}/skills` (instance) > `config.skills.paths` > внешние read-only каталоги
   (`.opencode/skills|skill`, `.claude/skills`, `.agents/skills`, `~/.config/opencode/skills`) >
   `config.skills.urls` (read-only индекс, `trusted:false`). Проигравшие дубли — диагностика
   `shadowed`; кэш инвалидируется лениво по mtime/size. Скиллы недоверенного проектного каталога
   (`skills.trustedProjectDirs`) **видны в реестре, но не грузятся** — защита от подмены через
   `git pull`. Install/доверие/подписи/`lock.json` — [PROP-068](./prop-068-skills-agents-registry.md).
10. **Capability-aware и права.** При нехватке `requires_capabilities`/`requires_toolsets` скилл
    остаётся видимым («агент осведомлён о процессе»), но помечен `unavailable`, а вызов возвращает
    делегирование через `task`. Права — `permission.rules.skill` (allow/deny/ask + glob, ADR-029);
    `deny` **скрывает** скилл; правило наследуется саб-агентами. `allowed-tools` во frontmatter —
    **advisory** (в права не транслируется).
11. **Уровни включения (модель ADR-071 §2.4).** `system`/`project`/`session`, per-item, дефолт
    **opt-in (off)**: hard-gate (`system.disabled`, `project.skills.enabled`) — **live** (действует
    и на старые сессии); дефолты (`disabledForNewProjects`, `project.defaultOn`, снапшот
    `skillsDefaultOn`) — **snapshot** (смена дефолта не трогает созданные проект/сессию).
    `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; merge
    `system > project > session`; отключённый скилл не исчезает — виден с причиной. Тул `skill`
    уважает scope (`skill.scope_disabled`).
12. **Доставка.** Тело — `<skill_content>` + base dir (`file://…`) + ≤10 путей supporting-файлов;
    обрезка `ToolOutputStore` (50 KB / 2000 строк). Каталог получают основная сессия (Composer) и
    саб-агенты (`task`; binding родителя, capabilities саб-агента). События `skill.invoked`/
    `command.invoked` — в шину сессии.
13. **Формат `SKILL.md`.** Markdown + толерантный YAML-frontmatter (неизвестные ключи не ломают
    discovery). Обязательные — `name` (1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`, совпадает с именем
    каталога) и `description` (1–1024); опциональные — `license`, `compatibility`, `metadata`,
    `allowed-tools`, `when_to_use`, `model`, `agent`, `argument-hint`, `user-invocable`,
    `disable-model-invocation`; `metadata.synth.*` — `tags`, `category`, `related_skills`,
    `requires_capabilities`, `requires_toolsets`, `fallback_for_capabilities`, `agents`, `groups`,
    `scope`, `trigger`, `command`, `mode`. `command` — **legacy**: `/`-имя скилла больше не
    создаётся (§7), поле читается только для совместимости frontmatter и ни на что не влияет.
    `invocation` — комбинация двух флагов:
    `both`/`user`/`model`/`none`. Невалидный скилл не попадает в реестр, discovery остальных не
    ломается.
14. **Bundles — команды `/bundle-name`.** Bundle грузит N тел скиллов одним сообщением (плюс
    необязательная инструкция); bundle **побеждает** одноимённый скилл по конфликту имён.
    Режимы `commands.conflict.mode` теперь описывают только builtin/template/bundle:
    `bundle-wins` — bundle > builtin > template; `conservative` — builtin > template > bundle
    (bundle↔builtin → error); `namespace` — bare: builtin > bundle, шаблоны не перекрывают.
    `commands.conflict.namespacePrefix` больше **не** создаёт `<bundle>:<skill>` — скиллов в
    `/`-каталоге нет.
15. **Read-only до явного действия.** Inline shell (`` !`cmd` ``) в шаблонных командах — прямой
    RCE-вектор — выключен по умолчанию (`skills.inlineShell: false`); при включении — только через
    `execute_shell` + `PermissionEvaluator` (ADR-029), timeout/лимит/аудит; недоверенный проектный
    контент не исполняется и при флаге. Эта механика — подстановка вывода в текст шаблонной команды
    и к `!`-запуску скриптов (§5) отношения **не** имеет: там запускается процесс, а не рендерится
    промпт. Instance-скиллы пишутся только через ADMIN API
    (`SkillService`/`SkillStore`, атомарная запись); builtin `skill-creator` — **скилл-инструкция в
    коде** (без ассетов на ФС), проектные скиллы создаются file-тулами. Builtin-скилл может
    поставляться **каталогом** `prompts/skills/<name>` — нужен, когда есть supporting-файлы
    (`assets/`, `scripts/`): каталог копируется сборкой в `dist/prompts` и публикуется в npm
    (ADR-038), тело и `meta` читаются из `SKILL.md` тем же `parseSkillFile`.

## Альтернативы

- **Тела скиллов в промпт** — отклонён: раздувает промпт всех сессий (progressive disclosure вместо).
- **Отдельные тулы на скилл / autoload `scripts/`** — отклонён: скиллы — инструкции; один тул `skill`.
- **Резолвинг `/`-команд в UI** — отклонён: расхождение UI/CLI/гибрида.
- **Два пути вызова скилла (`$` и `/skill-name`)** — отклонён: два источника правды в
  автокомплите и документации, скиллы конкурируют с командами за имена. `/` — команды, `$` — скиллы.
- **Автодоверие «своему» репозиторию** — отклонён: trust выдаётся явно, не по факту `.git`/`git pull`.
- **Доверие к внешним каталогам и `skills.urls`** — ограничено read-only индексацией; install/подписи — [PROP-068](./prop-068-skills-agents-registry.md).
- **`!` как raw shell (opencode)** — отклонён: второй путь исполнения кода из композера, неоднозначный
  парсинг (`!dev` — скрипт или команда `dev`?) и грант «на весь shell» вместо гранта по имени.
  Интерактивный shell уже есть в терминале ([PROP-132](./prop-132-ui-terminal.md)), агенту — `execute_shell`.
- **Скрипты как голые `.sh`/`.py` без декларации** — отклонён: интерпретатор, аргументы и описание
  пришлось бы угадывать по расширению и шапке-комментариям; trust-гейт и «видно, но не запускается»
  вешать некуда, а discovery/кэш/диагностика стали бы вторым набором правил рядом с `.synth/*`.

## Последствия

- (+) Один вход для команд и один для скиллов: `/` не конкурирует с именами скиллов, `$`-вызов
  однозначен. `@` больше не ломается на путях/email; сниппеты переиспользуют текстовые фрагменты;
  проектный контент защищён trust-гейтом; процедурное знание не раздувает промпт. `!` остаётся
  действием, а не промптом: запуск не тратит токены и не загрязняет историю модели.
- (−) Четыре каталога `.synth/*` (commands/skills/snippets/scripts) и три уровня у сниппетов требуют
  понимания; worktree-сессии читают проектные сниппеты из корня проекта (осознанно). `namespace`-режим
  конфликтов стал проще (без скиллов), а `namespacePrefix` фактически не используется. Скрипты —
  исполняемый контент проекта: доверие выдаётся явно, и `EDITOR` может объявить действие, которое
  запустит другой участник (класс риска «терминал/shell», ADR-136).
- Вне объёма: реализация реестра скриптов (§5) — решение зафиксировано, кода нет; транспортные
  команды мессенджеров; `/compact`-кнопка (slash работает); install/подписи/`lock.json` и
  backend-админка каталога скиллов (PROP-068).

## Остаток по командам

| Что | Состояние |
|---|---|
| `!` — запуск скрипта проекта | Решение — §5; кода нет (реестр + `ProcessService` + тул + автокомплит) |
| `/review` | Prompt-команда реализована; жёсткого `available:false` при отсутствии git/diff **нет** — гейт на стороне модели (промпт честно говорит «ревью недоступно») |
| `/compact` | Slash-команда реализована; отдельной UI-кнопки нет (UI вызывает `/summarize`-маршрут без `mode`) |
| TUI-команды | `/new`, `/undo`, `/redo`, `/sessions`, `/models`, `/connect` намеренно не перенесены; для шлюзов — отдельный слой |

## Остаток по скиллам

| Что | Состояние |
|---|---|
| install/доверие/подписи/`lock.json` | Не реализовано — [PROP-068](./prop-068-skills-agents-registry.md) |
| Backend-админка каталога | Не реализовано — [PROP-068](./prop-068-skills-agents-registry.md) |
| `skills.urls` | Read-only индексация (`trusted:false`); формат каталога — открытый вопрос PROP-068 |
| Inline shell | Реализован как opt-in (`skills.inlineShell`), по умолчанию выключен |

## Статус в коде

- Команды: `engine/commands/{builtin,service,resolver}.ts`, `orchestrator.ts`, `POST /sessions/:id/summarize`
  (`mode`), `POST /sessions/:id/prompt`. `GET /api/v2/commands` отдаёт только builtin/template/bundle;
  `CommandService.list`/`resolve` скиллов не содержат.
- `!`-запуск скриптов (§5): **решения в коде пока нет**. Точки, куда ложится реализация: сканер
  `.synth/scripts` (по образцу `engine/commands/discovery.ts`), `ScriptService` над
  `ProcessService` (`engine/processes/service.ts`, форма `argv`), лексер
  `engine/input-surface/parser.ts`, ранний путь `orchestrator/phases/process-early.ts`,
  роуты в контуре сессии, тулы `script_list`/`script_run` (`engine/tools/`),
  правило `permission.rules.script`, карточка в `components/panels/ProcessesTab.tsx`.
- Скиллы: `engine/skills/*` (формат `SKILL.md`, discovery/приоритет/`shadowed`, trust, каталог
  stable/volatile, scope-гейты, `seed`, `watcher`), `engine/tools/skill.ts`, `engine/commands/dollar-skills.ts`
  (`$`-вызов), `engine/commands/bundles.ts` (`/bundle-name`), `engine/context/*` (каталог в промпте,
  ADR-070), `engine/tools/task/*` (каталог и binding саб-агента).
- Ввод: `engine/input-surface/{parser,user-mentions,file-mentions}.ts`; UI
  `components/chat/{CommandAutocomplete,SkillAutocomplete,SnippetAutocomplete,MentionPopup,composerHighlight}.ts(x)`.
  `CommandAutocomplete` фильтрует `kind:'skill'` (совместимость со старым сервером),
  `SkillAutocomplete` читает только реестр скиллов.
- Сниппеты: `engine/snippets/*`, `server/routes/snippets.ts`, редакторы `SnippetsSettings`,
  `SnippetsAdminSettings`, `SnippetScopeEditor`; проектные — `ProjectTab`.
- Scope-API: `server/routes/skill-scope.ts` (system/project/session, снапшоты, миграция
  `migrateSessionScopeSnapshots`), `server/routes/skills.ts`, `server/routes/skill-bundles.ts`,
  `server/routes/commands.ts`.
- Хранение сообщений: `Message.mentions` (file-store + PostgreSQL-миграция `036_message_mentions`).
- UI скиллов: `stores/skillsStore.ts`, настройки `SkillsUserSettings`/`SkillsAdminSettings`/
  `CommandsSettings`, панели `SessionSettingsTab`/`ProjectTab`/`StatsTab` (секции скиллов и команд).

## История

- 2026-11-16 — `!` закрыт как **запуск объявленного скрипта проекта** (§5): реестр `.synth/scripts`,
  исполнение через `ProcessService`/`ProcessSpawnInput.argv`, терминал — только для интерактива;
  raw shell через `!` отклонён. Кода пока нет — остаток в §«Остаток по командам».
- 2026-11-16 — builtin-ассеты переехали в `prompts/skills/`: скилл `synth-html-report` поставляется
  каталогом (`assets/report.css`, `assets/logo.svg`, `scripts/check_html.mjs`), `metadata.synth.command`
  объявлен legacy — `/`-имя скилла больше не создаётся, поле ни на что не влияет.
- 2026-11-16 — `/skill-name` удалён полностью: `/` — только команды, скиллы — только `$name`;
  механика скиллов перенесена из ADR-046, сам ADR-046 переведён в legacy как ⛔ Заменено.
  `GET /commands` и `/`-автокомплит больше не содержат скиллов; `/skills` показывает `$name`;
  `commands.conflict.namespacePrefix` не создаёт `<bundle>:<skill>`.
