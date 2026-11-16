import type { CommandDiagnostic, CommandSummary, SkillBundle } from '@itphx/synth-shared';
import { BUILTIN_COMMANDS, isBuiltinCommand, type BuiltinCommandName } from './builtin.js';
import type {
  CommandConflictConfig,
  CommandEntry,
  TemplateCommand,
} from './types.js';

/**
 * ADR-126 §7: каталог `/`-команд — **только** builtin/template/bundle.
 * Скиллы в `/`-каталог не входят: единственный пользовательский вызов
 * скилла — `$name` (ADR-126 §3), а список доступных скиллов отдаёт
 * встроенная `/skills`.
 */
export interface ResolveCatalogInput {
  templates: readonly TemplateCommand[];
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
    return undefined;
  }
  if (mode === 'namespace') {
    // Скиллов в `/`-каталоге больше нет (ADR-126 §7), поэтому bare-имена —
    // builtin и bundle; шаблоны в этом режиме не перекрывают их.
    if (has.builtin) return 'builtin';
    if (has.bundle) return 'bundle';
    return undefined;
  }
  // bundle-wins
  if (has.bundle) return 'bundle';
  if (has.builtin) return 'builtin';
  if (has.template) return 'template';
  return undefined;
}

function shadowedDiag(name: string, loser: string, winner: string): CommandDiagnostic {
  return {
    level: 'warning', code: 'shadowed', command: name,
    message: `команда "${name}" (${loser}) перекрыта источником ${winner}`,
  };
}

/**
 * ADR-126 §7: единый порядок имён по режиму конфликта. Возвращает
 * упорядоченный список записей + `shadowed`-диагностику проигравших.
 *
 * | Режим | Порядок |
 * |---|---|
 * | `bundle-wins` | bundle > builtin > template |
 * | `conservative` | builtin > template > bundle; bundle↔builtin → error |
 * | `namespace` | bare: builtin > bundle; шаблоны не перекрывают |
 *
 * Скиллы в каталог не входят (вызов — только `$name`), поэтому
 * `commands.conflict.namespacePrefix` больше не создаёт `<bundle>:<skill>`.
 */
export function resolveCatalog(input: ResolveCatalogInput): ResolvedCatalog {
  const { templates, bundles, conflict } = input;
  const entries: CommandEntry[] = [];
  const diagnostics: CommandDiagnostic[] = [];

  const builtinByName = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));
  const templateByName = new Map(templates.map((t) => [t.name, t]));
  const bundleByName = new Map(bundles.map((b) => [b.name, b]));

  const names = new Set<string>();
  for (const n of builtinByName.keys()) names.add(n);
  for (const n of templateByName.keys()) names.add(n);
  for (const n of bundleByName.keys()) names.add(n);

  const emit = (entry: CommandEntry): void => { entries.push(entry); };

  for (const name of [...names].sort()) {
    const has = {
      builtin: builtinByName.has(name),
      template: templateByName.has(name),
      bundle: bundleByName.has(name),
    };
    const winner = kindOrder(conflict.mode, has);
    if (!winner) {
      // `namespace`: bare-имена разрешены только для builtin/bundle; шаблоны
      // не перекрывают их и не получают изобретённых префиксов.
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
      emit({ kind: 'builtin', summary: builtinByName.get(name)! });
    } else if (winner === 'template') {
      if (has.bundle) diagnostics.push(shadowedDiag(name, 'bundle', 'template'));
      const template = templateByName.get(name)!;
      emit({ kind: 'template', summary: templateSummary(template), template });
    } else {
      if (has.template) diagnostics.push(shadowedDiag(name, 'template', 'bundle'));
      const bundle = bundleByName.get(name)!;
      emit({ kind: 'bundle', summary: bundleSummary(bundle), bundle });
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
