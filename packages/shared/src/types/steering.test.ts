/**
 * ADR-104: контракт режима отправки сообщения (`queue`/`steer`/`interrupt`)
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
  steerInjectionClass,
  orderSteerInjections,
} from './steering.js';
import { promptRequestSchema } from '../schemas/index.js';

describe('ADR-104: типы режима отправки (steering)', () => {
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
    // `STEERING_INTERRUPT_UNSUPPORTED` удалён вместе с этапом 2: режим
    // `interrupt` реализован, отдельного кода отказа больше нет.
    expect(Object.keys(STEERING_ERROR_CODES)).toEqual(['limitExceeded']);
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

describe('ADR-104 этап 3: приоритет инъекций', () => {
  it('класс инъекции — по маркеру metadata.interrupt', () => {
    expect(steerInjectionClass({ metadata: { interrupt: true } })).toBe('interrupt');
    expect(steerInjectionClass({ metadata: { steer: true } })).toBe('steer');
    expect(steerInjectionClass({})).toBe('steer');
    expect(steerInjectionClass({ metadata: { interrupt: 'yes' } })).toBe('steer');
  });

  it('порядок: сначала interrupt, внутри класса — FIFO; вход не мутируется', () => {
    const input = [
      { content: 'steer 1' },
      { content: 'interrupt 1', metadata: { interrupt: true } },
      { content: 'steer 2' },
      { content: 'interrupt 2', metadata: { interrupt: true } },
    ];
    const ordered = orderSteerInjections(input);
    expect(ordered.map((m) => m.content)).toEqual([
      'interrupt 1', 'interrupt 2', 'steer 1', 'steer 2',
    ]);
    // Вход не переставлен — функция возвращает новый массив.
    expect(input.map((m) => m.content)).toEqual([
      'steer 1', 'interrupt 1', 'steer 2', 'interrupt 2',
    ]);
  });

  it('пустая очередь — пустой результат', () => {
    expect(orderSteerInjections([])).toEqual([]);
  });
});

describe('ADR-104: promptRequestSchema — поле mode', () => {
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
