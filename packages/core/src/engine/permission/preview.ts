/**
 * Превью изменений для запроса подтверждения (ADR-029).
 *
 * Пользователь подтверждает запись — он должен видеть, ЧТО именно изменится,
 * а не только сырые аргументы вызова. Для `write_file`/`edit_file`/`patch`
 * считается unified diff по файлам, которые тул собирается изменить.
 *
 * Превью — **украшение**: расчёт всегда «мягкий». Бинарный файл, файл
 * непозволительного объёма, смешанные переводы строк, файл не существует
 * (для `edit_file`/`patch`), неоднозначная правка или любая ошибка → превью
 * просто не добавляется, а запрос подтверждения работает как прежде.
 *
 * Секреты (ADR-036): аргументы вызова приходят обфусцированными (плейсхолдеры
 * `⟦SYNTH_SECRET_N⟧`), а реальные значения известных секретов маскируются в
 * диффе теми же плейсхолдерами через карту обфускации сессии.
 */

import { readFile, stat } from 'node:fs/promises';
import type { PermissionPreview, PermissionPreviewFile } from '@itphx/synth-shared';

import { generateUnifiedDiff } from '../tools/fs-write.js';
import { matchEdit } from '../tools/edit-match.js';
import { resolvePath } from '../tools/path-utils.js';
import { sniffBinary } from '../tools/fs-read.js';
import { detectLineEndings, toLfView } from '../tools/line-endings.js';
import { MAX_TOOL_FILE_BYTES } from '../tools/file-limits.js';

/** Тулы, для которых умеем считать превью изменений. */
const PREVIEWABLE_TOOLS = new Set(['write_file', 'edit_file', 'patch']);

/** Вход расчёта превью. */
export interface PermissionPreviewInput {
  /** Имя тула. */
  toolName: string;
  /** Аргументы вызова (как их видела модель — обфусцированные). */
  args: Record<string, unknown>;
  /** Рабочий каталог сессии (база для относительных путей). */
  workingDir: string;
  /**
   * Карта обфускации сессии (ADR-036): плейсхолдер → реальное значение.
   * Пустая карта — маскировать нечего.
   */
  secretsMap?: Record<string, string>;
}

/**
 * Посчитать превью изменений для запроса подтверждения.
 *
 * Возвращает `undefined`, если превью построить нельзя (тул не поддерживается,
 * файл нечитаем для диффа, правка неоднозначна, сбой расчёта) — вызывающий
 * трактует это как «превью нет» и ничего не ломает.
 */
export async function buildPermissionPreview(
  input: PermissionPreviewInput,
): Promise<PermissionPreview | undefined> {
  try {
    if (!PREVIEWABLE_TOOLS.has(input.toolName)) return undefined;

    const files = input.toolName === 'write_file'
      ? await previewWriteFile(input)
      : input.toolName === 'edit_file'
        ? await previewEditFile(input)
        : await previewPatch(input);
    if (!files || files.length === 0) return undefined;

    const map = input.secretsMap ?? {};
    return {
      files: files.map((file) => ({ ...file, diff: redactSecrets(file.diff, map) })),
    };
  } catch {
    // Превью — украшение: ошибка расчёта не должна ломать запрос подтверждения.
    return undefined;
  }
}

/** Содержимое файла, прочитанное для превью. */
interface LoadedFile {
  /** Содержимое в LF-виде (CRLF нормализован — как в `read_file`). */
  text: string;
  /** true — файл существует. */
  exists: boolean;
  /** true — в файле смешанные переводы строк (правка такому файлу запрещена). */
  mixed: boolean;
}

/**
 * Прочитать файл для превью: только обычный текстовый файл разумного объёма.
 *
 * `undefined` — по файлу превью построить нельзя (каталог/не-файл/бинарь/
 * слишком большой файл). Отсутствующий файл — не ошибка: это новый файл.
 */
async function loadForPreview(resolvedPath: string): Promise<LoadedFile | undefined> {
  const info = await stat(resolvedPath).catch(() => null);
  if (!info) return { text: '', exists: false, mixed: false };
  if (!info.isFile()) return undefined;
  if (info.size > MAX_TOOL_FILE_BYTES) return undefined;
  if (await sniffBinary(resolvedPath)) return undefined;
  const raw = await readFile(resolvedPath, 'utf-8');
  return {
    text: toLfView(raw),
    exists: true,
    mixed: detectLineEndings(raw) === 'mixed',
  };
}

/** Строка из аргументов вызова (undefined — если не строка). */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `write_file`: текущее содержимое файла (если он есть) против нового
 * `content`. Для нового файла старая сторона диффа — `/dev/null`.
 */
async function previewWriteFile(
  input: PermissionPreviewInput,
): Promise<PermissionPreviewFile[] | undefined> {
  const filePath = str(input.args.file_path);
  const content = str(input.args.content);
  if (filePath === undefined || content === undefined) return undefined;

  const loaded = await loadForPreview(resolvePath(filePath, input.workingDir));
  if (!loaded) return undefined;

  const newText = toLfView(content);
  if (loaded.exists && loaded.text === newText) return undefined;

  const diff = generateUnifiedDiff(loaded.text, newText, filePath, loaded.exists
    ? undefined
    : { oldLabel: '/dev/null', emptyOld: true });
  return [makePreviewFile(filePath, diff)];
}

