/**
 * PROP-126 §2: `@file` — файл из рабочего каталога проекта/сессии.
 *
 * Лексер (`input-surface/parser.ts`) помечает `@path` (есть `/` или `.`) как
 * `kind: 'file'`. Резолвер читает **текстовый** файл внутри workspace и
 * добавляет его содержимое отдельным блоком; бинарь/слишком большой файл —
 * `invalid` (роут отвечает 400, без частичной доставки).
 *
 * Сниппеты (`#`) и команды (`/`) сюда не входят: вызывающий передаёт только
 * агентскую часть и раскрывает сниппеты отдельно.
 */

import { readFile, stat } from 'node:fs/promises';
import { parseInput } from './parser.js';
import { looksBinary, resolveInDir } from '../commands/template.js';

/** Дефолтный лимит чтения файла — 5 МиБ (совпадает с `DEFAULT_MAX_READ_BYTES` fs-роутов). */
export const DEFAULT_FILE_MENTION_MAX_BYTES = 5 * 1024 * 1024;

export interface InvalidFileMention {
  /** Исходный `@path` (без префикса). */
  path: string;
  /** Машинная причина: `no_workspace` | `outside` | `not_found` | `not_file` | `too_large` | `binary` | `read_error`. */
  reason: string;
}

export interface FileMentionsResult {
  /** Исходный текст + блоки `<file path="…">…</file>` (в порядке появления). */
  text: string;
  /** Успешно прочитанные пути (относительные, как в `@path`). */
  files: string[];
  /** Непрочитанные/недопустимые упоминания — вызывающий решает (обычно 400). */
  invalid: InvalidFileMention[];
}

/**
 * Читает `@file`-упоминания и добавляет их содержимое к тексту.
 *
 * Файлы разрешаются только внутри `workspace` (containment через
 * `resolveInDir`); только текстовые; один и тот же путь читается один раз.
 */
export async function resolveFileMentions(
  text: string,
  workspace: string | undefined,
  maxBytes = DEFAULT_FILE_MENTION_MAX_BYTES,
): Promise<FileMentionsResult> {
  const mentions = parseInput(text).mentions.filter((mention) => mention.kind === 'file');
  if (mentions.length === 0) return { text, files: [], invalid: [] };

  const files: string[] = [];
  const invalid: InvalidFileMention[] = [];
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const mention of mentions) {
    const rel = mention.id;
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);

    if (!workspace) {
      invalid.push({ path: rel, reason: 'no_workspace' });
      continue;
    }
    const target = resolveInDir(workspace, rel);
    if (!target) {
      invalid.push({ path: rel, reason: 'outside' });
      continue;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) {
        invalid.push({ path: rel, reason: 'not_file' });
        continue;
      }
      if (info.size > maxBytes) {
        invalid.push({ path: rel, reason: 'too_large' });
        continue;
      }
      const buffer = await readFile(target);
      if (looksBinary(buffer)) {
        invalid.push({ path: rel, reason: 'binary' });
        continue;
      }
      files.push(rel);
      blocks.push(`<file path="${rel.replaceAll('"', '&quot;')}">\n${buffer.toString('utf-8')}\n</file>`);
    } catch {
      invalid.push({ path: rel, reason: 'read_error' });
    }
  }

  if (blocks.length === 0) return { text, files, invalid };
  return { text: `${text}\n\n${blocks.join('\n\n')}`, files, invalid };
}
