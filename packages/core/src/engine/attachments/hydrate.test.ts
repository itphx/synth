/**
 * ADR-115: гидратация вложений (blob → base64) и лимит объёма.
 */

import { describe, it, expect } from 'vitest';
import { MessageRole, type MediaPartData, type Message, type Part } from '@itphx/synth-shared';
import type { LLMMessage } from '../../providers/base.js';
import {
  hydrateMessageAttachments,
  MAX_ATTACHMENT_BASE64_BYTES,
  type HydrateDeps,
} from './hydrate.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n');

function mediaPart(type: Part['type'], data: Partial<MediaPartData>): Part {
  return {
    id: `p-${type}`,
    type,
    data: {
      blobPath: `attachments/aa/${type}`,
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      size: PNG_BYTES.length,
      ...data,
    },
  };
}

function sourceMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'src-1',
    role: MessageRole.USER,
    seq: 1,
    origin: 'local',
    parts: [],
    content: 'вопрос',
    createdAt: '2026-01-01T00:00:00.000Z',
    disabled: false,
    pinned: false,
    hidden: false,
    ...overrides,
  };
}

function llmMessage(overrides: Partial<LLMMessage> = {}): LLMMessage {
  return {
    id: '',
    role: 'user',
    content: 'вопрос',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: '',
    ...overrides,
  };
}

function makeDeps(blobs: Record<string, Buffer>): HydrateDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    resolve: async (blobPath) => {
      const bytes = blobs[blobPath];
      if (!bytes) return null;
      const mime = blobPath.endsWith('pdf') ? 'application/pdf' : 'image/png';
      return { mime, size: bytes.length, sha256: 'a'.repeat(64), name: blobPath.split('/').pop() };
    },
    read: async (blobPath) => {
      reads.push(blobPath);
      return blobs[blobPath] ?? null;
    },
  };
}

