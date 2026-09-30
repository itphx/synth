import type { CommandDiagnostic, CommandSummary, SkillBundle } from '@itphx/synth-shared';
import { BUILTIN_COMMANDS, isBuiltinCommand, type BuiltinCommandName } from './builtin.js';
import type {
  CommandConflictConfig,
  CommandEntry,
  CommandSkillEntry,
  TemplateCommand,
} from './types.js';

export interface ResolveCatalogInput {
  templates: readonly TemplateCommand[];
  skills: readonly CommandSkillEntry[];
  bundles: readonly SkillBundle[];
  conflict: CommandConflictConfig;
}

export interface ResolvedCatalog {
  entries: CommandEntry[];
  diagnostics: CommandDiagnostic[];
}

/** Разбор `/name args`. `undefined` — не `/`-команда. */
export function parseCommandInput(input: string): { name: string; args: string } | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_:-]*)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return undefined;
  return { name: match[1]!, args: (match[2] ?? '').trim() };
}

function kindOrder(mode: CommandConflictConfig['mode'], has: Record<string, boolean>): CommandEntry['kind'] | undefined {
  if (mode === 'conservative') {
    if (has.builtin) return 'builtin';
    if (has.template) return 'template';
    if (has.bundle) return 'bundle';
    if (has.skill) return 'skill';
    return undefined;
  }
  if (mode === 'namespace') {
    if (has.builtin) return 'builtin';
    if (has.skill) return 'skill';
    return undefined;
  }
  // bundle-wins
  if (has.bundle) return 'bundle';
  if (has.builtin) return 'builtin';
  if (has.template) return 'template';
  if (has.skill) return 'skill';
  return undefined;
}

function shadowedDiag(name: string, loser: string, winner: string): CommandDiagnostic {
  return {
    level: 'warning', code: 'shadowed', command: name,
    message: `команда "${name}" (${loser}) перекрыта источником ${winner}`,
  };
}

/**
 * AD-046 §7.1/§7.3: единый порядок имён по режиму конфликта. Возвращает
 * упорядоченный список записей + `shadowed`-диагностику проигравших.
 *
 * | Режим | Порядок |
 * |---|---|
 * | `bundle-wins` | bundle > builtin > template > skill |
 * | `conservative` | builtin > template > bundle > skill; bundle↔builtin → error |
 * | `namespace` | bare: builtin > skill; `namespacePrefix` → `<bundle>:<skill>`, `template:<name>` |
 */
