import { parseFrontmatter } from '@itphx/synth-shared';
import type { CommandDiagnostic } from '@itphx/synth-shared';
import type { TemplateCommand } from './types.js';

export interface ParsedTemplateCommand {
  command?: TemplateCommand;
  diagnostics: CommandDiagnostic[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === 'string');
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * AD-046 §7.2: парсинг шаблонной `.md`-команды. Frontmatter:
 * `description`, `argument-hint`, `agent`, `model`, `allowed-tools` (advisory).
 * Имя команды — `name` из frontmatter либо имя файла без `.md`.
 */
export function parseCommandFile(
  raw: string,
  fileName: string,
  dir: string,
  file: string,
  origin: TemplateCommand['origin'],
  mtimeMs: number,
): ParsedTemplateCommand {
  const fallbackName = fileName.replace(/\.md$/i, '');
  const fm = parseFrontmatter(raw);
  const diagnostics: CommandDiagnostic[] = [];

  if (!fm.hasFrontmatter) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-frontmatter',
      message: `команда "${fallbackName}": отсутствует YAML frontmatter (--- … ---)`,
      command: fallbackName,
      path: file,
    });
    return { diagnostics };
  }

  for (const issue of fm.issues) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-frontmatter',
      message: `команда "${fallbackName}": ${issue.message}`,
      command: fallbackName,
      path: file,
    });
  }

  const data = fm.data;
  const name = (asString(data.name) ?? fallbackName).trim();
  const description = asString(data.description) ?? '';

  if (!name) {
    diagnostics.push({ level: 'error', code: 'missing-name', message: 'не задано имя команды', path: file });
    return { diagnostics };
  }

  const command: TemplateCommand = {
    name,
    description,
    argumentHint: asString(data['argument-hint']),
    agent: asString(data.agent),
    model: asString(data.model),
    allowedTools: asStringArray(data['allowed-tools']),
    body: fm.body.trim(),
    file,
    dir,
    origin,
    mtimeMs,
  };
  return { command, diagnostics };
}
