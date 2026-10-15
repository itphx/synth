import { SKILL_NAME_REGEX, SKILL_NAME_MAX, parseFrontmatter } from '@itphx/synth-shared';
import type { CommandDiagnostic, SkillBundle } from '@itphx/synth-shared';
import type { LoadedBundle } from './types.js';

export interface ParsedBundle {
  bundle?: SkillBundle;
  diagnostics: CommandDiagnostic[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * ADR-046 §7.3: парсинг YAML-файла bundle. Использует общий толерантный
 * frontmatter-парсер (`js-yaml` в shared) — новой зависимости в core нет.
 */
export function parseBundleFile(raw: string, expectedName: string): ParsedBundle {
  const diagnostics: CommandDiagnostic[] = [];
  const wrapped = raw.trimStart().startsWith('---') ? raw : `---\n${raw}\n---\n`;
  const fm = parseFrontmatter(wrapped);
  const data = fm.data;

  const name = asString(data.name) ?? expectedName;
  if (!name || name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(name)) {
    diagnostics.push({
      level: 'error', code: 'invalid-bundle', command: expectedName,
      message: `недопустимое имя bundle "${name}"`,
    });
    return { diagnostics };
  }

  const skillsRaw = data.skills;
  const skills = Array.isArray(skillsRaw)
    ? skillsRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];
  if (skills.length === 0) {
    diagnostics.push({
      level: 'error', code: 'invalid-bundle', command: name,
      message: `bundle "${name}" не содержит скиллов`,
    });
    return { diagnostics };
  }

  const bundle: SkillBundle = {
    name,
    description: asString(data.description) ?? '',
    skills,
    instruction: asString(data.instruction),
  };
  return { bundle, diagnostics };
}

export interface LoadBundleOptions {
  projectWorkspace?: string;
  maxRenderedBytes: number;
}

/**
 * ADR-046 §7.3: `/bundle-name` грузит N тел скиллов одним сообщением.
 * Несуществующие/недоступные скиллы пропускаются с диагностикой (bundle не
 * ломается целиком). Агрегат ограничен `maxRenderedBytes`.
 */
export async function loadBundle(
  bundle: SkillBundle,
  loadSkillContent: (name: string, opts?: { projectWorkspace?: string }) => Promise<{ content: string; name: string } | undefined>,
  opts: LoadBundleOptions,
): Promise<LoadedBundle> {
  const diagnostics: CommandDiagnostic[] = [];
  const parts: string[] = [];
  const loaded: string[] = [];

  if (bundle.instruction && bundle.instruction.trim().length > 0) {
    parts.push(bundle.instruction.trim());
  }

  for (const skillName of bundle.skills) {
    const content = await loadSkillContent(skillName, { projectWorkspace: opts.projectWorkspace }).catch(() => undefined);
    if (!content) {
      diagnostics.push({
        level: 'warning', code: 'missing-skill', command: bundle.name,
        message: `bundle "${bundle.name}": скилл "${skillName}" не найден или недоступен`,
      });
      continue;
    }
    parts.push(content.content);
    loaded.push(content.name);
  }

  let prompt = parts.join('\n\n');
  if (Buffer.byteLength(prompt, 'utf-8') > opts.maxRenderedBytes) {
    let bytes = 0;
    let end = prompt.length;
    for (let i = 0; i < prompt.length; i++) {
      const b = Buffer.byteLength(prompt[i]!, 'utf-8');
      if (bytes + b > opts.maxRenderedBytes) { end = i; break; }
      bytes += b;
    }
    prompt = prompt.slice(0, end);
    diagnostics.push({
      level: 'warning', code: 'read-error', command: bundle.name,
      message: `bundle "${bundle.name}" обрезан до ${opts.maxRenderedBytes} байт`,
    });
  }

  return { bundle, prompt, skills: loaded, diagnostics };
}
