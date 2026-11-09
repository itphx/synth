/**
 * ADR-118 §8 / ADR-115: `GET /api/v2/meta` — возможности инстанса.
 *
 * `attachments` — аддитивное поле с эффективными лимитами вложений; без
 * резолвера (старый/минимальный инстанс) поля нет, прежние поля не меняются.
 */
import { describe, it, expect } from 'vitest';
import type { AttachmentsConfig } from '@itphx/synth-shared';
import { defaultConfig, MESSAGE_MODEL_VERSION } from '@itphx/synth-shared';
import { createMetaRoutes, instanceCapabilities } from './meta.js';

function attachmentsConfig(overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig {
  return {
    enabled: true,
    modalities: { image: true, pdf: false, audio: true, video: false },
    maxBytesPerFile: 1024,
    maxFilesPerMessage: 3,
    maxBytesPerSession: 4096,
    allowedMimePrefixes: ['image/'],
    workspaceFallback: true,
    gcDays: 30,
    // ADR-115: сжатие/миниатюры/chunked-загрузка — дефолты схемы.
    compression: defaultConfig.attachments.compression,
    thumbnail: defaultConfig.attachments.thumbnail,
    maxChunkBytes: defaultConfig.attachments.maxChunkBytes,
    maxActiveUploadsPerSession: defaultConfig.attachments.maxActiveUploadsPerSession,
    maxActiveUploads: defaultConfig.attachments.maxActiveUploads,
    ...overrides,
  };
}

describe('instanceCapabilities (ADR-118 §8)', () => {
  it('без deps — прежние поля и нет attachments', () => {
    const caps = instanceCapabilities();
    expect(caps.messageModel).toBe(MESSAGE_MODEL_VERSION);
    expect(caps.eventSeq).toBe(true);
    expect(caps.replay).toBe(true);
    expect(typeof caps.version).toBe('string');
    expect('attachments' in caps).toBe(false);
  });

  it('с getAttachments — точные эффективные значения (включая modalities)', () => {
    const caps = instanceCapabilities({ getAttachments: () => attachmentsConfig() });
    expect(caps.attachments).toEqual({
      enabled: true,
      modalities: { image: true, pdf: false, audio: true, video: false },
      maxBytesPerFile: 1024,
      maxFilesPerMessage: 3,
      maxBytesPerSession: 4096,
    });
  });

  // PROP-125: возможности инстанса (`features.remoteMcp`).
  it('без getFeatures — поля features нет', () => {
    const caps = instanceCapabilities();
    expect('features' in caps).toBe(false);
  });

  it('с getFeatures — features в ответе', () => {
    const caps = instanceCapabilities({ getFeatures: () => ({ remoteMcp: true }) });
    expect(caps.features).toEqual({ remoteMcp: true });
  });

  it('getFeatures без признаков — поля features нет', () => {
    const caps = instanceCapabilities({ getFeatures: () => undefined });
    expect('features' in caps).toBe(false);
    const empty = instanceCapabilities({ getFeatures: () => ({}) });
    expect('features' in empty).toBe(false);
  });

  // `features.users` — признак, что инстанс обслуживает `/api/v2/users*`
  // (управление пользователями): managed — всегда; core standalone — нет;
  // core в гибриде — пока подключён удалённый backend.
  it('features.users === true, когда контур обслуживается', () => {
    const caps = instanceCapabilities({ getFeatures: () => ({ users: true }) });
    expect(caps.features).toEqual({ users: true });
  });

  it('features.users === false — блок features присутствует, признак выключен', () => {
    const caps = instanceCapabilities({ getFeatures: () => ({ users: false, remoteMcp: false }) });
    expect('features' in caps).toBe(true);
    expect(caps.features?.users).toBe(false);
    expect(caps.features?.remoteMcp).toBe(false);
  });

  it('features без users — блок есть, признак отсутствует (fail-closed: «фичи нет»)', () => {
    const caps = instanceCapabilities({ getFeatures: () => ({ remoteMcp: true }) });
    expect(caps.features).toEqual({ remoteMcp: true });
    expect(caps.features?.users).toBeUndefined();
  });
});

describe('GET /meta (ADR-118 §8)', () => {
  it('200 и attachments в ответе при заданном резолвере', async () => {
    const app = createMetaRoutes({ getAttachments: () => attachmentsConfig() });
    const res = await app.request('/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messageModel: number;
      attachments?: { maxBytesPerFile: number; maxFilesPerMessage: number };
    };
    expect(body.messageModel).toBe(MESSAGE_MODEL_VERSION);
    expect(body.attachments?.maxBytesPerFile).toBe(1024);
    expect(body.attachments?.maxFilesPerMessage).toBe(3);
  });

  it('200 и features.remoteMcp в ответе при заданном резолвере', async () => {
    const app = createMetaRoutes({ getFeatures: () => ({ remoteMcp: true }) });
    const res = await app.request('/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features?: { remoteMcp?: boolean } };
    expect(body.features?.remoteMcp).toBe(true);
  });

  it('200 и без features, если резолвер не задан', async () => {
    const app = createMetaRoutes();
    const res = await app.request('/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features?: unknown };
    expect(body.features).toBeUndefined();
  });

  it('200 и features.users в ответе при заданном резолвере', async () => {
    const app = createMetaRoutes({ getFeatures: () => ({ users: true }) });
    const res = await app.request('/meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features?: { users?: boolean } };
    expect(body.features?.users).toBe(true);
  });
});
