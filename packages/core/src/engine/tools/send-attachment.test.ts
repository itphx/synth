/**
 * Тесты тула `send_attachment` (ADR-115, подраздел «Отправка файла в ответе»).
 *
 * Сервис вложений — **объектный мок** (`{upload, buildMediaPart}`): тул
 * проверяется, а не `AttachmentService` (у него свой suite —
 * `engine/attachments/service.test.ts`). Реальный ФС нужен: containment
 * (симлинки, `..`, абсолютные пути) заглушкой не проверить — работаем во
 * временном каталоге (`mkdtemp`).
 *
 * Что проверяется:
 * - успех: байты и имя (явное/`basename`) доехали до `upload`, медиа-часть
 *   положена в **коллектор** (а не отправлена сразу), файл в workspace не
 *   изменён, в результате — `metadata.blob_path`;
 * - containment: `../…`, абсолютный путь, побег через симлинк → `isError`,
 *   `upload` не вызывается;
 * - нет файла / каталог вместо файла → разные ключи отказа;
 * - `attachments.enabled=false` → отказ до чтения файла;
 * - размер больше `maxBytesPerFile` → отказ **по `stat`** (файл не читается);
 * - нет `attachmentService` / коллектора → `deps_unavailable`;
 * - `AttachmentError('unsupported_mime')` из `upload` → `unrecognized`;
 * - `buildMediaPart → null` → `unrecognized`;
 * - permission-слой: группа `read`, путь в `TOOL_PATH_PARAMS`, capability `file_read`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachmentsConfigSchema,
  generateId,
  type AttachmentsConfig,
  type Part,
  type ToolContext,
} from '@itphx/synth-shared';
import { sendAttachmentTool } from './send-attachment.js';
import { AttachmentError } from '../attachments/service.js';
import type { AttachmentService } from '../attachments/service.js';
import { TOOL_PATH_PARAMS, getToolGroups } from '../permission/groups.js';

/** Мок сервиса вложений: только методы, которые зовёт тул. */
interface AttachmentServiceMock {
  upload: ReturnType<typeof vi.fn>;
  buildMediaPart: ReturnType<typeof vi.fn>;
}

/** Данные объекта, который «лежит» в blob-хранилище (ответ мока). */
const BLOB_PATH = 'attachments/ab/deadbeef';

