import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from '@itphx/synth-shared';
import { isProjectTrusted } from '../skills/trust.js';
import { SNIPPET_NAME_REGEX } from './types.js';
import type {
  Snippet,
  SnippetDiagnostic,
  SnippetScanResult,
  SnippetSource,
} from './types.js';

/**
 * ADR-126 §4: источники сниппетов — три уровня, приоритет
 * `user > project > instance`.
 *
 * | Уровень | Где хранится |
 * |---|---|
 * | `instance` | `{dataDir}/snippets/<name>.md` |
 * | `project` | `{project.workspace}/.synth/snippets/<name>.md` |
 * | `user` | `{dataDir}/snippets/users/<userId>/<name>.md` |
 *
 * Каталог instance — плоский: пользовательские сниппеты лежат в подкаталоге
 * `users/`, который плоский скан пропускает (сканируются только файлы `*.md`).
 */

/** Подкаталог проекта для проектных сниппетов (ADR-126 §4). */
export const PROJECT_SNIPPETS_DIR = join('.synth', 'snippets');

/** Каталог сниппетов инстанса внутри `dataDir`. */
export const INSTANCE_SNIPPETS_DIR = 'snippets';

/** Подкаталог пользовательских сниппетов внутри каталога инстанса. */
export const USER_SNIPPETS_SUBDIR = 'users';

/** Каталог сниппетов инстанса: `{dataDir}/snippets`. */
export function instanceSnippetsDir(dataDir: string): string {
  return join(dataDir, INSTANCE_SNIPPETS_DIR);
}

/** Каталог сниппетов пользователя: `{dataDir}/snippets/users/<userId>`. */
export function userSnippetsDir(dataDir: string, userId: string): string {
  return join(instanceSnippetsDir(dataDir), USER_SNIPPETS_SUBDIR, userId);
}

/** Каталог проектных сниппетов: `{workspace}/.synth/snippets`. */
export function projectSnippetsDir(projectWorkspace: string): string {
  return join(projectWorkspace, PROJECT_SNIPPETS_DIR);
}

export interface BuildSnippetSourcesOptions {
  dataDir: string;
  /** Пользователь (уровень `user`). Пусто — пользовательский уровень не виден. */
  userId?: string;
  /** Рабочий каталог проекта (уровень `project`). Пусто — уровень не виден. */
  projectWorkspace?: string;
  /** `config.skills.trustedProjectDirs` — project-trust гейт. */
  trustedProjectDirs?: readonly string[];
  home?: string;
}

/**
 * ADR-126 §4: источники в порядке приоритета `user > project > instance`.
 * Проектный уровень доверен, только если доверен каталог проекта
 * (ADR-046 §4.4 — тот же гейт, что у скиллов и команд).
 */
export function buildSnippetSources(opts: BuildSnippetSourcesOptions): SnippetSource[] {
  const home = opts.home ?? homedir();
  const sources: SnippetSource[] = [];

  const userId = opts.userId?.trim();
  if (userId) {
    sources.push({ scope: 'user', dir: userSnippetsDir(opts.dataDir, userId), trusted: true });
  }

  const workspace = opts.projectWorkspace?.trim();
  if (workspace) {
    sources.push({
      scope: 'project',
      dir: projectSnippetsDir(workspace),
      trusted: isProjectTrusted(workspace, opts.trustedProjectDirs ?? [], home),
    });
  }

  sources.push({ scope: 'instance', dir: instanceSnippetsDir(opts.dataDir), trusted: true });
  return sources;
}

export interface ParsedSnippet {
  snippet?: Snippet;
  diagnostics: SnippetDiagnostic[];
}

/**
 * Разбор файла сниппета: frontmatter (`name`, `description`, `aliases`) + тело.
 *
 * Толерантный разбор (как у команд/скиллов): битый YAML — диагностика, а не
 * исключение; недопустимое имя — сниппет не попадает в реестр (иначе его
 * нельзя вызвать по `#name`).
 */
export function parseSnippetFile(
  raw: string,
  fileName: string,
  source: SnippetSource,
  file: string,
): ParsedSnippet {
  const fallbackName = fileName.replace(/\.md$/i, '');
  const fm = parseFrontmatter(raw);
  const diagnostics: SnippetDiagnostic[] = [];

  if (fm.hasFrontmatter && fm.issues.length > 0) {
    for (const issue of fm.issues) {
      diagnostics.push({
        level: 'error',
        code: 'invalid-frontmatter',
        message: `сниппет "${fallbackName}": ${issue.message}`,
        snippet: fallbackName,
        path: file,
      });
    }
    return { diagnostics };
  }

  const data = fm.data;
  const name = (asString(data.name) ?? fallbackName).trim();
  if (!SNIPPET_NAME_REGEX.test(name)) {
    diagnostics.push({
      level: 'error',
      code: 'invalid-frontmatter',
      message:
        `сниппет "${fallbackName}": недопустимое имя "${name}" ` +
        '(ожидается [a-z0-9][a-z0-9_-]{0,79})',
      snippet: fallbackName,
      path: file,
    });
    return { diagnostics };
  }

  const aliases: string[] = [];
  for (const rawAlias of asStringArray(data.aliases)) {
    const alias = rawAlias.trim();
    if (!SNIPPET_NAME_REGEX.test(alias)) {
      diagnostics.push({
        level: 'warning',
        code: 'invalid-frontmatter',
        message: `сниппет "${name}": алиас "${alias}" отброшен (недопустимое имя)`,
        snippet: name,
        path: file,
      });
      continue;
    }
    if (alias === name || aliases.includes(alias)) continue;
    aliases.push(alias);
  }

  const snippet: Snippet = {
    name,
    description: asString(data.description),
    aliases,
    body: fm.body.trim(),
    scope: source.scope,
    file,
    trusted: source.trusted,
  };
  return { snippet, diagnostics };
}

/**
 * Сканирует каталог-источник: плоские `*.md`-файлы. Отсутствие каталога — не
 * ошибка (источник просто не даёт сниппетов).
 */
export async function scanSnippetSource(source: SnippetSource): Promise<SnippetScanResult> {
  const snippets: Snippet[] = [];
  const diagnostics: SnippetDiagnostic[] = [];

  let entries;
  try {
    entries = await readdir(source.dir, { withFileTypes: true });
  } catch {
    return { snippets, diagnostics };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const file = join(source.dir, entry.name);
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch {
      diagnostics.push({
        level: 'warning',
        code: 'read-error',
        message: `не удалось прочитать ${file}`,
        path: file,
      });
      continue;
    }
    const parsed = parseSnippetFile(raw, entry.name, source, file);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.snippet) snippets.push(parsed.snippet);
  }

  return { snippets, diagnostics };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}
