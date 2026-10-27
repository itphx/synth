/**
 * ADR-115, подраздел «Повторная привязка файла из workspace»: тул
 * `attach_workspace_file` — приложить файл из рабочего каталога к диалогу
 * **как обычное вложение**.
 *
 * ## Зачем
 *
 * Отброшенное вложение материализуется в `<workspace>/attachments/<name>` и
 * модели сообщается путь. Но `read_file` читает файл как UTF-8: изображение,
 * аудио или PDF так не прочитать (`engine/tools/fs-read.ts`), а `ToolResult`
 * умеет отдавать только строку — медиа-блоков в результатах тулов нет. Тул
 * замыкает круг: файл с диска загружается в сервис вложений и доставляется в
 * сессию обычным user-сообщением с медиа-частью, поэтому следующий ход модели
 * получает вложение штатной гидратацией (ADR-115).
 *
 * ## Границы
 *
 * - **Только внутри рабочего каталога.** Абсолютный путь, `..` за пределы
 *   workspace и побег через симлинк отклоняются (containment как у
 *   `fs-read.ts`, но строже: абсолютные пути не принимаются вовсе — файл
 *   прикладывается из проекта, а не из ФС хоста).
 * - **Лимиты и allowlist — общие** (`attachments.*`): размер проверяется по
 *   `stat` **до** чтения файла, MIME/модальность/белый список — в
 *   `AttachmentService.upload` (единственная точка записи байтов).
 * - **Доставка — через хук оркестратора** (`deliverUserMessage`: очередь +
 *   автоход). Хука нет — честная ошибка, а не «тихий» успех: файл загружен,
 *   но модель его не увидит.
 * - Чисел метрик не добавляем: `upload`/`buildMediaPart` сами пишут
 *   `synth_attachment_*` (ADR-094).
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  appendMediaPlaceholders,
  attachmentsConfigSchema,
  generateId,
  makeMediaPart,
  MessageRole,
  nowISO,
  ToolCapability,
  type AttachmentsConfig,
  type Message,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@itphx/synth-shared';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import {
  AttachmentError,
  type AttachmentService,
} from '../attachments/service.js';
import { isAborted, abortedResult } from './abort.js';
import {
  isSymlinkEscape,
  pathEscapesWorkspaceResult,
  resolvePath,
  validateInputPath,
} from './path-utils.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/** Имя тула (используется в текстах и в permission-группах). */
export const ATTACH_WORKSPACE_FILE_TOOL = 'attach_workspace_file';

/**
 * Зависимости тула из `ToolContext.extra` (упаковка — оркестратор).
 *
 * - `attachmentService` — сервис вложений (ADR-115): загрузка байтов и сборка
 *   медиа-части. Не задан — привязка недоступна (`attach.tool.deps_unavailable`).
 * - `attachmentsConfig` — live-конфиг `attachments.*` (резолвер): ранние
 *   проверки (`enabled`, `maxBytesPerFile`) **до** чтения файла. Не задан —
 *   дефолты схемы (как у сервиса без runtime-настроек).
 * - `deliverUserMessage` — доставка user-сообщения в сессию (очередь +
 *   автоход). Не задан — отказ `attach.tool.delivery_unavailable`.
 * - `blobRefs` — учёт ссылок на объекты blob-хранилища: сообщение ссылается на
 *   объект, иначе GC (ADR-115) сочёл бы его сиротой по TTL.
 */
