import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscapeInRoots, isLexicallyInside, toolRoots, pathEscapesWorkspaceResult } from './path-utils.js';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { sniffBinary } from './fs-read.js';
import { MAX_TOOL_FILE_BYTES } from './file-limits.js';
import { generateUnifiedDiff } from './fs-write.js';
import { detectLineEndings, fromLfView, toLfView } from './line-endings.js';
import { writeFileAtomic } from './atomic-file-write.js';
import { withFileLocks } from './file-lock.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';

/** Лимит правок за один вызов (защита от «мегапатча» в один tool_call). */
export const MAX_PATCH_EDITS = 50;
/**
 * Предел размера файла для атомарной мультифайловой правки: оригиналы держим
 * в памяти для отката, поэтому «разумный» объём обязателен. Общий предел
 * файловых тулов — `MAX_TOOL_FILE_BYTES` (`tools/file-limits.ts`).
 */
export const MAX_PATCH_FILE_BYTES = MAX_TOOL_FILE_BYTES;

/**
 * Операции патча.
 *
 * - `update` — замена точного текста (операция по умолчанию; старые вызовы
 *   без `op` остаются валидными);
 * - `add` — создание нового файла;
 * - `delete` — удаление существующего файла;
 * - `rename` — перемещение/переименование файла внутри периметра.
 */
export const PATCH_OPS = ['update', 'add', 'delete', 'rename'] as const;
export type PatchOp = (typeof PATCH_OPS)[number];

/**
 * Схема одной правки — дискриминируемое объединение по `op`.
 *
 * Старый вызов (`{file_path, old_string, new_string, replace_all?}`) без поля
 * `op` остаётся валидным: у варианта `update` дискриминатор необязателен
 * (`z.literal('update').optional()`), а перед разбором аргументов отсутствующий
 * `op` дополняется значением `update` (`normalizePatchArgs`).
 */
const patchEditSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update').optional(),
    file_path: z.string().min(1).describe('Path to the file to patch (absolute or relative to the working directory)'),
    old_string: z.string().min(1).describe('Exact text to replace; must be unique unless replace_all is set'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().optional().default(false).describe('Replace all occurrences (default: false)'),
  }),
  z.object({
    op: z.literal('add'),
    file_path: z.string().min(1).describe('Path of the file to create (must not exist)'),
    content: z.string().describe('Full content of the new file'),
  }),
  z.object({
    op: z.literal('delete'),
    file_path: z.string().min(1).describe('Path of the file to delete (must exist)'),
  }),
  z.object({
    op: z.literal('rename'),
    from: z.string().min(1).describe('Current path of the file to move'),
    to: z.string().min(1).describe('New path of the file (must not exist)'),
  }),
]);

/** Разобранная правка — одна из четырёх операций. */
type PatchEdit =
  | { op: 'update'; file_path: string; old_string: string; new_string: string; replace_all: boolean }
  | { op: 'add'; file_path: string; content: string }
  | { op: 'delete'; file_path: string }
  | { op: 'rename'; from: string; to: string };

/** Ключи отказов патча (ADR-041 — строки движка только через i18n-ключи). */
type PatchErrorKey =
  | 'fs.patch_not_found'
  | 'fs.patch_multiple'
  | 'fs.patch_file_missing'
  | 'fs.patch_not_regular'
  | 'fs.patch_too_large'
  | 'fs.patch_binary'
  | 'fs.no_changes'
  | 'fs.mixed_line_endings'
  | 'fs.patch_add_exists'
  | 'fs.patch_delete_missing'
  | 'fs.patch_rename_missing'
  | 'fs.patch_rename_exists'
  | 'fs.patch_path_escapes';

/**
 * Файл в плане патча: итоговое содержимое + оригинал (для отката).
 *
 * Правки всегда идут по LF-виду содержимого (`read_file` отдаёт текст с LF),
 * а в файл попадают в стиле самого файла: CRLF-файл сохраняет `\r\n`.
 */
