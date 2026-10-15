import { describe, it, expect } from 'vitest';
import { nextCronDate, isValidCron } from './cron.js';

const at = (iso: string): Date => new Date(iso);

describe('nextCronDate (ADR-051)', () => {
  it('ежедневно в 00:00 UTC — строго после from', () => {
    expect(nextCronDate('0 0 * * *', at('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('шаг по минутам */15: секунды обнуляются', () => {
    expect(nextCronDate('*/15 * * * *', at('2026-01-01T10:07:30Z')).toISOString()).toBe(
      '2026-01-01T10:15:00.000Z',
    );
  });

  it('диапазон с шагом a-b/n', () => {
    expect(nextCronDate('0-30/10 * * * *', at('2026-01-01T10:00:00Z')).toISOString()).toBe(
      '2026-01-01T10:10:00.000Z',
    );
  });

  it('день недели 1-5 (будни): с пятницы — на понедельник', () => {
    expect(nextCronDate('0 9 * * 1-5', at('2026-01-02T10:00:00Z')).toISOString()).toBe(
      '2026-01-05T09:00:00.000Z',
    );
  });

  it('граница месяца: 31-е перескакивает через февраль', () => {
    expect(nextCronDate('0 0 31 * *', at('2026-01-31T01:00:00Z')).toISOString()).toBe(
      '2026-03-31T00:00:00.000Z',
    );
  });

  it('месяц как ограничение', () => {
    expect(nextCronDate('0 0 1 6 *', at('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('день недели: 0 и 7 — воскресенье', () => {
    expect(nextCronDate('0 12 * * 7', at('2026-01-02T00:00:00Z')).toISOString()).toBe(
      '2026-01-04T12:00:00.000Z',
    );
    expect(nextCronDate('0 12 * * 0', at('2026-01-02T00:00:00Z')).toISOString()).toBe(
      '2026-01-04T12:00:00.000Z',
    );
  });

  it('оба дня ограничены (dom и dow) — совпадение любого (Vixie)', () => {
    // 1-е число или понедельник; ближайший — понедельник 5 января.
    expect(nextCronDate('0 0 1 * 1', at('2026-01-02T00:00:00Z')).toISOString()).toBe(
      '2026-01-05T00:00:00.000Z',
    );
  });

  it('список значений a,b', () => {
    expect(nextCronDate('0 9,17 * * *', at('2026-01-01T10:00:00Z')).toISOString()).toBe(
      '2026-01-01T17:00:00.000Z',
    );
  });

  it('детерминизм: одинаковый вход → одинаковый выход', () => {
    const from = at('2026-03-04T05:06:07Z');
    const a = nextCronDate('*/5 6 * * *', from).toISOString();
    const b = nextCronDate('*/5 6 * * *', from).toISOString();
    expect(a).toBe(b);
  });

  it('невалидные выражения → Error', () => {
    for (const bad of ['bad', '* * * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '* * * * 8', '*/0 * * * *', '']) {
      expect(() => nextCronDate(bad, at('2026-01-01T00:00:00Z'))).toThrow();
    }
  });

  it('нет срабатывания в течение года → Error', () => {
    // 30 февраля не существует ни в одном году.
    expect(() => nextCronDate('0 0 30 2 *', at('2025-01-01T00:00:00Z'))).toThrow(/не найдено срабатывание/);
  });
});

describe('isValidCron (ADR-051)', () => {
  it('валидные', () => {
    for (const good of ['0 0 * * *', '*/15 9-17 * * 1-5', '0 0 1,15 * *', '0-30/10 * * * *']) {
      expect(isValidCron(good)).toBe(true);
    }
  });

  it('невалидные', () => {
    for (const bad of ['', 'bad', '* * * *', '60 * * * *', '0 0 * 13 *', '* * * * 8', '*/0 * * * *']) {
      expect(isValidCron(bad)).toBe(false);
    }
  });
});
