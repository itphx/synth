# AD-069: Проектные инструкции (AGENTS.md) и `/init`

> **Статус:** ✅ Реализовано (Фазы 1–3, 2026-09-24; остатки R1–R4, 2026-10-01). Отклонения: глобальные instruction-файлы (`~/.config`, `~/.claude`) не читаются (покрыто тиром identity); `config.instructions.sources` — список источников с `position: before|after`; URL-источники — fetch при старте + TTL-кэш без фонового таймера; кап динамический от окна модели; скилл `synth-agents-md` использует команду `/agents-md` во избежание конфликта с builtin `/init`; `/init` реализован как builtin-команда со статусом `prompt`. R1–R4: общий trust-гейт для lazy-догрузки; авто-trust workspace внутри `workspacesRoot`; CLI-флаги `--ignore-rules`/`--safe-mode` (+ env `SYNTH_IGNORE_RULES`) реально реализованы для `serve`/`chat`. R5 (кэш/инвалидация, 2026-10-01): общий с AD-046 helper подписей `engine/file-signature.ts`, результатный кэш резолвера по подписи и per-turn мемоизация в оркестраторе.
> **Дата:** 2026-09-17
> **Парные документы:**
> - [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — механизм скиллов и `/`-команд, в рамках которого реализуется встроенная команда `/init` и скилл `synth-agents-md`;
> - [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — источник модуля защиты от indirect prompt injection (`engine/security/prompt-injection.ts`), переиспользуемого для threat-scan проектных инструкций;
> - [AD-040](./ad-040-sessions-without-project.md) «Сессии без проекта» — проектный контекст существует только при наличии `project.workspace`, сессия без проекта инструкции репозитория не грузит.

**Решение:** ввести в Synth **автоматическую загрузку проектных инструкций** — репозиторных файлов-руководств (`AGENTS.md`, `AGENTS.override.md`, совместимо `CLAUDE.md`, deprecated `CONTEXT.md`), по образцу opencode и hermes-agent:

1. **Discovery** от `project.workspace` вверх до git-root (`git root → … → cwd`, глубже = приоритетнее), с приоритетом override над базовым файлом и дедупликацией идентичного контента.
2. **Merged chain** — все найденные файлы цепочки объединяются в системный промпт с provenance-заголовком (относительный путь), под общим капом.
3. **Lazy-догрузка** вложенных инструкций по аргументам file/shell-тулов — **в tool result**, а не в system prompt (сохраняет prompt-cache).
4. **Обрезка** head/tail с маркером и точным путём для `read_file`; динамический кап от окна модели.
5. **Threat-scan** перед вставкой через существующий модуль AD-036; при срабатывании контент не грузится или помечается.
6. **Install-tree guard** — каталог внутри исходников Synth не становится проектным контекстом (dev-режим).
7. **Встроенные `/init`** (механизм AD-046) и **скилл `synth-agents-md`** — генерация/обновление/аудит `AGENTS.md`.
8. **Прозрачность** — UI показывает, какие instruction-файлы загружены, откуда и как обрезаны.

---

## 1. Контекст и проблема

Сегодня Synth **не знает конвенций репозитория**. Агенту в системный промпт попадают:
- role-prompt агента (`engine/context/config.ts:321`, `getRolePrompt`);
- instance-файлы `SOUL.md`, `COMPANY.md`, `ABOUT.md` (`config.ts:64`, грузятся в `builder.ts:95–97,152–184`);
- внутренний проектный файл `{projectDataDir}/{projectName}/info.md` (`builder.ts:217–231`) — это **не** репозиторный `AGENTS.md`, а данные, заведённые через Synth.

Репозиторные `AGENTS.md` / `CLAUDE.md` / `.cursorrules` **не обнаруживаются и не грузятся вообще**. Итог: агент угадывает команды сборки/тестов, нарушает локальные конвенции, повторяет ошибки, которые автор репозитория уже задокументировал.

Что делают референсы:

| Источник | Глобально | Проектно | Подкаталоги | Обрезка / безопасность |
|---|---|---|---|---|
| **opencode** (`session/instruction.ts`, 237 строк) | `{global.config}/AGENTS.md` → `~/.claude/CLAUDE.md` (first existing wins) | `AGENTS.md` → `CLAUDE.md` → `CONTEXT.md` (deprecated); `findUp` от cwd до worktree, **first project-level match wins** | Ленивая догрузка при чтении файла тулом `read`: вверх от каталога файла, один раз на assistant-сообщение, дедуп (`claims`), исключение уже загруженных (`.loaded`) и системных (`sys.has`) | Обрезки/threat-scan в этом файле нет; `config.instructions` — доп. пути/glob/`~/`/абсолютные **и URL** (fetch, timeout 5000 мс) |
| **hermes-agent** (`agent/prompt_builder.py`, `agent/subdirectory_hints.py`) | `SOUL.md` из `$HERMES_HOME` — всегда и независимо | first-match-wins **между типами**: `.hermes.md`/`HERMES.md` → `AGENTS.md`/`agents.md` → `CLAUDE.md` → `.cursorrules`; `AGENTS.md` — **merged chain** `git root → … → cwd`, на каталог `AGENTS.override.md` > `AGENTS.md` > `agents.md`, дедуп, provenance | Progressive: по аргументам тул-коллов подклеивает ближайшие инструкции **в tool result** (`[Subdirectory context discovered: …]`), до 5 предков, внутри working_dir, исключая `node_modules/.git/vendor/…`, кап 8_000 символов, sha256-дедуп | Head/tail-обрезка (`CONTEXT_FILE_MAX_CHARS=20_000`, head 70%, tail 20%); динамический кап от окна (floor 20k, ceiling 500k, ~6% окна); threat-scan (`_scan_context_content`) → `[BLOCKED: …]`; install-tree guard; `--ignore-rules` / `HERMES_IGNORE_RULES=1` / `--safe-mode`; у субагентов `skip_context_files=True` |

Что уже есть в Synth для переиспользования:
- `packages/core/src/engine/security/prompt-injection.ts` — `wrapContent`, `detectPromptInjection` (словарь `injection`, ru/en), `applyPolicy` (`flag`/`sanitize`/`block`), тип `TrustLevel` (AD-036).
- `packages/core/src/engine/security/trust.ts` — доверие к проектному каталогу (project-trust гейт AD-046).
- `engine/context/builder.ts` — точка сборки системного промпта (`buildSystemPrompt`, строки 42–132).
- `engine/tools/task.ts` (`resolveSubagentPrompt`, 84; вызов 219–228) и `task-resume.ts:206` — путь промпта саб-агентов.
- `@itphx/synth-shared/config` (AD-023) — Zod-схема конфигурации (задел под секцию `instructions`).
- `git`-тулы и `list_repos` — определение git-root проекта.

**Проблемы, которые решаем:**
- **Незнание конвенций.** Агент не видит `AGENTS.md` репозитория → угадывает команды и паттерны.
- **Раздувание промпта.** `AGENTS.md` в крупных репозиториях (в т.ч. сам Synth) очень большой — цепочку нельзя лить в промпт без капа.
- **Prompt-cache.** Вставка подкаталожных инструкций в system prompt ломает кэш на каждом шаге; гермес грузит их в tool result — сохраняем это поведение.
- **Безопасность.** Инструкции — это управляющий текст для агента; подмена через `git pull`/чужой репозиторий = indirect prompt injection. Нужен threat-scan (AD-036) и trust-гейт (AD-046).
- **Install-tree leak.** При разработке самого Synth cwd может оказаться внутри дерева исходников — contributor-`AGENTS.md` не должен становиться «проектным» для пользовательских сессий (пробел, закрытый в hermes).
- **Онбординг.** Новому пользователю нужен способ быстро создать `AGENTS.md` в своём репозитории → `/init` + скилл `synth-agents-md`.

---

## 2. Решение

### 2.1. Три тира контекста (не смешивать)

```
Тир 1: ГЛОБАЛЬНАЯ IDENTITY (уже есть, отдельный тир)
  SOUL.md · COMPANY.md · ABOUT.md            {dataDir}/user, {dataDir}/roles, prompts/
      │  (builder.ts:95–97,152–184; config.ts:64)
      ▼
Тир 2: ПРОЕКТНЫЕ ИНСТРУКЦИИ (новое, AD-069)
  merged chain: git root → … → cwd
  AGENTS.override.md > AGENTS.md > agents.md, совместимо CLAUDE.md, deprecated CONTEXT.md
      │  provenance-заголовки, дедуп, общий кап
      ▼
Тир 3: ВЛОЖЕННЫЕ (LAZY, по требованию)
  ближайшие инструкции каталога файла → в tool result
  при вызове read_file/grep_files/glob/execute_shell/…
```

### 2.2. Схема

```
project.workspace (AD-014/AD-040)
      │
      ├─ git rev-parse --show-toplevel ─► gitRoot
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ Discovery (ProjectInstructionsResolver)                      │
│  1. merged chain: gitRoot → … → workspace (глубже = позже)   │
│  2. на каталог: AGENTS.override.md > AGENTS.md > agents.md   │
│  3. совместимость: CLAUDE.md (opt-in), CONTEXT.md (deprecated)│
│  4. config.instructions: пути/glob/~/абсолютные + URL (fetch) │
│  5. дедуп идентичного контента (sha256)                       │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
              threat-scan (AD-036: detectPromptInjection + applyPolicy)
                           │
        ┌──────────────────┴───────────────────┐
        ▼                                      ▼
  install-tree guard?                    head/tail-обрезка
  да и не allow → skip                   (маркер + путь для read_file)
        │                                      │
        └──────────────────┬───────────────────┘
                           ▼
     system prompt (builder.ts + task.ts/task-resume.ts)
     [PROJECT INSTRUCTIONS]
     --- from ./AGENTS.md (root, 12.4k) ---
     …
     [END PROJECT INSTRUCTIONS]

     + ленивая догрузка подкаталогов → ToolResult (не system prompt)
```

### 2.3. Ключевые принципы

| Принцип | Формулировка |
|---|---|
| **Три тира раздельно** | Глобальная identity ≠ проектные инструкции ≠ вложенные подкаталоги |
| **Глубже = приоритетнее** | merged chain `git root → … → cwd`; на каталог override > базовый |
| **Lazy — в tool result** | Вложенные инструкции не в system prompt (сохраняем prompt-cache) |
| **Read-only автоматически** | Файлы читаются, но никогда не исполняются и не изменяются автоматически |
| **Обрезка с указателем** | Обрезаем head/tail, но даём точный путь + строки для `read_file` |
| **Threat-scan до вставки** | Сканируем через модуль AD-036; при `block` — не грузим |
| **Trust как у скиллов** | Инструкции недоверенного клонированного проекта — под гейтом AD-046 |
| **Install-tree guard** | Исходники Synth не становятся проектным контекстом (кроме явного allow) |
| **Provenance** | Каждый блок подписан относительным путём (и обрезкой, если была) |

---

## 3. Discovery и приоритеты

### 3.1. Кандидаты

| Приоритет | Файл | Статус | Примечание |
|---|---|---|---|
| 1 | `AGENTS.override.md` | основной | На каталог побеждает базовый; allow-list policy (правила безопасности для монорепо) |
| 2 | `AGENTS.md` | основной | Де-факто стандарт (Synth сам использует) |
| 3 | `agents.md` | основной | Регистронезависимый вариант (совместимость) |
| 4 | `CLAUDE.md` | совместимость, read-only | Отключаемо флагом (аналог `disableClaudeCodePrompt`) |
| 5 | `CONTEXT.md` | deprecated | Грузим только если нет ничего выше; предупреждение в логе/диагностике |
| — | `.cursorrules` | вне v1 | Опционально, отдельным решением (см. §13) |

На каталог для каждого уровня цепочки выбирается **ровно один** файл из групп 1–3 (override > AGENTS.md > agents.md). `CLAUDE.md` — fallback уровня только если ни один основной не найден.

### 3.2. Merged chain `git root → … → cwd`

1. Определяется `gitRoot` (`git rev-parse --show-toplevel` из `project.workspace`; при отсутствии git — только сам cwd).
2. Строится список каталогов от `gitRoot` до `cwd` включительно.
3. В каждом каталоге выбирается один instruction-файл (по таблице §3.1).
4. Цепочка конкатенируется **от корня к cwd**: глубже = позже = приоритетнее (более поздний текст «перебивает» более ранний, как в hermes).
5. **Дедуп:** если контент совпадает с уже добавленным (sha256), блок пропускается.

Пример:

```
repo/
├── AGENTS.md                    ← шаг 1 (корень)
├── packages/
│   └── core/
│       ├── AGENTS.md            ← шаг 2 (пакет)
│       └── src/
│           └── (cwd)
```

В промпт уйдут оба, от корня к cwd, каждый со своим provenance-заголовком.

### 3.3. Provenance-заголовок

```
[PROJECT INSTRUCTIONS]
--- from ./AGENTS.md (root, 12 400 chars) ---
<содержимое>
--- from ./packages/core/AGENTS.md (12 100 chars, truncated: head 70% / tail 20%) ---
<содержимое с маркером обрезки>
[END PROJECT INSTRUCTIONS]
```

Путь — **относительный к `project.workspace`** (не абсолютный, не утечка домашнего пути).

### 3.4. `config.instructions` (доп. источники)

По образцу opencode — секция конфигурации с путями/шаблонами:

| Форма | Поведение |
|---|---|
| относительный путь / glob | от `project.workspace` (или от cwd?), first-match |
| `~/path` | от домашнего каталога пользователя |
| абсолютный путь | как есть |
| URL (`https://…`) | fetch с timeout 5000 мс, кэш; контент проходит threat-scan так же |

Доп. источники добавляются **после** merged chain (приоритетнее проектных) либо с явным местом в порядке — уточняется (см. §14).

### 3.5. Project-trust

- Инструкции из **недоверенного** проектного каталога (AD-046 project-trust гейт) видны в диагностике, но **в промпт не попадают**.
- Доверие — на проектный каталог, не на каждый файл.
- Изменение файлов (mtime/hash) → перечитывание и повторный threat-scan (инвалидация кэша, как у скиллов AD-046).
- **Инвалидация (R5, реализовано).** Общий с AD-046 generic-helper подписей `engine/file-signature.ts` (`filesSignature`/`dirsSignature`, формат `id:floor(mtimeMs):size`, отсутствующий кандидат — маркер `id:!`); `SkillWatcher` — тонкая обёртка над ним. У `ProjectInstructionsResolver` — **результатный кэш по подписи** всех кандидатов (chain-каталоги + выбранные файлы + `config.sources` + кэш-файлы URL): перед чтением/хешем/сканом считается дешёвая подпись (только `stat`/`access`), при совпадении возвращается сохранённый результат (кэшируются и пустые/`untrusted`); `clear()` сбрасывает, размер ограничен 64 записями. URL-TTL учтён через TTL-слот `floor(now/ttl)` в подписи — просроченный контент не отдаётся, `cacheTtlSec=0`/без `dataDir` кэш не применяется (fetch как раньше). Второй уровень — **per-turn мемоизация в оркестраторе** (`_resolveProjectInstructions(..., turnId)`): последний ход на сессию, ключ включает workspace/окно модели/язык/injection/projectId; реальный ход передаёт `turnId: streamId`, манифест и саб-агент обходятся файловым кэшем.

---

## 4. Lazy-догрузка вложенных инструкций

### 4.1. Зачем

Агент, читающий `packages/runner/src/main.ts`, должен знать локальные правила `packages/runner/AGENTS.md` — но не тащить их в системный промпт заранее (иначе разрастание + потеря prompt-cache).

### 4.2. Триггеры

Инструменты, чьи аргументы содержат путь:
- `read_file` (`path`), `grep_files` (`path`), `glob` (`path`), `list_directory`;
- file-операции записи (`write_file`, `edit_file`, `delete_file`, `create_directory`);
- `execute_shell` — путь извлекается разбором токенов команды (`cd <dir>`, `cat <file>` и т.п.), best-effort.

### 4.3. Алгоритм

1. По аргументам тула определяется каталог-цель.
2. Вверх от каталога файла (не более **5 предков**) ищутся ближайшие инструкции.
3. **Только внутри `project.workspace`** — выход за его пределы отсекается.
4. Исключаются каталоги: `node_modules`, `.git`, `vendor`, `dist`, `build`, `.next`, `coverage`, `tmp`, `.cache` и аналоги (настраиваемо).
5. Уже загруженные в этой сессии файлы исключаются (реестр `loaded`), плюс sha256-дедуп по содержимому.
6. Найденный контент подклеивается **в результат тула** (не в system prompt), с пометкой:

```
[Subdirectory context discovered: ./packages/runner/AGENTS.md]
<содержимое>
```

7. Догрузка выполняется **один раз на assistant-сообщение** (защита от N tool-call'ов в одном сообщении), дедуп `claims` Map — как в opencode.

### 4.4. Лимиты

| Лимит | Значение | Обоснование |
|---|---|---|
| Предков | 5 | Экономия; дальше — уже в merged chain или нерелевантно |
| Кап на блок | ~8 000 символов | Опыт hermes (`subdirectory_hints`) |
| Один раз на сообщение | да | Без зацикливания и дублей |
| Границы | `project.workspace` | Безопасность: не собираем файлы по всей ФС |
| Дедуп | sha256 + реестр `loaded` | Идемпотентность |

---

## 5. Обрезка и threat-scan

### 5.1. Обрезка (truncation)

`AGENTS.md` в Synth очень большой — простой «влезет/не влезет» недопустим.

- **Head/tail-стратегия:** при превышении капа оставляем head ~70% и tail ~20%, середину заменяем маркером:

```
… [TRUNCATED: see ./AGENTS.md — read_file(path: "./AGENTS.md", offset: 120, limit: 200)] …
```

- **Динамический кап от окна модели:** базово floor 20 000 символов, ceiling — настраиваемый (ориентир hermes: ~6% окна, ceiling 500k), плюс **config-override**.
- **Точный путь для `read_file`** в маркере — агент может при необходимости дочитать.
- Кап применяется **к merged-цепочке суммарно** (общий кап на тир), а не к каждому файлу по отдельности — иначе 10 вложенных файлов снова раздуют промпт.

### 5.2. Threat-scan (переиспользование AD-036)

Перед вставкой каждого блока (merged chain, `config.instructions`, lazy-догрузка):

```ts
import { detectPromptInjection, applyPolicy } from '../security/prompt-injection.js';

const detection = detectPromptInjection(content, dictionaryStore, lang);
const { content: safe, blocked, detail } = applyPolicy(content, policy, detection);
```

- Политика — **та же**, что и для tool-контента (`flag` / `sanitize` / `block`), конфигурируемо; для инструкций рекомендуемый дефолт — `sanitize` или `flag`.
- При `block` — блок **не грузится**, в диагностику/UI уходит `[BLOCKED: suspicious instruction content — <matches>]`.
- При `flag` — контент идёт с WARN-строкой (`buildWarnLine`).
- Дополнительно: `wrapContent(..., trust)` — обёртка с маркерами `[CONTENT | SOURCE: | trust: ]` для единообразия с tool-контентом.
- Совместимость с hermes: аналог `_scan_context_content` → `[BLOCKED: … Content not loaded.]`.

---

## 6. Install-tree guard и глобальная identity

### 6.1. Install-tree guard

Проблема: при разработке самого Synth (или запуске из дерева исходников) `cwd` может лежать внутри исходников Synth. Тогда contributor-`AGENTS.md` (архитектурные соглашения проекта) может быть ошибочно принят за проектный контекст пользовательской сессии.

- Если `cwd`/`project.workspace` — **внутри дерева исходников Synth** и `allowInstallTreeFallback = false` → проектные инструкции **не грузятся** (в диагностике — `skipped: install-tree`).
- CLI/TUI могут явно передавать `allowInstallTreeFallback = true` (как hermes: CLI/TUI передают `True`).
- Проверка install-tree — детерминированная, без LLM.

### 6.2. Глобальная identity — отдельный тир

- `SOUL.md`, `COMPANY.md`, `ABOUT.md` остаются в **тире 1** (`config.ts:64`, `builder.ts:95–97,152–184`) и с проектными инструкциями **не смешиваются**.
- Глобальная identity грузится всегда (subject to своего конфига), проектные инструкции — только при `project.workspace` (AD-014/AD-040).
- В промпте это **два разных блока** с разными заголовками; порядок: identity → project instructions.
- Глобальные instruction-файлы (`~/.config/synth/AGENTS.md`, `~/.claude/CLAUDE.md`) — опционально; по умолчанию не дублируют `SOUL.md` (см. §14).

---

## 7. Точки интеграции в коде

| Файл | Строки / сущность | Что менять |
|---|---|---|
| `packages/core/src/engine/context/builder.ts` | 42–132 (`buildSystemPrompt`) | Блок `[PROJECT INSTRUCTIONS]` после identity-контекста (95–97) и до project-info (104–105) |
| `packages/core/src/engine/context/builder.ts` | 152–184 (`_getAdditionalContext`) | Не смешивать с проектными инструкциями; тир 1 остаётся как есть |
| `packages/core/src/engine/context/builder.ts` | 217–231 (`_getProjectPrompt`) | `info.md` остаётся; проектные инструкции — отдельный резолвер |
| `packages/core/src/engine/context/config.ts` | 64 (`_enabledFiles`) | Тир 1 без изменений; вынести список в конфиг (уже частично, `setEnabledFiles` 316) |
| `packages/core/src/engine/context/config.ts` | 311 (`getEnabledFiles`), 321 (`getRolePrompt`) | Согласовать порядок блоков и приоритеты |
| `packages/core/src/engine/context/instructions.ts` | **новый модуль** | Discovery, merged chain, дедуп, обрезка, threat-scan, install-tree guard |
| `packages/core/src/engine/context/lazy-instructions.ts` | **новый модуль** | Lazy-догрузка в tool result, `claims`/`loaded`, sha256-дедуп, исключения |
| `packages/core/src/engine/tools/task.ts` | 84 (`resolveSubagentPrompt`), 219–228 (вызов) | Прокинуть проектные инструкции в промпт саб-агента; флаг `skip` |
| `packages/core/src/engine/tools/task-resume.ts` | 206 (`resolveSubagentPrompt`) | То же для ветки resume |
| `packages/core/src/engine/tools/index.ts` (или обёртка tool-result) | Реестр тулов | Хук на результат file/shell-тулов для lazy-догрузки |
| `packages/core/src/engine/orchestrator.ts` | 798–836 (сборка `systemPrompt`) | Учесть `session.settings.systemPrompt` override: если задан — инструкции не добавляются (как каталог скиллов AD-046) |
| `packages/core/src/engine/orchestrator.ts` | События сессии | Событие `context.instructions_loaded` (список/провенанс) |
| `packages/core/src/engine/security/prompt-injection.ts` | `detectPromptInjection`, `applyPolicy`, `wrapContent` | Переиспользование без изменений |
| `packages/core/src/security/trust.ts` | `trust.ts` (project-trust) | Гейт для инструкций недоверенного проекта |
| `packages/core/src/engine/commands/` (AD-046) | Резолвер `/`-команд | Встроенная команда `/init` |
| `packages/core/src/engine/skills/` (AD-046) | Реестр скиллов | Встроенный скилл `synth-agents-md` |
| `packages/shared/src/types/tools.ts` | 3–16 (`ToolCapability`) | `requires_capabilities` для скилла `synth-agents-md` |
| `@itphx/synth-shared/config` (AD-023) | Zod-схема | Секция `instructions` (`enabled`, `claudeCompat`, `maxChars`, `excludeDirs`, `urls`, `trusted…`) |
| `packages/core/src/server/routes/context.ts` | — | `GET /api/v2/context/instructions` (для UI-прозрачности) |
| `packages/ui/src/` | — | Индикатор загруженных instruction-файлов (см. §9) |

**Новые модули core:** `engine/context/instructions.ts` (resolver/loader/merge/truncate/scan), `engine/context/lazy-instructions.ts` (tool-result hooks).

---

## 8. `/init` и скилл `synth-agents-md`

### 8.1. Встроенная команда `/init`

Реализуется как встроенная slash-команда по механизму AD-046 (резолвинг в core, единообразно UI/CLI/гибрид). `$ARGUMENTS` — пользовательский фокус/ограничения. Промпт (адаптация opencode `initialize.txt`):

```text
Создай или обнови `AGENTS.md` для этого репозитория.

Цель — компактный файл инструкций, который помогает будущим сессиям Synth
избегать ошибок и быстро входить в контекст. Каждая строка должна отвечать
на вопрос: «Агент, скорее всего, ошибётся без этой подсказки?» Если нет — не
включай её.

Фокус и ограничения от пользователя (уважай их):
$ARGUMENTS

## Как исследовать

Сначала читай самые ценные источники:
- `README*`, корневые манифесты, конфиг workspace, lockfiles
- конфигурацию build, test, lint, formatter, typecheck и codegen
- CI-workflows и конфиг pre-commit / task runner
- существующие instruction-файлы (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`,
  `.cursorrules`, `.github/copilot-instructions.md`)
- локальный конфиг Synth (например `synth.config.yaml`/`config.yaml`)

Если архитектура всё ещё неясна после конфигов и документации — изучи
небольшое число репрезентативных файлов кода, чтобы найти реальные entrypoints,
границы пакетов и поток исполнения. Предпочитай файлы, объясняющие, как система
собрана, случайным листовым файлам.

Предпочитай исполняемые источники истины прозе. Если документация конфликтует с
конфигом или скриптами — доверяй исполняемому источнику и оставляй только то,
что можешь проверить.

## Что извлекать

Ищи самые высокосигнальные факты для агента, работающего в этом репозитории:
- точные команды разработчика, особенно неочевидные
- как запустить один тест, один пакет или сфокусированную проверку
- обязательный порядок команд, если он важен, например `lint -> typecheck -> test`
- границы монорепо или мультипакета, принадлежность крупных каталогов и
  реальные entrypoints приложения/библиотеки
- особенности фреймворка или тулчейна: генерируемый код, миграции, codegen,
  build-артефакты, загрузка env, dev-серверы, процесс деплоя инфраструктуры
- локальные конвенции стиля или workflow, отличающиеся от дефолтных
- особенности тестирования: fixtures, предпосылки интеграционных тестов,
  snapshot-workflow, необходимые сервисы, флаки или дорогие suite'ы
- важные ограничения из существующих instruction-файлов, которые стоит сохранить

Хорошее содержимое `AGENTS.md` — это обычно дорого добытый контекст, для
понимания которого пришлось прочитать несколько файлов.

## Вопросы

Задавай вопросы пользователю, только если репозиторий не может ответить на
что-то важное. Используй тул `question`, максимум один короткий батч.

Хорошие вопросы:
- недокументированные командные конвенции
- ожидания по веткам / PR / релизам
- отсутствующие предпосылки setup или тестов, которые известны, но не записаны

Не спрашивай о том, что репозиторий уже проясняет.

## Правила написания

Включай только высокосигнальные, специфичные для репозитория вещи:
- точные команды и сокращения, в которых агент иначе угадает неправильно
- заметки об архитектуре, неочевидные из имён файлов
- конвенции, отличающиеся от дефолтов языка или фреймворка
- требования к setup, особенности окружения и операционные подводные камни
- ссылки на существующие источники инструкций, которые важны

Исключай:
- общие советы по разработке
- длинные туториалы или исчерпывающие деревья файлов
- очевидные языковые конвенции
- спекулятивные утверждения или то, что не удалось проверить
- контент, который лучше хранить в другом файле, на который ссылаются через
  `instructions` в конфиге

Когда сомневаешься — опускай.

Предпочитай короткие секции и буллеты. Если репозиторий прост — оставь файл
простым. Если репозиторий большой — суммируй несколько структурных фактов,
которые реально меняют то, как агент должен работать.

Если `AGENTS.md` уже существует по пути `${path}`, улучшай его на месте, а не
переписывай вслепую. Сохраняй проверенные полезные указания, удаляй воду и
устаревшие утверждения, согласовывай с текущим состоянием кодовой базы.
```

### 8.2. Скилл `synth-agents-md`

Встроенный (instance) скилл для создания/обновления/аудита `AGENTS.md` — семейства `skill-creator` (AD-046).

```markdown
---
name: synth-agents-md
description: Создаёт, обновляет и аудирует AGENTS.md — проектные инструкции для агентов.
license: MIT
compatibility: synth>=0.1
allowed-tools: [read_file, grep_files, glob, list_directory, write_file, edit_file]
metadata:
  synth:
    tags: [synth-agents-md, onboarding, instructions, docs]
    category: meta
    related_skills: [skill-creator, docs-style]
    requires_capabilities: [file_read, search, file_write]
    agents: []
    groups: [meta]
    scope: instance
    trigger: manual
    command: init
    mode: any
---

# AGENTS.md

## Когда применять
Пользователь вызывает `/init`, либо нужно создать/обновить/проверить
проектные инструкции.

## Шаги
1. Исследуй репозиторий (README, манифесты, конфиги build/test/lint, CI,
   существующие instruction-файлы, entrypoints).
2. Извлеки только высокосигнальные, специфичные для репозитория факты.
3. Задай вопросы (один короткий батч), только если репозиторий не отвечает.
4. Сгенерируй/обнови AGENTS.md: короткие секции и буллеты, без общих советов.
   Если файл есть — улучшай на месте, сохраняя проверенное.
5. Аудит: проверь устаревшие команды/пути, дубли, спекуляции; отметь,
   что не удалось проверить.

## Принципы
- Каждая строка: «агент ошибётся без этого?» Нет — удалить.
- Исполняемые источники истины важнее прозы.
- Компактность важнее полноты.
```

> Скилл требует `file_read`, `search`, `file_write`. У read-only агента он виден, но помечен `unavailable` (capability-aware, AD-046) с делегированием через `task`.

---

## 9. Конфиг, флаги отключения, прозрачность

### 9.1. Конфигурация

```yaml
# config.yaml
instructions:
  enabled: true                 # глобальный тумблер автоматической загрузки
  claudeCompat: true            # читать CLAUDE.md, если нет AGENTS.md (аналог disableClaudeCodePrompt, инвертирован)
  contextCompat: false          # deprecated CONTEXT.md (выключено по умолчанию)
  maxChars: 40000               # общий кап на merged-цепочку (config-override)
  headRatio: 0.7                # доля head при обрезке
  tailRatio: 0.2                # доля tail при обрезке
  lazy:
    enabled: true
    maxAncestors: 5
    maxChars: 8000
    excludeDirs: [node_modules, .git, vendor, dist, build, .next, coverage, tmp]
  urls: []                      # доп. источники по URL (fetch, timeout 5000 мс)
  paths: []                     # доп. пути/glob/~/абсолютные
  excludeProjects: []           # проекты, где автозагрузка выключена
  allowInstallTreeFallback: false  # не грузить инструкции внутри дерева исходников Synth
```

### 9.2. Флаги отключения

| Уровень | Флаг | Действие |
|---|---|---|
| Глобально | `instructions.enabled: false` | Не грузить проектные инструкции вообще |
| CLI | `--ignore-rules` (serve/chat) / env `SYNTH_IGNORE_RULES=1\|true` | Разовая нейтральная сессия; флаг приоритетнее env |
| Безопасный режим | `--safe-mode` (serve/chat) | Инструкции не грузятся (как hermes) |
| Проект | `excludeProjects` / project-trust (авто-trust внутри `workspacesRoot`) | Для конкретного проекта |
| Саб-агенты | `skip_context_files=True` для субагентов в `task` | Не раздувать промпт дочерних сессий |
| Сессия | `session.settings.systemPrompt` override | Заменяет системный промпт → инструкции не добавляются (как каталог скиллов AD-046) |

**Реализация (R2, 2026-10-01):** флаги `--ignore-rules`/`--safe-mode` добавлены командам `serve` и `chat` в core (`packages/core/src/main.ts`) и публичном CLI (`packages/synth/src/cli.ts`); env-резолвер — `resolveIgnoreRules` (`shared/config/resolve.ts`, `SYNTH_IGNORE_RULES`). Эффективная конфигурация собирается как `{ ...synth.instructions, enabled: false }` (без мутации) и передаётся в `createStandaloneApp`/`runSingleChat`.

### 9.3. Прозрачность в UI

- Индикатор/секция «Проектные инструкции»: список загруженных файлов с **относительным путём**, размером, признаком обрезки и результатом threat-scan.
- Источник данных — `GET /api/v2/context/instructions` (или поля в `GET /sessions/:id/status`).
- Клик раскрывает провенанс (какой блок, сколько усечено, какие совпадения сканера).
- Событие `context.instructions_loaded` в `SessionEventBus` для реактивного обновления.
- Не загруженные (install-tree guard, project-trust, threat-scan `block`) — видны с причиной.

---

## 10. Связь с другими AD

| AD | Связь |
|---|---|
| [**AD-046**](./ad-046-skills-and-slash-commands.md) | Механизм, в рамках которого реализуются `/init` и скилл `synth-agents-md`; project-trust гейт для инструкций недоверенного проекта; событие-параллель `skill.invoked` |
| [**AD-036**](./ad-036-llm-gateway.md) | `engine/security/prompt-injection.ts` (`detectPromptInjection`, `applyPolicy`, `wrapContent`) переиспользуется для threat-scan инструкций |
| [**AD-040**](./ad-040-sessions-without-project.md) | Инструкции грузятся только при `project.workspace`; сессия без проекта — без проектных инструкций |
| [AD-014](./ad-014-project-container.md) | `project.workspace` — источник проектного контекста и граница lazy-догрузки |
| [AD-023](./ad-023-configuration.md) | Секция `instructions` в Zod-схеме `@itphx/synth-shared/config` |
| [AD-025](./ad-025-plan-act-toggle.md) | В plan/act поведение одинаково; в `strict` инструкции могут содержать обязательные проверки |
| [AD-026](./ad-026-subagent-context-modes.md) | Промпт саб-агента (`task.ts`) получает инструкции опционально (`skip_context_files`) |
| [AD-029](./ad-029-granular-permissions.md) | Права на запись `AGENTS.md` через скилл `synth-agents-md` (`allowed-tools`, `requires_capabilities`) |
| [AD-039](./ad-039-plan-in-project.md) | Инструкции — не план и не todo; контекст, не состояние |
| [AD-042](./ad-042-hybrid-mode.md) | В гибриде инструкции грузит локальный core для локальных проектов; удалённые — сервер/клиент (граница уточняется) |
| [AD-044](./ad-044-mobile-adaptive-ui-pwa.md) | UI-индикатор загруженных инструкций адаптируется под мобильный |
| [AD-045](./ad-045-hybrid-server-profiles.md) | Единый dataDir; глобальные instruction-файлы (если появятся) — в `{dataDir}` |
| [AD-068](./ad-068-skills-agents-registry.md) | Каталог/установка скилла `synth-agents-md` как обычного скилла; реестр владеет доставкой |

---

## 11. Фазы реализации и тесты

### Фаза 1 — discovery и merged chain

- Резолвер `engine/context/instructions.ts`: git-root, merged chain, приоритеты файлов, дедуп, provenance.
- Обрезка head/tail + динамический кап + config-override.
- Threat-scan через AD-036.
- Вставка в `builder.ts` (основная сессия).
- `instructions.enabled` + флаг отключения.
- Учёт `session.settings.systemPrompt` override.

### Фаза 2 — саб-агенты, lazy, UI

- Прокидка в `task.ts` / `task-resume.ts`, `skip_context_files`.
- Lazy-догрузка в tool result (`engine/context/lazy-instructions.ts`), лимиты/исключения/дедуп.
- Install-tree guard, project-trust гейт.
- `config.instructions` (пути/glob/URL).
- `GET /api/v2/context/instructions` + UI-индикатор, событие `context.instructions_loaded`.

### Фаза 3 — `/init` и скилл

- Встроенная команда `/init` (AD-046), `$ARGUMENTS`.
- Скилл `synth-agents-md` (instance), `requires_capabilities`, семейство `skill-creator`.
- CLI-вызов `/init` в REPL.
- Совместимость `CLAUDE.md` (opt-in), диагностика deprecated `CONTEXT.md`.

### Тесты (Vitest)

| Область | Что проверяем |
|---|---|
| Discovery/приоритет | `AGENTS.override.md` > `AGENTS.md` > `agents.md`; `CLAUDE.md` fallback; `CONTEXT.md` deprecated; несколько каталогов |
| Merged chain | `git root → … → cwd`; глубже = позже; порядок блоков; без git — только cwd |
| Дедуп | Идентичный контент (sha256) не дублируется; одинаковые файлы в разных каталогах |
| Provenance | Относительный путь, размер, признак обрезки |
| Обрезка | head/tail, маркер с точным путём/offset, общий кап на цепочку, config-override |
| Threat-scan | `detectPromptInjection` на malicious-контенте; `flag`/`sanitize`/`block`; `block` не грузит |
| Lazy-догрузка | Триггеры по file/shell-тулам; 5 предков; boundaries workspace; исключения; кап 8k; один раз на сообщение; sha256-дедуп |
| Install-tree guard | cwd внутри дерева Synth → skip; `allowInstallTreeFallback=true` → грузит |
| Trust-гейт (R1/R3) | Общий гейт system-chain и lazy: недоверенный workspace → подкаталожный `AGENTS.md` не грузится (статус `untrusted`); workspace внутри `workspacesRoot` доверен автоматически; skills project-trust не затронут |
| CLI-отключение (R2) | `resolveIgnoreRules`: `--ignore-rules`/`--safe-mode` приоритетнее env `SYNTH_IGNORE_RULES` → `instructions.enabled=false` (serve/chat) |
| Identity vs project | Тир 1 (`SOUL.md`/`COMPANY.md`/`ABOUT.md`) отдельно; не смешивается |
| Саб-агенты | `skip_context_files`; инструкции в `resolveSubagentPrompt` |
| `/init` | Резолвинг в core; `$ARGUMENTS`; merge in place; промпт содержит investigate/extract/questions/writing rules |
| Скилл `synth-agents-md` | Валидация frontmatter; `requires_capabilities`; capability-aware недоступность |
| Отключение | `instructions.enabled=false`; `--ignore-rules`; `--safe-mode`; `excludeProjects`; override `systemPrompt` |
| Прозрачность | Список/провенанс в API; событие `context.instructions_loaded` |

---

## 12. Что НЕ делаем

- **Не исполняем инструкции.** `AGENTS.md` — текст для промпта, не плагин. Никакого автозапуска команд из файла.
- **Не грузим весь репозиторий.** Только известные кандидаты + явные `config.instructions`.
- **Не смешиваем тиры.** `SOUL.md`/identity не становится проектным контекстом.
- **Не грузим недоверенное автоматически.** Project-trust гейт (AD-046) обязателен.
- **Не пропускаем threat-scan.** Любой instruction-контент сканируется (AD-036).
- **Не переписываем `AGENTS.md` молча.** `/init` — улучшение на месте с сохранением проверенного.
- **Не поддерживаем `.cursorrules` в v1** (опционально позже).
- **Не грузим инструкции для сессий без проекта** (AD-040).
- **Не ломаем prompt-cache.** Вложенные инструкции — в tool result, не в system prompt.

---

## 13. Открытые вопросы

1. **`config.instructions` — место в приоритете:** доп. пути/URL должны идти после merged chain (приоритетнее проектных) или перед ним? Или конфигурируемо?
2. **Глобальные instruction-файлы** — решение: **не поддерживаем** `~/.config/synth/AGENTS.md`/`~/.claude/CLAUDE.md`; глобальный тир остаётся за `SOUL.md`/`COMPANY.md`/`ABOUT.md` (тир identity, §6.2).
3. **Формат маркера обрезки:** точный синтаксис для `read_file` (`offset`/`limit` — строки или байты?) и политика, сколько середины сохранять.
4. **Динамический кап:** формула от окна модели (доля, floor/ceiling) — фиксируем ~6% (hermes) или подбираем под роутинг моделей AD-034?
5. **`.cursorrules`** — включать ли в v1 как ещё одну совместимость?
6. **Границы в гибриде (AD-042):** кто резолвит инструкции для удалённого проекта — сервер (он владеет workspace) или клиент? Куда попадает контент — в удалённый промпт?
7. **Project-trust UX** — решено (R3, 2026-10-01): workspace внутри `storage.workspacesRoot` доверяется автоматически (плюс явный `skills.trustedProjectDirs`); общий гейт для system-chain и lazy. Недоверенные инструкции в промпт/диагностику не грузятся (статус `untrusted`).
8. **Install-tree guard — эвристика:** как детектировать «внутри дерева исходников Synth» (по `package.json` с `@itphx/synth-core`, по маркеру, по пути установки npm-пакета)?
9. **(R5, решено, 2026-10-01) Кэш и инвалидация:** общий с AD-046 helper подписей `engine/file-signature.ts` (mtime:size); результатный кэш резолвера по подписи кандидатов + per-turn мемоизация в оркестраторе; URL-TTL — через TTL-слот подписи.
