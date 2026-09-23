import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillDiagnostic } from '@itphx/synth-shared';
import { parseSkillFile } from './parser.js';
import { expandHome, isProjectTrusted } from './trust.js';
import type { DiscoveredSkill, SkillScanResult, SkillSource } from './types.js';

/** Подкаталог проекта для проектных скиллов (AD-046 §4.1). */
export const PROJECT_SKILLS_DIR = join('.synth', 'skills');

export interface BuildSkillSourcesOptions {
  dataDir: string;
  /** Рабочий каталог проекта (`project.workspace`). Нет — только instance/config. */
  projectWorkspace?: string;
  /** `config.skills.paths`. */
  configPaths?: readonly string[];
  /** `config.skills.trustedProjectDirs`. */
  trustedProjectDirs?: readonly string[];
  home?: string;
}

/**
 * AD-046 §4.2/§4.3: источники discovery в порядке приоритета.
 * `project > instance > config.paths`; внешние каталоги и `skills.urls` в
 * Фазе 1 не подключаются (зафиксированное решение).
 */
export function buildSkillSources(opts: BuildSkillSourcesOptions): SkillSource[] {
  const home = opts.home ?? homedir();
  const sources: SkillSource[] = [];

  if (opts.projectWorkspace && opts.projectWorkspace.trim().length > 0) {
    sources.push({
      scope: 'project',
      level: 'project',
      origin: 'project',
      dir: join(opts.projectWorkspace, PROJECT_SKILLS_DIR),
      trusted: isProjectTrusted(opts.projectWorkspace, opts.trustedProjectDirs ?? [], home),
    });
  }

  sources.push({
    scope: 'instance',
    level: 'system',
    origin: 'instance',
    dir: join(opts.dataDir, 'skills'),
    trusted: true,
  });

  for (const raw of opts.configPaths ?? []) {
    const expanded = expandHome(raw.trim(), home);
    if (!expanded) continue;
    sources.push({
      scope: 'instance',
      level: 'system',
      origin: 'config',
      dir: expanded,
      trusted: true,
    });
  }

  return sources;
}

/**
 * Сканирует каталог-источник: подкаталоги с `SKILL.md`, парсинг и валидация.
 * Отсутствие каталога — не ошибка (источник вклада не даёт).
 */
export async function scanSkillSource(source: SkillSource): Promise<SkillScanResult> {
  const skills: DiscoveredSkill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  let entries;
  try {
    entries = await readdir(source.dir, { withFileTypes: true });
  } catch {
    return { skills, diagnostics };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(source.dir, entry.name);
    const file = join(skillDir, 'SKILL.md');

    let raw: string;
    let mtimeMs: number;
    try {
      const [content, info] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);
      raw = content;
      mtimeMs = info.mtimeMs;
    } catch {
      // нет SKILL.md — не скилл
      continue;
    }

    const parsed = parseSkillFile(raw, entry.name);
    for (const issue of parsed.issues) {
      diagnostics.push({
        ...issue,
        level: issue.code === 'none-invocation' ? 'warning' : 'error',
        skill: entry.name,
        dir: skillDir,
      });
    }
    if (!parsed.skill) continue;

    skills.push({
      name: parsed.skill.name,
      meta: parsed.skill.meta,
      body: parsed.skill.body,
      dir: skillDir,
      file,
      source,
      trusted: source.trusted,
      mtimeMs,
    });
  }

  return { skills, diagnostics };
}

/**
 * AD-046 §4.3: дедупликация по приоритету источников (first-wins). Проигравшие
 * фиксируются в диагностике как `shadowed`. Недоверенные — с диагностикой
 * `untrusted` (видны в реестре, не грузятся).
 */
export function mergeSkillScans(
  entries: ReadonlyArray<{ source: SkillSource; result: SkillScanResult }>,
): SkillScanResult {
  const skills: DiscoveredSkill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, DiscoveredSkill>();

  for (const { source, result } of entries) {
    diagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      const existing = byName.get(skill.name);
      if (existing) {
        diagnostics.push({
          level: 'warning',
          code: 'shadowed',
          skill: skill.name,
          dir: skill.dir,
          message: `скилл "${skill.name}" перекрыт источником ${existing.source.origin} (${existing.dir})`,
        });
        continue;
      }
      byName.set(skill.name, skill);
      skills.push(skill);
      if (!skill.trusted) {
        diagnostics.push({
          level: 'warning',
          code: 'untrusted',
          skill: skill.name,
          dir: skill.dir,
          message: `проектный каталог "${source.dir}" недоверенный: скилл виден, но не загружается`,
        });
      }
    }
  }

  return { skills, diagnostics };
}
