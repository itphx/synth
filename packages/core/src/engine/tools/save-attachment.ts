/**
 * ADR-115, подраздел «Сохранение вложения в workspace»: тул `save_attachment` —
 * выгрузить **доставленное** вложение сессии в рабочий каталог проекта.
 *
 * ## Зачем
 *
 * Отброшенное вложение материализуется в `<workspace>/attachments/`
 * (`engine/attachments/materialize.ts`), а доставленное живёт **только** в
 * blob-хранилище: в сообщении лежит ссылка (`blobPath`), байтов там нет.
 * Агенту нечем достать оригинал: `read_file` читает UTF-8, медиа-блоков в
 * результатах тулов нет. Тул замыкает круг: находит медиа-часть в истории
 * сессии, читает объект из blob через сервис вложений и кладёт файл в workspace
 * — дальше с ним работают обычные инструменты (shell, `read_file`, git).
 *
 * ## Границы
 *
 * - **Только сессия разговора.** Источник вложения — `messages[].parts[]`
 *   сессии хода/человека (`extra.sessionId`, у саб-агента — родительская:
 *   вложения приносит пользователь, своей пользовательской истории у ребёнка
 *   нет); чужие сессии не видны.
 * - **Только объекты вложений.** `blobPath` обязан быть из `attachments/`
 *   (`AttachmentService.resolve`/`read` и сами отказывают иначе) — произвольные
 *   blob'ы (логи процессов, артефакты) через этот контур не выгружаются.
 * - **Containment как у `attach_workspace_file`**: абсолютный путь, `..` за
 *   пределы workspace и побег через симлинк отклоняются. Периметр считается
 *   **по реальным путям точки исполнения** (PROP-135): симлинк наружу там виден.
 * - **Запись — на порту исполнения** (PROP-135, Ф3): файл публикуется
 *   **там, где лежит рабочий каталог** (в split-топологии — на исполнителе),
 *   а control plane лишь читает blob-объект и отдаёт байты порту. Публикация
 *   атомарная и **без перезаписи** (`fs.upload` с `ifExists: 'fail'`), занятое
 *   имя → отказ (`attach.tool.exists`).
 * - **Существующий файл не перезаписывается.** **Повторное сохранение
 *   идемпотентно:** если в целевом файле уже лежит ровно то же содержимое
 *   (sha256 совпадает, размер совпадает), операция считается успешной
 *   (`metadata.existing: true`) — «сохрани ещё раз» не упирается в отказ.
 *   Гонка (файл появился между проверкой и публикацией) разрешается той же
 *   сверкой содержимого.
 * - Лимитов размера здесь нет: файл уже принят вложениями (`attachments.*`),
 *   проверяется только непустота объекта.
 */
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  ToolCapability,
  type MediaPartData,
  type MediaPartType,
  type PartType,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@itphx/synth-shared';
import { ATTACHMENT_DIR, type AttachmentService } from '../attachments/service.js';
import { sanitizeAttachmentName } from '../attachments/materialize.js';
import type { SessionManager } from '../../sessions/manager.js';
import { isAborted, abortedResult } from './abort.js';
import { parentSessionIdOf } from './session-scope.js';
import {
  isLexicallyInside,
  pathEscapesWorkspaceResult,
  resolvePath,
  toolRoots,
  validateInputPath,
} from './path-utils.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
// PROP-135 (Ф3): файл публикуется в контуре исполнения — там, где в
// split-топологии лежит рабочий каталог проекта.
import { resolveExecutionPort } from '../../execution/tool-port.js';
import { escapesWorkspace, FS_UNAVAILABLE_TEXT } from '../../execution/fs-perimeter.js';
import { fsCall } from '../../execution/fs-tool-call.js';
import { isFsPathError, type ExecutionFs, type FsStat } from '../../execution/ports/index.js';

/** Имя тула (используется в текстах и в permission-группах). */
export const SAVE_ATTACHMENT_TOOL = 'save_attachment';

/**
 * Зависимости тула из `ToolContext.extra` (упаковка — оркестратор).
 *
 * - `attachmentService` — сервис вложений (ADR-115): `resolve` (метаданные) и
 *   `read` (поток байтов). Не задан — операция недоступна
 *   (`attach.tool.deps_unavailable`).
 * - `sessionManager` — доступ к истории сессии (`getSession`): вложения ищутся
 *   только в текущей сессии. Не задан — тот же отказ.
 */
export interface SaveAttachmentExtra {
  attachmentService?: AttachmentService;
  sessionManager?: SessionManager;
}

