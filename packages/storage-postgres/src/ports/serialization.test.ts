/**
 * Unit-тесты сериализации параметров PostgreSQL: реальные U+0000 не должны
 * доходить до сервера ни в `text`, ни в `jsonb` (иначе `invalid byte sequence`
 * / `unsupported Unicode escape sequence`). Живая БД не нужна.
 */

import { describe, expect, it } from 'vitest';
import { MessageRole, makeTextPart } from '@itphx/synth-shared';
import { jsonParam, rowValues, MESSAGE_MUTABLE_FIELDS } from './sessions.js';
import { jsonbParam as principalsJsonbParam } from './principals-shared.js';
import { messageRow } from './sessions-mapping.js';
import { jsonbLiteral, jsonbParam } from '../json-param.js';
import { sanitizeQueryParams } from '../pool.js';

/** JSON-поля сообщения (как `MESSAGE_JSON_FIELDS` в порту сессий). */
const MESSAGE_JSON_FIELDS = new Set([
  'parts',
  'tool_calls',
  'usage',
  'metadata',
  'prompt_meta',
  'debug_data',
  'summary_of',
]);

describe('jsonbParam/jsonbLiteral', () => {
  it('удаляет реальный U+0000 до сериализации (нет escape \\u0000)', () => {
    const result = jsonbParam({ text: 'a\u0000b', nested: ['c\u0000'] });
    expect(result).not.toBeNull();
    expect(result).not.toContain('\u0000');
    expect(result).not.toContain('\\u0000');
    expect(JSON.parse(result!)).toEqual({ text: 'ab', nested: ['c'] });
  });

  it('null/undefined → SQL NULL для jsonbParam и литерал "null" для jsonbLiteral', () => {
    expect(jsonbParam(null)).toBeNull();
    expect(jsonbParam(undefined)).toBeNull();
    expect(jsonbLiteral(null)).toBe('null');
  });

  it('литеральная последовательность «\\u0000» сохраняется (двойное экранирование)', () => {
    const result = jsonbParam({ text: 'a\\u0000b' });
    expect(result).not.toBeNull();
    // В JSON-строке обратный слэш заэкранирован: литерал остаётся литералом.
    expect(JSON.parse(result!)).toEqual({ text: 'a\\u0000b' });
  });
});

describe('jsonParam портов', () => {
  it('sessions.jsonParam и principals.jsonbParam очищают NUL', () => {
    for (const result of [
      jsonParam({ text: 'a\u0000b' }),
      principalsJsonbParam({ text: 'a\u0000b' }),
    ]) {
      expect(result).not.toBeNull();
      expect(result).not.toContain('\u0000');
      expect(result).not.toContain('\\u0000');
      expect(JSON.parse(result!)).toEqual({ text: 'ab' });
    }
  });
});

