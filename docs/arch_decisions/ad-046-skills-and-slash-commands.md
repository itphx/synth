# AD-046: Скиллы и slash-команды

> **Статус:** ✅ Фаза 1 реализована; ✅ Фаза 2 реализована (commit 1 — core+API+CLI: команды/bundles/scope-API; commit 2 — UI: настройки/панели/статистика//-автокомплит); ✅ Фаза 3 (часть) — внешние локальные каталоги (read-only discovery), `skills.urls` (read-only индексация, `trusted: false`) и встроенный мета-скилл `skill-creator` (builtin-скилл-инструкция); ⏳ остаток Фазы 3 (inline shell, install/trust/подписи/`lock.json` и backend-админка каталога — AD-068)
> **Дата:** 2026-09-17
> **Реализация:** Фаза 1 — 2026-09-23 (механизм скиллов; отклонения — в разделе «Реализовано в Фазе 1»); Фаза 2 — 2026-09-23 (commit 1 — core/API/CLI, commit 2 — UI; отклонения — в соответствующих разделах); Фаза 3 (часть) — 2026-09-24 (внешние каталоги + `skills.urls` read-only; `skill-creator` как builtin-скилл)
> **Парный документ:** [AD-068](./ad-068-skills-agents-registry.md) «Реестр и каталог скиллов и агентов» — контент-платформа, реестр, доверие и распространение

---

## Реализовано в Фазе 1 (2026-09-23)

Реализовано ядро механизма скиллов в `@itphx/synth-core` + контракты в `@itphx/synth-shared`.
Зафиксированные при реализации отклонения от исходного проекта:

| # | Исходный проект | Фактически | Причина |
|---|---|---|---|
| 1 | Frontmatter-парсер «в core» | Хелпер `parseFrontmatter`/`stringifyFrontmatter` в `packages/shared/src/skills/frontmatter.ts` на уже имеющемся `js-yaml` | В core `js-yaml` нет; новую зависимость не ставим (инвариант 13). Толерантность к неизвестным ключам/невалидному YAML — возвращает `issues`, не throw |
| 2 | FS-watch инвалидация кэша | Ленивая проверка mtime/size при обращении к реестру (`SkillWatcher`) + принудительный `POST /api/v2/skills/reload` | `fs.watch`/chokidar не добавляем (инвариант 13); ре-скан по mtime закрывает пробел opencode и защищает от инъекций через `git pull` |
| 3 | `tools.skill: false` (глобальный тумблер) | Отдельного `tools.skill` нет: тул `skill` (capability `file_read`) отключается существующим `tools.disabled` (AD-071 §2.9) + per-session контекстом | Не дублировать механизм; AD-071 уже даёт instance-wide отключение |
| 4 | Каталог — один блок | Два блока AD-070: `skills.catalog` (**stable** — system/project, доступные) и `skills.catalog.session` (**volatile** — session enable/disable + маркеры `unavailable`) | Тиры AD-070 §2.1/§4.5: стабильная часть не инвалидирует prompt-cache |
| 5 | Саб-агенты — через Composer | Каталог приклеивается к `llmSystemPrompt` в `engine/tools/task.ts`/`task-resume.ts`; binding — **родителя**, capabilities — саб-агента | Рефактор саб-агентов на Composer — вне Фазы 1 (см. §12/§13) |
| 6 | Внешние каталоги `.opencode`/`.claude`/`.agents`/`~/.config/opencode`, `skills.urls` | Подключены в Фазе 3 (часть, 2026-09-24) как **read-only discovery/индексация**: внешние локальные каталоги в проекте наследуют project-trust, `~/.config/opencode` — trusted; `skills.urls` кэшируются в `{dataDir}/skills-cache/urls/<sha1(url)[:16]>` с `trusted: false` (в каталог для модели не попадают, тело не грузится) | Фаза 1 ограничивалась instance/project/`config.skills.paths`; установка/доверие/подписи/`lock.json` — AD-068 |

**Состав Фазы 1:**
- Формат `SKILL.md`: толерантный YAML-frontmatter (неизвестные ключи → `meta.extra`), валидация `name` (1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`, совпадает с каталогом) и `description` (1–1024), поля §3.2 включая `metadata.synth.*`.
- Discovery: `{dataDir}/skills` (instance, level `system`), `{project.workspace}/.synth/skills` (project, level `project`), `config.skills.paths`; приоритет `project > instance > config.paths`, first-wins, `shadowed`-диагностика; недоверенные проектные скиллы видны, но не грузятся (`skills.trustedProjectDirs`).
- Каталог в промпт основной сессии (Composer) и саб-агентам; capability-aware `unavailable` + делегирование через `task`; binding `metadata.synth.agents`/`groups`.
- Core-тул `skill({name, file_path?})`: `<skill_content>` + base directory + ≤10 supporting-файлов; обрезка 50 KB / 2000 строк локально.
- Per-skill permissions (`permission.rules.skill`: строка или glob-паттерны по имени); `deny` скрывает скилл из каталога; наследование саб-агентами.
- Событие `skill.invoked`; тип `command.invoked` зарезервирован (Фаза 2).
- API: `GET/POST /api/v2/skills`, `GET/PATCH/DELETE /api/v2/skills/:name`, `GET/PUT/DELETE /api/v2/skills/:name/files/*`, `POST /api/v2/skills/reload`; instance-запись — через `SkillService`/`SkillStore` (атомарная запись tmp→rename).
- i18n-ключи `skill.*` (AD-041): `shared/i18n`, core `system-messages.ts`, UI `ru.ts`.

---

## Реализовано в Фазе 2 — commit 1 (core + API + CLI, без UI)

Реализованы slash-команды и bundles в `@itphx/synth-core` + контракты в `@itphx/synth-shared`. Отклонения/решения:

| # | Решение | Фактически |
|---|---|---|
| 1 | `/compact`, `/review` | Отложены (не реализованы в Фазе 2) |
| 2 | `allowed-tools` | Advisory: только метаданные frontmatter, в права не транслируется |
| 3 | `/summary` | Ручной триггер суммаризации: оркестратор вызывает `_handleSummarization` напрямую (в оркестраторе нет queueManager для enqueue SYSTEM) |
| 4 | `namespace` | bare — `builtin > skill`; бандл-скиллы как `<bundle>:<skill>` только при конфликте имени с builtin; префиксы `template:` не вводятся |
| 5 | Локальные команды | user+assistant сообщения builtin-ответов помечаются `Message.ephemeral` и исключаются из LLM-контекста (оптимизатор) |
| 6 | `requires_toolsets` | Экспансия через `config.skills.toolsets` (`scope.ts`), union с `requires_capabilities` |
| 7 | Счётчики/метрики | Из событий `command.invoked`/`skill.invoked` (отдельного хранилища нет) |
| 8 | Исправления Фазы 1 | `<skill_files>` → `<file>путь</file>`; base dir — `pathToFileURL(dir).href` |

**Состав Фазы 2 (commit 1):**
- `engine/commands/{parser,template,discovery,registry,bundles,builtin,resolver,service}.ts`, `storage/command-store.ts`, `storage/skill-bundle-store.ts`.
- Ранний резолвинг в `orchestrator.ts` (до micro-first/LLM); `command.invoked`; `skill.invoked` для skill/bundle.
- Permission `permission.rules.command` (allow/deny/ask + glob); наследование саб-агентами; `deny` скрывает из `/commands`.
- Core API: `GET /api/v2/commands`, CRUD `/api/v2/skill-bundles`, scope `/sessions|projects|settings/skills`.
- CLI: `/`-строки идут через единый путь `runSingleChat` → core-резолвер; локальные команды не требуют настроенного провайдера.
- Конфиг: `commands.*`, `skills.toolsets`. Bundles — YAML `{dataDir}/{commands.bundlesPath}/<name>.yaml`.
- UI (настройки/автокомплит/панели) — **не входит** в commit 1.

---

## Реализовано в Фазе 2 — commit 2 (UI)

UI-слой скиллов/команд поверх core-API Фазы 2 (commit 1). Пользователь свои скиллы не создаёт: user-раздел — просмотр; CRUD — только ADMIN.

**Resolver (core, commit 1, для контекста UI):** `/`-команды резолвятся в core до LLM единообразно для UI/CLI/гибрида. Builtins `/help` (статика), `/skills`, `/commands`, `/summary`; шаблонные `.md` (`$ARGUMENTS`/`@file`); bundles; событие `command.invoked`; builtin-ответы — `Message.ephemeral`. Scope-API `/sessions|projects|settings/skills`; project-запись — owner/LEAD/admin (по аналогии с MCP, AD-071 §2.4).

**Состав UI:**
- **API-клиент** (`packages/ui/src/lib/api/synthApi.ts`): skills (`getSkills/getSkill/createSkill/updateSkill/deleteSkill/getSkillFiles/getSkillFile/putSkillFile/deleteSkillFile/reloadSkills`), commands (`getCommands`), bundles (CRUD `/skill-bundles`), scope (`getSessionSkills/updateSessionSkills/getSessionSkillsEffective`, `getProjectSkills/updateProjectSkills`, `getSkillsSettings/updateSkillsSettings/resetSkillsSettings`).
- **Стор** `stores/skillsStore.ts`: реестр + деталь, commands, bundles, instance-настройки (disabled/policy + дефолты), CRUD-экшены, загрузка/ошибки; счётчики `skillInvocationCounts`/`commandInvocationCounts` и последний вызов.
- **События**: `transportStore` слушает `skill.invoked`/`command.invoked` (AD-046 §8.2) и пишет в `skillsStore`.
- **Настройки** (`components/settings/`): user «Скиллы» (`SkillsUserSettings` — просмотр реестра/тела/supporting-файлов; недоверенные — только метаданные + бейдж; reload); admin «Скиллы» (`SkillsAdminSettings` + `SkillEditorForm` — CRUD `SKILL.md`+файлы, system enable/disable группами и точечно, policy); admin «Команды» (`CommandsSettings` — список команд с kind/scope/available + диагностика `shadowed`/`collision`, CRUD bundles). Категории `skills` (user) и `skillsAdmin`, `commands` (ADMIN) в `SettingsModal`.
- **Правая панель**: тумблеры скиллов в сессии (`SessionSettingsTab` — `getSessionSkills`/`updateSessionSkills { name, enabled }`) и проектный скоуп (`ProjectTab` — `ProjectSkillsBlock`, «Доступен»/«Включён по умолчанию») — по образцу MCP.
- **Статистика** (`StatsTab`): секция «Скиллы» (имя, scope/уровень, available, enabled сессии с причиной, unavailableReason, trusted, вклад токенов/оценка, source stable/session; блочные размеры `skills.catalog`/`skills.catalog.session` из манифеста); секция «Команды» — счётчики и последние вызовы из `skillsStore`.
- **`/`-автокомплит** (`components/chat/CommandAutocomplete.tsx` + интеграция в `ChatInput`): источник `GET /api/v2/commands`; kind/scope/description/`argument-hint`, бейдж `unavailable`; клавиатура ArrowUp/Down/Enter/Tab/Escape, клик, закрытие outside; подстановка `/name ` (не отправка); тач-таргеты по AD-044.

**Отклонения/решения UI-слоя:**
- Счётчики статистики — из live-событий `skill.invoked`/`command.invoked` в рамках жизни UI (персистентного хранилища нет; соответствует решению commit 1).
- `/compact`/`/review` — по-прежнему отложены; `allowed-tools` — advisory (см. commit 1).
- Runtime-импорты из `@itphx/synth-shared` в UI — только через subpath (`/types`, `/schemas`, `/i18n`, `/version`); value-импорт из корня тянет `config/loader` (`node:fs`) в браузерный бандл (инцидент commit 2, `import type` из корня безопасен).

---

**Решение:** ввести в Synth механизм **скиллов** (папка с `SKILL.md` + supporting-файлы) и **slash-команд** (встроенные, шаблонные и скиллы-как-команды). Скиллы — это переиспользуемые инструкции/процедуры, которые:
1. попадают в системный промпт **только каталогом** (`name` + краткое `description`) — progressive disclosure;
2. загружаются целиком по явному `/name` пользователя или вызовом core-тула `skill({name})`;
3. проходят **project-trust гейт** (недоверенные проектные скиллы видны, но не грузятся);
4. подчиняются гранулярным правам (AD-029) и capability-модели агентов.

Резолвинг команд — **в core**, единообразно для UI, CLI и гибрида (AD-042). Механизма в коде сейчас нет; переиспользуются подходы `~/dev/opencode` (`skill({name})`, discovery), `~/dev/hermes-agent` (progressive disclosure, trust-гейт, bundles) и хардкод-команды прототипа `~/dev/aic/t11` (`/help`, `/add_repo`, `/review`, `/commands`).

---

## 1. Контекст и проблема

Сегодня в Synth нет способа переиспользовать процедурное знание («как ревьюить API», «как писать миграции»), кроме как:
- вручную вставлять текст в сообщение;
- класть все инструкции в role-промпт агента (`engine/context/config.ts:321–351`, `getRolePrompt`) — раздувает промпт для всех сессий.

Что есть в референсах:

| Источник | Что даёт | Ограничение |
|---|---|---|
| `~/dev/aic/t11/synth/app/handlers/chat_handler.py` | хардкод `/help`, `/add_repo`, `/review`, `/commands`; парсинг `^/(\w+)(?:\s+(.*))?$` | команды зашиты в код, нет расширяемости |
| `~/dev/opencode` | `skill({name})` → `<skill_content>` + base dir + supporting-файлы; discovery `.opencode/{skill,skills}`, `~/.config/opencode`, `.claude/skills`, `.agents/skills`, `skills.paths`, `skills.urls`; скилл = команда | кэш требует рестарта; нет project-trust |
| `~/dev/hermes-agent` | `skills_list` → `skill_view` → file; trust-гейт (`skills trust|untrust`, ре-скан после `git pull`); bundles; inline shell выключен по умолчанию | Python-реализация, нет capability-модели |
| Архив форка (вне репозитория `synth/`): `archive/synth-frontend/src/stores/useSkillsStore.ts`, `useCommandsStore.ts`, `components/chat/CommandAutocomplete.tsx`, `SkillAutocomplete.tsx` | готовый UI-слой: сторы, автокомплит, вкладки, API-контракт `/api/config/skills\|commands`, `/api/magic-prompts` | UI без серверного механизма |

**Проблемы, которые решаем:**
- **Раздувание промпта.** Нельзя класть тела скиллов в системный промпт — только каталог с короткими описаниями.
- **Безопасность.** Скилл — это инструкции, исполняемые агентом (в т.ч. `` !`cmd` ``). Проектный скилл может быть подменён через `git pull` — нужен trust-гейт и ре-скан.
- **Единство путей входа.** `/review` должен одинаково резолвиться в UI, CLI и гибридном режиме; резолвинг в UI привёл бы к расхождению.
- **Capability-несоответствие.** Скилл может требовать `shell`, которого у read-only агента нет. Скилл должен быть виден («агент осведомлён о процессе»), но помечен недоступным, с указанием делегировать через `task`.
- **Кэш.** Изменение `SKILL.md` на диске должно подхватываться без перезапуска процесса (пробел opencode).

---

## 2. Решение

### 2.1. Поток

```
                          ┌──────────────────────────────────────────┐
  instance: {dataDir}/skills                                        │
  project:  {ws}/.synth/skills                                      │
  external (ro): .opencode/skills, .claude/skills, .agents/skills,  │
                 ~/.config/opencode/skills                          │
  config:  skills.paths, skills.urls                                │
                          └──────────────────┬───────────────────────┘
                                             ▼
              discovery ──► реестр скиллов (нормализация, валидация,
                            дедупликация по приоритету, trust-статус)
                                             │
                    ┌────────────────────────┴────────────────────────┐
                    ▼                                                 ▼
        уровень 1: КАТАЛОГ                              runtime-резолвинг
        (name + ≤60–100 символов description,            ┌─ /name (UI/CLI/гибрид)
         группировка по category)                        ├─ skill({name}) (LLM)
                    │                                     └─ /bundle-name (bundles)
                    ▼                                                 │
     system prompt: основная сессия (builder.ts)                      ▼
                    + саб-агенты (task.ts)               тело SKILL.md → <skill_content>
                    ─────────────────────►               + base dir + ≤10 файлов
     уровень 3: supporting files — по требованию         → ToolOutputStore: 50 KB / 2000 строк
```

### 2.2. Ключевые принципы

| Принцип | Формулировка |
|---|---|
| **Progressive disclosure** | Промпт получает только каталог; тело — по вызову; supporting-файлы — по требованию |
| **Один core-тул** | `skill({name, file_path?})` — встроенный тул ядра; скиллы **не регистрируют** тулы |
| **Единый резолвинг** | `/`-команды разбираются в core (UI/CLI/гибрид — тонкие клиенты) |
| **Trust по умолчанию** | Проектные скиллы недоверенного каталога видны, но не загружаются |
| **Capability-aware** | Скилл виден при нехватке capability, но помечен недоступным + делегирование |
| **Права как у тулов** | allow/deny/ask + glob, наследование саб-агентами (AD-029) |
| **Read-only до явного действия** | Никакого кода до подтверждения пользователя; inline shell выключен по умолчанию |

---

## 3. Формат `SKILL.md`

### 3.1. Общие правила

- Файл — Markdown с YAML frontmatter (`---` … `---` в начале).
- Frontmatter-парсер **толерантен к неизвестным ключам**: не ошибка, а запись в metadata/игнор. Это обеспечивает совместимость с Anthropic/opencode/Claude Code.
- Тело — свободный Markdown; относительные пути (`references/`, `scripts/`, `assets/`) считаются от base dir скилла (каталога с `SKILL.md`).

### 3.2. Поля

| Поле | Группа | Обяз. | Тип / формат | Назначение |
|---|---|---|---|---|
| `name` | Synth core | ✅ | string, 1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`, **совпадает с именем каталога** | Уникальный id скилла; при несовпадении — ошибка discovery |
| `description` | Synth core | ✅ | string, 1–1024 | Что делает; в каталоге обрезается до ~60–100 символов |
| `license` | Anthropic/opencode | — | string | Лицензия содержимого |
| `compatibility` | Anthropic/opencode | — | string | Совместимость (напр. `synth>=0.1`) |
| `metadata` | Anthropic/opencode | — | object | Свободный контейнер; толерантен к любым ключам |
| `allowed-tools` | Claude Code | — | string \| string[] | Рекомендуемый whitelist тулов; транслируется в deny-политику скилла |
| `when_to_use` | Claude Code | — | string | Подсказка модели, когда применять (в отличие от `description`) |
| `model` | Claude Code | — | string | Предпочтительная модель для скилла |
| `agent` | Claude Code | — | string | Предпочтительный агент-исполнитель |
| `argument-hint` | Claude Code | — | string | Плейсхолдер аргументов в `/`-автокомплите |
| `user-invocable` | Claude Code | — | boolean, default `true` | `false` — скилл отсутствует в `/`-автокомплите |
| `disable-model-invocation` | Claude Code | — | boolean, default `false` | `true` — скилл отсутствует в каталоге для модели |
| `metadata.synth.tags` | Synth | — | string[] | Теги для поиска/каталога (AD-068) |
| `metadata.synth.category` | Synth | — | string | Категория для группировки в каталоге |
| `metadata.synth.related_skills` | Synth | — | string[] | Связанные скиллы |
| `metadata.synth.requires_capabilities` | Synth | — | `ToolCapability[]` | Требуемые возможности агента (`packages/shared/src/types/tools.ts:3–16`) |
| `metadata.synth.requires_toolsets` | Synth | — | string[] | Именованные группы тулов (напр. `git`, `web`, `mcp:<server>`) |
| `metadata.synth.fallback_for_capabilities` | Synth | — | `ToolCapability[]` | Для каких возможностей скилл является fallback-инструкцией |
| `metadata.synth.agents` | Synth | — | string[] | Привязка к agent id; **пусто = все агенты** |
| `metadata.synth.groups` | Synth | — | string[] | Привязка к категориям/группам агентов |
| `metadata.synth.scope` | Synth | — | `'instance' \| 'project'` | Декларативная подсказка; фактический scope — от источника |
| `metadata.synth.trigger` | Synth | — | `'manual' \| 'auto'` | Подсказка авто-применения (не является разрешением) |
| `metadata.synth.command` | Synth | — | string | Имя `/`-команды, если отличается от `name` |
| `metadata.synth.mode` | Synth | — | `'plan' \| 'act' \| 'any'` | Применимость по режиму сессии (AD-025) |

### 3.3. Пример

```markdown
---
name: api-contract-review
description: Проверяет изменения публичного API на обратную совместимость и полноту контракта.
license: MIT
compatibility: synth>=0.1
allowed-tools: [read_file, grep_files, git_diff]
when_to_use: When a public API route or a shared type is modified.
model: local.qwen3:14b
agent: reviewer
argument-hint: "[path/to/contract]"
user-invocable: true
disable-model-invocation: false
metadata:
  synth:
    tags: [api, review, backward-compatibility]
    category: quality
    related_skills: [contract-testing]
    requires_capabilities: [file_read, search, git_read]
    requires_toolsets: [git]
    fallback_for_capabilities: [file_write]
    agents: []          # пусто = все агенты
    groups: [review]
    scope: project
    trigger: manual
    command: api-review
    mode: plan
---

# API Contract Review

## Когда применять
Публичный маршрут или общий тип в `packages/shared` изменён.

## Шаги
1. Прочитай diff: `git_diff`.
2. Сверь сигнатуры с `references/checklist.md`.
3. Запусти `scripts/check-openapi.ts` (если есть контракт).
4. Верни отчёт: breaking / non-breaking / требует версии.

## Supporting files
- `references/checklist.md`
- `scripts/check-openapi.ts`
```

**Валидация:** при загрузке проверяются `name` (regex + совпадение с каталогом) и `description`. Невалидный скилл не попадает в реестр; ошибка видна в логах и в `GET /api/v2/skills?diagnostics=1` (не ломает discovery остальных).

---

## 4. Discovery, скоупы, приоритет, project-trust

### 4.1. Скоупы

| Scope | Каталог | Права | Запись |
|---|---|---|---|
| `instance` | `{dataDir}/skills` | общие для инстанса | через API/админку |
| `project` | `{project.workspace}/.synth/skills` | принадлежат проекту | напрямую/через API |

### 4.2. Дополнительные источники

| Источник | Тип | Примечание |
|---|---|---|
| `skills.paths` (config) | каталоги | пользовательские, read-write |
| `skills.urls` (config) | удалённые каталоги | opencode-совместимый `index.json`, скачивание в кэш |
| `.opencode/skills`, `.opencode/skill` | внешний | read-only discovery |
| `.claude/skills` | внешний | read-only discovery |
| `.agents/skills` | внешний | read-only discovery |
| `~/.config/opencode/skills` | внешний | read-only discovery |

Внешние источники — **только discovery** (совместимость), изменять их через Synth API нельзя.

Локальные каталоги агентов-совместимости (`.opencode/skills`, `.opencode/skill`, `.claude/skills`, `.agents/skills`, `~/.config/opencode/skills`) — read-only discovery **механизма** (AD-046), реализовано. Каталоги в `project.workspace` наследуют project-trust (§4.4), `~/.config/opencode/skills` — trusted.

`skills.urls` — **только read-only индексация**: opencode-совместимый `index.json` и `<base>/<path||name>/SKILL.md` скачиваются в `{dataDir}/skills-cache/urls/<sha1(url)[:16]>` (атомарная запись tmp→rename, AD-005), видны в реестре/диагностике, но `trusted: false`: в каталог для модели не попадают, тело не грузится. Сеть — только `http(s)`, SSRF-guard (loopback/private/link-local/ULA/`*.local`, проверка каждого редиректа). Ошибки — диагностикой (`remote`/`read-error`), старый кэш не затирается. **Установка/доверие/подписи/`lock.json` — AD-068** (здесь не реализуются); **удалённые каталоги-реестры** (github/well-known/skills.sh и т.п.) — тоже AD-068, по умолчанию включение явное.

### 4.3. Приоритет

При совпадении имён: **project > instance > external, first-wins**. Побеждает первое вхождение по порядку источников; проигравшие не перезатирают, но фиксируются в диагностике как `shadowed`.

```
project ({ws}/.synth/skills)
  └─ instance ({dataDir}/skills)
       └─ config skills.paths
            └─ external (.opencode, .claude, .agents, ~/.config/opencode)
                 └─ config skills.urls (кэш)
```

### 4.4. Project-trust гейт (безопасность)

- Проектные скиллы из **недоверенного** каталога **видны в реестре, но не загружаются**: не попадают ни в каталог для модели, ни в `skill`-тул, ни в `/`-автокомплит (либо помечены «недоверенный» в UI — см. AD-068).
- Доверие выдаётся явно: `synth skills trust-project <dir>` / `synth skills untrust-project <dir>`; хранится в `skills.trustedProjectDirs` (config).
- Это **доверие к локальному проектному каталогу** (бинарное trusted/untrusted, механизм AD-046). Ортогональная иерархия trust-уровней **источников/записей реестра** (`builtin`/`verified`/`trusted`/`community`/`agent-created`, install-policy) и команда `synth skills trust <source> --level` — [AD-068](./ad-068-skills-agents-registry.md); не путать одно с другим.
- **Ре-скан при изменении:** watcher отслеживает `SKILL.md`/файлы скиллов; после `git pull` (или любого изменения mtime/содержимого) trust-статус пересчитывается, содержимое перечитывается. Это защита от инъекции инструкций через обновление репозитория.

```yaml
# config.yaml
skills:
  paths:
    - ~/my-skills
  urls:
    - https://example.com/skills
  trustedProjectDirs:
    - /home/user/work/trusted-project
  inlineShell: false        # !`cmd` в шаблонных командах — выключено по умолчанию

tools:
  skill: true               # глобальный тумблер core-тула skill
```

### 4.5. Уровни и включение скиллов (модель AD-071)

Скиллы используют ту же модель уровней и включения, что и MCP ([AD-071](./ad-071-mcp-servers-prompt.md) §2.4/§2.9), не дублируя её.

**Уровни** (уточняют scope §4.1):

| Уровень | Кто управляет | Скоуп | По умолчанию |
|---|---|---|---|
| **System** | admin (instance) | все сессии и проекты | включён; пользователь может отключить в своей сессии |
| **Project** | owner/lead | все сессии проекта | включается owner/lead «по умолчанию для проекта» |
| **Session** | пользователь | одна сессия | личные/разовые скиллы |

Merge — `system ∪ project ∪ session`; при конфликте имён приоритет `system > project > session` (жёстко). `metadata.synth.scope` (`instance`/`project`, §3.2) — декларативная подсказка; фактический уровень задаёт источник/реестр.

**Реестр и источник.** Запись скилла несёт уровень и происхождение (`system`/`project`/`session`, `builtin`/`installed`/…); trust — по [AD-068](./ad-068-skills-agents-registry.md). Отключённый скилл **не исчезает** из реестра и диагностики: помечается `disabled` с причиной (уровень, opt-out), по аналогии с MCP (§2.4 AD-071).

**Включение/отключение.** Enable/disable на уровне `system` (admin, instance-wide), `project` (owner/lead) и `session` (пользователь). Отключать можно **группами** (`metadata.synth.category` / `metadata.synth.groups`) и **отдельными** скиллами (`name`); семантика — как у `tools.disabled` (AD-071 §2.9): union групп и точечных имён, а механизм (резолвинг `/`-команд, core-тул `skill`) неотключаем. Per-skill permissions AD-029 (`deny` скрывает) остаются отдельным механизмом.

**Представление в промпте.** Каталог скиллов — отдельный слой промпта с тирами AD-070:
- **стабильная часть** — скиллы, включённые на уровне `system`/`project` (состав константен на сессию) → `stable`, не инвалидирует кэш;
- **volatile-часть** — динамика: скиллы, включённые/отключённые в `session`, изменение состава после re-scan/`git pull`, маркеры `unavailable` → `volatile`/`context`.

Тело скилла (уровень 2, §5) в промпт не попадает — только каталог. Это распространяет правило AD-071 §2.1 («встроенное — `stable`, динамическое — `volatile`») на скиллы.

**Связь с AD-071/AD-068.** AD-071 задаёт уровни/включение и раскладку инструментов; AD-046 применяет ту же модель к скиллам; AD-068 владеет каталогом, доверием и установкой (см. AD-068 §8.1).

---

## 5. Доставка — progressive disclosure

### Уровень 1 — каталог в системном промпте

- Формат строки: `name` + обрезанный `description` (**~60–100 символов**) + при необходимости маркер недоступности.
- Группировка по `metadata.synth.category`.
- Добавляется:
  - в основную сессию — `engine/context/builder.ts:42–132` (`buildSystemPrompt`);
  - в саб-агентов — `engine/tools/task.ts` (там промпт собирается через `resolveSubagentPrompt`, **не** через `buildSystemPrompt`; см. `task.ts:84, 219–228` и `task-resume.ts:206`).
- Каталог учитывает binding агента и capabilities; при пустом списке доступных скиллов секция не добавляется. Тир каталога (`stable`/`volatile`) и правила включения — §4.5.

Секция каталога собирается в `orchestrator.ts:798–836` (после CLASSIFICATION, gateway, plan- и session-context-блоков). Если задан `session.settings.systemPrompt` override — он **заменяет** собранный промпт; каталог в этом случае не добавляется (сохраняем текущую семантику override).

### Уровень 2 — тело скилла

Два равнозначных входа:

| Вход | Кто инициирует | Поведение |
|---|---|---|
| `/name` (аргументы) | Пользователь (UI/CLI/гибрид) | core-резолвер подставляет тело в сообщение как явный контекст |
| `skill({name, file_path?})` | Модель | core-тул возвращает `ToolResult` |

Возврат тула `skill` (по образцу opencode):

```
<skill_content name="api-contract-review">
# Skill: api-contract-review

<тело SKILL.md>

Base directory for this skill: file:///.../.synth/skills/api-contract-review
Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.
<skill_files>
<references/checklist.md>
<scripts/check-openapi.ts>
</skill_files>
</skill_content>
```

- **До 10 supporting-файлов** в `<skill_files>` (пути, не содержимое).
- Обрезка результата — через `ToolOutputStore`: **50 KB / 2000 строк** (как у прочих тулов).
- `file_path` позволяет точечно прочитать supporting-файл без повторной загрузки тела.

### Уровень 3 — supporting files

`references/`, `scripts/`, `assets/` читаются по требованию через `read_file` или `skill({name, file_path})`. В промпт/каталог они не попадают.

---

## 6. Invocation и binding

### 6.1. Invocation

`invocation` вычисляется из двух совместимых флагов:

| `user-invocable` | `disable-model-invocation` | `invocation` | В каталоге для модели | В `/`-автокомплите |
|---|---|---|---|---|
| `true` (default) | `false` (default) | `both` | ✅ | ✅ |
| `true` | `true` | `user` | ❌ | ✅ |
| `false` | `false` | `model` | ✅ | ❌ |
| `false` | `true` | `none` | ❌ | ❌ (диагностика) |

### 6.2. Binding (ортогонально scope)

| Поле | Значение по умолчанию | Назначение |
|---|---|---|
| `metadata.synth.agents` | все агенты | Явная привязка к agent id |
| `metadata.synth.groups` | все группы | Привязка к категориям агентов |

Явная привязка нужна в первую очередь для **глобальных instance-скиллов**, чтобы сузить каталог для конкретных агентов и не засорять промпты. Проектный скилл по умолчанию доступен всем агентам проекта.

### 6.3. Capability-aware и делегирование

Если агенту не хватает `requires_capabilities`:
- скилл **остаётся видимым** в каталоге (агент «осведомлён о процессе»), но помечается `unavailable`;
- `skill({name})` возвращает не тело, а действие-делегирование:

> «Для скилла `db-migration` нужны capabilities: `shell`, `file_write`; у агента `reviewer` их нет. Вызови `task` с агентом `developer`.»

- Проверка доступности опирается на `getToolsForAgent` (`engine/agents/registry.ts:53–61` — фильтр тулов по capabilities).

---

## 7. Slash-команды и bundles

### 7.1. Резолвинг в core

Разбор `/`-команд выполняется в core **до** обращения к LLM, единообразно для UI, CLI и удалённых сессий в гибриде (AD-042). UI/CLI лишь передают исходное сообщение; автокомплит — подсказка клиента.

Источник вдохновения — t11: шаблон `^/(\w+)(?:\s+(.*))?$` (`chat_handler.py:125–139`), диспетчеризация в начале обработки сообщения (`chat_handler.py:505–514`).

### 7.2. Три вида команд

| Вид | Пример | Описание |
|---|---|---|
| **Встроенные продуктовые** | `/help`, `/skills`, `/commands`, `/compact`, `/summary`, `/review` | Реализованы в core, не расширяются конфигом |
| **Шаблонные `.md`-команды** | пользовательские файлы команд | opencode-совместимые подстановки: `$ARGUMENTS`, `@file`, `` !`cmd` `` |
| **Скиллы как команды** | `/api-review` | Команда резолвится в загрузку тела соответствующего скилла (уровень 2) |

`/help` — RAG-команда, зависит от памяти D2 (отдельная задача) → **Фаза 2**.

### 7.3. Bundles

Bundle — YAML-группа скиллов; `/bundle-name` грузит N скиллов одним сообщением (модель hermes, `agent/skill_bundles.py`):

```yaml
name: backend-dev
description: Backend feature work — code review, testing, PR workflow.
skills:
  - github-code-review
  - test-driven-development
instruction: |
  Дополнительная инструкция над телами скиллов (опционально).
```

- **Bundle побеждает одноимённый skill** при резолвинге (осознанный приоритет).
- Файлы bundle — в каталоге bundles под `dataDir` (единый dataDir, AD-045), API — `/api/v2/skill-bundles`.

### 7.4. Inline shell `` !`cmd` ``

- **По умолчанию выключено** (`skills.inlineShell: false`).
- При включении: только через `execute_shell` + `PermissionEvaluator` (AD-029), с timeout и лимитом вывода, с аудитом.
- Обоснование: `` !`cmd` `` — прямой **RCE-вектор** в проектном контенте; включение должно быть явным действием пользователя/администратора. Недоверенные проектные скиллы с inline shell не исполняются даже при включённом флаге.

---

## 8. Права и аудит

### 8.1. Permissions

- **Per-skill permissions**: `allow` / `deny` / `ask` + glob-паттерны (по имени скилла/команды), расширение модели AD-029.
- **Наследование саб-агентами**: дочерняя сессия получает права родителя + собственные deny (через `deriveSubagentSessionPermission`, `engine/permission/derive.ts`).
- `deny` **скрывает** скилл из каталога (в отличие от capability-unavailable, где скилл виден).
- Глобальный тумблер `tools.skill: false` полностью отключает тул `skill` (и, соответственно, model-invocation).
- `allowed-tools` из frontmatter — рекомендательный whitelist; ужесточение идёт через `PermissionEvaluator` (`engine/permission/evaluator.ts`).

### 8.2. События

| Событие | Момент | Данные |
|---|---|---|
| `skill.invoked` | Загрузка тела скилла (`/name` или `skill`) | `{ session_id, name, source: user\|model, scope, agent }` |
| `command.invoked` | Резолвинг `/`-команды (встроенной/шаблонной/bundle) | `{ session_id, command, args, actor: user\|cli }` |

Публикуются в `SessionEventBus` рядом с `tool_call.started` (`engine/orchestrator.ts:1135`). Используются для аудита, метрик и UI-подсветки.

### 8.3. Runtime и данные

- **FS-watch инвалидация кэша:** изменение `SKILL.md`/supporting-файла → пере-чтение и пересборка каталога без рестарта (закрываем пробел opencode).
- **Единый dataDir** (AD-045): instance-скиллы, bundles и кэш `skills.urls` живут в `{dataDir}`, не зависят от сервера.

---

## 9. API / UI / CLI

### 9.1. Core API

| Метод / путь | Назначение |
|---|---|
| `GET /api/v2/skills` | Реестр (с учётом trust-статуса, `?diagnostics=1`) |
| `POST /api/v2/skills` | Создать скилл (instance) |
| `GET/PATCH/DELETE /api/v2/skills/:name` | Чтение/правка/удаление |
| `GET/PUT /api/v2/skills/:name/files/*` | Supporting-файлы |
| `GET /api/v2/skills/catalog` | Публичный каталог для контент-платформы (стык с AD-068) |
| `GET /api/v2/commands` | Список команд (встроенные + шаблонные + скиллы) |
| `GET/POST/PATCH/DELETE /api/v2/skill-bundles[/:name]` | Bundles |

### 9.2. Backend (managed)

Админка instance-скиллов под RBAC `ADMIN` (аналогично провайдерам/моделям). Публичные эндпоинты каталога — для AD-068.

### 9.3. UI

Переиспользовать архивный слой форка (вне репозитория `synth/`):
- `archive/synth-frontend/src/stores/useSkillsStore.ts`, `useSkillsCatalogStore.ts`, `useCommandsStore.ts`;
- `archive/synth-frontend/src/components/chat/CommandAutocomplete.tsx`, `SkillAutocomplete.tsx`;
- контракт `/api/config/skills|commands`, `/api/magic-prompts` — переложить на `/api/v2/skills|commands`.
- Вкладки: commands / agents / files; автокомплит по `/`; маркеры trust/unavailable.

### 9.4. CLI

Перехват `/`-команд в REPL `packages/synth/src/cli.ts:596` (`startRepl`): строка, начинающаяся с `/`, уходит в core-резолвер, а не в LLM.

### 9.5. Встроенный мета-скилл `skill-creator`

Скаффолдер `SKILL.md`: генерирует frontmatter, **обязательно** запрашивает требуемые тулы/capabilities и создаёт структуру supporting-файлов. Референсы: `innokod/.opencode/skills/skill-creator`, `mattpocock/writing-great-skills`.

**Реализация (builtin-скилл-инструкция, 2026-09-24).** В отличие от исходного проекта, `skill-creator` не является core-тулом записи и не сидится на ФС: это **builtin-скилл**, объявленный в коде (`packages/core/src/engine/skills/builtin.ts`) как TS-константа — без нового asset-каталога и дублирования ассетов (AD-038). Агент создаёт **проектные** скиллы существующими file-тулами в `{project.workspace}/.synth/skills/<name>/SKILL.md`; instance-скиллы — только через ADMIN API/UI (`POST /api/v2/skills`), в обход ФС.

- `BUILTIN_SOURCE` — синтетический `SkillSource` (`scope: 'instance'`, `level: 'system'`, `origin: 'instance'`, `trusted: true`); `dir` — маркер `.builtin`, на ФС не читается.
- `buildBuiltinSkills({ dataDir })` → `DiscoveredSkill[]` с `name: 'skill-creator'`, meta (`userInvocable: true`, `disableModelInvocation: false`, `command: 'skill-creator'`, `requiresCapabilities: [file_read, file_write]`), телом-инструкцией (EN), `trusted: true`, `mtimeMs: 0`.
- `SkillRegistryOptions.builtin` подмешивает builtin **первым** entry в `list()` (до источников с ФС) → system-приоритет, не перекрывается project/instance (`shadowed`-диагностика для одноимённых). `reload()` builtin не трогает.
- `SkillService` передаёт builtin в реестр; скилл виден в `GET /api/v2/skills`/каталоге, грузится core-тулом `skill` и резолвится как `/skill-creator` (skill-команда).

---

## 10. Точки интеграции в коде

Фактические пути после Фазы 1 (✅ — реализовано, ⏳ — Фаза 2/3):

| Файл | Сущность | Статус |
|---|---|---|
| `packages/shared/src/types/skills.ts` | `SkillMeta/Summary/Detail/Diagnostic`, invocation/scope/level, capability-требования | ✅ |
| `packages/shared/src/skills/frontmatter.ts` | Толерантный `parseFrontmatter` + `stringifyFrontmatter` (js-yaml в shared) | ✅ |
| `packages/shared/src/types/index.ts` | `EventType` + `skill.invoked`/`command.invoked`; `SessionSettings.skills\|skillsDisabled`; `AgentDefinition.groups?` | ✅ |
| `packages/shared/src/schemas/index.ts` | Zod-схемы create/update/files/session-override | ✅ |
| `packages/shared/src/config/types.ts`, `defaults.ts` | Секция `skills.paths\|trustedProjectDirs\|inlineShell` (`skills.urls` — Фаза 3) | ✅ |
| `packages/shared/src/i18n/index.ts` | Ключи `skill.*` (AD-041) | ✅ |
| `packages/core/src/engine/skills/{types,scope,trust,parser,discovery,watcher,registry,catalog,loader,service}.ts` | Discovery/реестр/каталог/загрузка/CRUD-сервис | ✅ |
| `packages/core/src/storage/skill-store.ts` | Instance-дерево `{dataDir}/skills/<name>/`, атомарная запись tmp→rename (AD-005) | ✅ |
| `packages/core/src/engine/tools/skill.ts`, `engine/tools/index.ts` | Core-тул `skill` + регистрация в `ALL_BUILTIN_TOOLS` | ✅ |
| `packages/core/src/engine/context/composer.ts` | Блоки `skills.catalog` (stable) и `skills.catalog.session` (volatile) + labels; каталог не добавляется при `session.settings.systemPrompt` override | ✅ |
| `packages/core/src/engine/orchestrator.ts` | `_collectSkillsCatalog` в `getPromptInfo`/`_processMessage`; `ToolContext.extra.skillRuntime`; публикация `skill.invoked` рядом с `tool_call.started` | ✅ |
| `packages/core/src/engine/tools/task.ts`, `task-resume.ts` | Каталог саб-агентам — приклейка к `llmSystemPrompt` (binding родителя, capabilities саб-агента) | ✅ |
| `packages/core/src/engine/permission/evaluator.ts` (`resolveSkillRule`), `derive.ts` | Per-skill allow/deny/ask + glob; наследование саб-агентами | ✅ |
| `packages/core/src/server/routes/skills.ts`, `server/app.ts` | `/api/v2/skills[/:name]`, `/files/*`, `/reload` | ✅ |
| `packages/backend/src/app.ts` | Переиспользование core-фабрики + RBAC `ADMIN` на запись, `SkillService` в оркестраторе | ✅ |
| ~~`engine/context/builder.ts` (`buildSystemPrompt`)~~ | Каталог теперь в `SystemPromptComposer` (AD-070), а не в builder | заменено |
| `packages/core/src/engine/commands/` (resolver/builtin/template), `/skill-bundles` | Slash-команды и bundles | ⏳ Фаза 2 |
| `packages/ui/src/` (сторы/автокомплит), `packages/synth/src/cli.ts` (`startRepl`) | UI-слой и перехват `/` в REPL | ⏳ Фаза 2 |
| `engine/skills/builtin.ts` — builtin `skill-creator` (`BUILTIN_SOURCE`, `buildBuiltinSkills`) + `registry.ts` (`builtin`) | Встроенный мета-скилл-инструкция | ✅ Фаза 3 (часть) |
| `engine/skills` — `skills.urls`, inline shell | Расширения | ⏳ Фаза 3 (inline shell) |

**Новые модули core Фазы 1:** `engine/skills/` (discovery, parser, registry, catalog, loader, service, watcher, scope, trust), `storage/skill-store.ts`, `engine/tools/skill.ts`. Модуль `engine/commands/` (resolver, builtin, template, bundles) — Фаза 2 (не создан).

---

## 11. Связь с AD-068 и другими AD

| AD | Связь |
|---|---|
| [**AD-068**](./ad-068-skills-agents-registry.md) | Реестр и каталог скиллов/агентов как контент-платформа. AD-046 — механизм исполнения; AD-068 — доверие (trust-уровни источников), guard-уровни, публикация/каталог, install-policy, `GET /api/v2/skills/catalog` |
| [AD-025](./ad-025-plan-act-toggle.md) | `metadata.synth.mode` — применимость скилла к plan/act |
| [AD-029](./ad-029-granular-permissions.md) | Per-skill allow/deny/ask + glob; наследование; `deny` скрывает скилл |
| [AD-035](./ad-035-micro-model-first.md) | Микро-слой может маршрутизировать «`/name` → скилл» без LLM |
| [AD-036](./ad-036-llm-gateway.md) | Тела скиллов проходят через LLM Gateway (guard/обфускация/аудит) |
| [AD-039](./ad-039-plan-in-project.md) | Скиллы — не план и не todo; взаимодействуют через инструменты, не через состояние |
| [AD-042](./ad-042-hybrid-mode.md) | Резолвинг команд в core → одинаков в локальном и удалённом мире |
| [AD-045](./ad-045-hybrid-server-profiles.md) | Единый dataDir для instance-скиллов/bundles/кэша |
| [AD-071](./ad-071-mcp-servers-prompt.md) | Модель уровней `system`/`project`/`session`, enable/disable группами/точечно, стабильный каталог vs volatile — переиспользована для скиллов (§4.5) |

---

## 12. Фазы реализации и тесты

### Фаза 1 — ядро

- Парсер `SKILL.md` + Zod-схема (толерантная к неизвестным ключам), валидация `name`/`description`.
- Discovery (instance/project/external/config paths), приоритет, дедупликация, диагностика.
- Project-trust гейт + FS-watch инвалидация.
- Реестр, каталог в промпт (основная сессия + саб-агенты), capability-aware/binding.
- Core-тул `skill` (тело + base dir + ≤10 файлов, обрезка `ToolOutputStore`), `tools.skill` тумблер.
- Core API `/api/v2/skills[/:name]` + файлы.

### Фаза 2 — команды и bundles

- Резолвер `/`-команд в core, встроенные продуктовые команды.
- Шаблонные `.md`-команды (`$ARGUMENTS`, `@file`).
- Bundles + API `/api/v2/skill-bundles`.
- `/help` (RAG) — после готовности памяти D2.
- CLI-перехват `/` в REPL; UI-автокомплит.

### Фаза 3 — расширения

- `skills.paths`/`skills.urls` (удалённые каталоги) — ✅ (часть, read-only).
- Встроенный `skill-creator` — ✅ (builtin-скилл-инструкция, §9.5).
- Inline shell (opt-in, через `execute_shell` + AD-029).
- Backend-админка (RBAC) и стык с каталогом AD-068.

### Тесты (Vitest)

| Область | Что проверяем |
|---|---|
| Парсер | frontmatter, неизвестные ключи, `name` regex, несовпадение с каталогом, границы 1/64 и 1/1024 |
| Discovery/приоритет | project > instance > external, first-wins, `shadowed`-диагностика |
| Project-trust | untrusted не в каталоге/туле; trust-project/untrust-project; ре-скан после изменения |
| Тул `skill` | `<skill_content>` + base dir + ≤10 файлов; обрезка 50 KB/2000 строк; `file_path` |
| Capability-aware | видимость при нехватке capability; сообщение делегирования через `task` |
| Invocation/binding | четыре комбинации флагов; `agents`/`groups` по умолчанию — все |
| Команды | встроенные, шаблонные `$ARGUMENTS`/`@file`, приоритет bundle > skill |
| Bundles | парсинг YAML, `/bundle-name` грузит N скиллов |
| Inline shell | выключено по умолчанию; при включении — только `execute_shell` + permissions |
| Builtin `skill-creator` | виден в реестре/каталоге, trusted, `load()` отдаёт тело, `/skill-creator` резолвится, не перекрывается project/instance |
| Права/события | `deny` скрывает, `ask` спрашивает, наследование; `skill.invoked`/`command.invoked` |

---

## 13. Что НЕ делаем

- **Регистрация тулов скиллами.** Скиллы — инструкции; новых тулов не создают. Тул один — `skill`.
- **Произвольный код из скилла.** `scripts/` — файлы для чтения/запуска агентом через обычные тулы, не autoload-плагины.
- **Автозагрузка недоверенного.** Проектные скиллы без trust не грузятся (видны — да, исполняются — нет).
- **Inline shell по умолчанию.** `` !`cmd` `` включается только явно.
- **Резолвинг команд в UI.** Только core.
- **ClawHub и подобные публичные реестры** — вне рамок; контент-платформа — AD-068.
- **Автоматическое доверие «своему» репозиторию** — trust выдаётся явно, не по факту наличия `.git`.

---

## 14. Открытые вопросы

1. **Формат `skills.urls`** — строго opencode `index.json` или допускаем git-источники/архивы?
2. **`requires_toolsets`** — фиксированный словарь групп или произвольные имена, маппящиеся на capabilities конфигом?
3. **Кэш удалённых каталогов/индекса** — TTL, версионирование и офлайн-поведение относятся к реестру: см. [AD-068](./ad-068-skills-agents-registry.md) §3 и §11.6.
4. **Приоритет bundle vs встроенная команда** — сейчас bundle побеждает только одноимённый skill; нужен ли приоритет над встроенными?
5. **UI недоверенных скиллов** — показывать контент read-only или только метаданные до trust (граница с [AD-068](./ad-068-skills-agents-registry.md))?
6. **Наследование binding в саб-агентах** — каталог саб-агента фильтруется по parent binding или по binding самого саб-агента?
7. **`allowed-tools`** — делать мягким whitelist (advisory) или автоматически транслировать в deny по AD-029?
