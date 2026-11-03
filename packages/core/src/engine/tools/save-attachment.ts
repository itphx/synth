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
 * - **Только текущая сессия.** Источник вложения — `messages[].parts[]` сессии
 *   `ctx.sessionId` (`sessionManager.getSession`); чужие сессии не видны.
 * - **Только объекты вложений.** `blobPath` обязан быть из `attachments/`
 *   (`AttachmentService.resolve`/`read` и сами отказывают иначе) — произвольные
 *   blob'ы (логи процессов, артефакты) через этот контур не выгружаются.
 * - **Containment как у `attach_workspace_file`**: абсолютный путь, `..` за
 *   пределы workspace и побег через симлинк отклоняются (`path-utils`).
 * - **Существующий файл не перезаписывается.** Публикация атомарная: байты
 *   пишутся во временный файл `.tmp-<uuid>` того же каталога и публикуются
 *   ссылкой (`link`, fallback `copyFile` с `COPYFILE_EXCL`), поэтому занятое имя
 *   остаётся нетронутым, а модель получает подсказку указать другой `path`.
 *   **Повторное сохранение идемпотентно:** если в целевом файле уже лежит ровно
 *   то же содержимое (sha256 совпадает), операция считается успешной
 *   (`metadata.existing: true`) — «сохрани ещё раз» не упирается в отказ.
 * - Лимитов размера здесь нет: файл уже принят вложениями (`attachments.*`),
 *   проверяется только непустота объекта.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
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
import {
  isLexicallyInside,
  isSymlinkEscapeInRoots,
  pathEscapesWorkspaceResult,
  resolvePath,
  toolRoots,
  validateInputPath,
} from './path-utils.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';

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
 * SHA-256 содержимого файла **потоком** (`createHash` + `createReadStream`):
 * файл целиком в память не читается — вложения бывают крупными.
 */
async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * В существующем целевом файле уже лежит ровно это вложение?
 *
 * Сначала сравнивается размер (дешёвая проверка, файл не читается), затем
 * sha256 потоком. Не-обычный файл, ошибка `stat`/чтения — «не совпадает»:
 * перезаписи чужого содержимого нет (fail-closed).
 */
async function isSameFileContent(
  filePath: string,
  expected: { sha256: string; size: number },
): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== expected.size) return false;
    const actual = await hashFileSha256(filePath);
    return actual.toLowerCase() === expected.sha256.toLowerCase();
  } catch {
    return false;
  }
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

    // Вложения ищутся только в текущей сессии: чужую историю тул не читает.
    const session = await sessions.getSession(ctx.sessionId);
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
    if (isSymlinkEscapeInRoots(roots, resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

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
    try {
      await stat(resolvedPath);
      if (await isSameFileContent(resolvedPath, expected)) return saved(true);
      return failureResult('attach.tool.exists', { path: relPath }, { path: relPath });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOTDIR') {
        // Компонент пути занят файлом — целевое имя недоступно.
        return failureResult('attach.tool.exists', { path: relPath }, { path: relPath });
      }
      if (code !== 'ENOENT') {
        return failureResult(
          'attach.tool.save_failed',
          { error: err instanceof Error ? err.message : String(err) },
          { path: relPath },
        );
      }
    }

    const targetDir = dirname(resolvedPath);
    const tmpPath = `${targetDir}/.tmp-${randomUUID()}`;
    let tmpCreated = false;
    try {
      await mkdir(targetDir, { recursive: true });

      const stream = await service.read(data.blobPath);
      if (!stream) {
        return failureResult(
          'attach.tool.not_found',
          { path: data.blobPath },
          { blob_path: data.blobPath, message_id: selected.messageId },
        );
      }

      // Байты сначала во временный файл того же каталога (атомарная публикация).
      tmpCreated = true;
      await pipeline(stream, createWriteStream(tmpPath));

      // Публикация: `link` атомарен и не перезаписывает; `copyFile` с
      // `COPYFILE_EXCL` — фоллбек для ФС без жёстких ссылок. `rename` здесь не
      // годится: он молча заменил бы существующий файл. Гонка (файл появился
      // между проверкой и публикацией) разрешается той же сверкой содержимого.
      try {
        await link(tmpPath, resolvedPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EEXIST') {
          if (await isSameFileContent(resolvedPath, expected)) return saved(true);
          return failureResult('attach.tool.exists', { path: relPath }, { path: relPath });
        }
        await copyFile(tmpPath, resolvedPath, fsConstants.COPYFILE_EXCL);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        if (await isSameFileContent(resolvedPath, expected)) return saved(true);
        return failureResult('attach.tool.exists', { path: relPath }, { path: relPath });
      }
      return failureResult(
        'attach.tool.save_failed',
        { error: err instanceof Error ? err.message : String(err) },
        { path: relPath, blob_path: data.blobPath },
      );
    } finally {
      // Временный файл не оставляем ни при успехе (жёсткая ссылка уже создана),
      // ни при ошибке.
      if (tmpCreated) await rm(tmpPath, { force: true }).catch(() => undefined);
    }

    return saved(false);
  },
};
