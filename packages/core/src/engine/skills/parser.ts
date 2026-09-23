import {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  SKILL_NAME_REGEX,
  parseFrontmatter,
} from '@itphx/synth-shared';
import type { SkillIssue, SkillMeta, SkillMode, SkillScope, SkillTrigger } from '@itphx/synth-shared';
import { computeInvocation } from './scope.js';

export interface ParsedSkill {
  name: string;
  meta: SkillMeta;
  body: string;
}

export interface ParseSkillResult {
  skill?: ParsedSkill;
  issues: SkillIssue[];
}

/** Известные top-level ключи frontmatter (остальные — в `meta.extra`). */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'when_to_use',
  'model',
  'agent',
  'argument-hint',
  'user-invocable',
  'disable-model-invocation',
]);

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

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** Нормализует распарсенный frontmatter в `SkillMeta` (толерантно к неизвестным ключам). */
function normalizeMeta(data: Record<string, unknown>): SkillMeta {
  const userInvocable = asBoolean(data['user-invocable']) ?? true;
  const disableModelInvocation = asBoolean(data['disable-model-invocation']) ?? false;

  const metadata = (typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata))
    ? data.metadata as Record<string, unknown>
    : undefined;
  const synthRaw = metadata && typeof metadata.synth === 'object' && metadata.synth !== null && !Array.isArray(metadata.synth)
    ? metadata.synth as Record<string, unknown>
    : {};

  const scopeRaw = synthRaw.scope;
  const scope = scopeRaw === 'instance' || scopeRaw === 'project' ? scopeRaw as SkillScope : undefined;
  const triggerRaw = synthRaw.trigger;
  const trigger = triggerRaw === 'manual' || triggerRaw === 'auto' ? triggerRaw as SkillTrigger : undefined;
  const modeRaw = synthRaw.mode;
  const mode = modeRaw === 'plan' || modeRaw === 'act' || modeRaw === 'any' ? modeRaw as SkillMode : undefined;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }

  return {
    name: String(data.name ?? ''),
    description: String(data.description ?? ''),
    license: asString(data.license),
    compatibility: asString(data.compatibility),
    metadata,
    allowedTools: asStringArray(data['allowed-tools']),
    whenToUse: asString(data.when_to_use),
    model: asString(data.model),
    agent: asString(data.agent),
    argumentHint: asString(data['argument-hint']),
    userInvocable,
    disableModelInvocation,
    invocation: computeInvocation(userInvocable, disableModelInvocation),
    tags: asStringArray(synthRaw.tags),
    category: asString(synthRaw.category),
    relatedSkills: asStringArray(synthRaw.related_skills),
    requiresCapabilities: asStringArray(synthRaw.requires_capabilities) as SkillMeta['requiresCapabilities'],
    requiresToolsets: asStringArray(synthRaw.requires_toolsets),
    fallbackForCapabilities: asStringArray(synthRaw.fallback_for_capabilities) as SkillMeta['fallbackForCapabilities'],
    agents: asStringArray(synthRaw.agents),
    groups: asStringArray(synthRaw.groups),
    scope,
    trigger,
    command: asString(synthRaw.command),
    mode,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

/**
 * AD-046 §3.2: парсинг и валидация `SKILL.md`.
 *
 * Обязательные поля — `name` (regex 1–64, совпадает с именем каталога) и
 * `description` (1–1024). Невалидный скилл не попадает в реестр, но проблема
 * фиксируется в issues и не ломает discovery остальных.
 */
export function parseSkillFile(raw: string, dirName: string): ParseSkillResult {
  const fm = parseFrontmatter(raw);
  if (!fm.hasFrontmatter) {
    return {
      issues: [{
        code: 'missing-frontmatter',
        message: 'отсутствует YAML frontmatter (--- … ---)',
      }],
    };
  }

  const meta = normalizeMeta(fm.data);
  const issues: SkillIssue[] = [...fm.issues];

  const name = meta.name.trim();
  if (!name) {
    issues.push({ code: 'missing-name', message: 'обязательное поле "name" не задано' });
  } else if (name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(name)) {
    issues.push({
      code: 'invalid-name',
      message: `недопустимое имя скилла "${name}" (1–${SKILL_NAME_MAX}, ^[a-z0-9]+(-[a-z0-9]+)*$)`,
    });
  } else if (name !== dirName) {
    issues.push({
      code: 'name-mismatch',
      message: `name "${name}" не совпадает с именем каталога "${dirName}"`,
    });
  }

  const description = meta.description.trim();
  if (!description) {
    issues.push({ code: 'missing-description', message: 'обязательное поле "description" не задано' });
  } else if (description.length > SKILL_DESCRIPTION_MAX) {
    issues.push({
      code: 'invalid-description',
      message: `description длиннее ${SKILL_DESCRIPTION_MAX} символов`,
    });
  }

  // `none` — скилл нигде не виден, но остаётся в реестре для диагностики (§6.1).
  if (meta.invocation === 'none') {
    issues.push({
      code: 'none-invocation',
      message: 'user-invocable=false и disable-model-invocation=true — скилл недоступен ни пользователю, ни модели',
    });
  }

  const hasError = issues.some((i) => i.code !== 'none-invocation');
  if (hasError) return { issues };

  return {
    skill: { name, meta: { ...meta, name, description }, body: fm.body },
    issues,
  };
}
