/**
 * ADR-118 §8 / ADR-115: `GET /api/v2/meta` — возможности инстанса.
 *
 * `attachments` — аддитивное поле с эффективными лимитами вложений; без
 * резолвера (старый/минимальный инстанс) поля нет, прежние поля не меняются.
 */
import { describe, it, expect } from 'vitest';
import type { AttachmentsConfig } from '@itphx/synth-shared';
import { MESSAGE_MODEL_VERSION } from '@itphx/synth-shared';
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
});