interface PlannedFile {
  /** Путь для текстов сообщений — из первой правки этого файла (как ввёл агент). */
  displayPath: string;
  /** Итоговый абсолютный путь файла (после возможного переименования). */
  resolvedPath: string;
  /** Итоговое содержимое в LF-виде (для `verbatim` — как есть). */
  content: string;
  /** Оригинал в LF-виде (null — файла на диске не было). */
  original: string | null;
  /** Оригинал в сыром виде — для отката при сбое записи. */
  rawOriginal: string | null;
  /** Стиль переводов строк файла (`mixed` отсекается при загрузке). */
  style: 'lf' | 'crlf';
  /** Содержимое пишется как есть (новый файл со смешанными переводами строк). */
  verbatim: boolean;
  /** Права файла (undefined — новый файл). */
  mode: number | undefined;
  /** Счётчик замен (update). */
  replacements: number;
  /** Файла на диске не было (add или цель rename). */
  isNew: boolean;
  /** Происхождение файла в плане — для отчёта по операциям. */
  origin: 'update' | 'add' | 'rename';
  /** Откуда файл перенесён (rename) — для отчёта и отката. */
  movedFrom?: string;
}

/** План патча: итоговое состояние файлов + операции удаления. */
interface PatchPlan {
  /** Файлы по итоговому пути (порядок — по первой правке). */
  files: Map<string, PlannedFile>;
  /** Физические пути к удалению с диска → оригинал для отката. */
  deletions: Map<string, { rawOriginal: string; mode: number | undefined }>;
}

/** Запись отчёта по операциям (одна на файл/операцию). */
type ReportEntry =
  | { kind: 'update'; resolvedPath: string; path: string; count: number }
  | { kind: 'add'; resolvedPath: string; path: string }
  | { kind: 'delete'; resolvedPath: string; path: string }
  | { kind: 'rename'; from: string; to: string };

function patchError(
  key: PatchErrorKey,
  params: Record<string, string>,
  metadata: Record<string, unknown>,
): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { ...metadata, i18n: i18nMeta(key, params) },
  };
}

