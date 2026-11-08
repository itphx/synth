import { describe, it, expect, afterEach } from 'vitest';
import {
  TransferProgressRegistry,
  computeTransferPercent,
  emptyTransferProgress,
  sanitizeTransferError,
  transferProgressKey,
} from './transfer-progress.js';

const noSessions = { done: 0, total: 0 };
const noFiles = { done: 0, total: 0, bytesDone: 0, bytesTotal: 0 };

describe('computeTransferPercent', () => {
  it('обе фазы непусты: сессии 50 %, файлы 50 % по байтам', () => {
    // сессии 1/2 → 25, файлы 1/2 байт → 25 ⇒ 50
    expect(computeTransferPercent({
      sessions: { done: 1, total: 2 },
      files: { done: 1, total: 10, bytesDone: 50, bytesTotal: 100 },
    })).toBe(50);
    // сессии все, файлы половина байт ⇒ 50 + 25 = 75
    expect(computeTransferPercent({
      sessions: { done: 2, total: 2 },
      files: { done: 5, total: 10, bytesDone: 50, bytesTotal: 100 },
    })).toBe(75);
  });

  it('файлы считаются по байтам, а не по количеству', () => {
    // один маленький файл из двух, но 90 % байт уже залито
    expect(computeTransferPercent({
      sessions: noSessions,
      files: { done: 1, total: 2, bytesDone: 90, bytesTotal: 100 },
    })).toBe(90);
  });

  it('только сессии — 100 % веса', () => {
    expect(computeTransferPercent({
      sessions: { done: 1, total: 4 },
      files: noFiles,
    })).toBe(25);
  });

  it('только файлы — 100 % веса', () => {
    expect(computeTransferPercent({
      sessions: noSessions,
      files: { done: 1, total: 4, bytesDone: 25, bytesTotal: 100 },
    })).toBe(25);
  });

  it('пустой проект — 0 %', () => {
    expect(computeTransferPercent({ sessions: noSessions, files: noFiles })).toBe(0);
  });

  it('файлы нулевого размера — вес по количеству файлов', () => {
    // bytesTotal === 0 (все файлы пустые): считаем по done/total, иначе фаза
    // «файлы» навсегда осталась бы на 0 %.
    expect(computeTransferPercent({
      sessions: noSessions,
      files: { done: 1, total: 2, bytesDone: 0, bytesTotal: 0 },
    })).toBe(50);
  });

  it('монотонность: не опускается ниже предыдущего максимума', () => {
    // Расчёт по счётчикам дал бы 25, но прежний максимум 40 — остаётся 40.
    expect(computeTransferPercent({
      sessions: { done: 1, total: 4 },
      files: noFiles,
      percent: 40,
    })).toBe(40);
  });

  it('клампится в 0..100 и округляется до целого', () => {
    expect(computeTransferPercent({
      sessions: { done: 99, total: 10 },
      files: { done: 99, total: 10, bytesDone: 999, bytesTotal: 10 },
    })).toBe(100);
    expect(computeTransferPercent({
      sessions: { done: -5, total: 10 },
      files: noFiles,
      percent: -20,
    })).toBe(0);
    const value = computeTransferPercent({
      sessions: { done: 1, total: 3 },
      files: noFiles,
    });
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBe(33);
  });
});