/**
 * `edit_file`: замена применяется **в памяти** тем же матчером, что и в туле
 * (`edit-match.ts`), файл не меняется. Неоднозначная или не найденная правка →
 * превью нет (тул всё равно вернёт ошибку).
 */
async function previewEditFile(
  input: PermissionPreviewInput,
): Promise<PermissionPreviewFile[] | undefined> {
  const filePath = str(input.args.file_path);
  const oldString = str(input.args.old_string);
  const newString = str(input.args.new_string);
  if (filePath === undefined || oldString === undefined || newString === undefined) {
    return undefined;
  }

  const loaded = await loadForPreview(resolvePath(filePath, input.workingDir));
  if (!loaded || !loaded.exists || loaded.mixed) return undefined;

  const oldView = toLfView(oldString);
  const newView = toLfView(newString);
  // Правка «сама в себя» и пустой `old_string` — отказ тула, превью не нужно.
  if (oldView === newView || oldString === '') return undefined;

  const content = loaded.text;
  let newContent: string;
  if (input.args.replace_all === true) {
    // `replace_all` — только точное совпадение, все вхождения (как в туле).
    if (content.split(oldView).length - 1 === 0) return undefined;
    newContent = content.replaceAll(oldView, newView);
  } else {
    const match = matchEdit(content, oldView);
    if (!match || match.matches.length !== 1) return undefined;
    const found = match.matches[0]!;
    newContent = content.slice(0, found.start) + newView + content.slice(found.end);
  }
  if (newContent === content) return undefined;

  const diff = generateUnifiedDiff(content, newContent, filePath);
  return [makePreviewFile(filePath, diff)];
}

/**
 * `patch`: правки применяются последовательно **в памяти** (как в туле),
 * файлы не меняются. Патч — «всё-или-ничего», поэтому превью либо есть
 * целиком, либо нет вовсе: частичный дифф вводил бы в заблуждение.
 */
async function previewPatch(
  input: PermissionPreviewInput,
): Promise<PermissionPreviewFile[] | undefined> {
  const edits = input.args.edits;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;

  const order: string[] = [];
  const state = new Map<string, { displayPath: string; original: string; content: string }>();

  for (const raw of edits) {
    if (!raw || typeof raw !== 'object') return undefined;
    const edit = raw as Record<string, unknown>;
    const filePath = str(edit.file_path);
    const oldString = str(edit.old_string);
    const newString = str(edit.new_string);
    if (filePath === undefined || oldString === undefined || newString === undefined) {
      return undefined;
    }

    const resolved = resolvePath(filePath, input.workingDir);
    let item = state.get(resolved);
    if (!item) {
      const loaded = await loadForPreview(resolved);
      if (!loaded || !loaded.exists || loaded.mixed) return undefined;
      item = { displayPath: filePath, original: loaded.text, content: loaded.text };
      state.set(resolved, item);
      order.push(resolved);
    }

    const oldView = toLfView(oldString);
    const newView = toLfView(newString);
    if (oldView === newView) return undefined;
    // Сопоставление в `patch` — точное (без «умных» стратегий edit_file).
    const occurrences = item.content.split(oldView).length - 1;
    if (occurrences === 0) return undefined;
    const replaceAll = edit.replace_all === true;
    if (occurrences > 1 && !replaceAll) return undefined;
    item.content = replaceAll
      ? item.content.replaceAll(oldView, newView)
      : item.content.replace(oldView, newView);
  }

  const files: PermissionPreviewFile[] = [];
  for (const key of order) {
    const item = state.get(key)!;
    if (item.content === item.original) continue;
    files.push(makePreviewFile(item.displayPath, generateUnifiedDiff(item.original, item.content, item.displayPath)));
  }
  return files;
}

/** Собрать запись превью по файлу (путь + дифф + счётчики строк). */
function makePreviewFile(path: string, diff: string): PermissionPreviewFile {
  const { additions, deletions } = countDiffChanges(diff);
  return { path, diff, additions, deletions };
}

/**
 * Счётчики строк по unified diff: `+` — добавлено, `-` — удалено.
 *
 * Первые две строки — заголовки (`---`/`+++`), дальше идут заголовки hunka
 * (`@@ …`) и сами строки правки. Заголовок hunka отличается префиксом `@@`,
 * поэтому строка правки с таким содержимым (отрисованная как `-@@ …`/`+@@ …`)
 * счётчиком не путается.
 */
function countDiffChanges(diff: string): { additions: number; deletions: number } {
  const lines = diff.split('\n');
  let additions = 0;
  let deletions = 0;
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/**
 * Маскировать реальные значения известных секретов в диффе (ADR-036):
 * значение секрета заменяется его плейсхолдером из карты обфускации сессии.
 */
function redactSecrets(text: string, map: Record<string, string>): string {
  const entries = Object.entries(map).filter(([, secret]) => secret.length > 0);
  if (entries.length === 0) return text;
  // Длинные значения — первыми: короткое значение не должно «съесть» часть длинного.
  entries.sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [placeholder, secret] of entries) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(placeholder);
  }
  return out;
}
