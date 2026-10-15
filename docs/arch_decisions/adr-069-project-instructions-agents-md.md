# ADR-069: Проектные инструкции (AGENTS.md) и `/init`

> **Статус:** ✅ Реализовано (Фазы 1–3, 2026-09-24; остатки R1–R4 — 2026-10-01, R5 — 2026-10-01; as-built вынесено в spec — 2026-10-15).
> **Дата:** 2026-09-17.
> **Парные документы (as-built):** [ARCHITECTURE.md](../ARCHITECTURE.md) «Проектные инструкции (AGENTS.md)» · [CONFIGURATION.md](../CONFIGURATION.md) (`instructions`) · [API_V2.md](../API_V2.md) §5.13.1 · `packages/{core,ui,backend,shared}/AGENTS.md`.
> **Связано:** [ADR-046](./adr-046-skills-and-slash-commands.md) (скиллы/команды, project-trust), [ADR-036](./adr-036-llm-gateway.md) (threat-scan), [ADR-040](./adr-040-sessions-without-project.md) (проектный контекст), [ADR-014](./adr-014-project-container.md), [ADR-023](./adr-023-configuration.md), [ADR-026](./adr-026-subagent-context-modes.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-070](./adr-070-system-prompt-composer.md), [ADR-042](./adr-042-hybrid-mode.md)/[ADR-045](./adr-045-hybrid-server-profiles.md), [PROP-068](./prop-068-skills-agents-registry.md).
> **Карта подразделов (прежняя нумерация §) → spec-дом:** §2 тиры/принципы → [ARCHITECTURE.md](../ARCHITECTURE.md); §3 discovery/merged chain/provenance/`config.sources`/trust/кэш → [CONFIGURATION.md](../CONFIGURATION.md), `packages/core/AGENTS.md`; §4 lazy-догрузка → [ARCHITECTURE.md](../ARCHITECTURE.md), `packages/core/AGENTS.md`; §5 обрезка/threat-scan → [CONFIGURATION.md](../CONFIGURATION.md), `packages/core/AGENTS.md`; §6 install-tree guard/identity → [CONFIGURATION.md](../CONFIGURATION.md), [ARCHITECTURE.md](../ARCHITECTURE.md); §7 точки интеграции → `packages/core/AGENTS.md`; §8 `/init`/скилл → [CONFIGURATION.md](../CONFIGURATION.md), `packages/core/AGENTS.md`; §9 конфиг/флаги/прозрачность → [CONFIGURATION.md](../CONFIGURATION.md), [API_V2.md](../API_V2.md) §5.13.1, `packages/ui/AGENTS.md`; §10 связи → ниже; §11 фазы/тесты → «Статус реализации»; §12 «что не делаем» → «Альтернативы».

## Контекст

Агент не знал конвенций репозитория: репозиторные `AGENTS.md`/`CLAUDE.md`/`.cursorrules` не обнаруживались и не грузились — команды сборки/тестов и локальные правила угадывались, предупреждения автора игнорировались. Референсы — opencode (`session/instruction.ts`) и hermes-agent (`prompt_builder.py`/`subdirectory_hints.py`): merged chain, lazy-догрузка подкаталогов в tool result, обрезка, threat-scan, install-tree guard. Переиспользуемое в Synth: `engine/security/prompt-injection.ts` ([ADR-036](./adr-036-llm-gateway.md)), project-trust ([ADR-046](./adr-046-skills-and-slash-commands.md)), `engine/context/builder.ts`, промпт саб-агентов (`task.ts`/`task-resume.ts`).

## Решение

Ввести **автоматическую загрузку проектных инструкций** — репозиторных файлов-руководств (`AGENTS.override.md`/`AGENTS.md`, совместимо `CLAUDE.md`, deprecated `CONTEXT.md`):

