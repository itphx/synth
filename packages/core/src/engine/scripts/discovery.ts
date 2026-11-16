import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { ScriptDiagnostic } from '@itphx/synth-shared';
import { expandHome, isProjectTrusted } from '../skills/trust.js';
import { parseScriptFile } from './parser.js';
import type { ScriptScanResult, ScriptSource, TemplateScript } from './types.js';

/**
 * ADR-126 §5: discovery реестра скриптов.
 *
 * Источники (по приоритету): `.synth/scripts` проекта > `{dataDir}/scripts`
 * (инстанс) > `config.scripts.paths`. Trust-гейт — тот же, что у скиллов и
 * команд (ADR-126 §9): недоверенный проектный каталог виден в реестре, но
 * скрипты из него не запускаются.
 */

/** Подкаталог проекта для деклараций скриптов (ADR-126 §5). */
export const PROJECT_SCRIPTS_DIR = join('.synth', 'scripts');

/** Каталог скриптов инстанса (`{dataDir}/scripts`). */
export const INSTANCE_SCRIPTS_DIR = 'scripts';

/** Каталог исполняемых файлов проекта — источник подсказки «объявите скрипт». */
export const PROJECT_EXECUTABLES_DIR = 'scripts';

/**
 * Предел обхода файлов при поиске необъявленных исполняемых файлов.
 *
 * Обход best-effort: он подсказывает «объявите скрипт», а не сканирует
 * репозиторий — больше 200 файлов смотреть незачем.
 */
export const UNDECLARED_EXECUTABLES_SCAN_LIMIT = 200;

export interface BuildScriptSourcesOptions {
  /** Каталог данных инстанса. */
  dataDir: string;
  /** Рабочий каталог проекта (`project.workspace`). Нет — только instance/config. */
  projectWorkspace?: string;
  /** `config.scripts.paths`. */
  configPaths?: readonly string[];
  /** `config.skills.trustedProjectDirs` — доверенные проектные каталоги. */
  trustedProjectDirs?: readonly string[];
  /** Домашний каталог (раскрытие `~` в путях источников). */
  home?: string;
}

/**
 * ADR-126 §5: источники скриптов в порядке приоритета
 * `project > instance > config.paths`.
 */
export function buildScriptSources(opts: BuildScriptSourcesOptions): ScriptSource[] {
  const home = opts.home ?? homedir();
  const sources: ScriptSource[] = [];

  if (opts.projectWorkspace && opts.projectWorkspace.trim().length > 0) {
    sources.push({
      origin: 'project',
      dir: join(opts.projectWorkspace, PROJECT_SCRIPTS_DIR),
      trusted: isProjectTrusted(opts.projectWorkspace, opts.trustedProjectDirs ?? [], home),
    });
  }

  sources.push({
    origin: 'instance',
    dir: join(opts.dataDir, INSTANCE_SCRIPTS_DIR),
    trusted: true,
  });

  for (const raw of opts.configPaths ?? []) {
    const expanded = expandHome(raw.trim(), home);
    if (!expanded) continue;
    sources.push({ origin: 'config', dir: expanded, trusted: true });
  }
  return sources;
}

/**
 * Сканирует каталог-источник: плоские `*.md`-декларации.
 *
 * Отсутствие каталога — не ошибка (источник вклада не даёт). Ошибка чтения
 * файла — диагностика `read-error`, discovery остальных не ломает.
 */
export async function scanScriptSource(source: ScriptSource): Promise<ScriptScanResult> {
  const scripts: TemplateScript[] = [];
  const diagnostics: ScriptDiagnostic[] = [];

  let entries;
  try {
    entries = await readdir(source.dir, { withFileTypes: true });
  } catch {
    return { scripts, diagnostics };
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
        level: 'warning',
        code: 'read-error',
        // Путь — в поле `path` (его relativize'ит сервис); в тексте пути нет:
        // наружу абсолютные пути не отдаются.
        message: `не удалось прочитать декларацию скрипта "${entry.name}"`,
        path: file,
      });
      continue;
    }
    const parsed = parseScriptFile(raw, entry.name, source.dir, file, source.origin, mtimeMs);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.script) {
      scripts.push({ ...parsed.script, trusted: source.trusted ?? true });
    }
  }

  return { scripts, diagnostics };
}

