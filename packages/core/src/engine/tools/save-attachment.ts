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
 * - Лимитов размера здесь нет: файл уже принят вложениями (`attachments.*`),
 *   проверяется только непустота объекта.
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
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
  isSymlinkEscape,
  pathEscapesWorkspaceResult,
  resolvePath,
  validateInputPath,
} from './path-utils.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

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

/** Единый текст ошибки разбора аргументов (как у соседних тулов). */
function argsErrorResult(toolName: string, issues: string): ToolResult {
  return {
    content: sm('tool.args_error', { tool: toolName, issues }),
    isError: true,
    metadata: { i18n: i18nMeta('tool.args_error', { tool: toolName }) },
  };
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

/** Лексическая проверка вхождения пути в рабочий каталог (без ФС). */
function isLexicallyInsideWorkspace(workingDir: string, candidate: string): boolean {
  const rel = relative(workingDir, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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

export const saveAttachmentTool: ToolDefinition = {
  name: SAVE_ATTACHMENT_TOOL,
  description:
    'Save an attachment of the current session to the project working directory as a file '
    + '(image, audio, video, PDF, …), so that shell and file tools can process it. Attachments are '
    + 'searched in the session history: pass message_id or message_seq to restrict the search to one '
    + 'message, sha256 to pick an exact attachment, name to pick by file name, or nothing to take the '
    + 'latest media attachment. Selectors combine: message first, then sha256/name within it. Path is '
    + 'relative to the working directory (default attachments/<name|sha8>); absolute paths and paths '
    + 'outside the working directory are rejected, and an existing file is never overwritten.',
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
      return argsErrorResult(
        this.name,
        parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
      );
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
      if (byName.length > 1) {
        // Одноимённые вложения (частый случай: `image.png` из разных ходов) —
        // молча выбрать «первое» значит подсунуть модели не тот файл.
        return failureResult(
          'attach.tool.ambiguous',
          { query: wantName, list: byName.map(describeCandidate).join(', ') },
          { name: wantName, matches: byName.length },
        );
      }
      selected = byName[0];
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
      return argsErrorResult(this.name, err instanceof Error ? err.message : String(err));
    }
    // Абсолютный путь — отказ, а не «внешний доступ по правилу»: тул выгружает
    // файл проекта внутрь workspace (как `attach_workspace_file`).
    if (isAbsolute(relPath)) return pathEscapesWorkspaceResult(relPath);
    const resolvedPath = resolvePath(relPath, ctx.workingDir);
    if (!isLexicallyInsideWorkspace(ctx.workingDir, resolvedPath)) {
      return pathEscapesWorkspaceResult(resolvedPath);
    }
    if (isSymlinkEscape(ctx.workingDir, resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    // Существующий файл не перезаписываем: сначала честная проверка (быстрый
    // отказ до чтения blob), затем публикация без перезаписи (`link`/EXCL).
    try {
      await stat(resolvedPath);
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
      // годится: он молча заменил бы существующий файл.
      try {
        await link(tmpPath, resolvedPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EEXIST') {
          return failureResult('attach.tool.exists', { path: relPath }, { path: relPath });
        }
        await copyFile(tmpPath, resolvedPath, fsConstants.COPYFILE_EXCL);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
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

    const size = meta.size;
    return {
      content: sm('attach.tool.saved', { path: relPath, size: String(size) }),
      metadata: {
        i18n: i18nMeta('attach.tool.saved', { path: relPath, size: String(size) }),
        path: relPath,
        blob_path: data.blobPath,
        sha256: meta.sha256,
        mime: meta.mime,
        size,
      },
    };
  },
};