- **Три тира раздельно.** Глобальная identity (`SOUL.md`/`COMPANY.md`/`ABOUT.md`) ≠ проектные инструкции (только при `project.workspace`) ≠ вложенные подкаталоги. Глобальные instruction-файлы (`~/.config/synth`, `~/.claude`) намеренно не читаются — глобальный тир остаётся за identity-файлами.
- **Merged chain `git root → … → cwd`** — глубже = позже = приоритетнее; на каталог ровно один кандидат `AGENTS.override.md` > `AGENTS.md` > `agents.md` > `CLAUDE.md` (opt-in) > `CONTEXT.md` (deprecated opt-in); дедуп идентичного контента (sha256); блок в system prompt (тир `context`) с provenance-заголовком (относительный путь).
- **Доп. источники `config.instructions.sources`** (`path`/`url`) — позиционно `before`/`after` цепочки; URL — **read-only fetch** с TTL-кэшем (без фонового таймера), кап `maxBytes`, `ttlSec` per-source.
- **Lazy-догрузка подкаталогов — в tool result, не в system prompt** (сохраняем prompt-cache): триггеры — file/shell-тулы; вверх ≤5 предков только внутри `project.workspace`; исключение `node_modules`/…; дедуп (`loaded` + sha256); один раз на assistant-сообщение.
- **Обрезка head/tail** с маркером и точным путём/offset для `read_file`; **динамический кап от окна модели** (`clamp(windowRatio*window, minChars, maxCharsCeiling)`), общий на цепочку; `maxChars` — явный override.
- **Threat-scan до вставки** через модуль [ADR-036](./adr-036-llm-gateway.md) (политика `flag`/`sanitize`/`block`); при `block` блок не грузится.
- **Trust-гейт** как у скиллов ([ADR-046](./adr-046-skills-and-slash-commands.md)): инструкции недоверенного проекта не грузятся (`untrusted`); гейт общий для merged chain и lazy; workspace внутри `storage.workspacesRoot` доверяется автоматически (плюс явный `skills.trustedProjectDirs`).
- **Install-tree guard.** Каталог внутри дерева исходников Synth не становится проектным контекстом (`skipped-install-tree`), кроме явного `allowInstallTreeFallback`.
- **Read-only.** Инструкции — текст для промпта: не исполняются и не изменяются автоматически; грузятся только известные кандидаты + явные `sources`.
- **`/init` и скилл `synth-agents-md`** (механизм [ADR-046](./adr-046-skills-and-slash-commands.md)) — генерация/обновление/аудит `AGENTS.md`; `/init` улучшает файл на месте, не переписывает вслепую; скилл доступен как `/agents-md` (имя команды занято builtin `/init`).
- **Отключение и прозрачность.** `instructions.enabled=false`, `excludeProjects`, `--ignore-rules`/`--safe-mode` (env `SYNTH_IGNORE_RULES`), `session.settings.systemPrompt` override (инструкции не добавляются); снимок загруженного — `GET /api/v2/context/instructions` + событие `context.instructions_loaded` + UI-индикатор.
- **Кэш/инвалидация (R5).** Общий с [ADR-046](./adr-046-skills-and-slash-commands.md) helper подписей `engine/file-signature.ts` (`mtime:size`); результатный кэш резолвера по подписи кандидатов, per-turn мемоизация в оркестраторе, TTL-слот для URL.

## Альтернативы

- **Глобальные instruction-файлы** (`~/.config/synth/AGENTS.md`, `~/.claude/CLAUDE.md`) — не читаем: глобальный тир за identity-файлами (покрыто тиром identity).
- **Цепочка/вложенные инструкции в system prompt без капа** — отклонён: раздувание промпта и потеря prompt-cache (lazy — только в tool result).
- **Автодоверие «своему»/клонированному репозиторию** — отклонён: trust-гейт на проектный каталог ([ADR-046](./adr-046-skills-and-slash-commands.md)).
- **Исполнение инструкций** — отклонён: `AGENTS.md` — текст, не плагин; никакого автозапуска команд из файла.
- **`.cursorrules` в v1** — вне объёма, отдельным решением.

## Последствия

- (+) Агент знает конвенции репозитория без ручной вставки; prompt-cache не ломается (lazy в tool result, общий кап).
- (+) Инструкции — управляющий текст: threat-scan + trust + install-tree guard закрывают indirect prompt injection.
- (−) Незначительный `stat`-оверхед на подписи кандидатов (гасится кэшем по подписи, `clear()` — сброс).
- Проектный контекст существует только при `project.workspace`; сессия без проекта инструкций не грузит ([ADR-040](./adr-040-sessions-without-project.md)).

## Статус реализации

✅ Реализовано. As-built — [ARCHITECTURE.md](../ARCHITECTURE.md) «Проектные инструкции (AGENTS.md)», [CONFIGURATION.md](../CONFIGURATION.md) (`instructions`), [API_V2.md](../API_V2.md) §5.13.1, `packages/{core,ui,backend,shared}/AGENTS.md`. Тесты — `engine/context/instructions.test.ts`, `lazy-instructions.test.ts`, `engine/file-signature` и UI-тесты прозрачности.

## Открытые вопросы

Границы в гибриде — кто резолвит инструкции удалённого проекта (сервер/клиент) и куда попадает контент; точная эвристика install-tree-детекта (маркер/`package.json`); `.cursorrules` как ещё одна совместимость; подбор `windowRatio`/floor/ceiling под роутинг моделей ([ADR-034](./adr-034-model-routing.md)). Доставка скилла `synth-agents-md` как обычного скилла (реестр, install/policy) — [PROP-068](./prop-068-skills-agents-registry.md).

## История

- 2026-10-15 — сжатие до одной страницы: as-built вынесено в spec ([ARCHITECTURE.md](../ARCHITECTURE.md), [CONFIGURATION.md](../CONFIGURATION.md), [API_V2.md](../API_V2.md) §5.13.1, `packages/{core,ui,backend,shared}/AGENTS.md`).
- 2026-10-01 — R5: общий helper подписей, результатный кэш резолвера, per-turn мемоизация.
- 2026-10-01 — R1–R4: общий trust-гейт для merged chain и lazy, авто-trust `workspacesRoot`, CLI `--ignore-rules`/`--safe-mode`.
- 2026-09-24 — Фазы 1–3: резолвер/merged chain, lazy-догрузка, `/init` и скилл `synth-agents-md`.
- 2026-09-17 — решение принято.