/** Медиа-типы частей сообщения — кандидаты на выгрузку. */
const MEDIA_PART_TYPES: readonly string[] = ['image', 'audio', 'video', 'file'];

/** Найденная медиа-часть: сообщение-владелец + данные объекта. */
interface AttachmentCandidate {
  messageId: string;
  /** Порядковый номер сообщения в сессии (`seq`), если он есть. */
  messageSeq?: number;
  type: MediaPartType;
  data: MediaPartData;
}

/** Отказ с ключом i18n и (необязательным) блоком metadata. */
function failureResult(
  key: Parameters<typeof sm>[0],
  params: Record<string, string>,
  metadata: Record<string, unknown> = {},
): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { ...metadata, i18n: i18nMeta(key, params) },
  };
}

/** Лексическая проверка вхождения пути в любой из корней perimeter'а (без ФС). */
function isLexicallyInsideRoots(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isLexicallyInside(root, candidate));
}

/**
 * `Part.data` → `MediaPartData` при строгом совпадении формы.
 *
 * Части приходят из истории (в т.ч. после импорта/PG), поэтому доверять форме
 * нельзя: без `blobPath`/`sha256`/`mime`/`size` часть не считается вложением —
 * выгрузка по «полувалидной» ссылке не начинается.
 */
function toMediaData(type: PartType, data: unknown): MediaPartData | null {
  if (!MEDIA_PART_TYPES.includes(type)) return null;
  if (typeof data !== 'object' || data === null) return null;
  const raw = data as Partial<MediaPartData>;
  if (typeof raw.blobPath !== 'string' || raw.blobPath === '') return null;
  if (typeof raw.sha256 !== 'string' || raw.sha256 === '') return null;
  if (typeof raw.mime !== 'string' || raw.mime === '') return null;
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size)) return null;
  return {
    blobPath: raw.blobPath,
    sha256: raw.sha256,
    mime: raw.mime,
    size: raw.size,
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
  };
}

/** Все медиа-вложения сессии в порядке истории (старые → новые). */
function collectAttachments(
  messages: readonly { id: string; seq?: number; parts?: unknown }[],
): AttachmentCandidate[] {
  const found: AttachmentCandidate[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts as { type?: PartType; data?: unknown }[]) {
      if (!part || typeof part.type !== 'string') continue;
      const data = toMediaData(part.type, part.data);
      if (!data) continue;
      found.push({
        messageId: message.id,
        ...(typeof message.seq === 'number' ? { messageSeq: message.seq } : {}),
        type: part.type as MediaPartType,
        data,
      });
    }
  }
  return found;
}

/** Подпись кандидата в списке неоднозначности: `name (sha8, messageId)`. */
function describeCandidate(candidate: AttachmentCandidate): string {
  const sha8 = candidate.data.sha256.slice(0, 8);
  const name = candidate.data.name ?? sha8;
  return `${name} (${sha8}, ${candidate.messageId})`;
}

/**
 * Схлопывание кандидатов по объекту blob-хранилища.
 *
 * Один и тот же файл, отправленный в чат несколько раз, — это **одно**
 * вложение, а не неоднозначность: подсунуть «не тот файл» невозможно, потому
 * что содержимое совпадает. Ключ — `sha256` (content-addressed; fallback —
 * `blobPath`, если хэш пришёл пустым). Побеждает первое (самое старое)
 * вхождение в истории — подпись в списке остаётся стабильной.
 */
