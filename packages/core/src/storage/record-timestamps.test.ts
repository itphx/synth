import { describe, it, expect } from 'vitest';
import { resolveCreatedAt, resolveUpdatedAt } from './record-timestamps.js';

describe('record-timestamps (семантика upsert в слое хранения)', () => {
  it('createdAt: сохранённое значение приоритетно (создание иммутабельно)', () => {
    expect(resolveCreatedAt('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(resolveCreatedAt(undefined, '2026-06-01T00:00:00.000Z')).toBe('2026-06-01T00:00:00.000Z');
    // Ни сохранённого, ни входящего — «сейчас» (ISO-строка).
    expect(resolveCreatedAt(undefined, undefined)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('updatedAt: монотонно не убывает и всегда отличается от прежнего', () => {
    const stored = '2026-01-01T00:00:00.000Z';
    const next = resolveUpdatedAt(stored, stored);
    expect(next).not.toBe(stored);
    expect(Date.parse(next)).toBeGreaterThan(Date.parse(stored));
  });

  it('updatedAt: входящее значение «из будущего» сохраняется', () => {
    const future = '2999-01-01T00:00:00.000Z';
    expect(resolveUpdatedAt('2026-01-01T00:00:00.000Z', future)).toBe(future);
  });

  it('updatedAt: неразбираемое значение игнорируется (берется «сейчас»/сохранённое)', () => {
    const stored = '2026-01-01T00:00:00.000Z';
    const next = resolveUpdatedAt(stored, 'не-дата');
    expect(Date.parse(next)).toBeGreaterThan(Date.parse(stored));
  });
});
