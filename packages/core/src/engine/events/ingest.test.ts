import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentsConfig, EventAttachmentRef, RouteDecision, Session, SynthEvent } from '@itphx/synth-shared';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { AttachmentService } from '../attachments/service.js';
import { EventAttachmentError, EventIngress } from './ingest.js';
import type { RequestSessionService } from './request-session.js';

function createMockService(result?: {
  decision?: RouteDecision;
  session?: Session | null;
}): RequestSessionService {
  const decision: RouteDecision = result?.decision ?? { kind: 'bound', sessionId: 's1' };
  const session = result?.session === undefined ? ({ id: 's1' } as Session) : result.session;
  return {
    handleEvent: vi.fn(async () => ({ decision, session })),
  } as unknown as RequestSessionService;
}

describe('EventIngress (ADR-089)', () => {
  it('normalize: id с префиксом evt_, identity/ts/dedupKey по умолчанию', () => {
    const ingress = new EventIngress({ requestSessionService: createMockService() });

    const event = ingress.normalize({ source: 'telegram', type: 'message', payload: { text: 'hi' } });

    expect(event.id.startsWith('evt_')).toBe(true);
    expect(event.id).toHaveLength('evt_'.length + 36);
    expect(event.source).toBe('telegram');
    expect(event.type).toBe('message');
    expect(event.payload).toEqual({ text: 'hi' });
    expect(event.identity).toEqual({});
    expect(typeof event.ts).toBe('string');
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  });

  it('normalize: явные identity/ts/dedupKey не перезаписываются', () => {
    const ingress = new EventIngress({ requestSessionService: createMockService() });
    const ts = '2026-10-08T00:00:00.000Z';

    const event = ingress.normalize({
      source: 'webhook',
      type: 'callback',
      payload: { ok: true },
      identity: { chatKey: 'chat:webhook:1' },
      dedupKey: 'explicit-key',
      ts,
    });

    expect(event.identity).toEqual({ chatKey: 'chat:webhook:1' });
    expect(event.dedupKey).toBe('explicit-key');
    expect(event.ts).toBe(ts);
  });

  it('normalize: dedupKey по умолчанию стабилен для одинакового входа', () => {
    const ingress = new EventIngress({ requestSessionService: createMockService() });
    const input = {
      source: 'telegram',
      type: 'message',
      identity: { chatKey: 'chat:telegram:1' },
      payload: { text: 'hello' },
    };

    const a = ingress.normalize(input);
    const b = ingress.normalize(input);

    expect(a.dedupKey).toBe(b.dedupKey);
    expect(a.id).not.toBe(b.id);
  });

  it('ingest: нормализует и делегирует в handleEvent', async () => {
    const service = createMockService();
    const ingress = new EventIngress({ requestSessionService: service });

    const res = await ingress.ingest({ source: 'ci', type: 'ci_event', payload: { build: 42 } });

    expect(res.event.source).toBe('ci');
    expect(res.decision).toEqual({ kind: 'bound', sessionId: 's1' });
    expect(res.session).toEqual({ id: 's1' });
    expect(service.handleEvent).toHaveBeenCalledOnce();
    const passed = (service.handleEvent as unknown as { mock: { calls: SynthEvent[][] } }).mock.calls[0]![0]!;
    expect(passed.id).toBe(res.event.id);
    expect(passed.source).toBe('ci');
  });

  it('ingest: без сессии (drop) возвращает session null', async () => {
    const service = createMockService({ decision: { kind: 'drop', reason: 'no_route', audited: true }, session: null });
    const ingress = new EventIngress({ requestSessionService: service });

    const res = await ingress.ingest({ source: 'ui', type: 'message' });
    expect(res.session).toBeNull();
  });

  it('ADR-094: metrics.onIngest — ok при успехе, error при исключении (и проброс)', async () => {
    const onIngest = vi.fn();
    const onDecision = vi.fn();
    const okService = createMockService();
    const okIngress = new EventIngress({
      requestSessionService: okService,
      metrics: { onIngest, onDecision },
    });

    await okIngress.ingest({ source: 'ci', type: 'ci_event' });
    expect(onIngest).toHaveBeenLastCalledWith({ source: 'ci', outcome: 'ok' });

    const failing = {
      handleEvent: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as RequestSessionService;
    const failIngress = new EventIngress({
      requestSessionService: failing,
      metrics: { onIngest, onDecision },
    });

    await expect(failIngress.ingest({ source: 'telegram', type: 'message' })).rejects.toThrow('boom');
    expect(onIngest).toHaveBeenLastCalledWith({ source: 'telegram', outcome: 'error' });
    expect(onIngest).toHaveBeenCalledTimes(2);
  });
});

/**
 * ADR-115 × ADR-089: вложения внешнего события.
 *
 * Шлюз загружает байты в staging (`POST /api/v2/attachments`) и передаёт в
 * событии ссылку. Приём проверяет ссылку **до** роутинга: объект существует,
 * метаданные совпадают со sidecar, количество/размер в пределах конфига.
 */
describe('EventIngress: вложения события (ADR-115 × ADR-089)', () => {
  /** PNG-сигнатура (sniffMime → image/png). */
  const pngBytes = (): Buffer =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('rest', 'latin1'),
    ]);

  let tmpDir: string;
  let blobs: FileBlobStore;
  let service: AttachmentService;

  const attachmentConfig = (overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig => ({
    enabled: true,
    modalities: { image: true, pdf: true, audio: true, video: true },
    maxBytesPerFile: 1024 * 1024,
    maxFilesPerMessage: 10,
    maxBytesPerSession: 10 * 1024 * 1024,
    allowedMimePrefixes: ['image/', 'audio/', 'video/', 'application/pdf', 'text/'],
    workspaceFallback: true,
    gcDays: 30,
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-events-attachments-'));
    blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    service = new AttachmentService({ blobs, config: attachmentConfig() });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Загрузить вложение в staging и получить ссылку для события. */
  const uploadRef = async (name = 'photo.png'): Promise<EventAttachmentRef> => {
    const meta = await service.upload({ bytes: pngBytes(), name });
    return {
      blobPath: meta.blobPath,
      sha256: meta.sha256,
      mime: meta.mime,
      size: meta.size,
      ...(meta.name ? { name: meta.name } : {}),
    };
  };

  it('валидное событие с вложениями проходит и сохраняет `attachments` в SynthEvent', async () => {
    const ref = await uploadRef();
    const svc = createMockService();
    const ingress = new EventIngress({ requestSessionService: svc, attachments: service });

    const res = await ingress.ingest({
      source: 'telegram',
      type: 'message',
      payload: { text: 'смотри' },
      dedupKey: 'tg:update:1',
      attachments: [ref],
    });

    expect(res.event.attachments).toEqual([ref]);
    expect(svc.handleEvent).toHaveBeenCalledOnce();
    const passed = (svc.handleEvent as unknown as { mock: { calls: SynthEvent[][] } }).mock.calls[0]![0]!;
    expect(passed.attachments).toEqual([ref]);
    expect(passed.dedupKey).toBe('tg:update:1');
  });

  it('без вложений проверка не выполняется (сервис можно не передавать)', async () => {
    const svc = createMockService();
    const ingress = new EventIngress({ requestSessionService: svc });

    const res = await ingress.ingest({ source: 'ci', type: 'ci_event', payload: { build: 1 } });
    expect(res.event.attachments).toBeUndefined();
    expect(svc.handleEvent).toHaveBeenCalledOnce();
  });

  it('вложения без явного dedupKey — отказ до роутинга', async () => {
    const ref = await uploadRef();
    const svc = createMockService();
    const ingress = new EventIngress({ requestSessionService: svc, attachments: service });

    await expect(
      ingress.ingest({ source: 'telegram', type: 'message', payload: { text: 'x' }, attachments: [ref] }),
    ).rejects.toMatchObject({ name: 'EventAttachmentError', reason: 'dedup_key_required' });
    expect(svc.handleEvent).not.toHaveBeenCalled();
  });

  it('несуществующий blobPath — отказ `not_found`', async () => {
    const ref = await uploadRef();
    const missing: EventAttachmentRef = {
      ...ref,
      blobPath: `attachments/zz/${'0'.repeat(64)}`,
    };
    const ingress = new EventIngress({ requestSessionService: createMockService(), attachments: service });

    await expect(
      ingress.ingest({
        source: 'telegram',
        type: 'message',
        dedupKey: 'tg:update:2',
        attachments: [missing],
      }),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('несовпадение MIME/sha256/size с объектом — отказ `metadata_mismatch`', async () => {
    const ref = await uploadRef();
    const ingress = new EventIngress({ requestSessionService: createMockService(), attachments: service });

    const variants: EventAttachmentRef[] = [
      { ...ref, mime: 'audio/mpeg' },
      { ...ref, sha256: 'b'.repeat(64) },
      { ...ref, size: ref.size + 1 },
    ];
    for (const attachment of variants) {
      await expect(
        ingress.ingest({
          source: 'telegram',
          type: 'message',
          dedupKey: 'tg:update:3',
          attachments: [attachment],
        }),
      ).rejects.toMatchObject({ reason: 'metadata_mismatch' });
    }
  });

  it('blobPath вне attachments/ — отказ `invalid_path` (событие не принимается)', async () => {
    const ingress = new EventIngress({ requestSessionService: createMockService(), attachments: service });

    await expect(
      ingress.ingest({
        source: 'telegram',
        type: 'message',
        dedupKey: 'tg:update:4',
        attachments: [
          { blobPath: 'processes/run.log', sha256: 'a'.repeat(64), mime: 'text/plain', size: 10 },
        ],
      }),
    ).rejects.toMatchObject({ reason: 'invalid_path' });
  });

  it('лимит количества — по конфигу (`maxFilesPerMessage`), иначе жёсткий 10', async () => {
    const limited = new AttachmentService({
      blobs,
      config: attachmentConfig({ maxFilesPerMessage: 2 }),
    });
    const ref = await uploadRef();
    const ingress = new EventIngress({ requestSessionService: createMockService(), attachments: limited });

    await expect(
      ingress.ingest({
        source: 'telegram',
        type: 'message',
        dedupKey: 'tg:update:5',
        attachments: [ref, ref, ref],
      }),
    ).rejects.toMatchObject({ reason: 'too_many' });

    // Без сервиса — жёсткий предел EVENT_ATTACHMENTS_MAX_FILES (10).
    const hard = new EventIngress({ requestSessionService: createMockService() });
    await expect(
      hard.ingest({
        source: 'telegram',
        type: 'message',
        dedupKey: 'tg:update:6',
        attachments: Array.from({ length: 11 }, () => ref),
      }),
    ).rejects.toMatchObject({ reason: 'too_many' });
  });

  it('размер файла больше `maxBytesPerFile` — отказ `too_large`', async () => {
    const ref = await uploadRef();
    // Лимит применяется на приёме: объект мог быть загружен при другом (большем) лимите.
    const strict = new AttachmentService({
      blobs,
      config: attachmentConfig({ maxBytesPerFile: 4 }),
    });
    const ingress = new EventIngress({ requestSessionService: createMockService(), attachments: strict });

    await expect(
      ingress.ingest({
        source: 'telegram',
        type: 'message',
        dedupKey: 'tg:update:7',
        attachments: [ref],
      }),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('сервис вложений не передан — fail-closed `attachments_unavailable`', async () => {
    const ref = await uploadRef();
    const ingress = new EventIngress({ requestSessionService: createMockService() });

    const err = await ingress
      .ingest({
        source: 'telegram',
        type: 'message',
        dedupKey: 'tg:update:8',
        attachments: [ref],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventAttachmentError);
    expect(err).toMatchObject({ reason: 'attachments_unavailable' });
  });

  it('ADR-094: отказ по вложениям считается в метриках как error', async () => {
    const onIngest = vi.fn();
    const ingress = new EventIngress({
      requestSessionService: createMockService(),
      attachments: service,
      metrics: { onIngest, onDecision: vi.fn() },
    });
    const ref = await uploadRef();

    await expect(
      ingress.ingest({
        source: 'telegram',
        type: 'message',
        dedupKey: 'tg:update:9',
        attachments: [{ ...ref, mime: 'audio/mpeg' }],
      }),
    ).rejects.toMatchObject({ reason: 'metadata_mismatch' });
    expect(onIngest).toHaveBeenLastCalledWith({ source: 'telegram', outcome: 'error' });
  });
});
