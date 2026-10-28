/**
 * ADR-115: гидратация вложений (blob → base64) и лимит объёма.
 */

import { describe, it, expect, vi } from 'vitest';
import { MessageRole, type MediaPartData, type Message, type Part } from '@itphx/synth-shared';
import type { LLMMessage } from '../../providers/base.js';
import {
  hydrateMessageAttachments,
  MAX_ATTACHMENT_BASE64_BYTES,
  type HydrateDeps,
} from './hydrate.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n');

/** JPEG-сегмент: маркер + длина (включая саму длину) + данные. */
function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** JPEG с EXIF (APP1): провайдеру эти байты уходить не должны. */
function jpegWithExif(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, Buffer.from('Exif\0\0GPS', 'latin1')),
    jpegSegment(0xdb, Buffer.from([1, 2, 3, 4])),
    jpegSegment(0xda, Buffer.alloc(8, 9)),
    Buffer.from([0x12, 0x34, 0x56, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

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
      const mime = blobPath.endsWith('pdf')
        ? 'application/pdf'
        : blobPath.includes('jpeg')
          ? 'image/jpeg'
          : blobPath.endsWith('.mp4')
            ? 'video/mp4'
            : blobPath.endsWith('.ogg')
              ? 'audio/ogg'
              : blobPath.endsWith('.wav')
                ? 'audio/wav'
                : 'image/png';
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

  it('отдаёт провайдеру очищенные байты (без APP1/EXIF), blob не меняется', async () => {
    const raw = jpegWithExif();
    const deps = makeDeps({ 'attachments/aa/jpeg': raw });
    const source = [
      sourceMessage({ parts: [mediaPart('image', { blobPath: 'attachments/aa/jpeg' })] }),
    ];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['image'],
    });

    const sent = Buffer.from(result[0]!.attachments![0]!.base64, 'base64');
    // Очистка метаданных — на границе отправки: APP1 в base64 не попадает.
    expect(sent.includes(Buffer.from('Exif\0\0GPS', 'latin1'))).toBe(false);
    expect(sent.length).toBeLessThan(raw.length);
    expect(sent.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(sent.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    // В blob лежит оригинал — чтение не изменилось.
    expect(await deps.read('attachments/aa/jpeg')).toEqual(raw);
  });

  it('сопоставляет сообщения по индексу с учётом фильтра sessionMessagesToLlm (disabled)', async () => {    const deps = makeDeps({
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

  it('ошибка чтения объекта → вложение пропускается, ход не падает, модели — пометка', async () => {
    const deps = makeDeps({});
    const source = [
      sourceMessage({ parts: [mediaPart('image', { blobPath: 'attachments/aa/missing' })] }),
    ];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['image'],
    });

    expect(result[0]!.attachments).toBeUndefined();
    // Модель не должна искать «потерянный» файл на диске: пометка в LLM-сообщении.
    expect(result[0]!.content).toBe(
      'вопрос\n\n[attachment not delivered: image/png — unavailable]',
    );
    expect(result[0]!.debug?.attachmentsDropped).toEqual([
      { mime: 'image/png', sizeBytes: 0, reason: 'unavailable' },
    ]);
    // Исходная история не тронута.
    expect(source[0]!.content).toBe('вопрос');
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
    // Причина отброса видна модели, а не только в `debug`.
    expect(result[0]!.content).toBe(
      'вопрос\n\n[attachment not delivered: old (image/png) — limit]',
    );
    expect(result[1]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[1]!.debug?.attachmentsDropped).toBeUndefined();
    // Дефолтный предел — 20 МиБ (ADR-115).
    expect(MAX_ATTACHMENT_BASE64_BYTES).toBe(20 * 1024 * 1024);
  });

  it('вложение, отброшенное по лимиту, тоже материализуется (файл остаётся доступен)', async () => {
    const deps = makeDeps({ 'attachments/aa/old': PNG_BYTES });
    const source = [
      sourceMessage({
        id: 'old',
        parts: [mediaPart('image', { blobPath: 'attachments/aa/old', name: 'старое.png' })],
      }),
    ];
    const base64Length = PNG_BYTES.toString('base64').length;
    const refs: Array<{ name?: string; reason: string }> = [];

    const result = await hydrateMessageAttachments(
      [llmMessage()],
      source,
      deps,
      {
        modalities: ['image'],
        maxTotalBase64Bytes: base64Length - 1,
        noticeTemplate: '{items}',
        materialize: async (ref) => {
          refs.push({ name: ref.name, reason: ref.reason });
          return 'attachments/старое.png';
        },
      },
    );

    expect(result[0]!.attachments).toBeUndefined();
    // Имя берётся из метаданных объекта (`meta.name` важнее имени части).
    expect(refs).toEqual([{ name: 'old', reason: 'limit' }]);
    expect(result[0]!.content).toBe(
      'вопрос\n\n- old (image/png) — limit; path: attachments/старое.png',
    );
  });

  it('модальность не принята: вложение помечается reason=modality, в лог — сводка', async () => {    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
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

  it('пометка по модальности: шаблон с {items}, имя и MIME, история сессии не меняется', async () => {
    const deps = makeDeps({ 'attachments/aa/pdf': PDF_BYTES });
    const text = 'посмотри [file: Планировка квартиры.pdf]';
    const source = [
      sourceMessage({
        content: text,
        parts: [
          mediaPart('file', {
            blobPath: 'attachments/aa/pdf',
            mime: 'application/pdf',
            name: 'Планировка квартиры.pdf',
          }),
        ],
      }),
    ];
    const sourceBefore = JSON.stringify(source);
    const template = '[ATTACHMENTS NOT DELIVERED]\n{items}';

    const result = await hydrateMessageAttachments([llmMessage({ content: text })], source, deps, {
      modalities: ['text'],
      noticeTemplate: template,
    });

    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe(
      `${text}\n\n[ATTACHMENTS NOT DELIVERED]\n- Планировка квартиры.pdf (application/pdf) — modality`,
    );
    expect(result[0]!.debug?.attachmentsDropped).toEqual([
      { mime: 'application/pdf', name: 'Планировка квартиры.pdf', sizeBytes: 0, reason: 'modality' },
    ]);
    // Пометка — только в LLM-сообщении: сохранённый `source` не мутирован,
    // строки-пометки в него не попадают.
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(source[0]!.content).toBe(text);
    expect(source[0]!.content).not.toContain('ATTACHMENTS NOT DELIVERED');
  });

  it('шаблон не задан → короткая техническая строка на английском (канал LLM)', async () => {
    const deps = makeDeps({ 'attachments/aa/pdf': PDF_BYTES });
    const source = [
      sourceMessage({
        parts: [
          mediaPart('file', {
            blobPath: 'attachments/aa/pdf',
            mime: 'application/pdf',
            name: 'док.pdf',
          }),
        ],
      }),
    ];

    const withoutTemplate = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
    });
    expect(withoutTemplate[0]!.content).toBe(
      'вопрос\n\n[attachment not delivered: док.pdf (application/pdf) — modality]',
    );

    // Пустой шаблон — то же поведение, что и отсутствующий.
    const emptyTemplate = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
      noticeTemplate: '   ',
    });
    expect(emptyTemplate[0]!.content).toBe(withoutTemplate[0]!.content);
  });

  it('материализованное вложение: путь в строке списка (шаблон)', async () => {
    const deps = makeDeps({ 'attachments/aa/pdf': PDF_BYTES });
    const source = [
      sourceMessage({
        parts: [
          mediaPart('file', {
            blobPath: 'attachments/aa/pdf',
            mime: 'application/pdf',
            name: 'док.pdf',
          }),
        ],
      }),
    ];
    const refs: Array<{ name?: string; mime: string; blobPath: string; reason: string }> = [];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
      noticeTemplate: '{items}',
      materialize: async (ref) => {
        refs.push(ref);
        return 'attachments/док.pdf';
      },
    });

    expect(refs).toEqual([
      { name: 'док.pdf', mime: 'application/pdf', blobPath: 'attachments/aa/pdf', reason: 'modality' },
    ]);
    expect(result[0]!.content).toBe(
      'вопрос\n\n- док.pdf (application/pdf) — modality; path: attachments/док.pdf',
    );
  });

  it('материализация вернула null (нет workspace) — строка без пути, ход не падает', async () => {
    const deps = makeDeps({ 'attachments/aa/pdf': PDF_BYTES });
    const source = [
      sourceMessage({
        parts: [
          mediaPart('file', {
            blobPath: 'attachments/aa/pdf',
            mime: 'application/pdf',
            name: 'док.pdf',
          }),
        ],
      }),
    ];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
      materialize: async () => null,
    });

    expect(result[0]!.content).toBe(
      'вопрос\n\n[attachment not delivered: док.pdf (application/pdf) — modality]',
    );
    expect(result[0]!.content).not.toContain('path:');
  });

  it('ошибка материализации не роняет ход: строка без пути, предупреждение в лог', async () => {
    const deps = makeDeps({ 'attachments/aa/pdf': PDF_BYTES });
    const source = [
      sourceMessage({
        parts: [
          mediaPart('file', {
            blobPath: 'attachments/aa/pdf',
            mime: 'application/pdf',
            name: 'док.pdf',
          }),
        ],
      }),
    ];
    const logs: string[] = [];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
      noticeTemplate: '{items}',
      materialize: async () => {
        throw new Error('EACCES');
      },
      log: (message) => logs.push(message),
    });

    expect(result[0]!.content).toBe('вопрос\n\n- док.pdf (application/pdf) — modality');
    expect(logs.some((line) => line.includes('EACCES'))).toBe(true);
  });

  it('несколько отброшенных вложений — один блок со списком, порядок устойчивый', async () => {
    const deps = makeDeps({
      'attachments/aa/img': PNG_BYTES,
      'attachments/aa/pdf': PDF_BYTES,
    });
    const source = [
      sourceMessage({
        parts: [
          mediaPart('image', { blobPath: 'attachments/aa/img', name: 'фото.png' }),
          mediaPart('file', {
            blobPath: 'attachments/aa/pdf',
            mime: 'application/pdf',
            name: 'док.pdf',
          }),
        ],
      }),
    ];
    const template = '[ATTACHMENTS NOT DELIVERED]\n{items}';
    const options = { modalities: ['text' as const], noticeTemplate: template };

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, options);

    expect(result[0]!.content).toBe(
      'вопрос\n\n[ATTACHMENTS NOT DELIVERED]'
        + '\n- фото.png (image/png) — modality'
        + '\n- док.pdf (application/pdf) — modality',
    );
    expect(result[0]!.debug?.attachmentsDropped).toHaveLength(2);
    // Блок ровно один, даже если отброшено несколько вложений.
    expect(result[0]!.content.split('[ATTACHMENTS NOT DELIVERED]')).toHaveLength(2);

    // Порядок пометок не зависит от повторного прогона.
    const again = await hydrateMessageAttachments([llmMessage()], source, deps, options);
    expect(again[0]!.content).toBe(result[0]!.content);
  });

  it('сообщение без вложений не меняется', async () => {
    const deps = makeDeps({});
    const messages = [llmMessage()];

    const result = await hydrateMessageAttachments(messages, [sourceMessage()], deps, {
      modalities: ['text'],
    });

    expect(result).toBe(messages);
    expect(result[0]).toBe(messages[0]);
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

/**
 * ADR-115 §«Модели обработки по модальностям»: derive в гидратации —
 * native → aux-текст → отброс.
 */
describe('hydrateMessageAttachments: derive (ADR-115)', () => {
  function imageSource(): Message[] {
    return [
      sourceMessage({
        parts: [
          mediaPart('image', { blobPath: 'attachments/aa/image', name: 'plan.png' }),
        ],
      }),
    ];
  }

  function audioSource(mime = 'audio/ogg', name = 'voice.ogg'): Message[] {
    const ext = mime === 'audio/wav' ? 'wav' : 'ogg';
    return [
      sourceMessage({
        parts: [
          mediaPart('audio', {
            blobPath: `attachments/aa/voice.${ext}`,
            mime,
            name,
          }),
        ],
      }),
    ];
  }

  function videoSource(): Message[] {
    return [
      sourceMessage({
        parts: [
          mediaPart('video', {
            blobPath: 'attachments/aa/clip.mp4',
            mime: 'video/mp4',
            name: 'clip.mp4',
          }),
        ],
      }),
    ];
  }

  it('модальность не принята + derive → текст в content, вложения нет, debug.attachmentsDerived=1', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const derive = vi.fn(async () => 'Схема зала и подписи');

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, {
      modalities: ['text'],
      derive,
    });

    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith({
      blobPath: 'attachments/aa/image',
      mime: 'image/png',
      name: 'plan.png',
      family: 'image',
    });
    // Байты модели сессии не отправляются: вместо вложения — текст.
    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос\n\n[image: plan.png]\nСхема зала и подписи');
    expect(result[0]!.debug?.attachmentsDerived).toBe(1);
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
    expect(deps.reads).toEqual([]);
  });

  it('derive → null: прежний путь — отброс и материализация', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const derive = vi.fn(async () => null);
    const refs: Array<{ reason: string }> = [];

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, {
      modalities: ['text'],
      derive,
      noticeTemplate: '{items}',
      materialize: async (ref) => {
        refs.push({ reason: ref.reason });
        return 'attachments/plan.png';
      },
    });

    expect(derive).toHaveBeenCalledTimes(1);
    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe(
      'вопрос\n\n- plan.png (image/png) — modality; path: attachments/plan.png',
    );
    expect(result[0]!.debug?.attachmentsDropped).toEqual([
      { mime: 'image/png', name: 'plan.png', sizeBytes: 0, reason: 'modality' },
    ]);
    expect(result[0]!.debug?.attachmentsDerived).toBeUndefined();
    expect(refs).toEqual([{ reason: 'modality' }]);
  });

  it('ошибка derive → отброс, ход не падает, предупреждение в лог', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const logs: string[] = [];

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, {
      modalities: ['text'],
      derive: async () => {
        throw new Error('aux down');
      },
      log: (message) => logs.push(message),
    });

    expect(result[0]!.content).toContain('[attachment not delivered: plan.png (image/png) — modality]');
    expect(result[0]!.debug?.attachmentsDropped).toHaveLength(1);
    expect(logs.some((line) => line.includes('aux down'))).toBe(true);
  });

  it('поддерживаемая модальность → derive не вызывается', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const derive = vi.fn(async () => 'не должно вызываться');

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, {
      modalities: ['text', 'image'],
      derive,
    });

    expect(derive).not.toHaveBeenCalled();
    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[0]!.debug?.attachmentsDerived).toBeUndefined();
  });

  it('поддерживаемая audio + derive → текст (явная aux-модель важнее нативного пути)', async () => {
    const deps = makeDeps({ 'attachments/aa/voice.ogg': Buffer.from('OggS') });
    const derive = vi.fn(async () => 'транскрипт голосового');

    const result = await hydrateMessageAttachments([llmMessage()], audioSource(), deps, {
      modalities: ['text', 'audio'],
      derive,
    });

    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith({
      blobPath: 'attachments/aa/voice.ogg',
      mime: 'audio/ogg',
      name: 'voice.ogg',
      family: 'audio',
    });
    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос\n\n[audio: voice.ogg]\nтранскрипт голосового');
    expect(result[0]!.debug?.attachmentsDerived).toBe(1);
    expect(deps.reads).toEqual([]);
  });

  it('audio-формат не поддержан транспортом + derive → текст (не теряется молча)', async () => {
    const deps = makeDeps({ 'attachments/aa/voice.ogg': Buffer.from('OggS') });
    const derive = vi.fn(async () => 'транскрипт голосового');

    // Модальность `audio` в каталоге есть, но протокол не умеет ogg
    // (Anthropic-совместимый): без aux вложение должно стать «недоставленным»,
    // а не пропасть у провайдера.
    const result = await hydrateMessageAttachments([llmMessage()], audioSource(), deps, {
      modalities: ['text', 'audio'],
      canDeliverNative: () => false,
      derive,
    });

    expect(derive).toHaveBeenCalledTimes(1);
    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос\n\n[audio: voice.ogg]\nтранскрипт голосового');
    expect(result[0]!.debug?.attachmentsDerived).toBe(1);
    expect(deps.reads).toEqual([]);
  });

  it('video не доставляется нативно (адаптеры его не кодируют) + derive → кадры текстом', async () => {
    const deps = makeDeps({ 'attachments/aa/clip.mp4': Buffer.from('ftyp') });
    const derive = vi.fn(async () => 'На кадрах: двор и две машины');

    const result = await hydrateMessageAttachments([llmMessage()], videoSource(), deps, {
      modalities: ['text', 'video'],
      canDeliverNative: () => false,
      derive,
    });

    expect(derive).toHaveBeenCalledTimes(1);
    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос\n\n[video: clip.mp4]\nНа кадрах: двор и две машины');
    expect(result[0]!.debug?.attachmentsDerived).toBe(1);
  });

  it('video нативно (RouterAI video_url) → байты уходят провайдеру, без derive', async () => {
    const deps = makeDeps({ 'attachments/aa/clip.mp4': Buffer.from('ftyp') });
    const derive = vi.fn(async () => 'не должен вызываться');

    const result = await hydrateMessageAttachments([llmMessage()], videoSource(), deps, {
      modalities: ['text', 'video'],
      canDeliverNative: () => true,
      derive,
    });

    expect(derive).not.toHaveBeenCalled();
    expect(result[0]!.attachments).toEqual([
      {
        mime: 'video/mp4',
        name: 'clip.mp4',
        base64: Buffer.from('ftyp').toString('base64'),
      },
    ]);
    // Плейсхолдер уже в content сообщения (его ставит `eventToMessage`);
    // нативная доставка content не меняет.
    expect(result[0]!.content).toBe('вопрос');
  });

  it('audio → видео для модели с video без audio: MP4 + пометка «только звук»', async () => {
    const deps = makeDeps({ 'attachments/aa/voice.ogg': Buffer.from('OggS') });
    const derive = vi.fn(async () => 'не должен вызываться');
    const wrapAudioAsVideo = vi.fn(async () => ({
      part: {
        blobPath: 'attachments/.derived/audio-video.mp4',
        sha256: 'b'.repeat(64),
        mime: 'video/mp4',
        size: 4,
        name: 'voice.mp4',
      },
      bytes: Buffer.from('MP4!'),
    }));

    const result = await hydrateMessageAttachments([llmMessage()], audioSource(), deps, {
      modalities: ['text', 'video'],
      canDeliverNative: (mime) => mime === 'video/mp4',
      derive,
      wrapAudioAsVideo,
    });

    expect(wrapAudioAsVideo).toHaveBeenCalledTimes(1);
    expect(derive).not.toHaveBeenCalled();
    expect(result[0]!.attachments).toEqual([
      {
        mime: 'video/mp4',
        name: 'voice.mp4',
        base64: Buffer.from('MP4!').toString('base64'),
      },
    ]);
    expect(result[0]!.content).toContain('audio-only source');
    expect(result[0]!.content).toContain('black placeholder');
  });

  it('audio → видео не удалось → обычный derive (транскрипт)', async () => {
    const deps = makeDeps({ 'attachments/aa/voice.ogg': Buffer.from('OggS') });
    const derive = vi.fn(async () => 'транскрипт');
    const wrapAudioAsVideo = vi.fn(async () => null);

    const result = await hydrateMessageAttachments([llmMessage()], audioSource(), deps, {
      modalities: ['text', 'video'],
      canDeliverNative: (mime) => mime === 'video/mp4',
      derive,
      wrapAudioAsVideo,
    });

    expect(derive).toHaveBeenCalledTimes(1);
    expect(result[0]!.content).toBe('вопрос\n\n[audio: voice.ogg]\nтранскрипт');
  });

  it('video без aux-модели → отброс modality, без тихой потери', async () => {
    const deps = makeDeps({ 'attachments/aa/clip.mp4': Buffer.from('ftyp') });

    const result = await hydrateMessageAttachments([llmMessage()], videoSource(), deps, {
      modalities: ['text', 'video'],
      canDeliverNative: () => false,
      noticeTemplate: '{items}',
    });

    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос\n\n- clip.mp4 (video/mp4) — modality');
    expect(result[0]!.debug?.attachmentsDropped).toEqual([
      { mime: 'video/mp4', name: 'clip.mp4', sizeBytes: 0, reason: 'modality' },
    ]);
    expect(deps.reads).toEqual([]);
  });

  it('audio-формат не поддержан транспортом, derive нет → отброс modality', async () => {
    const deps = makeDeps({ 'attachments/aa/voice.ogg': Buffer.from('OggS') });

    const result = await hydrateMessageAttachments([llmMessage()], audioSource(), deps, {
      modalities: ['text', 'audio'],
      canDeliverNative: () => false,
      noticeTemplate: '{items}',
    });

    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос\n\n- voice.ogg (audio/ogg) — modality');
    expect(result[0]!.debug?.attachmentsDropped).toEqual([
      { mime: 'audio/ogg', name: 'voice.ogg', sizeBytes: 0, reason: 'modality' },
    ]);
    expect(deps.reads).toEqual([]);
  });

  it('audio wav поддержан транспортом, derive null → нативно', async () => {
    const deps = makeDeps({ 'attachments/aa/voice.wav': Buffer.from('RIFF0000') });

    const result = await hydrateMessageAttachments(
      [llmMessage()],
      audioSource('audio/wav', 'voice.wav'),
      deps,
      {
        modalities: ['text', 'audio'],
        derive: async () => null,
        canDeliverNative: (mime) => mime === 'audio/wav',
      },
    );

    expect(result[0]!.attachments?.[0]?.mime).toBe('audio/wav');
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
    expect(deps.reads).toEqual(['attachments/aa/voice.wav']);
  });

  it('модальности неизвестны + derive → текст в content, вложения нет, debug.attachmentsDerived=1', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const derive = vi.fn(async () => 'Схема зала и подписи');

    // Каталог провайдера модальностей не сообщил (`modalities` не задан), но
    // aux-модель семейства назначена: провайдер может молча выкинуть тип —
    // вместо байтов в диалог идёт текст.
    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, { derive });

    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith({
      blobPath: 'attachments/aa/image',
      mime: 'image/png',
      name: 'plan.png',
      family: 'image',
    });
    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос\n\n[image: plan.png]\nСхема зала и подписи');
    expect(result[0]!.debug?.attachmentsDerived).toBe(1);
    // Ни отброса, ни чтения байтов: вложение обработано aux-моделью.
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
    expect(deps.reads).toEqual([]);
  });

  it('модальности неизвестны + derive → whitespace-текст: нативно (успех — только непустой)', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, {
      derive: async () => '   \n',
    });

    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[0]!.debug?.attachmentsDerived).toBeUndefined();
  });

  it('модальности неизвестны + derive → null: прежнее поведение (нативно, без drop-блока)', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const derive = vi.fn(async () => null);
    const refs: string[] = [];

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, {
      derive,
      noticeTemplate: '{items}',
      materialize: async (ref) => {
        refs.push(ref.reason);
        return 'attachments/plan.png';
      },
    });

    expect(derive).toHaveBeenCalledTimes(1);
    // Модальности неизвестны — тихая потеря запрещена: вложение уходит как
    // есть, решение за провайдером.
    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[0]!.content).toBe('вопрос');
    expect(result[0]!.content).not.toContain('attachment not delivered');
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
    expect(result[0]!.debug?.attachmentsDerived).toBeUndefined();
    expect(refs).toEqual([]);
    expect(deps.reads).toEqual(['attachments/aa/image']);
  });

  it('модальности неизвестны + ошибка derive → нативно, ход не падает', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const logs: string[] = [];

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, {
      derive: async () => {
        throw new Error('aux down');
      },
      log: (message) => logs.push(message),
    });

    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
    expect(result[0]!.debug?.attachmentsDerived).toBeUndefined();
    expect(logs.some((line) => line.includes('aux down'))).toBe(true);
  });

  it('модальности неизвестны + derive не задан → нативно (derive не вызывается)', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, {
      modalities: [],
    });

    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[0]!.debug?.attachmentsDerived).toBeUndefined();
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
  });

  it('блок «не доставлено»: {model} и {modalities} подставлены, без них — «—»', async () => {
    const deps = makeDeps({ 'attachments/aa/pdf': PDF_BYTES });
    const source = [
      sourceMessage({
        parts: [
          mediaPart('file', { blobPath: 'attachments/aa/pdf', mime: 'application/pdf', name: 'док.pdf' }),
        ],
      }),
    ];
    const template = 'model={model}; modalities={modalities}\n{items}';

    const withModel = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
      noticeTemplate: template,
      modelLabel: 'itphx/text-small',
      modelModalities: ['text'],
    });
    expect(withModel[0]!.content).toContain('model=itphx/text-small; modalities=text');
    expect(withModel[0]!.content).toContain('- док.pdf (application/pdf) — modality');

    const withoutModel = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
      noticeTemplate: template,
    });
    expect(withoutModel[0]!.content).toContain('model=—; modalities=—');
  });

  it('несколько вложений: derive для одного, отброс другого — оба блока в порядке частей', async () => {
    const deps = makeDeps({
      'attachments/aa/image': PNG_BYTES,
      'attachments/aa/pdf': PDF_BYTES,
    });
    const source = [
      sourceMessage({
        parts: [
          mediaPart('image', { blobPath: 'attachments/aa/image', name: 'фото.png' }),
          mediaPart('file', { blobPath: 'attachments/aa/pdf', mime: 'application/pdf', name: 'док.pdf' }),
        ],
      }),
    ];

    const result = await hydrateMessageAttachments([llmMessage()], source, deps, {
      modalities: ['text'],
      noticeTemplate: '{items}',
      derive: async (input) => (input.family === 'image' ? 'описание фото' : null),
    });

    expect(result[0]!.content).toBe(
      'вопрос\n\n[image: фото.png]\nописание фото'
        + '\n\n- док.pdf (application/pdf) — modality',
    );
    expect(result[0]!.debug?.attachmentsDerived).toBe(1);
    expect(result[0]!.debug?.attachmentsDropped).toHaveLength(1);
  });
});

