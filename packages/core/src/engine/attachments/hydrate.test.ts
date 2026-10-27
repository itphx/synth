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

  it('модальности модели неизвестны → derive не вызывается (нечего сравнивать)', async () => {
    const deps = makeDeps({ 'attachments/aa/image': PNG_BYTES });
    const derive = vi.fn(async () => 'не должно вызываться');

    const result = await hydrateMessageAttachments([llmMessage()], imageSource(), deps, { derive });

    expect(derive).not.toHaveBeenCalled();
    expect(result[0]!.attachments?.[0]?.base64).toBe(PNG_BYTES.toString('base64'));
    expect(result[0]!.debug?.attachmentsDerived).toBeUndefined();
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
