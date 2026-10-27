import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SkillSummary } from '@itphx/synth-shared';
import { t as sm } from '../system-messages.js';
import { BLOB_SKILL_DIR_PREFIX } from './types.js';
import type { DiscoveredSkill, LoadedSkill } from './types.js';

/** ADR-046 §5: не более 10 supporting-файлов в выдаче тула `skill`. */
export const MAX_SKILL_FILES = 10;
/** ADR-046 §5: обрезка вывода — 50 KB. */
export const SKILL_MAX_BYTES = 50 * 1024;
/** ADR-046 §5: обрезка вывода — 2000 строк. */
export const SKILL_MAX_LINES = 2000;

/** Рекурсивный список файлов скилла (относительные пути, без `SKILL.md`), отсортирован. */
export async function collectSupportingFiles(skillDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(skillDir, rel) : skillDir;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile() && childRel !== 'SKILL.md') {
        out.push(childRel);
      }
    }
  }
  await walk('');
  return out.sort();
}

/**
 * ADR-116: supporting-файлы скилла по его источнику. Порт-источник (instance из
 * SQL/blobs) — `listFiles` порта; ФС-источник (project/config/external/url) —
 * обход каталога.
 */
export async function listSupportingFiles(skill: DiscoveredSkill): Promise<string[]> {
  const repository = skill.source.repository;
  if (repository) {
    const files = await repository.listFiles(skill.name);
    return files.map((file) => file.path);
  }
  return collectSupportingFiles(skill.dir);
}

/** Безопасно резолвит supporting-файл внутри каталога скилла (защита от `..`). */
export function resolveSkillFile(skillDir: string, relPath: string): string | null {
  const base = resolve(skillDir);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
  return target;
}

/** Читает supporting-файл; `undefined` — нет файла или небезопасный путь. */
export async function readSupportingFile(
  skillDir: string,
  relPath: string,
): Promise<string | undefined> {
  const target = resolveSkillFile(skillDir, relPath);
  if (!target) return undefined;
  try {
    return await readFile(target, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * ADR-116: чтение supporting-файла скилла по источнику: порт (`readFile`) либо
 * ФС (`readSupportingFile`). Нет файла/небезопасный путь — `undefined`.
 */
export async function readSkillSupportingFile(
  skill: DiscoveredSkill,
  relPath: string,
): Promise<string | undefined> {
  const repository = skill.source.repository;
  if (repository) {
    const content = await repository.readFile(skill.name, relPath);
    return content ?? undefined;
  }
  return readSupportingFile(skill.dir, relPath);
}

/**
 * ADR-046 §5: обрезка вывода тула `skill` — 50 KB / 2000 строк (локально,
 * аналог ToolOutputStore).
 */
export function truncateSkillOutput(content: string): string {
  let out = content;
  let truncated = false;

  const lines = out.split('\n');
  if (lines.length > SKILL_MAX_LINES) {
    out = lines.slice(0, SKILL_MAX_LINES).join('\n');
    truncated = true;
  }

  if (Buffer.byteLength(out, 'utf-8') > SKILL_MAX_BYTES) {
    let bytes = 0;
    let end = out.length;
    for (let i = 0; i < out.length; i++) {
      const b = Buffer.byteLength(out[i]!, 'utf-8');
      if (bytes + b > SKILL_MAX_BYTES) {
        end = i;
        break;
      }
      bytes += b;
    }
    out = out.slice(0, end);
    truncated = true;
  }

  return truncated ? out + sm('tool.output_truncated') : out;
}

/**
 * ADR-046 §5 (по образцу opencode): `<skill_content>` + тело + base directory +
 * `<skill_files>` (до 10 путей, без содержимого).
 *
 * ADR-116: у instance-скиллов из порта ФС-пути нет (`dir` — `blob:skills/<name>`),
 * поэтому вместо base directory подсказка читать файлы тулом `skill`
 * (`file_path`).
 */
export function buildSkillContentBlock(
  summary: SkillSummary,
  body: string,
  dir: string,
  files: readonly string[],
): string {
  const shown = files.slice(0, MAX_SKILL_FILES);
  const lines: string[] = [
    `<skill_content name="${summary.name}">`,
    `# Skill: ${summary.name}`,
    '',
    body.trim(),
    '',
  ];
  if (dir.startsWith(BLOB_SKILL_DIR_PREFIX)) {
    lines.push(
      'This skill is stored in the instance store (no filesystem directory).',
      'Read its supporting files with the `skill` tool (name + file_path).',
    );
  } else {
    lines.push(
      `Base directory for this skill: ${pathToFileURL(dir).href}`,
      'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
    );
  }
  if (shown.length > 0) {
    lines.push('<skill_files>');
    for (const f of shown) lines.push(`<file>${f}</file>`);
    lines.push('</skill_files>');
  }
  lines.push('</skill_content>');
  return truncateSkillOutput(lines.join('\n'));
}

/** Загружает тело + supporting-файлы найденного скилла. */
export async function loadSkill(skill: DiscoveredSkill, summary: SkillSummary): Promise<LoadedSkill> {
  const files = await listSupportingFiles(skill);
  return {
    summary,
    meta: skill.meta,
    body: skill.body,
    dir: skill.dir,
    files,
  };
}

/** mtime `SKILL.md` (best-effort; 0 при ошибке). */
export async function skillFileMtime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}