/** Ошибка загрузки файла-цели: ключ i18n + параметры + метаданные. */
interface LoadFailure {
  key: PatchErrorKey;
  params: Record<string, string>;
  metadata: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Дополнить правку без `op` значением `update` — обратная совместимость:
 * старые вызовы `{file_path, old_string, new_string}` остаются валидными.
 */
function normalizePatchArgs(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  const edits = args.edits;
  if (!Array.isArray(edits)) return args;
  return {
    ...args,
    edits: edits.map((edit) => {
      if (!isPlainObject(edit) || typeof edit.op === 'string') return edit;
      return { ...edit, op: 'update' };
    }),
  };
}

export const patchTool: ToolDefinition = {
  name: 'patch',
  description:
    'Apply a set of file operations in one atomic call (all-or-nothing). '
    + 'Provide a JSON list of edits; each edit has an "op" field: '
    + '"update" (default) replaces exact text — file_path, old_string, new_string and optional replace_all; '
    + '"add" creates a new file — file_path and content (fails if the file already exists); '
    + '"delete" removes an existing file — file_path (fails if the file is missing); '
    + '"rename" moves a file — from and to (fails if from is missing or to already exists). '
    + 'Nothing is written unless all edits can be applied: 0 matches or an ambiguous match without replace_all fails the whole call. '
    + 'read_file prefixes every line with its number ("N: "); that prefix is for reading only — never include it in old_string or new_string. '
    + 'Line endings of the file are preserved: an LF file is edited as is, a CRLF file is matched in LF view and written back as CRLF, '
    + 'a file with mixed line endings is refused. '
    + 'Paths are resolved against the project working directory; prefer relative paths. Absolute paths outside the session perimeter are rejected, and paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    edits: z
      .array(patchEditSchema)
      .min(1)
      .max(MAX_PATCH_EDITS)
      .describe('1..50 file operations applied in order (op: update|add|delete|rename)'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx): Promise<ToolResult> {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(normalizePatchArgs(args));
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    // `op` без значения — это `update` (правка без `op` — старый формат).
    const edits = (parsed.data.edits as Array<Record<string, unknown>>).map(
      (edit) => ({ ...edit, op: (typeof edit.op === 'string' ? edit.op : 'update') }) as unknown as PatchEdit,
    );
    const roots = toolRoots(ctx);

    // ---------------------------------------------------------------------
    // Фаза 0: резолв путей (без чтения файлов и без проверок).
    //
    // Нужен ДО взятия локов: список затрагиваемых путей известен только
    // после резолва, а локи надо взять до первого чтения — иначе
    // read-modify-write патча не сериализован с параллельной правкой того
    // же файла. Порядок отказов не меняется: проверки путей и содержимого
    // по-прежнему идут в порядке правок (внутри лока).
    // ---------------------------------------------------------------------
    const resolvedPaths = edits.map((edit) => resolveEditPaths(edit, ctx.workingDir));

    // ---------------------------------------------------------------------
    // Фазы 1–2 под локами затрагиваемых путей: чтение, расчёт, запись и
    // откат — одна критическая секция. Патч и параллельная правка того же
    // файла не должны перетирать друг друга (оба читали бы одну версию).
    // ---------------------------------------------------------------------
    const lockPaths = resolvedPaths.flatMap((paths) => paths.resolved);
    return withFileLocks(lockPaths, async (): Promise<ToolResult> => {
      // ---------------------------------------------------------------------
      // Фаза 1: валидация и расчёт результата в памяти. Ничего не пишем.
      // ---------------------------------------------------------------------
      const plan: PatchPlan = { files: new Map(), deletions: new Map() };
      const report: ReportEntry[] = [];

      for (let index = 0; index < edits.length; index++) {
        const edit = edits[index]!;
        const paths = resolvedPaths[index]!;

        if (edit.op === 'update') {
          const failure = await applyUpdateEdit(edit, index, paths, plan, report, ctx, roots);
          if (failure) return failure;
          continue;
        }
        if (edit.op === 'add') {
          const failure = await applyAddEdit(edit, paths, plan, report, ctx, roots);
          if (failure) return failure;
          continue;
        }
        if (edit.op === 'delete') {
          const failure = await applyDeleteEdit(edit, paths, plan, report, roots);
          if (failure) return failure;
          continue;
        }
        const failure = await applyRenameEdit(edit, paths, plan, report, roots);
        if (failure) return failure;
      }

      // ---------------------------------------------------------------------
      // Фаза 2: запись. Атомарно по файлу (tmp в том же каталоге → rename);
      // при сбое посередине — best-effort откат уже изменённых файлов.
      // ---------------------------------------------------------------------
      let currentPath = '';
      try {
        for (const file of plan.files.values()) {
          currentPath = file.resolvedPath;
          // CRLF-файл возвращаем в CRLF — ни один `\r\n` не теряется.
          const content = file.verbatim
            ? file.content
            : file.style === 'crlf'
              ? fromLfView(file.content)
              : file.content;
          // Каталоги создаются (op: add/rename — цель может быть в новом каталоге).
          await mkdir(dirname(file.resolvedPath), { recursive: true });
          await writeFileAtomic(file.resolvedPath, content, file.mode);
        }
        // Удаление — после записей: переименование реализовано как «записать
        // в цель + удалить источник», поэтому источник должен уйти последним.
        for (const path of plan.deletions.keys()) {
          currentPath = path;
          await rm(path, { force: true });
        }
      } catch (err) {
        await rollbackPatch(plan);
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: sm('fs.patch_write_failed', { path: currentPath, error: message }),
          isError: true,
          metadata: { path: currentPath, i18n: i18nMeta('fs.patch_write_failed', { path: currentPath, error: message }) },
        };
      }

      // ---------------------------------------------------------------------
      // Успех: сводка + по строке на файл; в metadata — диффы и счётчики.
      // ---------------------------------------------------------------------
      return buildPatchResult(plan, report);
    });
  },
};

/** Разрешённые пути правки (для `rename` — источник и цель). */
interface ResolvedEditPaths {
  /** Абсолютные пути (в порядке: `file_path` либо `from`, `to`). */
  resolved: string[];
}

function resolveEditPaths(edit: PatchEdit, workingDir: string): ResolvedEditPaths {
  if (edit.op === 'rename') {
    return {
      resolved: [resolvePath(edit.from, workingDir), resolvePath(edit.to, workingDir)],
    };
  }
  return {
    resolved: [resolvePath(edit.file_path, workingDir)],
  };
}

