/**
 * ADR-115: HTTP-контур вложений — загрузка (multipart), раздача (Range/ETag),
 * граничный guard и приём `attachments` в промпте.
 *
 * Доступ к `:id` решает единый prefix-guard роутера сессий (инвариант 16):
 * чужой пользователь получает 403, несуществующая сессия — 404.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentsConfig, Message, Session } from '@itphx/synth-shared';
import { createSessionRoutes } from './sessions.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { FileStore } from '../../storage/file-store.js';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { FileBlobRefRepository } from '../../storage/file-blob-ref-repository.js';
import { MetricsRegistry } from '../../metrics/registry.js';
import {
  createAttachmentMetrics,
  setAttachmentMetricsHook,
} from '../../metrics/collectors/attachments.js';
import type { AuthKit } from '../../auth/local.js';

/** Мок auth: requireAuth — no-op (single-user режим core). */
function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createMockQueueManager(isRunning = false) {
  return {
    isRunning: vi.fn().mockReturnValue(isRunning),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    stopAll: vi.fn(),
    getRingBuffer: vi.fn(),
    setContextOptimizer: vi.fn(),
    requestStop: vi.fn().mockReturnValue(false),
  };
}

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    agentRegistry: undefined,
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    interrupt: vi.fn(),
    // Обфускация выключена — сообщение возвращается как есть (ADR-036).
    obfuscateUserMessageForHistory: async (_sessionId: string, message: Message) => message,
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

function attachmentsConfig(overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig {
  return {
    maxBytesPerFile: 1024 * 1024,
    maxFilesPerMessage: 10,
    maxBytesPerSession: 10 * 1024 * 1024,
    allowedMimePrefixes: ['image/', 'audio/', 'application/pdf', 'text/'],
    gcDays: 30,
    ...overrides,
  };
}

/** PNG-чанк (CRC-заглушка: парсер метаданных CRC не проверяет). */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function pngBytes(fill = 1): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13, fill)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

interface HarnessOptions {
  /** Правило доступа к содержимому сессии (по умолчанию — владелец `local`). */
  canAccess?: (session: Session) => boolean;
  /** Считать ход активным (нужно, чтобы промпт шёл режимом `steer` без SSE). */
  turnActive?: boolean;
  config?: Partial<AttachmentsConfig>;
  /** ADR-094: поставить sink метрик вложений (иначе вызовы — no-op). */
  metrics?: boolean;
}

