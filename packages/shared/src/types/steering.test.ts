/**
 * PROP-098: контракт режима отправки сообщения (`queue`/`steer`/`interrupt`)
 * и его схема запроса промпта.
 */
import { describe, it, expect } from 'vitest';
import {
  STEER_MODES,
  DEFAULT_STEER_MODE,
  MAX_STEER_INJECTIONS_PER_TURN,
  STEERING_ERROR_CODES,
  STEER_METADATA_KEY,
  STEER_INTERRUPT_METADATA_KEY,
  STEER_INTERRUPTED_METADATA_KEY,
  isSteerMode,
} from './steering.js';
import { promptRequestSchema } from '../schemas/index.js';

describe('PROP-098: типы режима отправки (steering)', () => {
  it('известные режимы: queue/steer/interrupt', () => {
    expect([...STEER_MODES]).toEqual(['queue', 'steer', 'interrupt']);
  });

  it('режим по умолчанию — queue (обратная совместимость)', () => {
    expect(DEFAULT_STEER_MODE).toBe('queue');
  });

  it('isSteerMode отличает известные значения от мусора', () => {
    for (const mode of STEER_MODES) expect(isSteerMode(mode)).toBe(true);
    for (const value of ['', 'QUEUE', 'steering', undefined, null, 1, {}]) {
      expect(isSteerMode(value)).toBe(false);
    }
  });

  it('лимит инъекций на ход — 5', () => {
    expect(MAX_STEER_INJECTIONS_PER_TURN).toBe(5);
  });

  it('машинные коды ошибок steering', () => {
    // `STEERING_INTERRUPT_UNSUPPORTED` — гейт HTTP-контура этапа 2: режим
    // `interrupt` движком реализован, но `/prompt` пока отвечает 400.
    expect(STEERING_ERROR_CODES.interruptUnsupported).toBe('STEERING_INTERRUPT_UNSUPPORTED');
    expect(STEERING_ERROR_CODES.limitExceeded).toBe('STEER_LIMIT_EXCEEDED');
  });

  it('признак инъекции в metadata — steer', () => {
    expect(STEER_METADATA_KEY).toBe('steer');
  });

  it('признаки режима interrupt в metadata', () => {
    expect(STEER_INTERRUPT_METADATA_KEY).toBe('interrupt');
    expect(STEER_INTERRUPTED_METADATA_KEY).toBe('interrupted');
  });
});

describe('PROP-098: promptRequestSchema — поле mode', () => {
  it('mode не задан → queue (default)', () => {
    const parsed = promptRequestSchema.parse({ content: 'привет' });
    expect(parsed.mode).toBe('queue');
    expect(parsed.stream).toBe(true);
  });

  it('mode=steer принимается', () => {
    const parsed = promptRequestSchema.parse({ content: 'привет', mode: 'steer' });
    expect(parsed.mode).toBe('steer');
  });

  it('неизвестный mode → ошибка валидации', () => {
    expect(promptRequestSchema.safeParse({ content: 'привет', mode: 'unknown' }).success).toBe(false);
  });
});