export interface AttachWorkspaceFileExtra {
  attachmentService?: AttachmentService;
  attachmentsConfig?: () => AttachmentsConfig;
  deliverUserMessage?: (sessionId: string, message: Message) => Promise<void>;
  blobRefs?: BlobRefRepository;
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

export const attachWorkspaceFileTool: ToolDefinition = {
  name: ATTACH_WORKSPACE_FILE_TOOL,
  description:
    'Attach a file from the project working directory to the dialog as a regular attachment '
    + '(image, audio, video, PDF, …), so the model receives it on the next turn. Use it for files '
    + 'that cannot be read as text (read_file reads UTF-8 only). Path must be relative to the '
    + 'working directory; absolute paths and paths outside the working directory are rejected. '
    + 'Attachment limits and allowed MIME types of the instance apply.',
  parameters: z.object({
    path: z
      .string()
      .describe('Path to the file relative to the working directory (absolute paths are rejected)'),
    name: z
      .string()
      .optional()
      .describe('File name to show to the model (defaults to the file basename)'),
  }),
  capabilities: [ToolCapability.FILE_READ],
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
    const params = parsed.data as { path: string; name?: string };
    try {
      validateInputPath(params.path, 'path');
    } catch (err) {
      return argsErrorResult(this.name, err instanceof Error ? err.message : String(err));
    }
    // Абсолютный путь — не «внешний доступ по правилу», а отказ: тул прикладывает
    // файл проекта из workspace (иначе агент тянул бы в диалог файлы хоста).
    if (isAbsolute(params.path)) return pathEscapesWorkspaceResult(params.path);
    const resolvedPath = resolvePath(params.path, ctx.workingDir);
    if (!isLexicallyInsideWorkspace(ctx.workingDir, resolvedPath)) {
      return pathEscapesWorkspaceResult(resolvedPath);
    }
    if (isSymlinkEscape(ctx.workingDir, resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    const extra = ctx.extra as AttachWorkspaceFileExtra | undefined;
    const service = extra?.attachmentService;
    if (!service) {
      return failureResult('attach.tool.deps_unavailable', {}, { path: resolvedPath });
    }
    const config = extra?.attachmentsConfig?.() ?? attachmentsConfigSchema.parse({});
    if (!config.enabled) {
      return failureResult('attach.tool.disabled', {}, { path: resolvedPath });
    }

    // Файл существует и это файл (каталог/устройство приложить нельзя).
    let info;
    try {
      info = await stat(resolvedPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return failureResult('attach.tool.not_found', { path: params.path }, { path: resolvedPath });
      }
      throw err;
    }
    if (!info.isFile()) {
      return failureResult('attach.tool.not_a_file', { path: params.path }, { path: resolvedPath });
    }
    // Размер — по `stat`, до чтения: гигабайтный файл в память не тянем.
    if (info.size > config.maxBytesPerFile) {
      return failureResult(
        'attach.tool.too_large',
        { path: params.path, size: String(info.size), limit: String(config.maxBytesPerFile) },
        { path: resolvedPath, size: info.size, limit: config.maxBytesPerFile },
      );
    }

    let meta;
    try {
      meta = await service.upload({
        sessionId: ctx.sessionId,
        bytes: await readFile(resolvedPath),
        ...(params.name ? { name: params.name } : {}),
      });
    } catch (err) {
      if (err instanceof AttachmentError) {
        if (err.code === 'attachments_disabled') {
          return failureResult('attach.tool.disabled', {}, { path: resolvedPath });
        }
        if (err.code === 'too_large') {
          return failureResult(
            'attach.tool.too_large',
            { path: params.path, size: String(info.size), limit: String(config.maxBytesPerFile) },
            { path: resolvedPath, size: info.size, limit: config.maxBytesPerFile },
          );
        }
        return failureResult(
          'attach.tool.unsupported_mime',
          { path: params.path, detail: err.message },
          { path: resolvedPath },
        );
      }
      throw err;
    }

    // Медиа-часть сообщения собирает сервис (тип части по MIME, sidecar-метаданные).
    const part = await service.buildMediaPart(meta.blobPath);
    if (!part) {
      return failureResult(
        'attach.tool.unrecognized',
        { path: params.path },
        { path: resolvedPath, blob_path: meta.blobPath },
      );
    }

    const deliver = extra?.deliverUserMessage;
    if (!deliver) {
      return failureResult(
        'attach.tool.delivery_unavailable',
        {},
        { path: resolvedPath, blob_path: meta.blobPath, mime: meta.mime, size: meta.size },
      );
    }

    // Сообщение — как пользовательское: роль USER, автор `User`, медиа-часть
    // несёт ссылку на объект, `content` — короткий текст (в чате локализуется
    // по `metadata.i18n`) + плейсхолдер вложения: без него факт привязки
    // «испаряется» в строковых производных (экспорт, поиск, PG-маппинг) —
    // ADR-115 §«Модель контента».
    const contentParams = { path: params.path };
    const parts = [makeMediaPart(part.type, part.data)];
    const content = appendMediaPlaceholders(sm('attach.message.from_workspace', contentParams), parts);
    const message: Message = {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts,
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      ephemeral: false,
      author: 'User',
      metadata: {
        source: 'workspace-attachment',
        path: params.path,
        mime: meta.mime,
        size: meta.size,
        i18n: i18nMeta('attach.message.from_workspace', contentParams),
      },
    };

    await deliver(ctx.sessionId, message);
    // Учёт ссылки на объект: без него GC (ADR-115) удалил бы вложение по TTL,
    // хотя сообщение на него ссылается. Best-effort — сообщение уже доставлено.
    if (extra?.blobRefs) {
      try {
        await extra.blobRefs.add({
          blobPath: meta.blobPath,
          ownerKind: 'message',
          ownerId: message.id,
        });
      } catch {
        // учёт ссылок — производная: не отменяет привязку и не роняет ход
      }
    }

    return {
      content: sm('attach.tool.attached', { path: params.path }),
      metadata: {
        i18n: i18nMeta('attach.tool.attached', { path: params.path }),
        blob_path: meta.blobPath,
        mime: meta.mime,
        size: meta.size,
        path: params.path,
        message_id: message.id,
      },
    };
  },
};