/**
 * ADR-115: вложения собираются только из реплик пользователя. Медиа в
 * assistant-сообщении — исходящее (шлюзы/UI через `stream.done.attachments`),
 * провайдеру не отправляется.
 */
describe('hydrateMessageAttachments: только реплики пользователя', () => {
  /** Assistant-сообщение с медиа-частью (исходящее вложение). */
  function assistantImageSource(): Message[] {
    return [
      sourceMessage({
        id: 'src-assistant',
        role: MessageRole.ASSISTANT,
        parts: [mediaPart('image', { blobPath: 'attachments/aa/image', name: 'plan.png' })],
      }),
    ];
  }

  it('медиа assistant-сообщения пропускается полностью: без вложения, derive и пометок', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const derive = vi.fn(async () => 'не должно вызываться');
    const messages = [llmMessage({ role: 'assistant' })];

    const result = await hydrateMessageAttachments(messages, assistantImageSource(), deps, {
      // Модальность не принята — при обходе роли это вызвало бы derive.
      modalities: ['text'],
      derive,
    });

    // Сообщение не тронуто: ни байтов, ни блока «не доставлено», ни debug-записей.
    expect(result[0]).toBe(messages[0]);
    expect(result[0]!.attachments).toBeUndefined();
    expect(result[0]!.content).toBe('вопрос');
    expect(result[0]!.content).not.toContain('ATTACHMENTS NOT DELIVERED');
    expect(result[0]!.content).not.toContain('[attachment not delivered');
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
    expect(result[0]!.debug?.attachmentsDerived).toBeUndefined();
    expect(derive).not.toHaveBeenCalled();
    expect(deps.reads).toEqual([]);
  });

  it('та же часть в реплике пользователя — прежнее поведение (derive, затем вложение)', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const userSource = [sourceMessage({ parts: [mediaPart('image', { blobPath: 'attachments/aa/image', name: 'plan.png' })] })];

    // Модальность не принята → текст aux-модели вместо байтов.
    const derived = await hydrateMessageAttachments([llmMessage()], userSource, deps, {
      modalities: ['text'],
      derive: async () => 'Схема зала',
    });
    expect(derived[0]!.content).toBe('вопрос\n\n[image: plan.png]\nСхема зала');
    expect(derived[0]!.debug?.attachmentsDerived).toBe(1);

    // Модальность принята → байты вложения.
    const native = await hydrateMessageAttachments([llmMessage()], userSource, deps, {
      modalities: ['text', 'image'],
    });
    expect(native[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
  });

  it('смешанная история: обрабатывается только user, медиа assistant не считается и в лимите', async () => {
    const deps = makeDeps({
      'attachments/aa/u1': PNG_BYTES,
      'attachments/aa/image': PNG_BYTES,
      'attachments/aa/u2': PNG_BYTES,
    });
    const source = [
      sourceMessage({ id: 'u1', parts: [mediaPart('image', { blobPath: 'attachments/aa/u1' })] }),
      sourceMessage({
        id: 'a1',
        role: MessageRole.ASSISTANT,
        parts: [mediaPart('image', { blobPath: 'attachments/aa/image' })],
      }),
      sourceMessage({ id: 'u2', parts: [mediaPart('image', { blobPath: 'attachments/aa/u2' })] }),
    ];
    const base64Length = PNG_BYTES.toString('base64').length;

    const result = await hydrateMessageAttachments(
      [llmMessage({ id: 'm-u1' }), llmMessage({ id: 'm-a1', role: 'assistant' }), llmMessage({ id: 'm-u2' })],
      source,
      deps,
      // Лимит ровно на два вложения: если бы часть assistant считалась,
      // самым старым оказалось бы `u1` и оно было бы отброшено по лимиту.
      { modalities: ['image'], maxTotalBase64Bytes: base64Length * 2 },
    );

    expect(deps.reads).toEqual(['attachments/aa/u1', 'attachments/aa/u2']);
    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[0]!.debug?.attachmentsDropped).toBeUndefined();
    // Assistant-сообщение не тронуто и в лимит не попало.
    expect(result[1]!.attachments).toBeUndefined();
    expect(result[1]!.debug?.attachmentsDropped).toBeUndefined();
    expect(result[1]!.content).toBe('вопрос');
    expect(result[2]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[2]!.debug?.attachmentsDropped).toBeUndefined();
  });
});