export function resolveCatalog(input: ResolveCatalogInput): ResolvedCatalog {
  const { templates, skills, bundles, conflict } = input;
  const entries: CommandEntry[] = [];
  const diagnostics: CommandDiagnostic[] = [];

  const builtinByName = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));
  const templateByName = new Map(templates.map((t) => [t.name, t]));
  const skillByName = new Map<string, CommandSkillEntry[]>();
  for (const skill of skills) {
    const list = skillByName.get(skill.commandName) ?? [];
    list.push(skill);
    skillByName.set(skill.commandName, list);
  }
  const bundleByName = new Map(bundles.map((b) => [b.name, b]));

  const names = new Set<string>();
  for (const n of builtinByName.keys()) names.add(n);
  for (const n of templateByName.keys()) names.add(n);
  for (const n of skillByName.keys()) names.add(n);
  for (const n of bundleByName.keys()) names.add(n);

  const emit = (entry: CommandEntry): void => { entries.push(entry); };

  for (const name of [...names].sort()) {
    const has = {
      builtin: builtinByName.has(name),
      template: templateByName.has(name),
      skill: skillByName.has(name),
      bundle: bundleByName.has(name),
    };
    const winner = kindOrder(conflict.mode, has);
    if (!winner) {
      // `namespace`: bare-имена разрешены только для builtin/skill; шаблоны и
      // бандлы не перекрывают их и не получают изобретённых префиксов.
      continue;
    }

    // conservative: коллизия bundle ↔ builtin — bundle игнорируется.
    if (conflict.mode === 'conservative' && has.builtin && has.bundle) {
      diagnostics.push({
        level: 'error', code: 'collision', command: name,
        message: `bundle "${name}" игнорируется: конфликт с встроенной командой (conservative)`,
      });
    }
    // conservative: bundle vs template — template побеждает.
    if (conflict.mode === 'conservative' && winner === 'template' && has.bundle) {
      diagnostics.push(shadowedDiag(name, 'bundle', 'template'));
    }

    if (winner === 'builtin') {
      if (has.bundle) diagnostics.push(shadowedDiag(name, 'bundle', 'builtin'));
      if (has.template) diagnostics.push(shadowedDiag(name, 'template', 'builtin'));
      if (has.skill) diagnostics.push(shadowedDiag(name, 'skill', 'builtin'));
      emit({ kind: 'builtin', summary: builtinByName.get(name)! });
    } else if (winner === 'template') {
      if (has.bundle) diagnostics.push(shadowedDiag(name, 'bundle', 'template'));
      if (has.skill) diagnostics.push(shadowedDiag(name, 'skill', 'template'));
      const template = templateByName.get(name)!;
      emit({ kind: 'template', summary: templateSummary(template), template });
    } else if (winner === 'bundle') {
      if (has.template) diagnostics.push(shadowedDiag(name, 'template', 'bundle'));
      if (has.skill) diagnostics.push(shadowedDiag(name, 'skill', 'bundle'));
      const bundle = bundleByName.get(name)!;
      emit({ kind: 'bundle', summary: bundleSummary(bundle), bundle });
    } else {
      if (has.bundle) diagnostics.push(shadowedDiag(name, 'bundle', 'skill'));
      if (has.template) diagnostics.push(shadowedDiag(name, 'template', 'skill'));
      const skill = skillByName.get(name)![0]!;
      emit({ kind: 'skill', summary: skillSummary(skill), skill });
    }
  }

  // namespace + namespacePrefix: бандл-скиллы доступны как `<bundle>:<skill>`
  // только тогда, когда bare-имя скилла уже занято (builtin/skill) — «конфликтующие имена».
  if (conflict.mode === 'namespace' && conflict.namespacePrefix) {
    for (const bundle of bundles) {
      for (const skillName of bundle.skills) {
        const skill = skills.find((s) => s.skillName === skillName);
        if (!skill) {
          diagnostics.push({
            level: 'warning', code: 'missing-skill', command: `${bundle.name}:${skillName}`,
            message: `bundle "${bundle.name}": скилл "${skillName}" не найден`,
          });
          continue;
        }
        // В namespace bare — builtin > skill, поэтому скилл, чьё имя совпадает
        // со встроенной командой, иначе недостижим → доступен как `<bundle>:<skill>`.
        if (!builtinByName.has(skillName)) continue;
        emit({
          kind: 'skill',
          summary: { ...skillSummary(skill), name: `${bundle.name}:${skillName}`, bundle: bundle.name },
          skill,
        });
      }
    }
  }

  return { entries, diagnostics };
}

export function templateSummary(template: TemplateCommand): CommandSummary {
  return {
    name: template.name,
    kind: 'template',
    description: template.description,
    ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
    available: true,
  };
}

export function skillSummary(skill: CommandSkillEntry): CommandSummary {
  return {
    name: skill.commandName,
    kind: 'skill',
    description: skill.description,
    available: skill.available,
    ...(skill.available ? {} : { unavailableReason: 'capabilities' as const }),
  };
}

export function bundleSummary(bundle: SkillBundle): CommandSummary {
  return {
    name: bundle.name,
    kind: 'bundle',
    description: bundle.description,
    skills: [...bundle.skills],
    available: true,
  };
}

export function builtinSummary(name: BuiltinCommandName): CommandSummary {
  return BUILTIN_COMMANDS.find((c) => c.name === name)!;
}

export { isBuiltinCommand };
