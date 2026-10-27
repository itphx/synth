/**
 * Тесты тула `attach_workspace_file` (ADR-115, подраздел «Повторная привязка
 * файла из workspace»).
 *
 * Сервис вложений — **объектный мок** (`{upload, buildMediaPart}`): тул
 * проверяется, а не `AttachmentService` (у него свой suite —
 * `engine/attachments/service.test.ts`). Реальный ФС нужен: containment
 * (симлинки, `..`, абсолютные пути) заглушкой не проверить — работаем во
 * временном каталоге (`mkdtemp`).
 *
 * Что проверяется:
 * - успех: байты и имя доехали до `upload`, user-сообщение отдано доставке
 *   (роль, медиа-часть, `content` с плейсхолдером, `metadata.source`), ссылка
 *   на объект учтена, в результате — `metadata.blob_path`;
 * - containment: `../…`, абсолютный путь, побег через симлинк → `isError`,
 *   `upload` не вызывается;
 * - нет файла / каталог вместо файла → разные ключи отказа;
 * - `attachments.enabled=false` → отказ до чтения файла;
 * - размер больше `maxBytesPerFile` → отказ **по `stat`** (файл не читается,
 *   `upload` не вызывается);
 * - `AttachmentError('unsupported_mime')` из `upload` → отказ с ключом типа;
 * - нет `deliverUserMessage` → `attach.tool.delivery_unavailable`;
 * - `buildMediaPart → null` (объект не распознан) → `attach.tool.unrecognized`;
 * - permission-слой: группа `file_read`, путь в `TOOL_PATH_PARAMS`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachmentsConfigSchema,
  generateId,
  MessageRole,
  type AttachmentsConfig,
  type Message,
  type ToolContext,
} from '@itphx/synth-shared';
import { attachWorkspaceFileTool } from './attach-workspace-file.js';
import { AttachmentError } from '../attachments/service.js';
import type { AttachmentService } from '../attachments/service.js';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import { TOOL_PATH_PARAMS, getToolGroups } from '../permission/groups.js';

/** Мок сервиса вложений: только методы, которые зовёт тул. */
interface AttachmentServiceMock {
  upload: ReturnType<typeof vi.fn>;
  buildMediaPart: ReturnType<typeof vi.fn>;
}

/** Данные объекта, который «лежит» в blob-хранилище (ответ мока). */
const BLOB_PATH = 'attachments/ab/deadbeef';