/**
 * Периметр операции: путь должен лежать внутри корней сессии.
 *
 * Симлинк наружу — отдельный отказ (`pathEscapesWorkspaceResult`, как у
 * остальных файловых тулов). Прочие выходы за периметр (абсолютный путь
 * вне workspace или относительный `..`) — собственный ключ патча.
 *
 * Проверка лексическая: путь должен лежать внутри корня **до** разыменования
 * симлинков (симлинк наружу ловит отдельная проверка выше).
 */
function checkPerimeter(
  displayPath: string,
  resolvedPath: string,
  roots: string[],
): ToolResult | null {
  if (isSymlinkEscapeInRoots(roots, resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);
  if (!roots.some((root) => isLexicallyInside(root, resolvedPath))) {
    return patchError('fs.patch_path_escapes', { path: displayPath }, { path: resolvedPath });
  }
  return null;
}

/** `update` — замена точного текста (последовательно, в памяти). */
async function applyUpdateEdit(
  edit: Extract<PatchEdit, { op: 'update' }>,
  editIndex: number,
  paths: ResolvedEditPaths,
  plan: PatchPlan,
  report: ReportEntry[],
  ctx: ToolContext,
  roots: string[],
): Promise<ToolResult | null> {
  const displayPath = edit.file_path;
  const resolvedPath = paths.resolved[0]!;
  validateInputPath(displayPath, 'file_path');
  const guard = checkPerimeter(displayPath, resolvedPath, roots);
  if (guard) return guard;

  let planned = plan.files.get(resolvedPath);
  if (!planned) {
    const loaded = await loadPatchTarget(resolvedPath, displayPath);
    if ('failure' in loaded) return patchError(loaded.failure.key, loaded.failure.params, loaded.failure.metadata);
    planned = loaded.file;
    plan.files.set(resolvedPath, planned);
  }

  // ADR-036: деобфускация в точке потребления — тексты правки могут содержать ⟦SYNTH_SECRET_N⟧
  const oldString = await deobfuscateText(ctx, edit.old_string);
  const newString = await deobfuscateText(ctx, edit.new_string);

  // Сопоставление и замена — по LF-виду (в этом виде текст приходит из
  // `read_file`). Поэтому и сравнение «есть ли изменение» — по LF-виду:
  // иначе пара «old с \r\n, new с \n» прошла бы гейт, а после нормализации
  // стала бы no-op — и тул рапортовал бы об успешной правке впустую.
  const oldView = planned.verbatim ? oldString : toLfView(oldString);
  const newView = planned.verbatim ? newString : toLfView(newString);
  if (oldView === newView) {
    return patchError('fs.no_changes', {}, { path: resolvedPath, index: editIndex });
  }

  const occurrences = planned.content.split(oldView).length - 1;
  if (occurrences === 0) {
    return patchError(
      'fs.patch_not_found',
      { path: displayPath, index: String(editIndex + 1) },
      { path: resolvedPath, index: editIndex },
    );
  }
  const replaceAll = edit.replace_all === true;
  if (occurrences > 1 && !replaceAll) {
    return patchError(
      'fs.patch_multiple',
      { path: displayPath, index: String(editIndex + 1), count: String(occurrences) },
      { path: resolvedPath, index: editIndex, count: occurrences },
    );
  }

  // Правки применяются последовательно в памяти: следующая видит результат предыдущей.
  planned.content = replaceAll
    ? planned.content.replaceAll(oldView, newView)
    : planned.content.replace(oldView, newView);
  planned.replacements += replaceAll ? occurrences : 1;

  const existing = report.find((entry) => entry.kind === 'update' && entry.resolvedPath === resolvedPath);
  if (existing && existing.kind === 'update') existing.count += replaceAll ? occurrences : 1;
  else report.push({ kind: 'update', resolvedPath, path: displayPath, count: replaceAll ? occurrences : 1 });
  return null;
}

/** `add` — создание нового файла (каталоги создаются). */
async function applyAddEdit(
  edit: Extract<PatchEdit, { op: 'add' }>,
  paths: ResolvedEditPaths,
  plan: PatchPlan,
  report: ReportEntry[],
  ctx: ToolContext,
  roots: string[],
): Promise<ToolResult | null> {
  const displayPath = edit.file_path;
  const resolvedPath = paths.resolved[0]!;
  validateInputPath(displayPath, 'file_path');
  const guard = checkPerimeter(displayPath, resolvedPath, roots);
  if (guard) return guard;

  // Файл уже есть — либо на диске, либо создан/перенесён в этом же вызове.
  if (plan.files.has(resolvedPath) || plan.deletions.has(resolvedPath)) {
    return patchError('fs.patch_add_exists', { path: displayPath }, { path: resolvedPath });
  }
  const existing = await stat(resolvedPath).catch(() => null);
  if (existing) {
    return patchError('fs.patch_add_exists', { path: displayPath }, { path: resolvedPath });
  }

  // ADR-036: деобфускация в точке потребления — контент может содержать ⟦SYNTH_SECRET_N⟧
  const content = await deobfuscateText(ctx, edit.content);
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_PATCH_FILE_BYTES) {
    return patchError(
      'fs.patch_too_large',
      { path: displayPath, bytes: String(bytes), limit: String(MAX_PATCH_FILE_BYTES) },
      { path: resolvedPath, bytes, limit: MAX_PATCH_FILE_BYTES },
    );
  }

  // Смешанные переводы строк у нового файла сохраняем как есть (`verbatim`):
  // стиля «как в файле» тут ещё нет, а терять `\r` нельзя.
  const style = detectLineEndings(content);
  const verbatim = style === 'mixed';
  plan.files.set(resolvedPath, {
    displayPath,
    resolvedPath,
    content: verbatim ? content : toLfView(content),
    original: null,
    rawOriginal: null,
    style: verbatim ? 'lf' : style,
    verbatim,
    mode: undefined,
    replacements: 0,
    isNew: true,
    origin: 'add',
  });
  report.push({ kind: 'add', resolvedPath, path: displayPath });
  return null;
}