describe('HTTP: вложения сообщений (ADR-115)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachment-routes-'));
  });

  afterEach(async () => {
    setAttachmentMetricsHook(null);
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createHarness(options: HarnessOptions = {}) {
    const app = new Hono();
    const registry = new MetricsRegistry();
    if (options.metrics) setAttachmentMetricsHook(createAttachmentMetrics(registry));
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(fileStore);
    const eventBus = new EventBus();
    const queueManager = createMockQueueManager(options.turnActive ?? true);
    const orchestrator = createMockOrchestrator();
    const blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    const blobRefs = new FileBlobRefRepository({ dataDir: tmpDir });

    app.route('/api/v2/sessions', createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: queueManager as never,
        processMessage: orchestrator.createProcessMessage() as never,
        orchestrator: orchestrator as never,
        attachments: {
          blobs,
          blobRefs,
          config: attachmentsConfig(options.config),
        },
      },
      options.canAccess
        ? { canAccess: (session) => options.canAccess!(session) }
        : {},
    ));

    return { app, sessionManager, blobs, blobRefs, registry };
  }

  /** Загрузить файл через HTTP (multipart, поле `file`). */
  async function upload(
    app: Hono,
    sessionId: string,
    bytes: Buffer,
    name = 'photo.png',
    type = 'image/png',
  ): Promise<Response> {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(bytes)], name, { type }));
    form.set('name', name);
    return app.request(`/api/v2/sessions/${sessionId}/attachments`, { method: 'POST', body: form });
  }

  describe('POST /:id/attachments', () => {
    it('201: возвращает метаданные вложения (id === blobPath)', async () => {
      const { app, sessionManager, blobs } = createHarness();
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

      const res = await upload(app, session.id, pngBytes());
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string; blobPath: string; sha256: string; mime: string; size: number; name?: string;
      };
      expect(body.id).toBe(body.blobPath);
      expect(body.mime).toBe('image/png');
      expect(body.name).toBe('photo.png');
      expect(body.blobPath.startsWith('attachments/')).toBe(true);
      expect(await blobs.exists(body.blobPath)).toBe(true);
    });

    it('404: сессия не найдена (guard)', async () => {
      const { app } = createHarness();
      const res = await upload(app, 'missing', pngBytes());
      expect(res.status).toBe(404);
    });

    it('403: чужая сессия (guard на границе)', async () => {
      const { app, sessionManager } = createHarness({ canAccess: () => false });
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await upload(app, session.id, pngBytes());
      expect(res.status).toBe(403);
    });

    it('413 PAYLOAD_TOO_LARGE: файл больше maxBytesPerFile', async () => {
      const { app, sessionManager } = createHarness({ config: { maxBytesPerFile: 20 } });
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await upload(app, session.id, pngBytes());
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('415 UNSUPPORTED_MEDIA_TYPE: MIME вне белого списка', async () => {
      const { app, sessionManager } = createHarness({ config: { allowedMimePrefixes: ['image/'] } });
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await upload(app, session.id, Buffer.from('просто текст'), 'note.txt', 'text/plain');
      expect(res.status).toBe(415);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('415: SVG запрещён всегда', async () => {
      const { app, sessionManager } = createHarness();
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      const res = await upload(app, session.id, svg, 'pic.svg', 'image/svg+xml');
      expect(res.status).toBe(415);
    });
  });

  describe('attachments в POST /:id/prompt', () => {
    it('создаёт сообщение [текст, вложение] и фиксирует ссылку blob_refs', async () => {
      const { app, sessionManager, blobRefs } = createHarness();
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const uploaded = (await (await upload(app, session.id, pngBytes())).json()) as {
        blobPath: string;
      };

      const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'смотри', attachments: [uploaded.blobPath], mode: 'steer' }),
      });
      expect(res.status).toBe(202);

      const stored = await sessionManager.getSession(session.id);
      const message = stored!.steerInbox!.at(-1)!;
      expect(message.parts.map((p) => p.type)).toEqual(['text', 'image']);
      // Плейсхолдер вложения сохраняется в строковой производной.
      expect(message.content).toContain('[image: photo.png]');
      expect(message.content.startsWith('смотри')).toBe(true);

      const refs = await blobRefs.listByOwner('message', message.id);
      expect(refs).toEqual([uploaded.blobPath]);
    });

    it('маркер, пришедший из композера, не дублируется в content', async () => {
      const { app, sessionManager } = createHarness();
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const uploaded = (await (await upload(app, session.id, pngBytes())).json()) as {
        blobPath: string;
      };

      const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'смотри [image: photo.png]',
          attachments: [uploaded.blobPath],
          mode: 'steer',
        }),
      });
      expect(res.status).toBe(202);

      const stored = await sessionManager.getSession(session.id);
      const message = stored!.steerInbox!.at(-1)!;
      expect(message.content.split('[image: photo.png]')).toHaveLength(2);
      expect(message.content).toBe('смотри [image: photo.png]');
    });

    it('без маркера в тексте — маркер дописывается в content', async () => {
      const { app, sessionManager } = createHarness();
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const uploaded = (await (await upload(app, session.id, pngBytes())).json()) as {
        blobPath: string;
      };

      const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'смотри', attachments: [uploaded.blobPath], mode: 'steer' }),
      });
      expect(res.status).toBe(202);

      const stored = await sessionManager.getSession(session.id);
      const message = stored!.steerInbox!.at(-1)!;
      expect(message.content).toBe('смотри\n[image: photo.png]');
    });

    it('неизвестный путь вложения → 400 VALIDATION_ERROR с перечнем', async () => {
      const { app, sessionManager } = createHarness();
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const missing = 'attachments/00/' + 'f'.repeat(64);

      const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'смотри', attachments: [missing], mode: 'steer' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain(missing);
    });

    it('превышение maxFilesPerMessage → 400', async () => {
      const { app, sessionManager } = createHarness({ config: { maxFilesPerMessage: 1 } });
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const first = (await (await upload(app, session.id, pngBytes(1))).json()) as { blobPath: string };
      const second = (await (await upload(app, session.id, pngBytes(2), 'b.png')).json()) as { blobPath: string };

      const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'смотри',
          attachments: [first.blobPath, second.blobPath],
          mode: 'steer',
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /:id/attachments/:partId', () => {
    /** Загрузить вложение и вернуть часть сообщения (id части для раздачи). */
    async function seedMessagePart(
      app: Hono,
      sessionManager: SessionManager,
      bytes: Buffer,
      name = 'photo.png',
    ): Promise<{ session: Session; partId: string; sha256: string; size: number }> {
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const uploaded = (await (await upload(app, session.id, bytes, name)).json()) as {
        blobPath: string; sha256: string; mime: string; size: number;
      };
      await sessionManager.withLock(session.id, async (locked) => {
        locked.messages.push({
          id: 'msg-1',
          role: 'user',
          seq: 1,
          origin: 'local',
          parts: [
            { id: 'text-1', type: 'text', data: 'смотри' },
            {
              id: 'part-1',
              type: 'image',
              data: {
                blobPath: uploaded.blobPath,
                sha256: uploaded.sha256,
                mime: uploaded.mime,
                size: uploaded.size,
                name,
              },
            },
          ],
          content: 'смотри [image: ' + name + ']',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
        } as Message);
        await sessionManager.updateSession(locked);
      });
      return { session, partId: 'part-1', sha256: uploaded.sha256, size: uploaded.size };
    }

    it('200: байты с Content-Type/ETag/Accept-Ranges/Disposition', async () => {
      const { app, sessionManager } = createHarness();
      const bytes = pngBytes(3);
      const { session, partId, sha256 } = await seedMessagePart(app, sessionManager, bytes);

      const res = await app.request(`/api/v2/sessions/${session.id}/attachments/${partId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('etag')).toBe(`"${sha256}"`);
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('cache-control')).toContain('private');
      expect(res.headers.get('content-disposition')).toContain('inline');
      expect(res.headers.get('content-disposition')).toContain('photo.png');

      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(bytes)).toBe(true);
    });

    it('206: диапазон байтов с Content-Range', async () => {
      const { app, sessionManager } = createHarness();
      const bytes = pngBytes(4);
      const { session, partId } = await seedMessagePart(app, sessionManager, bytes);

      const res = await app.request(`/api/v2/sessions/${session.id}/attachments/${partId}`, {
        headers: { Range: 'bytes=2-5' },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 2-5/${bytes.length}`);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(2, 6))).toBe(true);
    });

    it('HEAD: заголовки без тела', async () => {
      const { app, sessionManager } = createHarness();
      const bytes = pngBytes(7);
      const { session, partId, size } = await seedMessagePart(app, sessionManager, bytes);

      const res = await app.request(`/api/v2/sessions/${session.id}/attachments/${partId}`, {
        method: 'HEAD',
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(size));
      expect(res.headers.get('content-type')).toBe('image/png');
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    });

    it('416: недостижимый диапазон', async () => {
      const { app, sessionManager } = createHarness();
      const bytes = pngBytes(8);
      const { session, partId, size } = await seedMessagePart(app, sessionManager, bytes);

      const res = await app.request(`/api/v2/sessions/${session.id}/attachments/${partId}`, {
        headers: { Range: `bytes=${size + 10}-` },
      });
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${size}`);
    });

    it('304: If-None-Match совпал с ETag', async () => {      const { app, sessionManager } = createHarness();
      const { session, partId, sha256 } = await seedMessagePart(app, sessionManager, pngBytes(5));

      const res = await app.request(`/api/v2/sessions/${session.id}/attachments/${partId}`, {
        headers: { 'If-None-Match': `"${sha256}"` },
      });
      expect(res.status).toBe(304);
    });

    it('404: неизвестная часть и неизвестный объект', async () => {
      const { app, sessionManager } = createHarness();
      const { session } = await seedMessagePart(app, sessionManager, pngBytes(6));

      const missingPart = await app.request(`/api/v2/sessions/${session.id}/attachments/nope`);
      expect(missingPart.status).toBe(404);

      const missingSession = await app.request(`/api/v2/sessions/missing/attachments/part-1`);
      expect(missingSession.status).toBe(404);
    });

    it('403: чужая сессия', async () => {
      const { app, sessionManager } = createHarness({ canAccess: () => false });
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}/attachments/part-1`);
      expect(res.status).toBe(403);
    });
  });

  // ADR-094: инкременты метрик вложений — загрузка (успех/ошибка) и раздача.
  describe('метрики вложений (ADR-094)', () => {
    it('upload ok → synth_attachment_uploads_total{outcome="ok",kind="image"}', async () => {
      const { app, sessionManager, registry } = createHarness({ metrics: true });
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await upload(app, session.id, pngBytes());
      expect(res.status).toBe(201);

      const text = registry.render().text;
      expect(text).toContain('synth_attachment_uploads_total{outcome="ok",kind="image"} 1');
      expect(text).toContain('synth_attachment_upload_bytes_count{kind="image"} 1');
    });

    it('upload ошибки: too_large и unsupported попадают в счётчик', async () => {
      const tooLarge = createHarness({ metrics: true, config: { maxBytesPerFile: 20 } });
      const s1 = await tooLarge.sessionManager.createSession({ title: 'S', userId: 'local' });
      expect((await upload(tooLarge.app, s1.id, pngBytes())).status).toBe(413);
      expect(tooLarge.registry.render().text).toContain(
        'synth_attachment_uploads_total{outcome="too_large",kind="image"} 1',
      );

      setAttachmentMetricsHook(null);
      const unsupported = createHarness({ metrics: true });
      const s2 = await unsupported.sessionManager.createSession({ title: 'S', userId: 'local' });
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      expect((await upload(unsupported.app, s2.id, svg, 'pic.svg', 'image/svg+xml')).status).toBe(415);
      expect(unsupported.registry.render().text).toContain(
        'synth_attachment_uploads_total{outcome="unsupported",kind="image"} 1',
      );
    });

    it('download: ok и not_found', async () => {
      const { app, sessionManager, registry } = createHarness({ metrics: true });
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const uploaded = (await (await upload(app, session.id, pngBytes())).json()) as {
        blobPath: string; sha256: string; mime: string; size: number;
      };
      await sessionManager.withLock(session.id, async (locked) => {
        locked.messages.push({
          id: 'msg-1',
          role: 'user',
          seq: 1,
          origin: 'local',
          parts: [
            {
              id: 'part-1',
              type: 'image',
              data: {
                blobPath: uploaded.blobPath,
                sha256: uploaded.sha256,
                mime: uploaded.mime,
                size: uploaded.size,
                name: 'photo.png',
              },
            },
          ],
          content: 'см.',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
        } as Message);
        await sessionManager.updateSession(locked);
      });

      expect((await app.request(`/api/v2/sessions/${session.id}/attachments/part-1`)).status).toBe(200);
      expect((await app.request(`/api/v2/sessions/${session.id}/attachments/nope`)).status).toBe(404);

      const text = registry.render().text;
      expect(text).toContain('synth_attachment_downloads_total{outcome="ok"} 1');
      expect(text).toContain('synth_attachment_downloads_total{outcome="not_found"} 1');
    });
  });
});