function dedupeCandidates(candidates: readonly AttachmentCandidate[]): AttachmentCandidate[] {
  const seen = new Set<string>();
  const unique: AttachmentCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.data.sha256
      ? candidate.data.sha256.toLowerCase()
      : candidate.data.blobPath;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

/**
 * В существующем целевом файле уже лежит ровно это вложение?
 *
 * Сначала сравнивается размер (дешёвая проверка, файл не читается), затем
 * sha256 — **потоком, на точке исполнения** (`fs.hash`: там, где лежит файл,
 * файл целиком в память не поднимается). Не-обычный файл, ошибка чтения —
 * «не совпадает»: перезаписи чужого содержимого нет (fail-closed).
 */
async function isSameFileContent(
  fs: ExecutionFs,
  filePath: string,
  expected: { sha256: string; size: number },
): Promise<boolean> {
  try {
    const info: FsStat = await fs.stat(filePath);
    if (info.kind !== 'file' || info.size !== expected.size) return false;
    const actual = await fs.hash(filePath);
    return actual.toLowerCase() === expected.sha256.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Прочитать объект вложения в память (поток сервиса → `Buffer`).
 *
 * Кап — `meta.size` байт: содержимое больше ожидаемого **не** дочитывается
 * (файл может быть огромным, а объект уже принят вложениями с лимитом).
 * Несовпадение размера — ошибка сохранения: значит, sidecar и байты расходятся
 * (объект повреждён или подменён) — публиковать такое нельзя.
 */
async function readAttachmentBytes(
  service: AttachmentService,
  blobPath: string,
  expectedSize: number,
): Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; kind: 'not_found' | 'save_failed'; error: string }
> {
  let stream: Awaited<ReturnType<AttachmentService['read']>>;
  try {
    stream = await service.read(blobPath);
  } catch (err) {
    return {
      ok: false,
      kind: 'save_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!stream) {
    return { ok: false, kind: 'not_found', error: `объект вложения не найден: ${blobPath}` };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > expectedSize) {
      // Больше, чем в метаданных, — дальше читать нечего.
      return {
        ok: false,
        kind: 'save_failed',
        error: `размер вложения не совпадает с метаданными (ожидалось ${expectedSize} байт)`,
      };
    }
    chunks.push(buf);
  }
  if (total !== expectedSize) {
    return {
      ok: false,
      kind: 'save_failed',
      error: `размер вложения не совпадает с метаданными (ожидалось ${expectedSize} байт, получено ${total})`,
    };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/** Успешный результат сохранения (`existing` — файл уже лежал на месте). */
function savedResult(params: {
  relPath: string;
  blobPath: string;
  sha256: string;
  mime: string;
  size: number;
  existing: boolean;
}): ToolResult {
  const text = sm('attach.tool.saved', { path: params.relPath, size: String(params.size) });
  return {
    content: text,
    metadata: {
      i18n: i18nMeta('attach.tool.saved', { path: params.relPath, size: String(params.size) }),
      path: params.relPath,
      blob_path: params.blobPath,
      sha256: params.sha256,
      mime: params.mime,
      size: params.size,
      ...(params.existing ? { existing: true } : {}),
    },
  };
}

export const saveAttachmentTool: ToolDefinition = {
  name: SAVE_ATTACHMENT_TOOL,
  description:
    'Save an attachment of the current session to the project working directory as a file '
    + '(image, audio, video, PDF, …), so that shell and file tools can process it. Attachments are '
    + 'searched in the session history: pass message_id or message_seq to restrict the search to one '
    + 'message, sha256 to pick an exact attachment, name to pick by file name, or nothing to take the '
    + 'latest media attachment. Selectors combine: message first, then sha256/name within it. Path is '
    + 'relative to the working directory (default attachments/<name|sha8>); absolute paths and paths '
    + 'outside the working directory are rejected, and an existing file is never overwritten. Saving the '
    + 'same attachment to the same path again is a no-op (the existing file is reported).',
  parameters: z.object({
    message_id: z
      .string()
      .optional()
      .describe('Internal session message id (as in the message history) to search attachments in'),
    message_seq: z
      .number()
      .int()
      .optional()
      .describe('Session message ordinal (seq, as shown by read_session_reference)'),
    name: z
      .string()
      .optional()
      .describe('Attachment file name to select (several matches are reported with their sha256)'),
    sha256: z
      .string()
      .optional()
      .describe('Exact SHA-256 of the attachment content — the unambiguous selector'),
    path: z
      .string()
      .optional()
      .describe(
        'Path to save to, relative to the working directory (default attachments/<name|sha8>)',
      ),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as {
      message_id?: string;
      message_seq?: number;
      name?: string;
      sha256?: string;
      path?: string;
    };
    // Пустая строка — «не задано»: модель часто присылает "" вместо отсутствия поля.
    const wantName = params.name?.trim() ? params.name.trim() : undefined;
    const wantSha = params.sha256?.trim() ? params.sha256.trim() : undefined;
    const wantMessageId = params.message_id?.trim() ? params.message_id.trim() : undefined;
    const wantSeq = params.message_seq;

    const extra = ctx.extra as SaveAttachmentExtra | undefined;
    const service = extra?.attachmentService;
    const sessions = extra?.sessionManager;
    if (!service || !sessions) {
      return failureResult('attach.tool.deps_unavailable', {});
    }

    // Вложения ищутся только в сессии разговора: у саб-агента это родительская
    // (там живут вложения пользователя), в основной — она же сама. Чужую
    // историю тул не читает.
    const session = await sessions.getSession(parentSessionIdOf(ctx) ?? ctx.sessionId);
    let candidates = session ? collectAttachments(session.messages) : [];

    // Явный выбор сообщения — до выбора вложения. Так «последнее вложение»
    // не подменяет файл из другого хода (частый случай: агент сохраняет
    // вложение, а в сессии есть более позднее/раннее медиа).
    if (wantMessageId !== undefined || wantSeq !== undefined) {
      candidates = candidates.filter((candidate) =>
        (wantMessageId === undefined || candidate.messageId === wantMessageId)
        && (wantSeq === undefined || candidate.messageSeq === wantSeq),
      );
      if (candidates.length === 0) {
        return failureResult(
          'attach.tool.not_found',
          {
            path: wantMessageId ?? `seq ${wantSeq}`,
          },
          {
            ...(wantMessageId !== undefined ? { message_id: wantMessageId } : {}),
            ...(wantSeq !== undefined ? { message_seq: wantSeq } : {}),
          },
        );
      }
    }

    let selected: AttachmentCandidate | undefined;
    if (wantSha) {
      // Точное совпадение по содержимому. Дубль (одно и то же вложение в разных
      // сообщениях) — не ошибка выбора: объект один, берём первое вхождение.
      selected = candidates.find((c) => c.data.sha256.toLowerCase() === wantSha.toLowerCase());
      if (!selected) {
        return failureResult('attach.tool.not_found', { path: wantSha }, { sha256: wantSha });
      }
    } else if (wantName) {
      const byName = candidates.filter((c) => c.data.name === wantName);
      if (byName.length === 0) {
        return failureResult('attach.tool.not_found', { path: wantName }, { name: wantName });
      }
      // Одноимённые вложения (частый случай: `image.png` из разных ходов)
      // сначала схлопываются по содержимому: повторная отправка того же файла
      // не должна выглядеть как «выбери sha256». Разные файлы с одним именем —
      // по-прежнему неоднозначность: молча выбрать «первое» значит подсунуть
      // модели не тот файл.
      const distinct = dedupeCandidates(byName);
      if (distinct.length > 1) {
        return failureResult(
          'attach.tool.ambiguous',
          { query: wantName, list: distinct.map(describeCandidate).join(', ') },
          { name: wantName, matches: distinct.length, occurrences: byName.length },
        );
      }
      selected = distinct[0];
    } else {
      // Ничего не задано — последнее медиа-вложение сессии (обычно то, о котором
      // только что говорил пользователь).
      selected = candidates[candidates.length - 1];
      if (!selected) {
        return failureResult('attach.tool.no_attachment', {});
      }
    }
    // Защита от пустого выбора (недостижима: ветки выше либо вернули отказ,
    // либо нашли кандидата) — нужна для сужения типа без не-null assertion.
    if (!selected) {
      return failureResult('attach.tool.no_attachment', {});
    }

    const data = selected.data;
    // Только объекты вложений: индекс `attachments/` в blob-хранилище.
    if (!data.blobPath.startsWith(`${ATTACHMENT_DIR}/`)) {
      return failureResult(
        'attach.tool.not_found',
        { path: data.blobPath },
        { blob_path: data.blobPath, message_id: selected.messageId },
      );
    }

    // Метаданные — из сервиса (sidecar), он же отказывает на чужих путях.
    let meta;
    try {
      meta = await service.resolve(data.blobPath);
    } catch (err) {
      return failureResult(
        'attach.tool.save_failed',
        { error: err instanceof Error ? err.message : String(err) },
        { blob_path: data.blobPath },
      );
    }
    if (!meta) {
      return failureResult(
        'attach.tool.not_found',
        { path: data.blobPath },
        { blob_path: data.blobPath, message_id: selected.messageId },
      );
    }
    if (meta.size <= 0) {
      return failureResult(
        'attach.tool.save_failed',
        { error: 'attachment is empty (0 bytes)' },
        { blob_path: data.blobPath, size: meta.size },
      );
    }

    // Целевой путь: по умолчанию `<workspace>/attachments/<name|sha8>`; имя
    // санитайзится той же функцией, что и материализация отброшенных вложений.
    const defaultName = sanitizeAttachmentName(meta.name ?? data.name, meta.sha256.slice(0, 8));
    const relPath = params.path?.trim() ? params.path.trim() : `${ATTACHMENT_DIR}/${defaultName}`;
    try {
      validateInputPath(relPath, 'path');
    } catch (err) {
      return argErrorResult(this.name, err instanceof Error ? err.message : String(err));
    }
    // Абсолютный путь — отказ, а не «внешний доступ по правилу»: тул выгружает
    // файл проекта внутрь workspace (как `attach_workspace_file`).
    if (isAbsolute(relPath)) return pathEscapesWorkspaceResult(relPath);
    const roots = toolRoots(ctx);
    const resolvedPath = resolvePath(relPath, ctx.workingDir);
    if (!isLexicallyInsideRoots(roots, resolvedPath)) {
      return pathEscapesWorkspaceResult(resolvedPath);
    }

    // PROP-135 (Ф3): запись идёт в контур исполнения — там, где в
    // split-топологии лежит рабочий каталог проекта. Без FS в порте — отказ
    // про `features.fs` (тот же текст, что у прочих файловых тулов).
    const port = resolveExecutionPort(ctx);
    const fs = port.fs;
    if (!fs) {
      return { content: FS_UNAVAILABLE_TEXT, isError: true };
    }
    // Симлинк-побег проверяется по **реальным** путям (у точки исполнения):
    // лексическая проверка в control plane симлинк наружу не видит.
    const perimeter = await fsCall(() => escapesWorkspace(fs, roots, resolvedPath));
    if (!perimeter.ok) return perimeter.result;
    if (perimeter.value) {
      return pathEscapesWorkspaceResult(resolvedPath);
    }

    // Существующий файл не перезаписываем. Если в нём уже лежит ровно это
    // вложение — операция идемпотентна (успех, `existing: true`): повторное
    // «сохрани файл» не должно упираться в отказ. Чужое содержимое — прежний
    // отказ с подсказкой указать другой `path`.
    const expected = { sha256: meta.sha256, size: meta.size };
    const saved = (existing: boolean): ToolResult =>
      savedResult({
        relPath,
        blobPath: data.blobPath,
        sha256: meta.sha256,
        mime: meta.mime,
        size: meta.size,
        existing,
      });
    let existingInfo: FsStat | null = null;
    try {
      existingInfo = await fs.stat(resolvedPath);
    } catch (err) {
      if (!isFsPathError(err)) throw err;
      if (err.code === 'not_found') {
        // Пути нет — идём создавать (обычное состояние, а не сбой).
        existingInfo = null;
      } else if (err.code === 'not_directory') {
        // Компонент пути занят файлом — целевое имя недоступно.
        return failureResult('attach.tool.exists', { path: relPath }, { path: relPath });
      } else {
        // Нет доступа / путь не разрешается — не «пути нет»: отказ с причиной.
        return failureResult(
          'attach.tool.save_failed',
          { error: err.message },
          { path: relPath },
        );
      }
    }
    if (existingInfo) {
      if (await isSameFileContent(fs, resolvedPath, expected)) return saved(true);
      return failureResult('attach.tool.exists', { path: relPath }, { path: relPath });
    }

    // Каталог назначения создаётся до чтения объекта (как прежде): публикация
    // идёт в него, а ошибка чтения не должна оставлять «половину» операции.
    const targetDir = dirname(resolvedPath);
    try {
      await fs.mkdir(targetDir);
    } catch (err) {
      if (!isFsPathError(err)) throw err;
      return failureResult(
        'attach.tool.save_failed',
        { error: err.message },
        { path: relPath, blob_path: data.blobPath },
      );
    }

    const read = await readAttachmentBytes(service, data.blobPath, meta.size);
    if (!read.ok) {
      if (read.kind === 'not_found') {
        return failureResult(
          'attach.tool.not_found',
          { path: data.blobPath },
          { blob_path: data.blobPath, message_id: selected.messageId },
        );
      }
      return failureResult(
        'attach.tool.save_failed',
        { error: read.error },
        { blob_path: data.blobPath, size: meta.size },
      );
    }

    // Публикация — на порту: атомарно и **без перезаписи** (`ifExists: 'fail'`).
    try {
      await fs.upload(resolvedPath, read.bytes, { ifExists: 'fail' });
    } catch (err) {
      if (isFsPathError(err) && err.code === 'exists') {
        // Гонка: файл появился между проверкой и публикацией. Совпало ли
        // содержимое — решает та же сверка (идемпотентность сохраняется).
        if (await isSameFileContent(fs, resolvedPath, expected)) return saved(true);
        return failureResult('attach.tool.exists', { path: relPath }, { path: relPath });
      }
      if (isFsPathError(err)) {
        return failureResult(
          'attach.tool.save_failed',
          { error: err.message },
          { path: relPath, blob_path: data.blobPath },
        );
      }
      throw err;
    }

    return saved(false);
  },
};