describe('messageRow + rowValues', () => {
  const message = {
    id: 'msg-1',
    role: MessageRole.ASSISTANT,
    seq: 7,
    origin: 'local',
    parts: [makeTextPart('part\u0000text')],
    content: 'content\u0000text',
    toolCalls: [{ id: 't1', function: { name: 'x', arguments: '{"q":"arg\u0000"}' } }],
    reasoning: 'reasoning\u0000',
    metadata: { note: 'meta\u0000', nested: { list: ['l\u0000'] } },
    debugData: { raw: 'debug\u0000' },
    promptMeta: { predicted: 'prompt\u0000' },
    createdAt: '2025-01-15T10:30:00.000Z',
    disabled: false,
    pinned: false,
    hidden: false,
  };

  it('JSON-колонки очищены, текстовая content остаётся до pool-санитайзера', () => {
    const row = messageRow(message as never, 'sess-1', 1);
    const values = rowValues(row, ['content', 'parts', 'tool_calls', 'metadata', 'prompt_meta', 'debug_data'], MESSAGE_JSON_FIELDS);
    const [content, parts, toolCalls, metadata, promptMeta, debugData] = values;

    // content — text-колонка: NUL уходит на уровне пула (не теряем данные раньше).
    expect(String(content)).toContain('\u0000');
    for (const json of [parts, toolCalls, metadata, promptMeta, debugData]) {
      expect(typeof json).toBe('string');
      expect(json as string).not.toContain('\u0000');
      expect(json as string).not.toContain('\\u0000');
    }

    expect(JSON.parse(parts as string)).toEqual([{ id: expect.any(String), type: 'text', data: 'parttext' }]);
    expect(JSON.parse(metadata as string)).toEqual({ note: 'meta', nested: { list: ['l'] } });
    expect(JSON.parse(promptMeta as string)).toEqual({ predicted: 'prompt' });
    expect(JSON.parse(debugData as string)).toEqual({ raw: 'debug' });
  });

  it('пустые jsonb-поля → NULL, а не строка "undefined"', () => {
    const row = messageRow({ ...message, metadata: undefined, promptMeta: undefined } as never, 'sess-1', 1);
    const values = rowValues(row, ['metadata', 'prompt_meta', 'usage'], MESSAGE_JSON_FIELDS);
    expect(values).toEqual([null, null, null]);
  });
});

describe('MESSAGE_MUTABLE_FIELDS (updateMessage)', () => {
  it('не содержит неизменяемых колонок и не передаёт их в SET-параметры', () => {
    for (const field of ['id', 'session_id', 'seq', 'created_at']) {
      expect(MESSAGE_MUTABLE_FIELDS).not.toContain(field);
    }
    expect(MESSAGE_MUTABLE_FIELDS).toContain('content');
    expect(MESSAGE_MUTABLE_FIELDS).toContain('metadata');

    const message = {
      id: 'msg-immutable-id',
      role: MessageRole.ASSISTANT,
      seq: 7,
      origin: 'local',
      parts: [makeTextPart('text')],
      content: 'content',
      metadata: { note: 'meta\u0000' },
      createdAt: '2025-01-15T10:30:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
    };
    const row = messageRow(message as never, 'sess-immutable-id', 7);
    const values = rowValues(row, MESSAGE_MUTABLE_FIELDS, MESSAGE_JSON_FIELDS);

    expect(values).not.toContain('msg-immutable-id');
    expect(values).not.toContain('sess-immutable-id');
    expect(values).not.toContain(7);
    expect(values).not.toContain('2025-01-15T10:30:00.000Z');
    // JSON-поля очищаются и в SET-параметрах (NUL не дойдёт до jsonb).
    const metadataIndex = MESSAGE_MUTABLE_FIELDS.indexOf('metadata');
    expect(values[metadataIndex]).toBe(JSON.stringify({ note: 'meta' }));
  });
});

describe('sanitizeQueryParams', () => {
  it('удаляет реальные U+0000 из строковых параметров', () => {
    const params = ['a\u0000b', 'clean', 42, null, undefined];
    const result = sanitizeQueryParams(params)!;
    expect(result).toEqual(['ab', 'clean', 42, null, undefined]);
    expect(result[0]).toBe('ab');
  });

  it('не трогает Buffer и не-строки', () => {
    const buffer = Buffer.from('a\u0000b');
    const result = sanitizeQueryParams([buffer, 1, true, null, undefined])!;
    expect(result[0]).toBe(buffer);
    expect(result).toEqual([buffer, 1, true, null, undefined]);
  });

  it('не меняет массив, если NUL нет (та же ссылка)', () => {
    const params = ['clean', 1];
    expect(sanitizeQueryParams(params)).toBe(params);
  });

  it('пустой/не заданный список параметров возвращается как есть', () => {
    expect(sanitizeQueryParams(undefined)).toBeUndefined();
    const empty: unknown[] = [];
    expect(sanitizeQueryParams(empty)).toBe(empty);
  });
});