/** `delete` — удаление существующего файла. */
async function applyDeleteEdit(
  edit: Extract<PatchEdit, { op: 'delete' }>,
  paths: ResolvedEditPaths,
  plan: PatchPlan,
  report: ReportEntry[],
  roots: string[],
): Promise<ToolResult | null> {
  const displayPath = edit.file_path;
  const resolvedPath = paths.resolved[0]!;
  validateInputPath(displayPath, 'file_path');
  const guard = checkPerimeter(displayPath, resolvedPath, roots);
  if (guard) return guard;

  const planned = plan.files.get(resolvedPath);
  if (planned) {
    if (planned.isNew) {
      // Файл создан в этом же вызове — на диске его нет, удалять нечего.
      plan.files.delete(resolvedPath);
      return null;
    }
    plan.files.delete(resolvedPath);
    plan.deletions.set(resolvedPath, { rawOriginal: planned.rawOriginal ?? '', mode: planned.mode });
    report.push({ kind: 'delete', resolvedPath, path: displayPath });
    return null;
  }

  if (plan.deletions.has(resolvedPath)) {
    return patchError('fs.patch_delete_missing', { path: displayPath }, { path: resolvedPath });
  }

  const loaded = await loadPatchTarget(resolvedPath, displayPath);
  if ('failure' in loaded) {
    // Отсутствующий файл — «нечего удалять»; остальные отказы (не-обычный
    // файл, бинарь, размер) — как есть.
    if (loaded.failure.key === 'fs.patch_file_missing') {
      return patchError('fs.patch_delete_missing', { path: displayPath }, { path: resolvedPath });
    }
    return patchError(loaded.failure.key, loaded.failure.params, loaded.failure.metadata);
  }
  plan.deletions.set(resolvedPath, { rawOriginal: loaded.file.rawOriginal ?? '', mode: loaded.file.mode });
  report.push({ kind: 'delete', resolvedPath, path: displayPath });
  return null;
}

/**
 * `rename` — перемещение/переименование файла внутри периметра.
 *
 * Перенос реализован как «записать содержимое в цель + удалить источник»:
 * так перемещение укладывается в общий всё-или-ниothing-план патча (один
 * набор файлов на запись + один набор на удаление) и откат работает так же,
 * как у `add`/`delete`.
 */