/**
 * ADR-126 §5: дедупликация first-wins по имени. Проигравшие — `shadowed`.
 * Недоверенные — с диагностикой `untrusted` (видны в реестре, но
 * `available: false` — запустить нельзя).
 */
export function mergeScriptScans(
  entries: ReadonlyArray<{ source: ScriptSource; result: ScriptScanResult }>,
): ScriptScanResult {
  const scripts: TemplateScript[] = [];
  const diagnostics: ScriptDiagnostic[] = [];
  const byName = new Map<string, TemplateScript>();

  for (const { source, result } of entries) {
    diagnostics.push(...result.diagnostics);
    for (const script of result.scripts) {
      const existing = byName.get(script.name);
      if (existing) {
        diagnostics.push({
          level: 'warning',
          code: 'shadowed',
          script: script.name,
          path: script.file,
          message: `скрипт "${script.name}" перекрыт источником ${existing.origin}`,
        });
        continue;
      }
      byName.set(script.name, script);
      scripts.push(script);
      if (!script.trusted) {
        diagnostics.push({
          level: 'warning',
          code: 'untrusted',
          script: script.name,
          path: script.file,
          message: `источник "${source.origin}" недоверенный: скрипт виден в реестре, но не запускается`,
        });
      }
    }
  }
  return { scripts, diagnostics };
}

/**
 * ADR-126 §5: исполняемые файлы проекта без одноимённой декларации.
 *
 * Это **подсказка** («объявите скрипт»), а не исполняемая запись: файл
 * остаётся обычным файлом репозитория, интерпретатор и аргументы угадывать
 * нельзя (ADR-126 §5 «Формат — декларация, а не сам скрипт»).
 *
 * Best-effort: ошибки чтения игнорируются молча, каталоги не создаются,
 * обход ограничен {@link UNDECLARED_EXECUTABLES_SCAN_LIMIT} файлами.
 *
 * @returns относительные пути (от корня проекта) необъявленных файлов.
 */
export async function listUndeclaredExecutables(workspaceDir: string): Promise<string[]> {
  const declared = await collectDeclaredScriptNames(join(workspaceDir, PROJECT_SCRIPTS_DIR));
  const found: string[] = [];
  let budget = UNDECLARED_EXECUTABLES_SCAN_LIMIT;

  // Каталог `scripts/` и корень проекта — два места, где обычно лежат
  // исполняемые файлы (`scripts/dev.sh`, `./release`).
  const dirs = [join(workspaceDir, PROJECT_EXECUTABLES_DIR), workspaceDir];
  for (const dir of dirs) {
    if (budget <= 0) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget <= 0) break;
      if (!entry.isFile()) continue;
      // Бюджет обхода считаем по **всем** файлам, а не только по исполняемым:
      // иначе «лимит 200 файлов» не ограничивал бы работу.
      budget -= 1;
      const file = join(dir, entry.name);
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      if ((info.mode & 0o111) === 0) continue;
      const stem = entry.name.replace(/\.[^.]+$/, '');
      if (declared.has(entry.name) || declared.has(stem)) continue;
      found.push(relative(workspaceDir, file));
    }
  }
  return found;
}

/**
 * Имена объявленных скриптов проекта — чтобы не считать «необъявленным»
 * файл, для которого уже есть декларация.
 */
async function collectDeclaredScriptNames(scriptsDir: string): Promise<Set<string>> {
  const names = new Set<string>();
  let entries;
  try {
    entries = await readdir(scriptsDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const file = join(scriptsDir, entry.name);
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseScriptFile(raw, entry.name, scriptsDir, file, 'project', 0);
    if (parsed.script) names.add(parsed.script.name);
    else names.add(entry.name.replace(/\.md$/i, ''));
  }
  return names;
}
