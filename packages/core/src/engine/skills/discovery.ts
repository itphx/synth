import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillDiagnostic } from '@itphx/synth-shared';
import { parseSkillFile } from './parser.js';
import { expandHome, isProjectTrusted } from './trust.js';
import type { DiscoveredSkill, SkillScanResult, SkillSource } from './types.js';

/** Подкаталог проекта для проектных скиллов (AD-046 §4.1). */
export const PROJECT_SKILLS_DIR = join('.synth', 'skills');

/**
 * AD-046 §4.2: внешние локальные каталоги совместимости в рабочем каталоге
 * проекта — read-only discovery, trust наследуется от проектного каталога.
 */
export const EXTERNAL_PROJECT_SKILL_DIRS: readonly string[] = [
  join('.opencode', 'skills'),
  join('.opencode', 'skill'),
  join('.claude', 'skills'),
  join('.agents', 'skills'),
];

/** AD-046 §4.2: внешний каталог совместимости в домашней конфигурации (trusted). */
export const EXTERNAL_HOME_SKILL_DIR = join('.config', 'opencode', 'skills');

/** Подкаталог кэша удалённых каталогов внутри `skillsCacheDir`. */
export const URLS_CACHE_SUBDIR = 'urls';

/** Длина hex-среза sha1(url) в слаге кэша. */
export const URLS_CACHE_SLUG_LENGTH = 16;

/** Детерминированный слаг каталога кэша для URL: `sha1(url)[:16]`. */
export function urlCacheSlug(url: string): string {
  return createHash('sha1').update(url.trim()).digest('hex').slice(0, URLS_CACHE_SLUG_LENGTH);
}

/**
 * Детерминированный каталог кэша для URL: `{cacheDir}/urls/<sha1(url)[:16]>`.
 * Должен совпадать с тем, что строит `buildSkillSources` (и `refreshRemoteCatalogs`).
 */
export function urlCacheDir(cacheDir: string, url: string): string {
  return join(cacheDir, URLS_CACHE_SUBDIR, urlCacheSlug(url));
}

/**
 * AD-046 §4.2/§4.3: источник удалённого каталога (кэш `skills.urls`).
 * `trusted: false` — read-only индексация: скиллы видны в реестре/диагностике,
 * но не попадают в каталог для модели и не грузятся (установка/доверие/подписи —
 * AD-068).
 */
export function buildUrlSource(cacheDir: string, url: string): SkillSource {
  return {
    scope: 'instance',
    level: 'system',
    origin: 'url',
    dir: urlCacheDir(cacheDir, url),
    trusted: false,
  };
}

export interface BuildSkillSourcesOptions {
  dataDir: string;
  /** Рабочий каталог проекта (`project.workspace`). Нет — только instance/config. */
  projectWorkspace?: string;
  /** `config.skills.paths`. */
  configPaths?: readonly string[];
  /** `config.skills.urls` — удалённые каталоги (read-only, кэш). */
  urls?: readonly string[];
  /** Корень кэша удалённых каталогов (обычно `{dataDir}/skills-cache`). */
  skillsCacheDir?: string;
  /** `config.skills.trustedProjectDirs`. */
  trustedProjectDirs?: readonly string[];
  home?: string;
}

/**
 * AD-046 §4.2/§4.3: источники discovery в порядке приоритета:
 * `project > instance > config.paths > external > urls`.
 * Внешние локальные каталоги — read-only discovery; удалённые (`urls`) — кэш,
 * `trusted: false`. Отсутствие каталога — не ошибка (см. `scanSkillSource`).
 */
export function buildSkillSources(opts: BuildSkillSourcesOptions): SkillSource[] {
  const home = opts.home ?? homedir();
  const sources: SkillSource[] = [];
  const hasProject = Boolean(opts.projectWorkspace && opts.projectWorkspace.trim().length > 0);
  const projectTrusted = hasProject
    ? isProjectTrusted(opts.projectWorkspace!, opts.trustedProjectDirs ?? [], home)
    : false;

  if (hasProject) {
    sources.push({
      scope: 'project',
      level: 'project',
      origin: 'project',
      dir: join(opts.projectWorkspace!, PROJECT_SKILLS_DIR),
      trusted: projectTrusted,
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

  // AD-046 §4.2: внешние локальные каталоги — read-only discovery (приоритет выше urls).
  if (hasProject) {
    for (const rel of EXTERNAL_PROJECT_SKILL_DIRS) {
      sources.push({
        scope: 'project',
        level: 'project',
        origin: 'external',
        dir: join(opts.projectWorkspace!, rel),
        trusted: projectTrusted,
      });
    }
  }
  sources.push({
    scope: 'instance',
    level: 'system',
    origin: 'external',
    dir: join(home, EXTERNAL_HOME_SKILL_DIR),
    trusted: true,
  });

  // AD-046 §4.2/§4.3: удалённые каталоги — по одному кэш-источнику на URL.
  if (opts.urls && opts.urls.length > 0) {
    const cacheDir = opts.skillsCacheDir ?? join(opts.dataDir, 'skills-cache');
    for (const raw of opts.urls) {
      const url = raw.trim();
      if (!url) continue;
      sources.push(buildUrlSource(cacheDir, url));
    }
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
        const message = source.origin === 'url'
          ? `удалённый каталог "${source.dir}" недоверенный (read-only индексация, установка — AD-068): скилл виден, но не загружается`
          : `каталог "${source.dir}" недоверенный: скилл виден, но не загружается`;
        diagnostics.push({
          level: 'warning',
          code: 'untrusted',
          skill: skill.name,
          dir: skill.dir,
          message,
        });
      }
    }
  }

  return { skills, diagnostics };
}