async function applyRenameEdit(
  edit: Extract<PatchEdit, { op: 'rename' }>,
  paths: ResolvedEditPaths,
  plan: PatchPlan,
  report: ReportEntry[],
  roots: string[],
): Promise<ToolResult | null> {
  const fromDisplay = edit.from;
  const toDisplay = edit.to;
  const fromPath = paths.resolved[0]!;
  const toPath = paths.resolved[1]!;
  validateInputPath(fromDisplay, 'from');
  validateInputPath(toDisplay, 'to');
  const guardFrom = checkPerimeter(fromDisplay, fromPath, roots);
  if (guardFrom) return guardFrom;
  const guardTo = checkPerimeter(toDisplay, toPath, roots);
  if (guardTo) return guardTo;

  // Цель должна быть свободна: и на диске, и в плане этого вызова.
  if (plan.files.has(toPath) || plan.deletions.has(toPath)) {
    return patchError('fs.patch_rename_exists', { to: toDisplay }, { path: toPath });
  }
  const existingTarget = await stat(toPath).catch(() => null);
  if (existingTarget) {
    return patchError('fs.patch_rename_exists', { to: toDisplay }, { path: toPath });
  }

  const source = plan.files.get(fromPath);
  if (source) {
    // Источник уже в плане (обновлён или создан в этом вызове) — переносим
    // его состояние на цель.
    plan.files.delete(fromPath);
    plan.files.set(toPath, {
      ...source,
      displayPath: toDisplay,
      resolvedPath: toPath,
      isNew: true,
      origin: 'rename',
      movedFrom: fromDisplay,
    });
    if (!source.isNew) {
      plan.deletions.set(fromPath, { rawOriginal: source.rawOriginal ?? '', mode: source.mode });
    }
    // Записи отчёта по исходному пути теперь относятся к цели.
    for (const entry of report) {
      if ('resolvedPath' in entry && entry.resolvedPath === fromPath) entry.resolvedPath = toPath;
    }
    report.push({ kind: 'rename', from: fromDisplay, to: toDisplay });
    return null;
  }

  if (plan.deletions.has(fromPath)) {
    return patchError('fs.patch_rename_missing', { from: fromDisplay }, { path: fromPath });
  }

  const loaded = await loadPatchTarget(fromPath, fromDisplay);
  if ('failure' in loaded) {
    if (loaded.failure.key === 'fs.patch_file_missing') {
      return patchError('fs.patch_rename_missing', { from: fromDisplay }, { path: fromPath });
    }
    return patchError(loaded.failure.key, loaded.failure.params, loaded.failure.metadata);
  }
  plan.files.set(toPath, {
    ...loaded.file,
    displayPath: toDisplay,
    resolvedPath: toPath,
    isNew: true,
    origin: 'rename',
    movedFrom: fromDisplay,
  });
  plan.deletions.set(fromPath, { rawOriginal: loaded.file.rawOriginal ?? '', mode: loaded.file.mode });
  report.push({ kind: 'rename', from: fromDisplay, to: toDisplay });
  return null;
}

/**
 * Прочитать и проверить файл-цель до правок (обычный файл, текст, разумный размер).
 */
async function loadPatchTarget(
  resolvedPath: string,
  displayPath: string,
): Promise<{ file: PlannedFile } | { failure: LoadFailure }> {
  const info = await stat(resolvedPath).catch(() => null);
  if (!info) {
    return {
      failure: {
        key: 'fs.patch_file_missing',
        params: { path: displayPath },
        metadata: { path: resolvedPath },
      },
    };
  }
  if (!info.isFile()) {
    return {
      failure: {
        key: 'fs.patch_not_regular',
        params: { path: displayPath },
        metadata: { path: resolvedPath },
      },
    };
  }
  if (info.size > MAX_PATCH_FILE_BYTES) {
    return {
      failure: {
        key: 'fs.patch_too_large',
        params: {
          path: displayPath,
          bytes: String(info.size),
          limit: String(MAX_PATCH_FILE_BYTES),
        },
        metadata: { path: resolvedPath, bytes: info.size, limit: MAX_PATCH_FILE_BYTES },
      },
    };
  }
  if (await sniffBinary(resolvedPath)) {
    return {
      failure: {
        key: 'fs.patch_binary',
        params: { path: displayPath },
        metadata: { path: resolvedPath },
      },
    };
  }
  const raw = await readFile(resolvedPath, 'utf-8');
  const style = detectLineEndings(raw);
  // Смешанные переводы строк — отказ: патч всё-или-ничего, стиль файла
  // менять нельзя (иначе часть строк потеряла бы `\r`).
  if (style === 'mixed') {
    return {
      failure: {
        key: 'fs.mixed_line_endings',
        params: {},
        metadata: { path: resolvedPath },
      },
    };
  }
  const view = toLfView(raw);
  return {
    file: {
      displayPath,
      resolvedPath,
      rawOriginal: raw,
      original: view,
      content: view,
      style,
      verbatim: false,
      mode: info.mode & 0o777,
      replacements: 0,
      isNew: false,
      origin: 'update',
    },
  };
}