describe('hydrateMessageAttachments (ADR-115)', () => {
  it('читает байты вложения через порт и заполняет attachments', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const source = [sourceMessage({ parts: [mediaPart('image', { blobPath: 'attachments/aa/image' })] })];

    const result = await hydrateMessageAttachments(
      [llmMessage()],
      source,
      deps,
      { modalities: ['text', 'image'] },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.attachments).toEqual([
      { mime: 'image/png', name: 'image', base64: PNG_BYTES.toString('base64') },
    ]);
    expect(deps.reads).toEqual(['attachments/aa/image']);
  });

  it('сопоставляет сообщения по индексу с учётом фильтра sessionMessagesToLlm (disabled)', async () => {
    const deps = makeDeps({
      'attachments/aa/skip': PNG_BYTES,
      'attachments/aa/image': PNG_BYTES,
    });
    const source = [
      sourceMessage({
        id: 'src-disabled',
        disabled: true,
        parts: [mediaPart('image', { blobPath: 'attachments/aa/skip' })],
      }),
      sourceMessage({
        id: 'src-active',
        parts: [mediaPart('image', { blobPath: 'attachments/aa/image' })],
      }),
    ];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['image'],
    });

    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(deps.reads).toEqual(['attachments/aa/image']);
  });

  it('фильтрует вложения по модальностям модели', async () => {
    const deps = makeDeps({ 'attachments/aa/pdf': PDF_BYTES });
    const source = [
      sourceMessage({ parts: [mediaPart('file', { blobPath: 'attachments/aa/pdf', mime: 'application/pdf' })] }),
    ];

    const withoutPdf = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text', 'image'],
    });
    expect(withoutPdf[0]!.attachments).toBeUndefined();

    const withPdf = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text', 'pdf'],
    });
    expect(withPdf[0]!.attachments?.[0]).toEqual({
      mime: 'application/pdf',
      name: 'pdf',
      base64: PDF_BYTES.toString('base64'),
    });
  });

  it('модальности неизвестны (не заданы) → вложение уходит, фильтра нет', async () => {
    const deps = makeDeps({ 'attachments/aa/pdf': PDF_BYTES });
    const source = [
      sourceMessage({ parts: [mediaPart('file', { blobPath: 'attachments/aa/pdf', mime: 'application/pdf' })] }),
    ];

    // Модальности модели неизвестны (каталог провайдера их не сообщил):
    // вложение отправляется как есть — ошибку непринятого типа вернёт
    // провайдер, тихой потери вложения быть не должно.
    const result = await hydrateMessageAttachments([llmMessage()], source, deps);

    expect(result[0]!.attachments?.[0]).toEqual({
      mime: 'application/pdf',
      name: 'pdf',
      base64: PDF_BYTES.toString('base64'),
    });
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
    expect(deps.reads).toEqual(['attachments/aa/pdf']);
  });

  it('пустой список модальностей трактуется как «неизвестны» — без фильтра', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const source = [sourceMessage({ parts: [mediaPart('image', { blobPath: 'attachments/aa/image' })] })];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, { modalities: [] });

    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
  });

  it('ошибка чтения объекта → вложение пропускается, ход не падает', async () => {
    const deps = makeDeps({});
    const source = [
      sourceMessage({ parts: [mediaPart('image', { blobPath: 'attachments/aa/missing' })] }),
    ];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['image'],
    });

    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос');
  });

  it('превышение лимита: старые вложения отбрасываются, на сообщении остаётся пометка в debug', async () => {
    const deps = makeDeps({
      'attachments/aa/old': PNG_BYTES,
      'attachments/aa/new': PNG_BYTES,
    });
    const source = [
      sourceMessage({ id: 'old', parts: [mediaPart('image', { blobPath: 'attachments/aa/old' })] }),
      sourceMessage({ id: 'new', parts: [mediaPart('image', { blobPath: 'attachments/aa/new' })] }),
    ];
    const base64Length = PNG_BYTES.toString('base64').length;

    const result = await hydrateMessageAttachments(
      [llmMessage({ id: 'm-old' }), llmMessage({ id: 'm-new' })],
      source,
      deps,
      { modalities: ['image'], maxTotalBase64Bytes: base64Length + 1 },
    );

    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.debug?.attachmentsDropped).toEqual([
      { mime: 'image/png', name: 'old', sizeBytes: PNG_BYTES.length, reason: 'limit' },
    ]);
    expect(result[1]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[1]!.debug?.attachmentsDropped).toBeUndefined();
    // Дефолтный предел — 20 МиБ (ADR-115).
    expect(MAX_ATTACHMENT_BASE64_BYTES).toBe(20 * 1024 * 1024);
  });

  it('модальность не принята: вложение помечается reason=modality, в лог — сводка', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const source = [sourceMessage({ parts: [mediaPart('image', { blobPath: 'attachments/aa/image' })] })];
    const logs: string[] = [];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
      log: (message) => logs.push(message),
    });

    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.debug?.attachmentsDropped).toEqual([
      { mime: 'image/png', sizeBytes: 0, reason: 'modality' },
    ]);
    // Байты отсечённого по модальности вложения не читаются.
    expect(deps.reads).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('1');
    expect(logs[0]).toContain('modality');
  });

  it('не мутирует входные сообщения и исходную историю', async () => {    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const source = [sourceMessage({ parts: [mediaPart('image', { blobPath: 'attachments/aa/image' })] })];
    const messages = [llmMessage()];
    const messagesBefore = JSON.stringify(messages);
    const sourceBefore = JSON.stringify(source);

    const result = await hydrateMessageAttachments(messages, source, deps, { modalities: ['image'] });

    expect(result).not.toBe(messages);
    expect(result[0]).not.toBe(messages[0]);
    expect(JSON.stringify(messages)).toBe(messagesBefore);
    expect(JSON.stringify(source)).toBe(sourceBefore);
  });
});
