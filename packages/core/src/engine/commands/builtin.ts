import type { CommandSummary } from '@itphx/synth-shared';
import { t as sm } from '../system-messages.js';

/**
 * ADR-046 §7.2: встроенные продуктовые команды Фазы 2. `/compact` (PROP-126 §1)
 * — ручной запуск компактизации контекста (ADR-119).
 * `/init` (ADR-069 §8.1) генерирует prompt для LLM (`status: 'prompt'`), а не
 * локальный ответ; `/review` (PROP-126 §1) — тоже prompt-команда (ревью
 * изменений кода в git-репозитории).
 */
export const BUILTIN_COMMAND_NAMES = ['help', 'skills', 'commands', 'summary', 'compact', 'init', 'review'] as const;
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
  { name: 'compact', kind: 'builtin', description: 'Сжать контекст (компактизация)', available: true },
  { name: 'init', kind: 'builtin', description: 'Создать или обновить AGENTS.md (проектные инструкции)', available: true },
  { name: 'review', kind: 'builtin', description: 'Ревью изменений кода в git-репозитории', available: true },
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
 * ADR-069 §8.1: путь проектных инструкций, к которому апеллирует `/init`
 * (относительно `project.workspace`). Не абсолютный — без утечки домашнего пути.
 */
export const INIT_INSTRUCTION_PATH = 'AGENTS.md';

/**
 * ADR-069 §8.1: prompt встроенной команды `/init` (адаптация opencode
 * `initialize.txt`). Модель-facing текст на английском — единый язык с
 * встроенным скиллом `skill-creator` и LLM-каналом `system-messages` (ADR-041).
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

/**
 * PROP-126 §1: prompt встроенной команды `/review` — ревью **изменений кода**
 * в git-репозитории (адаптация opencode `review.txt`). Model-facing текст на
 * английском — единый язык с `/init` и LLM-каналом `system-messages` (ADR-041).
 *
 * Аргумент (`commit|branch|pr`) — цель ревью; без аргумента — незакоммиченные
 * изменения рабочего дерева. Промпт требует от модели **сказать**, что ревью
 * изменений недоступно (нет git-репозитория/рабочего каталога/самого diff), а
 * не выдумывать изменения: `/review` — не универсальное ревью (PROP-126 §1),
 * в объём работ входят только изменения кода.
 */
export function renderReviewPrompt(args: string): string {
  const target = args.trim().length > 0
    ? args.trim()
    : '(not provided — review the uncommitted changes of the working tree)';
  return `You are a code reviewer. Your job is to review code changes and provide actionable feedback.

---

Target of the review: ${target}

---

## 1. Determine what to review

Based on the target above, determine which changes to review:

1. **No target** — the uncommitted changes of the working tree:
   - Run: \`git_diff\` for unstaged changes
   - Run: \`git_diff { staged: true }\` for staged changes
   - Run: \`git_status\` to identify untracked (net new) files

2. **Commit hash** (40-char SHA or short hash): review that specific commit
   - Run: \`git_show { object: "<hash>" }\`

3. **Branch name**: compare that branch to the current HEAD
   - Run: \`git_diff { commit: "<branch>...HEAD" }\`
   - If the branch is not found, check \`git_branch_list\` first

4. **PR number or URL**: review the pull request
   - There is no built-in PR tool: if \`gh\` is available in this environment, use
     \`execute_shell\` (\`gh pr view <n>\`, \`gh pr diff <n>\`)
   - If \`gh\` is not available or the command fails, say that reviewing a pull
     request is not possible here and offer to review the local branch instead

Use best judgement when the target is ambiguous. If the target names something
else (a file, a ticket), review the changes that belong to it and state which
changes the review is based on.

---

## 2. Gathering Context

**Diffs alone are not enough.** After getting the diff, read the entire file(s)
being modified to understand the full context. Code that looks wrong in
isolation may be correct given surrounding logic — and vice versa.

- Use the diff to identify which files changed
- Read the full changed files (\`read_file\`) — existing patterns, control flow, error handling
- Read the untracked files from \`git_status\` in full — they are part of the change
- Check for existing style guide or conventions files (AGENTS.md, CONTRIBUTING.md, .editorconfig, etc.)

---

## 3. What to Look For

**Bugs** — your primary focus.
- Logic errors, off-by-one mistakes, incorrect conditionals
- If-else guards: missing guards, incorrect branching, unreachable code paths
- Edge cases: null/empty/undefined inputs, error conditions, race conditions
- Security issues: injection, auth bypass, data exposure
- Broken error handling that swallows failures, throws unexpectedly, or returns error types that are not caught

**Structure** — does the code fit the codebase?
- Does it follow existing patterns and conventions?
- Are there established abstractions it should use but does not?
- Excessive nesting that could be flattened with early returns or extraction

**Performance** — only flag it if obviously problematic.
- O(n²) on unbounded data, N+1 queries, blocking I/O on hot paths

**Behavior Changes** — if a behavioral change is introduced, raise it (especially if it is possibly unintentional).

---

## 4. Before You Flag Something

**Be certain.** If you are going to call something a bug, you need to be confident it actually is one.

- Only review the changes — do not review pre-existing code that was not modified
- Do not flag something as a bug if you are unsure — investigate first
- Do not invent hypothetical problems — if an edge case matters, explain the realistic scenario where it breaks
- If you need more context to be sure, use the tools to get it (read the file, search the codebase, delegate to a subagent)

**Do not be a zealot about style.** When checking code against conventions:
- Verify the code is *actually* in violation. Do not complain about else statements if early returns are already being used correctly.
- Some "violations" are acceptable when they are the simplest option. A \`let\` statement is fine if the alternative is convoluted.
- Excessive nesting is a legitimate concern regardless of other style choices.

---

## 5. When the Review Is Not Possible

A code review needs a git repository and a diff. If any of the following is true, say plainly that reviewing the changes is **not available** and why. Never invent a diff and never review code you have not actually seen:

- the session has no working directory, or the project has no workspace — the git tools have nothing to work with
- the working directory is not a git repository (the git tools report that it is not one)
- the target has no changes: a clean working tree, an empty diff, an unknown commit or branch
- the target cannot be resolved at all (for example an unknown pull request)

In that case answer in one or two sentences: exactly what is unavailable and what the user should do (open a project with a git repository, make the changes, name an existing commit or branch). Do not fall back to a general review of the code — only the changes are in scope.

---

## 6. Output

1. If there is a bug, be direct and clear about why it is a bug.
2. Clearly communicate severity of issues. Do not overstate severity.
3. Critiques should clearly and explicitly communicate the scenarios, environments, or inputs that are necessary for the bug to arise.
4. Your tone should be matter-of-fact and not accusatory or overly positive.
5. Write so the reader can quickly understand the issue without reading too closely.
6. AVOID flattery, do not give any comments that are not helpful to the reader.`;
}