describe('attach_workspace_file — привязка файла из workspace (ADR-115)', () => {
  let workspace: string;
  let outside: string;
  let service: AttachmentServiceMock;
  let delivered: Array<{ sessionId: string; message: Message }>;
  let addedRefs: Array<{ blobPath: string; ownerKind: string; ownerId: string }>;

  /** Контекст тула: рабочий каталог — временный workspace сессии. */
  function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
    return {
      sessionId: 'sess-1',
      messageId: generateId(),
      workingDir: workspace,
      extra,
    };
  }

  /** Полный набор зависимостей тула (из `ctx.extra` упаковывает оркестратор). */
  function makeExtra(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      attachmentService: service as unknown as AttachmentService,
      deliverUserMessage: async (sessionId: string, message: Message) => {
        delivered.push({ sessionId, message });
      },
      blobRefs: {
        add: async (ref: { blobPath: string; ownerKind: string; ownerId: string }) => {
          addedRefs.push(ref);
        },
      } as unknown as BlobRefRepository,
      ...overrides,
    };
  }

  /** Ключ i18n отказа (машинный код проверки — без текста). */
  function errorKey(result: { metadata?: Record<string, unknown> }): string | undefined {
    return (result.metadata?.i18n as { key?: string } | undefined)?.key;
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'synth-attach-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'synth-attach-out-'));
    delivered = [];
    addedRefs = [];
    service = {
      upload: vi.fn(async ({ bytes, name }: { bytes: Buffer; name?: string }) => ({
        id: BLOB_PATH,
        blobPath: BLOB_PATH,
        sha256: 'deadbeef',
        mime: 'image/png',
        size: bytes.length,
        ...(name ? { name } : {}),
      })),
      buildMediaPart: vi.fn(async () => ({
        type: 'image' as const,
        data: {
          blobPath: BLOB_PATH,
          sha256: 'deadbeef',
          mime: 'image/png',
          size: 8,
          name: 'shot.png',
        },
      })),
    };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('успешная привязка', () => {
    it('загружает файл и доставляет user-сообщение с медиа-частью', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');

      const result = await attachWorkspaceFileTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBeFalsy();
      // `upload` получил именно байты файла (не путь и не пустой буфер).
      const uploadArg = service.upload.mock.calls[0]![0] as { bytes: Buffer; name?: string; sessionId: string };
      expect(uploadArg.sessionId).toBe('sess-1');
      expect(uploadArg.bytes.toString()).toBe('PNGDATA1');
      expect(uploadArg.name).toBeUndefined();
      expect(service.buildMediaPart).toHaveBeenCalledWith(BLOB_PATH);

      // Сообщение — пользовательское, с медиа-частью и меткой происхождения.
      expect(delivered).toHaveLength(1);
      const { sessionId, message } = delivered[0]!;
      expect(sessionId).toBe('sess-1');
      expect(message.role).toBe(MessageRole.USER);
      expect(message.parts).toHaveLength(1);
      expect(message.parts[0]!.type).toBe('image');
      expect(message.parts[0]!.data).toMatchObject({ blobPath: BLOB_PATH, mime: 'image/png' });
      expect(message.metadata?.source).toBe('workspace-attachment');
      expect(message.metadata?.path).toBe('shot.png');
      // ADR-115: факт вложения обязан оставить след в тексте (`content`).
      expect(message.content).toContain('[image: shot.png]');

      // Ссылка на объект учтена: иначе GC (ADR-115) счёл бы его сиротой.
      expect(addedRefs).toEqual([
        { blobPath: BLOB_PATH, ownerKind: 'message', ownerId: message.id },
      ]);

      expect(result.metadata).toMatchObject({
        blob_path: BLOB_PATH,
        mime: 'image/png',
        path: 'shot.png',
        message_id: message.id,
      });
    });

    it('явное имя (`name`) уезжает в `upload` и в метаданные', async () => {
      await writeFile(join(workspace, 'raw.bin'), 'PAYLOAD');
      await attachWorkspaceFileTool.execute(
        { path: 'raw.bin', name: 'Скриншот.png' },
        makeCtx(makeExtra()),
      );

      const uploadArg = service.upload.mock.calls[0]![0] as { name?: string };
      expect(uploadArg.name).toBe('Скриншот.png');
    });

    it('дефолтный конфиг (`attachmentsConfig` не задан) — привязка работает', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const extra = makeExtra();
      delete extra.attachmentsConfig;

      const result = await attachWorkspaceFileTool.execute({ path: 'shot.png' }, makeCtx(extra));
      expect(result.isError).toBeFalsy();
      expect(service.upload).toHaveBeenCalledTimes(1);
    });

    it('сбой учёта ссылки не отменяет привязку (best-effort)', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const extra = makeExtra({
        blobRefs: {
          add: async () => {
            throw new Error('blob_refs недоступен');
          },
        } as unknown as BlobRefRepository,
      });

      const result = await attachWorkspaceFileTool.execute({ path: 'shot.png' }, makeCtx(extra));
      expect(result.isError).toBeFalsy();
      expect(delivered).toHaveLength(1);
    });
  });

  describe('containment: только внутри рабочего каталога', () => {
    it('`../…` за пределы workspace → отказ, `upload` не вызван', async () => {
      await writeFile(join(outside, 'secret.txt'), 'SECRET');

      const result = await attachWorkspaceFileTool.execute(
        { path: '../secret.txt' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect(service.upload).not.toHaveBeenCalled();
      expect(delivered).toHaveLength(0);
    });

    it('абсолютный путь отклоняется всегда (не «правило внешнего доступа»)', async () => {
      await writeFile(join(outside, 'secret.txt'), 'SECRET');

      const result = await attachWorkspaceFileTool.execute(
        { path: join(outside, 'secret.txt') },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('побег через симлинк → отказ', async () => {
      await writeFile(join(outside, 'secret.txt'), 'SECRET');
      await symlink(outside, join(workspace, 'link'), 'dir');

      const result = await attachWorkspaceFileTool.execute(
        { path: 'link/secret.txt' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('пустой путь → ошибка аргументов', async () => {
      const result = await attachWorkspaceFileTool.execute({ path: '   ' }, makeCtx(makeExtra()));
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('tool.args_error');
      expect(service.upload).not.toHaveBeenCalled();
    });
  });

  describe('отказы до чтения файла', () => {
    it('файла нет → `not_found`', async () => {
      const result = await attachWorkspaceFileTool.execute(
        { path: 'missing.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_found');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('каталог вместо файла → другой ключ (`not_a_file`)', async () => {
      await mkdir(join(workspace, 'dir'), { recursive: true });

      const result = await attachWorkspaceFileTool.execute({ path: 'dir' }, makeCtx(makeExtra()));

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_a_file');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('вложения выключены (`enabled=false`) → отказ, `upload` не вызван', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const config: AttachmentsConfig = { ...attachmentsConfigSchema.parse({}), enabled: false };

      const result = await attachWorkspaceFileTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra({ attachmentsConfig: () => config })),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.disabled');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('размер больше `maxBytesPerFile` → отказ по `stat`, файл не читается', async () => {
      await writeFile(join(workspace, 'big.bin'), '0123456789');
      const config: AttachmentsConfig = {
        ...attachmentsConfigSchema.parse({}),
        maxBytesPerFile: 4,
      };

      const result = await attachWorkspaceFileTool.execute(
        { path: 'big.bin' },
        makeCtx(makeExtra({ attachmentsConfig: () => config })),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.too_large');
      expect(result.metadata).toMatchObject({ size: 10, limit: 4 });
      // Размер проверен по `stat` ДО чтения: загрузки не было вовсе.
      expect(service.upload).not.toHaveBeenCalled();
      expect(delivered).toHaveLength(0);
    });

    it('нет сервиса вложений → `deps_unavailable`', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const extra = makeExtra();
      delete extra.attachmentService;

      const result = await attachWorkspaceFileTool.execute({ path: 'shot.png' }, makeCtx(extra));

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.deps_unavailable');
      expect(delivered).toHaveLength(0);
    });
  });

  describe('отказы сервиса и доставки', () => {
    it('`unsupported_mime` из `upload` → отказ с ключом типа', async () => {
      await writeFile(join(workspace, 'weird.bin'), 'PAYLOAD');
      service.upload.mockRejectedValueOnce(
        new AttachmentError('unsupported_mime', 'Тип application/octet-stream не разрешён'),
      );

      const result = await attachWorkspaceFileTool.execute(
        { path: 'weird.bin' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.unsupported_mime');
      expect(result.content).toContain('application/octet-stream');
      expect(delivered).toHaveLength(0);
      expect(addedRefs).toHaveLength(0);
    });

    it('`too_large` из `upload` (гонка с runtime-лимитом) → `too_large`', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      service.upload.mockRejectedValueOnce(new AttachmentError('too_large', 'Слишком большой'));

      const result = await attachWorkspaceFileTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.too_large');
      expect(delivered).toHaveLength(0);
    });

    it('нет `deliverUserMessage` → честный отказ, а не «тихий» успех', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const extra = makeExtra();
      delete extra.deliverUserMessage;

      const result = await attachWorkspaceFileTool.execute({ path: 'shot.png' }, makeCtx(extra));

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.delivery_unavailable');
      // Файл уже загружен — в metadata видно, что именно не доставлено.
      expect(result.metadata).toMatchObject({ blob_path: BLOB_PATH });
      expect(addedRefs).toHaveLength(0);
    });

    it('`buildMediaPart → null` (объект не распознан) → `unrecognized`', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      service.buildMediaPart.mockResolvedValueOnce(null);

      const result = await attachWorkspaceFileTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.unrecognized');
      expect(delivered).toHaveLength(0);
      expect(addedRefs).toHaveLength(0);
    });
  });

  describe('permission-слой', () => {
    it('группа `file_read` и путь в `TOOL_PATH_PARAMS` (file-паттерны работают)', () => {
      expect(getToolGroups('attach_workspace_file')).toContain('file_read');
      expect(TOOL_PATH_PARAMS.attach_workspace_file).toEqual(['path']);
    });

    it('capability — `file_read` (доступность как у read-тулов, ADR-075)', () => {
      expect(attachWorkspaceFileTool.capabilities).toContain('file_read');
    });
  });
});
