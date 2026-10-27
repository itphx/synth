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
 * - успех: байты и имя доехали до `upload`, в результате — `attachments`
 *   (ссылка для инъекции в текущий ход, без очереди) и `metadata.blob_path`;
 * - containment: `../…`, абсолютный путь, побег через симлинк → `isError`,
 *   `upload` не вызывается;
 * - нет файла / каталог вместо файла → разные ключи отказа;
 * - `attachments.enabled=false` → отказ до чтения файла;
 * - размер больше `maxBytesPerFile` → отказ **по `stat`** (файл не читается,
 *   `upload` не вызывается);
 * - `AttachmentError('unsupported_mime')` из `upload` → отказ с ключом типа;
 * - модальности модели: семейство не принято и aux-модели нет → отказ
 *   `attach.tool.modality_unsupported` без загрузки/доставки; aux назначена,
 *   семейство принято или модальности неизвестны → привязка работает;
 * - результат содержит `attachments` для инъекции в текущий ход;
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
  type AttachmentsConfig,
  type Message,
  type ToolContext,
} from '@itphx/synth-shared';
import { attachWorkspaceFileTool } from './attach-workspace-file.js';
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
    it('возвращает attachments для инъекции в текущий ход (без очереди)', async () => {
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

      // ADR-115: вложение уходит в `ToolResult.attachments`, оркестратор
      // вставляет его в `currentMessages` того же хода. User-сообщения и
      // очереди нет — иначе модель зацикливалась.
      expect(result.attachments).toEqual([{
        blobPath: BLOB_PATH,
        sha256: 'deadbeef',
        mime: 'image/png',
        size: 8,
      }]);
      expect(delivered).toHaveLength(0);
      expect(result.metadata).toMatchObject({
        blob_path: BLOB_PATH,
        mime: 'image/png',
        path: 'shot.png',
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

    it('результат пригоден для инъекции (attachments + metadata)', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');
      const result = await attachWorkspaceFileTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra()),
      );
      expect(result.isError).toBeFalsy();
      expect(result.attachments).toHaveLength(1);
      expect(result.metadata).toMatchObject({ blob_path: BLOB_PATH, path: 'shot.png' });
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

  /**
   * ADR-115: модель не принимает семейство файла и aux-модели для него нет —
   * привязка отменяется **до** загрузки и доставки. Иначе модель повторяла бы
   * вызов (вложение всё равно отбросили бы) и уходила в цикл.
   */
  describe('модальности модели: заведомо отбрасываемое не доставляем', () => {
    /** Байты с сигнатурой PNG (семейство определяется по содержимому). */
    const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    it('модель без audio, aux-модели нет → `modality_unsupported`, доставки нет', async () => {
      await writeFile(join(workspace, 'voice.oga'), `OggS${'x'.repeat(32)}`);

      const result = await attachWorkspaceFileTool.execute(
        { path: 'voice.oga' },
        makeCtx(makeExtra({ modelModalities: ['text', 'image'] })),
      );

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.modality_unsupported');
      expect(result.metadata).toMatchObject({ modality: 'audio' });
      // Ни загрузки, ни user-сообщения, ни ссылки на blob — цикл не воспроизводится.
      expect(service.upload).not.toHaveBeenCalled();
      expect(delivered).toHaveLength(0);
      expect(addedRefs).toHaveLength(0);
    });

    it('aux-модель семейства назначена → привязка разрешена (derive обработает следующим ходом)', async () => {
      await writeFile(join(workspace, 'voice.oga'), `OggS${'x'.repeat(32)}`);
      const config: AttachmentsConfig = {
        ...attachmentsConfigSchema.parse({}),
        modalityModels: { audio: { provider: 'local', model: 'whisper' } },
      };

      const result = await attachWorkspaceFileTool.execute(
        { path: 'voice.oga' },
        makeCtx(
          makeExtra({
            modelModalities: ['text', 'image'],
            attachmentsConfig: () => config,
          }),
        ),
      );

      expect(result.isError).toBeFalsy();
      expect(service.upload).toHaveBeenCalledTimes(1);
      expect(result.attachments).toHaveLength(1);
    });

    it('модель принимает семейство → привязка разрешена', async () => {
      await writeFile(join(workspace, 'shot.png'), PNG_BYTES);

      const result = await attachWorkspaceFileTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra({ modelModalities: ['text', 'image'] })),
      );

      expect(result.isError).toBeFalsy();
      expect(service.upload).toHaveBeenCalledTimes(1);
      expect(result.attachments).toHaveLength(1);
    });

    it('модальности модели неизвестны → прежнее поведение (привязка)', async () => {
      await writeFile(join(workspace, 'voice.oga'), `OggS${'x'.repeat(32)}`);
      const extra = makeExtra();
      delete extra.modelModalities; // поле не передано вовсе

      const result = await attachWorkspaceFileTool.execute({ path: 'voice.oga' }, makeCtx(extra));

      expect(result.isError).toBeFalsy();
      expect(service.upload).toHaveBeenCalledTimes(1);
      expect(result.attachments).toHaveLength(1);
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

    it('успешный результат всегда несёт attachments (инъекция в текущий ход)', async () => {
      await writeFile(join(workspace, 'shot.png'), 'PNGDATA1');

      const result = await attachWorkspaceFileTool.execute(
        { path: 'shot.png' },
        makeCtx(makeExtra()),
      );

      expect(result.isError).toBeFalsy();
      expect(result.attachments).toHaveLength(1);
      expect(result.metadata).toMatchObject({ blob_path: BLOB_PATH });
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
