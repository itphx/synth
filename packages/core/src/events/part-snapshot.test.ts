/**
 * ADR-115: снимок частей сообщения для live-событий (`message.added`,
 * `message.injected`) — текст с лимитом, медиа-часть целиком.
 */
import { describe, it, expect } from 'vitest';
import type { Part } from '@itphx/synth-shared';
import {
  snapshotPartsForEvent,
  DEFAULT_EVENT_PART_TEXT_LIMIT,
} from './part-snapshot.js';

function textPart(id: string, text: string): Part {
  return { id, type: 'text', data: text };
}

function imagePart(id: string): Part {
  return {
    id,
    type: 'image',
    data: {
      blobPath: 'attachments/aa/bb',
      sha256: 'bb',
      mime: 'image/jpeg',
      size: 1234,
      name: 'Yeti 2.jpg',
      width: 100,
      height: 80,
    },
  };
}

describe('snapshotPartsForEvent', () => {
  it('нет частей / пустой массив → undefined', () => {
    expect(snapshotPartsForEvent(undefined)).toBeUndefined();
    expect(snapshotPartsForEvent([])).toBeUndefined();
  });

  it('строковая часть обрезается до лимита (как content события)', () => {
    const long = 'x'.repeat(DEFAULT_EVENT_PART_TEXT_LIMIT + 100);
    const snapshot = snapshotPartsForEvent([textPart('p1', long)]);
    expect(snapshot).toHaveLength(1);
    expect(snapshot![0]!.data).toHaveLength(DEFAULT_EVENT_PART_TEXT_LIMIT);
    expect(snapshotPartsForEvent([textPart('p1', long)], { textLimit: 10 })![0]!.data).toBe('x'.repeat(10));
  });

  it('короткий текст не трогается', () => {
    const snapshot = snapshotPartsForEvent([textPart('p1', 'привет')]);
    expect(snapshot).toEqual([{ id: 'p1', type: 'text', data: 'привет' }]);
  });

  it('медиа-часть отдаётся целиком (объект с blobPath/mime/size/name)', () => {
    const part = imagePart('p2');
    const snapshot = snapshotPartsForEvent([part]);
    expect(snapshot).toHaveLength(1);
    expect(snapshot![0]!.type).toBe('image');
    expect(snapshot![0]!.data).toEqual(part.data);
  });

  it('у tool_result-подобного объекта обрезается строковое content, остальное сохраняется', () => {
    const long = 'y'.repeat(DEFAULT_EVENT_PART_TEXT_LIMIT + 50);
    const part: Part = { id: 'p3', type: 'tool_result', data: { content: long, isError: true } };
    const snapshot = snapshotPartsForEvent([part])!;
    const data = snapshot[0]!.data as { content: string; isError: boolean };
    expect(data.content).toHaveLength(DEFAULT_EVENT_PART_TEXT_LIMIT);
    expect(data.isError).toBe(true);
  });

  it('не мутирует вход (ни строку, ни объект части)', () => {
    const long = 'z'.repeat(DEFAULT_EVENT_PART_TEXT_LIMIT + 10);
    const text = textPart('p1', long);
    const toolResult: Part = { id: 'p2', type: 'tool_result', data: { content: long } };
    snapshotPartsForEvent([text, toolResult]);
    expect((text.data as string)).toHaveLength(DEFAULT_EVENT_PART_TEXT_LIMIT + 10);
    expect((toolResult.data as { content: string }).content).toHaveLength(
      DEFAULT_EVENT_PART_TEXT_LIMIT + 10,
    );
  });

  it('части без id/type пропускаются', () => {
    const broken: Part[] = [
      { id: '', type: 'text', data: 'пусто' },
      // Невалидный тип приходит извне (данные/старое сообщение) — снимок не падает.
      { id: 'p1', type: '' as Part['type'], data: 'пусто' },
      imagePart('p2'),
    ];
    const snapshot = snapshotPartsForEvent(broken)!;
    expect(snapshot.map((p) => p.id)).toEqual(['p2']);
  });
});
