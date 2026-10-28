/**
 * Тесты тула `save_attachment` (ADR-115, подраздел «Сохранение вложения в
 * workspace»).
 *
 * Сервис вложений — **объектный мок** (`resolve`/`read`): проверяется тул, а не
 * сервис (у него свой suite — `engine/attachments/service.test.ts`). Реальный ФС
 * нужен: containment (симлинки, `..`, абсолютные пути), атомарная публикация и
 * «не перезаписывать» заглушкой не проверить — работаем во временном каталоге
 * (`mkdtemp`).
 *
 * Что проверяется:
 * - успех: байты на диске равны blob-объекту, путь по умолчанию
 *   (`attachments/<name>` / `<sha8>`), `metadata` результата, нет `.tmp-*`;
 * - выбор вложения: по `name`, по `sha256`, без параметров — последнее в сессии;
 * - неоднозначность по `name` → ошибка со списком `name (sha8, messageId)`;
 * - нет вложений / нет совпадений / объект не из `attachments/` → разные ключи;
 * - containment: `../`, абсолютный путь, побег через симлинк;
 * - существующий файл не перезаписывается и blob не читается;
 * - ошибка чтения объекта → `save_failed`, временный файл убран;
 * - нет `attachmentService`/`sessionManager` → `deps_unavailable`;
 * - permission-слой: группа записи (plan-режим блокирует), путь в
 *   `TOOL_PATH_PARAMS`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ToolCapability,
  generateId,
  makeMediaPart,
  MessageRole,
  type MediaPartType,
  type Message,
  type ToolContext,
} from '@itphx/synth-shared';
import { saveAttachmentTool } from './save-attachment.js';
import type { AttachmentService, ResolvedAttachment } from '../attachments/service.js';
import type { SessionManager } from '../../sessions/manager.js';
import { TOOL_PATH_PARAMS, getToolGroups } from '../permission/groups.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';

/** Объект blob-хранилища, доступный «сервису» в тесте. */
interface BlobFixture {
  bytes: Buffer;
  name?: string;
  mime: string;
  sha256: string;
}

/** Мок сервиса вложений: только методы, которые зовёт тул. */
interface AttachmentServiceMock {
  resolve: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}

const SESSION_ID = 'sess-1';

