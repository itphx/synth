import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandDiagnostic } from '@itphx/synth-shared';
import { expandHome } from '../skills/trust.js';
import { parseCommandFile } from './parser.js';
import type { CommandScanResult, CommandSource, TemplateCommand } from './types.js';

/** Подкаталог проекта для шаблонных команд (AD-046 §7.1). */
export const PROJECT_COMMANDS_DIR = join('.synth', 'commands');

export interface BuildCommandSourcesOptions {
  dataDir: string;
  projectWorkspace?: string;
  configPaths?: readonly string[];
  home?: string;
}

/**
 * AD-046 §7.1/§4.3: источники шаблонных команд в порядке приоритета
 * `project > instance > config.paths`.
 */
export function buildCommandSources(opts: BuildCommandSourcesOptions): CommandSource[] {
  const home = opts.home ?? homedir();
  const sources: CommandSource[] = [];

  if (opts.projectWorkspace && opts.projectWorkspace.trim().length > 0) {
    sources.push({ origin: 'project', dir: join(opts.projectWorkspace, PROJECT_COMMANDS_DIR) });
  }
  sources.push({ origin: 'instance', dir: join(opts.dataDir, 'commands') });

  for (const raw of opts.configPaths ?? []) {
    const expanded = expandHome(raw.trim(), home);
    if (!expanded) continue;
    sources.push({ origin: 'config', dir: expanded });
  }
  return sources;
}

/** Сканирует каталог-источник: плоские `*.md`-файлы. Отсутствие — не ошибка. */
export async function scanCommandSource(source: CommandSource): Promise<CommandScanResult> {
  const commands: TemplateCommand[] = [];
  const diagnostics: CommandDiagnostic[] = [];

  let entries;
  try {
    entries = await readdir(source.dir, { withFileTypes: true });
  } catch {
    return { commands, diagnostics };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const file = join(source.dir, entry.name);
    let raw: string;
    let mtimeMs: number;
    try {
      const [content, info] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);
      raw = content;
      mtimeMs = info.mtimeMs;
    } catch {
      diagnostics.push({
        level: 'warning', code: 'read-error',
        message: `не удалось прочитать ${file}`, path: file,
      });
      continue;
    }
    const parsed = parseCommandFile(raw, entry.name, source.dir, file, source.origin, mtimeMs);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.command) commands.push(parsed.command);
  }

  return { commands, diagnostics };
}

/**
 * AD-046 §4.3: дедупликация first-wins по имени. Проигравшие — `shadowed`.
 */
export function mergeCommandScans(
  entries: ReadonlyArray<{ source: CommandSource; result: CommandScanResult }>,
): CommandScanResult {
  const commands: TemplateCommand[] = [];
  const diagnostics: CommandDiagnostic[] = [];
  const byName = new Map<string, TemplateCommand>();

  for (const { result } of entries) {
    diagnostics.push(...result.diagnostics);
    for (const command of result.commands) {
      const existing = byName.get(command.name);
      if (existing) {
        diagnostics.push({
          level: 'warning', code: 'shadowed', command: command.name, path: command.file,
          message: `команда "${command.name}" перекрыта источником ${existing.origin} (${existing.file})`,
        });
        continue;
      }
      byName.set(command.name, command);
      commands.push(command);
    }
  }
  return { commands, diagnostics };
}
