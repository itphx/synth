/**
 * М2: сбор корпуса файлов — обход рабочего каталога проекта.
 *
 * Источник `files` индекса: текстовые файлы рабочего каталога (ADR-075:
 * `project.workspace` — он же `ctx.workingDir` у плагинного тула).
 *
 * Правила отбора (docs/MEMORY.md §2.3):
 * - только текстовые расширения (список ниже);
 * - исключаются служебные каталоги (`node_modules`, `.git`, `dist`, `build`,
 *   `.next`, `coverage`, `tmp`) и файлы `*.lock`, `*.min.*`, `*.map`;
 * - бинарные файлы (NUL-байт) и файлы больше лимита размера — пропускаются;
 * - путь документа — **относительный, POSIX** (`docs/api.md`), одинаковый при
 *   любом запуске (иначе индекс не воспроизводим).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Расширения файлов, которые индексируются. */
export const TEXT_EXTENSIONS: readonly string[] = [
  '.md',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.sql',
  '.css',
  '.html',
];

/** Каталоги, которые не индексируются никогда. */
export const EXCLUDED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'tmp',
];

/** Число байт, по которым определяется бинарность файла. */
const BINARY_SNIFF_BYTES = 8000;

/** Файл корпуса. */
export interface CorpusFile {
  /** Относительный POSIX-путь файла (идентификатор документа). */
  path: string;
  /** Содержимое файла (текст). */
  text: string;
}

/** Параметры сбора корпуса. */
export interface CorpusOptions {
  /** Максимальный размер файла (байты); больше — файл пропускается. */
  maxFileBytes: number;
  /** Дополнительные glob-исключения (пути относительно корня). */
  exclude: readonly string[];
  /** Glob-включение (если задан — только совпавшие пути). */
  include?: string;
}

/**
 * Glob → регулярное выражение.
 *
 * Поддерживаются `*` (внутри сегмента), `**` (через сегменты) и `?`
 * (один символ). Остальные символы — литералы.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? '';
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Совпадает ли путь с одним из glob-шаблонов. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/** Текстовое ли расширение файла. */
export function isTextExtension(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith('.min.js') || lower.includes('.min.')) return false;
  if (lower.endsWith('.map')) return false;
  if (lower.endsWith('.lock')) return false;
  return TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Относительный POSIX-путь файла относительно корня корпуса. */
export function toPosixRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/**
 * Собрать текстовые файлы корпуса.
 *
 * Порядок — детерминированный (по пути): одинаковый каталог → одинаковый
 * корпус (иначе индекс не воспроизводим, а выдача дрожит).
 */
export async function collectTextFiles(
  root: string,
  options: CorpusOptions,
): Promise<CorpusFile[]> {
  if (!root) return [];
  const found: CorpusFile[] = [];
  await walk(root, root, options, found);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

/** Рекурсивный обход каталога. */
async function walk(
  root: string,
  dir: string,
  options: CorpusOptions,
  found: CorpusFile[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
      await walk(root, full, options, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isTextExtension(entry.name)) continue;
    const relPath = toPosixRelative(root, full);
    if (options.include && !matchesAnyGlob(relPath, [options.include])) continue;
    if (matchesAnyGlob(relPath, options.exclude)) continue;
    const text = await readTextFile(full, options.maxFileBytes);
    if (text === null) continue;
    found.push({ path: relPath, text });
  }
}

/**
 * Прочитать текстовый файл; `null` — файл неиндексируемый (бинарный, велик,
 * не читается).
 */
async function readTextFile(file: string, maxFileBytes: number): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxFileBytes) return null;
  } catch {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return null;
  }
  const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) return null;
  return buffer.toString('utf-8');
}
