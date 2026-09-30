import type { CommandSummary } from '@itphx/synth-shared';
import { t as sm } from '../system-messages.js';

/**
 * AD-046 §7.2: встроенные продуктовые команды Фазы 2. `/compact` и `/review`
 * отложены (решение Фазы 2). `/init` (AD-069 §8.1) генерирует prompt для LLM
 * (`status: 'prompt'`), а не локальный ответ.
 */
export const BUILTIN_COMMAND_NAMES = ['help', 'skills', 'commands', 'summary', 'init'] as const;
export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];

export function isBuiltinCommand(name: string): name is BuiltinCommandName {
  return (BUILTIN_COMMAND_NAMES as readonly string[]).includes(name);
}

/** Сводки встроенных команд для `list()`/`/help`. */
export const BUILTIN_COMMANDS: CommandSummary[] = [
  { name: 'help', kind: 'builtin', description: 'Справка по командам и скиллам', available: true },
  { name: 'skills', kind: 'builtin', description: 'Список доступных скиллов', available: true },
  { name: 'commands', kind: 'builtin', description: 'Список всех команд', available: true },
  { name: 'summary', kind: 'builtin', description: 'Запустить ручную суммаризацию диалога', available: true },
  { name: 'init', kind: 'builtin', description: 'Создать или обновить AGENTS.md (проектные инструкции)', available: true },
];

/** `/help` — статическая справка (без RAG). */
export function renderHelp(): string {
  const lines = [sm('command.help'), '', ...BUILTIN_COMMANDS.map((c) => `- /${c.name} — ${c.description}`)];
  return lines.join('\n');
}

/** `/skills` — список доступных скиллов. */
export function renderSkillsList(skills: readonly { commandName: string; description: string; available: boolean }[]): string {
  if (skills.length === 0) return sm('command.skills_empty');
  const lines = skills.map((s) => `- /${s.commandName}${s.available ? '' : ' (unavailable)'}: ${s.description}`);
  return lines.join('\n');
}

/** `/commands` — итоговый список команд. */
export function renderCommandsList(commands: readonly CommandSummary[]): string {
  if (commands.length === 0) return sm('command.list_empty');
  const lines = commands.map((c) => {
    const markers: string[] = [c.kind];
    if (!c.available && c.unavailableReason) markers.push(c.unavailableReason);
    return `- /${c.name} (${markers.join(', ')}): ${c.description}`;
  });
  return lines.join('\n');
}

/**
 * AD-069 §8.1: путь проектных инструкций, к которому апеллирует `/init`
 * (относительно `project.workspace`). Не абсолютный — без утечки домашнего пути.
 */
export const INIT_INSTRUCTION_PATH = 'AGENTS.md';

/**
 * AD-069 §8.1: prompt встроенной команды `/init` (адаптация opencode
 * `initialize.txt`). Модель-facing текст на английском — единый язык с
 * встроенным скиллом `skill-creator` и LLM-каналом `system-messages` (AD-041).
 *
 * `$ARGUMENTS` (пользовательский фокус/ограничения) подставляется как есть;
 * пустые аргументы — явная пометка, чтобы модель не приняла отсутствие фокуса
 * за ошибку. Ссылки на несуществующий тул `question` нет — вопросы задаются
 * обычным текстом, максимум один короткий батч.
 */
export function renderInitPrompt(args: string): string {
  const focus = args.trim().length > 0
    ? args.trim()
    : '(not provided — use your own judgment about what matters most)';
  return `Create or update \`${INIT_INSTRUCTION_PATH}\` for this repository.

Goal: a compact instruction file that helps future Synth sessions avoid mistakes
and get oriented quickly. Every line must answer: "Would the agent likely get
this wrong without the hint?" If not, leave it out.

User focus and constraints (respect them):
${focus}

## Investigate

Read the highest-value sources first:
- \`README*\`, root manifests, workspace config, lockfiles
- build, test, lint, formatter, typecheck and codegen configuration
- CI workflows and pre-commit / task-runner config
- existing instruction files (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`,
  \`.cursorrules\`, \`.github/copilot-instructions.md\`)
- local Synth config (e.g. \`synth.config.yaml\` / \`config.yaml\`)

If the architecture is still unclear after configs and docs, read a small number
of representative code files to find real entrypoints, package boundaries and the
execution flow. Prefer files that explain how the system is assembled over random
leaf files.

Prefer executable sources of truth over prose. If documentation conflicts with
config or scripts, trust the executable source and keep only what you can verify.

## Extract

Look for the highest-signal facts for an agent working in this repository:
- exact developer commands, especially non-obvious ones
- how to run a single test, a single package or a focused check
- required command order when it matters, e.g. \`lint -> typecheck -> test\`
- monorepo / multi-package boundaries, what major directories own, real entrypoints
- framework or toolchain specifics: generated code, migrations, codegen,
  build artifacts, env loading, dev servers, infra deploy process
- local style or workflow conventions that differ from defaults
- testing specifics: fixtures, integration-test prerequisites, snapshot workflow,
  required services, flaky or expensive suites
- important constraints from existing instruction files worth preserving

Good \`AGENTS.md\` content is usually hard-won context that required reading
several files to understand.

## Questions

Ask the user only when the repository cannot answer something important. Ask in
plain text, at most one short batch — do not use a special tool.

Good questions:
- undocumented team conventions
- branch / PR / release expectations
- missing setup or test prerequisites that are known but not written down

Do not ask about what the repository already clarifies.

## Writing rules

Include only high-signal, repository-specific things:
- exact commands and shortcuts the agent would otherwise guess wrong
- architecture notes that are not obvious from file names
- conventions that differ from language or framework defaults
- setup requirements, environment quirks and operational pitfalls
- pointers to existing instruction sources that matter

Exclude:
- generic development advice
- long tutorials or exhaustive file trees
- obvious language conventions
- speculative or unverified claims
- content better kept in another file referenced via \`instructions\` in config

When in doubt, leave it out.

Prefer short sections and bullets. If the repository is simple, keep the file
simple. If it is large, summarize a few structural facts that really change how
the agent should work.

If \`${INIT_INSTRUCTION_PATH}\` already exists, improve it in place rather than
rewriting blindly: keep proven useful guidance, remove filler and stale claims,
and reconcile it with the current state of the codebase.`;
}