describe('TransferProgressRegistry', () => {
  let registry: TransferProgressRegistry | undefined;

  afterEach(() => {
    registry?.clear();
    registry = undefined;
  });

  it('неизвестный ключ — idle по умолчанию', () => {
    registry = new TransferProgressRegistry();
    expect(registry.get(transferProgressKey('u1', 'p1'))).toEqual(emptyTransferProgress());
  });

  it('ключ включает userId: чужой пользователь не видит прогресс', () => {
    registry = new TransferProgressRegistry();
    registry.begin(transferProgressKey('u1', 'p1'));
    registry.update(transferProgressKey('u1', 'p1'), {
      phase: 'sessions',
      sessions: { done: 1, total: 2 },
    });

    const own = registry.get(transferProgressKey('u1', 'p1'));
    expect(own.active).toBe(true);
    expect(own.percent).toBe(50); // только сессии: 1/2 = 50 %

    const foreign = registry.get(transferProgressKey('u2', 'p1'));
    expect(foreign.active).toBe(false);
    expect(foreign.phase).toBe('idle');
    expect(foreign.percent).toBe(0);
  });

  it('begin → project/0, update пересчитывает процент монотонно, complete → done/100', () => {
    registry = new TransferProgressRegistry();
    const key = transferProgressKey('u1', 'p1');

    const started = registry.begin(key);
    expect(started).toMatchObject({ active: true, phase: 'project', percent: 0, error: null });
    expect(typeof started.startedAt).toBe('string');

    registry.update(key, {
      phase: 'sessions',
      sessions: { done: 0, total: 2 },
      files: { done: 0, total: 4, bytesDone: 0, bytesTotal: 100 },
    });
    expect(registry.get(key).percent).toBe(0);

    registry.update(key, { sessions: { done: 1, total: 2 } });
    const half = registry.get(key);
    expect(half.phase).toBe('sessions');
    expect(half.percent).toBe(25);

    registry.update(key, { phase: 'files', files: { done: 2, total: 4, bytesDone: 50, bytesTotal: 100 } });
    const files = registry.get(key);
    expect(files.percent).toBe(50);
    expect(files.files.bytesDone).toBe(50);

    const done = registry.complete(key);
    expect(done).toMatchObject({
      active: false,
      phase: 'done',
      percent: 100,
      sessions: { done: 2, total: 2 },
      files: { done: 4, total: 4, bytesDone: 100, bytesTotal: 100 },
      error: null,
    });
  });

  it('пустой проект: 0 % в процессе → 100 % на финише', () => {
    registry = new TransferProgressRegistry();
    const key = transferProgressKey('u1', 'empty');
    registry.begin(key);
    registry.update(key, {
      phase: 'sessions',
      sessions: { done: 0, total: 0 },
      files: { done: 0, total: 0, bytesDone: 0, bytesTotal: 0 },
    });
    expect(registry.get(key).percent).toBe(0);
    expect(registry.complete(key).percent).toBe(100);
  });

  it('fail: active:false, phase:error, краткий текст без стектрейса', () => {
    registry = new TransferProgressRegistry();
    const key = transferProgressKey('u1', 'p1');
    registry.begin(key);
    registry.update(key, { phase: 'sessions', sessions: { done: 1, total: 4 } });

    const failed = registry.fail(key, new Error('boom: сервер недоступен\n    at stack:1:2'));
    expect(failed.active).toBe(false);
    expect(failed.phase).toBe('error');
    expect(failed.error).toBe('boom: сервер недоступен');
    // Процент не откатывается назад.
    expect(failed.percent).toBe(registry.get(key).percent);
  });

  it('TTL: истёкшая запись становится idle (ленивая очистка)', () => {
    let now = 1_000_000;
    registry = new TransferProgressRegistry({ ttlMs: 1000, now: () => now });
    const key = transferProgressKey('u1', 'p1');

    registry.begin(key);
    expect(registry.get(key).active).toBe(true);
    expect(registry.size()).toBe(1);

    now += 999;
    expect(registry.get(key).active).toBe(true);

    now += 2;
    expect(registry.get(key)).toEqual(emptyTransferProgress());
    expect(registry.size()).toBe(0);
  });
});

describe('sanitizeTransferError', () => {
  it('оставляет первую строку и ограничивает длину', () => {
    expect(sanitizeTransferError('line1\nline2')).toBe('line1');
    expect(sanitizeTransferError(new Error('  spaced  '))).toBe('spaced');
    expect(sanitizeTransferError('')).toBe('Ошибка публикации');
    expect(sanitizeTransferError('x'.repeat(1000)).length).toBe(300);
  });
});
