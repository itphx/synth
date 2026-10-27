/**
 * ADR-115, подраздел «Отправка файла в ответе»: тул `send_attachment` —
 * прикрепить файл из рабочего каталога к **ответу** агента.
 *
 * ## Зачем
 *
 * `attach_workspace_file` доставляет файл как **пользовательское** вложение:
 * модель получает его на следующем ходу, но во внешний канал (Telegram/VK)
 * файл не уходит — шлюз раздаёт только вложения **ответа**
 * (`stream.done.attachments`, `engine/orchestrator/phases/process-finalize.ts`).
 * Продюсера этих вложений не было: `saveAssistantMessage` писал только текст.
 * Тул замыкает цепочку «файл в workspace → blob → медиа-часть финального
 * сообщения → `stream.done.attachments` → шлюз».
 *
 * ## Границы
 *
 * - **Только внутри рабочего каталога.** Containment как у
 *   `attach_workspace_file`/`fs-read`: абсолютный путь отклоняется (файл
 *   отправляется из проекта, а не из ФС хоста), `..` за пределы workspace и
 *   побег через симлинк — отказ.
 * - **Лимиты и allowlist — общие** (`attachments.*`): `enabled`, размер по
 *   `stat` **до** чтения, MIME/модальность/белый список — в
 *   `AttachmentService.upload` (единственная точка записи байтов).
 * - **Не отправка, а очередь.** Часть складывается в коллектор хода
 *   (`extra.outboundAttachments`), а к сообщению её добавляет финализация.
 *   Поэтому ошибка/отмена хода ничего не отправляет: части остаются в blob до
 *   GC (`blob_refs` не создаётся, TTL вычистит объект).
 * - Чисел метрик не добавляем: `upload`/`buildMediaPart` сами пишут
 *   `synth_attachment_*` (ADR-094).
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  attachmentsConfigSchema,
  makeMediaPart,
  ToolCapability,
  type AttachmentsConfig,
  type Part,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@itphx/synth-shared';
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
export const SEND_ATTACHMENT_TOOL = 'send_attachment';

/**
 * Коллектор медиа-частей ответа текущего хода.
 *
 * Создаётся оркестратором на один ход (`_processMessage`) и передаётся тулам
 * через `ctx.extra.outboundAttachments`. Части складываются здесь, а не
 * отправляются сразу: вложения обязаны принадлежать **финальному** сообщению
 * хода (иначе при отмене/ошибке они ушли бы без ответа, а при нескольких
 * итерациях — к промежуточному tool-chain сообщению, которое шлюз не читает).
 */
export interface OutboundAttachmentCollector {
  /** Положить медиа-часть в ответ текущего хода (порядок — порядок вызовов). */
  add(part: Part): void;
}

/**
 * Зависимости тула из `ToolContext.extra` (упаковка — оркестратор).
 *
 * - `attachmentService` — сервис вложений (ADR-115): загрузка байтов и сборка
 *   медиа-части. Не задан — отправка недоступна (`attach.tool.deps_unavailable`).
 * - `attachmentsConfig` — live-конфиг `attachments.*` (резолвер): ранние
 *   проверки (`enabled`, `maxBytesPerFile`) **до** чтения файла. Не задан —
 *   дефолты схемы (как у сервиса без runtime-настроек).
 * - `outboundAttachments` — коллектор частей ответа хода. Не задан — отправка
 *   недоступна (`attach.tool.deps_unavailable`): «тихий» успех означал бы, что
 *   файл загружен, а получатель его не увидит.
 */
export interface SendAttachmentExtra {
  attachmentService?: AttachmentService;
  attachmentsConfig?: () => AttachmentsConfig;
  outboundAttachments?: OutboundAttachmentCollector;
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

export const sendAttachmentTool: ToolDefinition = {
  name: SEND_ATTACHMENT_TOOL,
  description:
    'Attach a file from the project working directory to the reply, so that the user receives it '
    + 'as a file (for example in a messenger). The file is uploaded to the attachment store and '
    + 'added to the final message of the current turn. Path must be relative to the working '
    + 'directory; absolute paths and paths outside the working directory are rejected. Attachment '
    + 'limits and allowed MIME types of the instance apply. Nothing is sent if the turn fails or is '
    + 'cancelled.',
  parameters: z.object({
    path: z
      .string()
      .describe('Path to the file relative to the working directory (absolute paths are rejected)'),
    name: z
      .string()
      .optional()
      .describe('File name to show to the recipient (defaults to the file basename)'),
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
    // Абсолютный путь — не «внешний доступ по правилу», а отказ: файл
    // отправляется из проекта (как `attach_workspace_file`).
    if (isAbsolute(params.path)) return pathEscapesWorkspaceResult(params.path);
    const resolvedPath = resolvePath(params.path, ctx.workingDir);
    if (!isLexicallyInsideWorkspace(ctx.workingDir, resolvedPath)) {
      return pathEscapesWorkspaceResult(resolvedPath);
    }
    if (isSymlinkEscape(ctx.workingDir, resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    const extra = ctx.extra as SendAttachmentExtra | undefined;
    const service = extra?.attachmentService;
    const collector = extra?.outboundAttachments;
    if (!service || !collector) {
      return failureResult('attach.tool.deps_unavailable', {}, { path: resolvedPath });
    }
    const config = extra?.attachmentsConfig?.() ?? attachmentsConfigSchema.parse({});
    if (!config.enabled) {
      return failureResult('attach.tool.disabled', {}, { path: resolvedPath });
    }

    // Файл существует и это файл (каталог/устройство отправить нельзя).
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
    // Пустой файл не грузим: MIME по содержимому не определяется (`upload`
    // ответил бы `unsupported_mime`) — отказ сразу, без чтения.
    if (info.size <= 0) {
      return failureResult('attach.tool.unrecognized', { path: params.path }, { path: resolvedPath });
    }
    // Размер — по `stat`, до чтения: гигабайтный файл в память не тянем.
    if (info.size > config.maxBytesPerFile) {
      return failureResult(
        'attach.tool.too_large',
        { path: params.path, size: String(info.size), limit: String(config.maxBytesPerFile) },
        { path: resolvedPath, size: info.size, limit: config.maxBytesPerFile },
      );
    }

    // Имя для получателя: явное (`name`) либо basename файла.
    const name = params.name?.trim() ? params.name.trim() : basename(resolvedPath);

    let bytes: Buffer;
    try {
      bytes = await readFile(resolvedPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return failureResult('attach.tool.not_found', { path: params.path }, { path: resolvedPath });
      }
      throw err;
    }

    let meta;
    try {
      meta = await service.upload({ sessionId: ctx.sessionId, bytes, name });
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
        // `unsupported_mime` — формат не распознан/не разрешён (в т.ч. SVG).
        return failureResult(
          'attach.tool.unrecognized',
          { path: params.path },
          { path: resolvedPath, detail: err.message },
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

    // Ещё **не** отправка: часть ждёт финализации хода (см. док-блок модуля).
    collector.add(makeMediaPart(part.type, part.data));

    const resultName = meta.name ?? name;
    return {
      content: sm('attach.tool.queued', { name: resultName }),
      metadata: {
        i18n: i18nMeta('attach.tool.queued', { name: resultName }),
        path: params.path,
        blob_path: meta.blobPath,
        mime: meta.mime,
        size: meta.size,
        name: resultName,
      },
    };
  },
};