describe('send_attachment — файл из workspace в ответе (ADR-115)', () => {
  let workspace: string;
  let outside: string;
  let service: AttachmentServiceMock;
  let collected: Part[];

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
      outboundAttachments: {
        add: (part: Part) => {
          collected.push(part);
        },
      },
      ...overrides,
    };
  }

  /** Ключ i18n отказа (машинный код проверки — без текста). */
  function errorKey(result: { metadata?: Record<string, unknown> }): string | undefined {
    return (result.metadata?.i18n as { key?: string } | undefined)?.key;
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'synth-send-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'synth-send-out-'));
    collected = [];
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

  describe('успешная постановка в очередь', () => {
    it('загружает файл и кладёт медиа-часть в коллектор (не отправляет сразу)', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');

      const result = await sendAttachmentTool.execute({ path: 'shot.png' }, makeCtx(makeExtra()));

      expect(result.isError).toBeFalsy();
      // `upload` получил именно байты файла и имя по умолчанию (basename).
      const uploadArg = service.upload.mock.calls[0]![0] as {
        bytes: Buffer;
        name?: string;
        sessionId: string;
      };
      expect(uploadArg.sessionId).toBe('sess-1');
      expect(uploadArg.bytes.toString()).toBe('PNGDATA1');
      expect(uploadArg.name).toBe('shot.png');
      expect(service.buildMediaPart).toHaveBeenCalledWith(BLOB_PATH);

      // Часть — в коллекторе хода; сама по себе никуда не отправлена.
      expect(collected).toHaveLength(1);
      expect(collected[0]!.type).toBe('image');
      expect(collected[0]!.data).toMatchObject({
        blobPath: BLOB_PATH,
        mime: 'image/png',
        size: 8,
        name: 'shot.png',
      });

      expect(errorKey(result)).toBe('attach.tool.queued');
      expect(result.content).toContain('shot.png');
      expect(result.metadata).toMatchObject({
        path: 'shot.png',
        blob_path: BLOB_PATH,
        mime: 'image/png',
        size: 8,
        name: 'shot.png',
      });
    });

    it('файл в workspace не изменяется', async () => {
      const file = join(workspace, 'report.pdf');
      await writeFile(file, 'PDFDATA');
      const before = await readFile(file);

      await sendAttachmentTool.execute({ path: 'report.pdf' }, makeCtx(makeExtra()));

      expect(await readFile(file)).toEqual(before);
    });

    it('явное имя (`name`) уезжает в `upload` и в результат', async () => {
      await writeFile(join(workspace, 'raw.bin'), 'PAYLOAD');
      service.buildMediaPart.mockResolvedValueOnce({
        type: 'file' as const,
        data: {
          blobPath: BLOB_PATH,
          sha256: 'deadbeef',
          mime: 'application/octet-stream',
          size: 7,
          name: 'Договор.pdf',
        },
      });

      const result = await sendAttachmentTool.execute(
        { path: 'raw.bin', name: 'Договор.pdf' },
        makeCtx(makeExtra()),
      );

      const uploadArg = service.upload.mock.calls[0]![0] as { name?: string };
      expect(uploadArg.name).toBe('Договор.pdf');
      expect(result.metadata).toMatchObject({ name: 'Договор.pdf' });
      expect(collected).toHaveLength(1);
    });

    it('дефолтный конфиг (`attachmentsConfig` не задан) — отправка работает', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const extra = makeExtra();
      delete extra.attachmentsConfig;

      const result = await sendAttachmentTool.execute({ path: 'shot.png' }, makeCtx(extra));
      expect(result.isError).toBeFalsy();
      expect(service.upload).toHaveBeenCalledTimes(1);
    });
  });

  describe('containment: только внутри рабочего каталога', () => {
    it('`../…` за пределы workspace → отказ, `upload` не вызван', async () => {
      await writeFile(join(outside, 'secret.txt'), 'SECRET');

      const result = await sendAttachmentTool.execute(
        { path: '../secret.txt' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect(service.upload).not.toHaveBeenCalled();
      expect(collected).toHaveLength(0);
    });

    it('абсолютный путь отклоняется всегда (не «правило внешнего доступа»)', async () => {
      await writeFile(join(outside, 'secret.txt'), 'SECRET');

      const result = await sendAttachmentTool.execute(
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

      const result = await sendAttachmentTool.execute(
        { path: 'link/secret.txt' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('пустой путь → ошибка аргументов', async () => {
      const result = await sendAttachmentTool.execute({ path: '   ' }, makeCtx(makeExtra()));
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('tool.args_error');
      expect(service.upload).not.toHaveBeenCalled();
    });
  });

  describe('отказы до чтения файла', () => {
    it('файла нет → `not_found`', async () => {
      const result = await sendAttachmentTool.execute(
        { path: 'missing.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_found');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('каталог вместо файла → `not_a_file`', async () => {
      await mkdir(join(workspace, 'dir'), { recursive: true });

      const result = await sendAttachmentTool.execute({ path: 'dir' }, makeCtx(makeExtra()));

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_a_file');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('пустой файл → отказ `unrecognized`, `upload` не вызван', async () => {
      await writeFile(join(workspace, 'empty.bin'), '');

      const result = await sendAttachmentTool.execute({ path: 'empty.bin' }, makeCtx(makeExtra()));

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.unrecognized');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('вложения выключены (`enabled=false`) → отказ, `upload` не вызван', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const config: AttachmentsConfig = { ...attachmentsConfigSchema.parse({}), enabled: false };

      const result = await sendAttachmentTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra({ attachmentsConfig: () => config })),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.disabled');
      expect(service.upload).not.toHaveBeenCalled();
      expect(collected).toHaveLength(0);
    });

    it('размер больше `maxBytesPerFile` → отказ по `stat`, файл не читается', async () => {
      await writeFile(join(workspace, 'big.bin'), '0123456789');
      const config: AttachmentsConfig = {
        ...attachmentsConfigSchema.parse({}),
        maxBytesPerFile: 4,
      };

      const result = await sendAttachmentTool.execute(
        { path: 'big.bin' },
        makeCtx(makeExtra({ attachmentsConfig: () => config })),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.too_large');
      expect(result.metadata).toMatchObject({ size: 10, limit: 4 });
      // Размер проверен по `stat` ДО чтения: загрузки не было вовсе.
      expect(service.upload).not.toHaveBeenCalled();
      expect(collected).toHaveLength(0);
    });

    it('нет сервиса вложений → `deps_unavailable`', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const extra = makeExtra();
      delete extra.attachmentService;

      const result = await sendAttachmentTool.execute({ path: 'shot.png' }, makeCtx(extra));

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.deps_unavailable');
      expect(collected).toHaveLength(0);
    });

    it('нет коллектора ответа → `deps_unavailable` (а не «тихий» успех)', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const extra = makeExtra();
      delete extra.outboundAttachments;

      const result = await sendAttachmentTool.execute({ path: 'shot.png' }, makeCtx(extra));

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.deps_unavailable');
      // До чтения файла дело не дошло.
      expect(service.upload).not.toHaveBeenCalled();
    });
  });

  describe('отказы сервиса', () => {
    it('`unsupported_mime` из `upload` → `unrecognized`', async () => {
      await writeFile(join(workspace, 'weird.bin'), 'PAYLOAD');
      service.upload.mockRejectedValueOnce(
        new AttachmentError('unsupported_mime', 'Тип application/octet-stream не разрешён'),
      );

      const result = await sendAttachmentTool.execute(
        { path: 'weird.bin' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.unrecognized');
      expect(result.metadata).toMatchObject({ detail: 'Тип application/octet-stream не разрешён' });
      expect(collected).toHaveLength(0);
    });

    it('`too_large` из `upload` (гонка с runtime-лимитом) → `too_large`', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      service.upload.mockRejectedValueOnce(new AttachmentError('too_large', 'Слишком большой'));

      const result = await sendAttachmentTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.too_large');
      expect(collected).toHaveLength(0);
    });

    it('`attachments_disabled` из `upload` → `disabled`', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      service.upload.mockRejectedValueOnce(new AttachmentError('attachments_disabled', 'Выключено'));

      const result = await sendAttachmentTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.disabled');
    });

    it('`buildMediaPart → null` (объект не распознан) → `unrecognized`', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      service.buildMediaPart.mockResolvedValueOnce(null);

      const result = await sendAttachmentTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.unrecognized');
      expect(collected).toHaveLength(0);
    });
  });

  describe('permission-слой', () => {
    it('группа `read` и путь в `TOOL_PATH_PARAMS` (file-паттерны работают)', () => {
      expect(getToolGroups('send_attachment')).toContain('read');
      expect(TOOL_PATH_PARAMS.send_attachment).toEqual(['path']);
    });

    it('capability — `file_read` (доступность как у read-тулов, ADR-075)', () => {
      expect(sendAttachmentTool.capabilities).toContain('file_read');
    });
  });
});