/**
 * Откат после сбоя записи (best-effort):
 * - созданные файлы — удаляются;
 * - изменённые существующие — возвращаются к оригиналу;
 * - удалённые/перенесённые — восстанавливаются из памяти.
 */
async function rollbackPatch(plan: PatchPlan): Promise<void> {
  for (const file of plan.files.values()) {
    if (!file.isNew) continue;
    await rm(file.resolvedPath, { force: true }).catch(() => undefined);
  }
  for (const file of plan.files.values()) {
    if (file.isNew || file.rawOriginal === null) continue;
    await writeFile(file.resolvedPath, file.rawOriginal, { encoding: 'utf-8', mode: file.mode }).catch(() => undefined);
  }
  for (const [path, saved] of plan.deletions) {
    await writeFile(path, saved.rawOriginal, { encoding: 'utf-8', mode: saved.mode }).catch(() => undefined);
  }
}

/** Сборка успешного результата: сводка, строки по файлам и metadata. */
function buildPatchResult(plan: PatchPlan, report: ReportEntry[]): ToolResult {
  // Операции над файлом, который в итоге удалён, в отчёт не попадают.
  const entries = report.filter((entry) => {
    if (entry.kind === 'update' || entry.kind === 'add') return plan.files.has(entry.resolvedPath);
    return true;
  });

  const updatedFiles = entries.filter((entry): entry is Extract<ReportEntry, { kind: 'update' }> => entry.kind === 'update');
  const totalReplacements = updatedFiles.reduce((sum, entry) => sum + entry.count, 0);
  const added = entries.filter((entry) => entry.kind === 'add').length;
  const deleted = entries.filter((entry) => entry.kind === 'delete').length;
  const renamed = entries.filter((entry) => entry.kind === 'rename').length;
  const touchedFiles = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'rename') {
      // Переименование — один затронутый файл (источник и цель — одна сущность).
      touchedFiles.add(entry.to);
      continue;
    }
    touchedFiles.add(entry.path);
  }

  const lines: string[] = [];
  const appliedParams = { files: String(touchedFiles.size), replacements: String(totalReplacements) };
  lines.push(sm('fs.patch_applied', appliedParams));
  if (added + deleted + renamed > 0) {
    lines.push(
      sm('fs.patch_summary', {
        added: String(added),
        updated: String(updatedFiles.length),
        deleted: String(deleted),
        renamed: String(renamed),
      }),
    );
  }
  for (const entry of entries) {
    if (entry.kind === 'update') {
      lines.push(sm('fs.patch_file_line', { path: entry.path, count: String(entry.count) }));
      continue;
    }
    if (entry.kind === 'add') {
      lines.push(sm('fs.patch_file_added', { path: entry.path }));
      continue;
    }
    if (entry.kind === 'delete') {
      lines.push(sm('fs.patch_file_deleted', { path: entry.path }));
      continue;
    }
    lines.push(sm('fs.patch_file_renamed', { from: entry.from, to: entry.to }));
  }

  const files = entries.map((entry) => {
    if (entry.kind === 'update') {
      const file = plan.files.get(entry.resolvedPath);
      return {
        path: entry.path,
        replacements: entry.count,
        diff: file ? generateUnifiedDiff(file.original ?? '', file.content, entry.path) : '',
      };
    }
    if (entry.kind === 'add') return { path: entry.path, op: 'add' as const };
    if (entry.kind === 'delete') return { path: entry.path, op: 'delete' as const };
    return { path: entry.to, op: 'rename' as const, from: entry.from, to: entry.to };
  });

  return {
    content: lines.join('\n'),
    metadata: {
      files,
      totalReplacements,
      summary: { added, updated: updatedFiles.length, deleted, renamed },
      i18n: i18nMeta('fs.patch_applied', appliedParams),
    },
  };
}