describe('save_attachment — сохранение вложения сессии в workspace (ADR-115)', () => {
  let workspace: string;
  let outside: string;
  let blobs: Map<string, BlobFixture>;
  let service: AttachmentServiceMock;
  let messages: Message[];

  /** Вложение в «blob-хранилище» + медиа-часть сообщения. */
  function addAttachment(
    bytes: string,
    options: { name?: string; mime?: string; messageId?: string; blobPath?: string; seq?: number } = {},
  ): { blobPath: string; sha256: string; messageId: string } {
    const buffer = Buffer.from(bytes);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const blobPath = options.blobPath ?? `attachments/${sha256.slice(0, 2)}/${sha256}`;
    const mime = options.mime ?? 'image/png';
    const messageId = options.messageId ?? generateId();
    blobs.set(blobPath, { bytes: buffer, mime, sha256, ...(options.name ? { name: options.name } : {}) });
    const type: MediaPartType = mime.startsWith('image/') ? 'image' : 'file';
    messages.push(
      makeMessage(
        messageId,
        makeMediaPart(type, {
          blobPath,
          sha256,
          mime,
          size: buffer.length,
          ...(options.name ? { name: options.name } : {}),
        }),
        options.seq,
      ),
    );
    return { blobPath, sha256, messageId };
  }

  function makeMessage(id: string, part: Message['parts'][number], seq = 0): Message {
    return {
      id,
      role: MessageRole.USER,
      seq,
      origin: 'local',
      parts: [part],
      content: '',
      createdAt: '2026-10-27T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ephemeral: false,
    };
  }

  /** Контекст тула: рабочий каталог — временный workspace сессии. */
  function makeCtx(overrides: Record<string, unknown> = {}): ToolContext {
    const extra: Record<string, unknown> = {
      attachmentService: service as unknown as AttachmentService,
      sessionManager: {
        getSession: async (id: string) =>
          id === SESSION_ID ? { id: SESSION_ID, messages } : null,
      } as unknown as SessionManager,
      ...overrides,
    };
    return { sessionId: SESSION_ID, messageId: generateId(), workingDir: workspace, extra };
  }

  /** Ключ i18n отказа (машинный код проверки — без текста). */
  function errorKey(result: { metadata?: Record<string, unknown> }): string | undefined {
    return (result.metadata?.i18n as { key?: string } | undefined)?.key;
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'synth-save-attach-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'synth-save-attach-out-'));
    blobs = new Map();
    messages = [];
    // Тот же набор вложений, что ищет тул: байты — из `blobs`, метаданные — из
    // фикстуры (sidecar в сервисе). Неизвестный/чужой путь → `null`, как у
    // реального `AttachmentService.resolve`.
    service = {
      resolve: vi.fn(async (blobPath: string): Promise<ResolvedAttachment | null> => {
        const blob = blobs.get(blobPath);
        if (!blob || !blobPath.startsWith('attachments/')) return null;
        return {
          blobPath,
          mime: blob.mime,
          size: blob.bytes.length,
          sha256: blob.sha256,
          ...(blob.name ? { name: blob.name } : {}),
          stat: { size: blob.bytes.length, mtimeMs: 0 },
        };
      }),
      read: vi.fn(async (blobPath: string) => {
        const blob = blobs.get(blobPath);
        return blob ? Readable.from([blob.bytes]) : null;
      }),
    };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('успешное сохранение', () => {
    it('байты равны blob-объекту, путь по умолчанию — attachments/<name>', async () => {
      const { blobPath, sha256 } = addAttachment('PNGDATA1', { name: 'shot.png' });

      const result = await saveAttachmentTool.execute({}, makeCtx());

      expect(result.isError).toBeFalsy();
      const saved = await readFile(join(workspace, 'attachments', 'shot.png'));
      expect(saved.toString()).toBe('PNGDATA1');
      expect(result.metadata).toMatchObject({
        path: 'attachments/shot.png',
        blob_path: blobPath,
        sha256,
        mime: 'image/png',
        size: 8,
      });
      expect(result.content).toContain('attachments/shot.png');
      // Временный файл не остаётся после публикации.
      expect(await readdir(join(workspace, 'attachments'))).toEqual(['shot.png']);
    });

    it('без имени путь по умолчанию — attachments/<sha8>', async () => {
      const { sha256 } = addAttachment('NONAME');
      const result = await saveAttachmentTool.execute({}, makeCtx());

      expect(result.isError).toBeFalsy();
      expect(result.metadata?.path).toBe(`attachments/${sha256.slice(0, 8)}`);
      const saved = await readFile(join(workspace, 'attachments', sha256.slice(0, 8)));
      expect(saved.toString()).toBe('NONAME');
    });

    it('явный `path` с подкаталогами: каталоги создаются', async () => {
      addAttachment('PDFDATA', { name: 'doc.pdf', mime: 'application/pdf' });
      const result = await saveAttachmentTool.execute({ path: 'docs/raw/doc.pdf' }, makeCtx());

      expect(result.isError).toBeFalsy();
      expect((await readFile(join(workspace, 'docs', 'raw', 'doc.pdf'))).toString()).toBe('PDFDATA');
      expect(result.metadata?.path).toBe('docs/raw/doc.pdf');
    });

    it('непустое имя из sidecar приоритетнее имени части', async () => {
      // Имя части могло быть усечено/санитайзировано клиентом — источник истины sidecar.
      blobs.set('attachments/aa/deadbeef', {
        bytes: Buffer.from('X'),
        name: 'sidecar.png',
        mime: 'image/png',
        sha256: 'deadbeef',
      });
      messages.push(
        makeMessage(
          generateId(),
          makeMediaPart('image', {
            blobPath: 'attachments/aa/deadbeef',
            sha256: 'deadbeef',
            mime: 'image/png',
            size: 1,
            name: 'part.png',
          }),
        ),
      );

      const result = await saveAttachmentTool.execute({}, makeCtx());
      expect(result.isError).toBeFalsy();
      expect(result.metadata?.path).toBe('attachments/sidecar.png');
    });
  });

  describe('поиск вложения в сессии', () => {
    it('выбор по `name`', async () => {
      addAttachment('AAA', { name: 'a.png' });
      addAttachment('BBB', { name: 'b.png' });

      const result = await saveAttachmentTool.execute({ name: 'b.png' }, makeCtx());

      expect(result.isError).toBeFalsy();
      expect((await readFile(join(workspace, 'attachments', 'b.png'))).toString()).toBe('BBB');
    });

    it('неоднозначность по `name` → ошибка со списком `name (sha8, messageId)`', async () => {
      const first = addAttachment('ONE', { name: 'image.png', messageId: 'msg-1' });
      const second = addAttachment('TWO', { name: 'image.png', messageId: 'msg-2' });

      const result = await saveAttachmentTool.execute({ name: 'image.png' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.ambiguous');
      expect(result.content).toContain(`image.png (${first.sha256.slice(0, 8)}, msg-1)`);
      expect(result.content).toContain(`image.png (${second.sha256.slice(0, 8)}, msg-2)`);
      expect(result.content).toContain('sha256');
      // Ничего не записано: неоднозначность — отказ до чтения blob.
      expect(await readdir(workspace)).toEqual([]);
      expect(service.read).not.toHaveBeenCalled();
    });

    it('выбор по `sha256` (единственный точный селектор)', async () => {
      addAttachment('ONE', { name: 'image.png' });
      const second = addAttachment('TWO', { name: 'image.png' });

      const result = await saveAttachmentTool.execute({ sha256: second.sha256 }, makeCtx());

      expect(result.isError).toBeFalsy();
      expect(result.metadata?.blob_path).toBe(second.blobPath);
      const files = await readdir(join(workspace, 'attachments'));
      expect(files).toHaveLength(1);
      expect((await readFile(join(workspace, 'attachments', files[0]!))).toString()).toBe('TWO');
    });

    it('без параметров — последнее медиа-вложение сессии', async () => {
      addAttachment('FIRST', { name: 'first.png' });
      addAttachment('SECOND', { name: 'second.png' });
      addAttachment('THIRD', { name: 'third.png' });

      const result = await saveAttachmentTool.execute({}, makeCtx());

      expect(result.isError).toBeFalsy();
      expect((await readFile(join(workspace, 'attachments', 'third.png'))).toString()).toBe('THIRD');
    });

    it('выбор конкретного сообщения по `message_seq` — не «последнее вложение»', async () => {
      addAttachment('OLD', { name: 'old.png', seq: 5, messageId: 'msg-old' });
      addAttachment('NEW', { name: 'new.png', seq: 9, messageId: 'msg-new' });

      const result = await saveAttachmentTool.execute({ message_seq: 5 }, makeCtx());

      expect(result.isError).toBeFalsy();
      expect((await readFile(join(workspace, 'attachments', 'old.png'))).toString()).toBe('OLD');
      expect(result.metadata?.sha256).toBe(createHash('sha256').update('OLD').digest('hex'));
    });

    it('выбор сообщения по `message_id` + `name`', async () => {
      addAttachment('A', { name: 'clip.mp4', seq: 5, messageId: 'msg-a' });
      addAttachment('B', { name: 'clip.mp4', seq: 9, messageId: 'msg-b' });

      const result = await saveAttachmentTool.execute(
        { message_id: 'msg-a', name: 'clip.mp4' },
        makeCtx(),
      );

      expect(result.isError).toBeFalsy();
      expect((await readFile(join(workspace, 'attachments', 'clip.mp4'))).toString()).toBe('A');
    });

    it('сообщение без вложений → `not_found`, без отката к последнему', async () => {
      addAttachment('AAA', { name: 'a.png', seq: 5 });
      const result = await saveAttachmentTool.execute({ message_seq: 6 }, makeCtx());
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_found');
    });

    it('текстовые части не считаются вложениями', async () => {
      messages.push({
        ...makeMessage('msg-text', { id: 'part-1', type: 'text', data: { text: 'hello' } }),
      });

      const result = await saveAttachmentTool.execute({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.no_attachment');
    });

    it('вложений нет → `no_attachment`', async () => {
      const result = await saveAttachmentTool.execute({}, makeCtx());
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.no_attachment');
    });

    it('`name` не найден → `not_found`', async () => {
      addAttachment('AAA', { name: 'a.png' });
      const result = await saveAttachmentTool.execute({ name: 'missing.png' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_found');
    });

    it('`sha256` не найден → `not_found`', async () => {
      addAttachment('AAA', { name: 'a.png' });
      const result = await saveAttachmentTool.execute({ sha256: 'f'.repeat(64) }, makeCtx());
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_found');
    });

    it('`blobPath` не из `attachments/` → отказ, сервис не вызывается', async () => {
      messages.push(
        makeMessage(
          generateId(),
          makeMediaPart('file', {
            blobPath: 'processes/run.log',
            sha256: 'abc',
            mime: 'text/plain',
            size: 10,
          }),
        ),
      );

      const result = await saveAttachmentTool.execute({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_found');
      expect(service.resolve).not.toHaveBeenCalled();
    });

    it('объект исчез из blob (GC) → `not_found`', async () => {
      const { blobPath } = addAttachment('AAA', { name: 'a.png' });
      blobs.delete(blobPath);

      const result = await saveAttachmentTool.execute({}, makeCtx());
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.not_found');
    });

    it('пустой объект (0 байт) → `save_failed`', async () => {
      addAttachment('', { name: 'empty.png' });
      const result = await saveAttachmentTool.execute({}, makeCtx());
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.save_failed');
    });
  });

  describe('containment рабочего каталога', () => {
    it('`..` за пределы workspace — отказ, файл не создаётся', async () => {
      addAttachment('AAA', { name: 'a.png' });
      const result = await saveAttachmentTool.execute({ path: '../escape.png' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect(await readdir(outside)).toEqual([]);
    });

    it('абсолютный путь — отказ', async () => {
      addAttachment('AAA', { name: 'a.png' });
      const absolute = join(outside, 'abs.png');
      const result = await saveAttachmentTool.execute({ path: absolute }, makeCtx());

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect(await readdir(outside)).toEqual([]);
    });

    it('побег через симлинк — отказ', async () => {
      addAttachment('AAA', { name: 'a.png' });
      await mkdir(join(outside, 'dir'));
      await symlink(join(outside, 'dir'), join(workspace, 'link'));

      const result = await saveAttachmentTool.execute({ path: 'link/x.png' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect(await readdir(join(outside, 'dir'))).toEqual([]);
    });
  });

  describe('публикация без перезаписи', () => {
    it('существующий файл не перезаписывается, blob не читается', async () => {
      addAttachment('NEWDATA', { name: 'shot.png' });
      await mkdir(join(workspace, 'attachments'), { recursive: true });
      await writeFile(join(workspace, 'attachments', 'shot.png'), 'OLD');

      const result = await saveAttachmentTool.execute({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.exists');
      expect((await readFile(join(workspace, 'attachments', 'shot.png'))).toString()).toBe('OLD');
      expect(service.read).not.toHaveBeenCalled();
    });

    it('компонент пути занят файлом → containment-отказ (как у `write_file`)', async () => {
      addAttachment('AAA', { name: 'a.png' });
      await writeFile(join(workspace, 'docs'), 'not a directory');

      const result = await saveAttachmentTool.execute({ path: 'docs/a.png' }, makeCtx());

      // `resolveRealPath` fail-closed на `ENOTDIR` → путь не разрешается, и
      // тул отклоняет его тем же результатом, что `write_file`/`edit_file`
      // (единая политика containment из `path-utils`).
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('permission.external_directory_default');
      expect((await readFile(join(workspace, 'docs'))).toString()).toBe('not a directory');
    });
  });

  describe('ошибки выполнения', () => {
    it('ошибка чтения объекта → `save_failed`, временный файл убран', async () => {
      addAttachment('AAA', { name: 'a.png' });
      service.read.mockRejectedValueOnce(new Error('blob read failed'));

      const result = await saveAttachmentTool.execute({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.save_failed');
      expect(result.content).toContain('blob read failed');
      // Каталог создан, но ни целевого файла, ни `.tmp-*` не осталось.
      expect(await readdir(join(workspace, 'attachments'))).toEqual([]);
    });

    it('нет `attachmentService` → `deps_unavailable`', async () => {
      addAttachment('AAA', { name: 'a.png' });
      const result = await saveAttachmentTool.execute(
        {},
        makeCtx({ attachmentService: undefined }),
      );
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.deps_unavailable');
    });

    it('нет `sessionManager` → `deps_unavailable`', async () => {
      addAttachment('AAA', { name: 'a.png' });
      const result = await saveAttachmentTool.execute({}, makeCtx({ sessionManager: undefined }));
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.deps_unavailable');
    });

    it('сессия не найдена → `no_attachment`', async () => {
      const ctx = makeCtx();
      ctx.sessionId = 'sess-unknown';
      const result = await saveAttachmentTool.execute({}, ctx);
      expect(result.isError).toBe(true);
      expect(errorKey(result)).toBe('attach.tool.no_attachment');
    });
  });

  describe('permission-слой', () => {
    it('группа записи (plan-режим блокирует) и путь в `TOOL_PATH_PARAMS`', () => {
      const groups = getToolGroups('save_attachment', [ToolCapability.FILE_WRITE]);
      expect(groups).toContain('edit');
      expect(groups).toContain(ToolCapability.FILE_WRITE);
      // ADR-025/ADR-029: запись в workspace в plan-режиме запрещена.
      expect(isPlanBlockedTool('save_attachment', [ToolCapability.FILE_WRITE])).toBe(true);
      // Файловые паттерны правил применяются к пути назначения.
      expect(TOOL_PATH_PARAMS.save_attachment).toEqual(['path']);
    });
  });
});
