import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduleInput } from '@itphx/synth-shared';
import { ScheduleStore } from './schedule-store.js';

const input = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  name: 'Ночная проверка',
  enabled: true,
  every: '1h',
  target: { mode: 'bound', sessionId: 's1' },
  ...overrides,
});

describe('ScheduleStore (ADR-051 / ADR-089)', () => {
  let store: ScheduleStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-schedules-'));
    store = new ScheduleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('create генерирует sch_<uuid> и таймстемпы', async () => {
    const created = await store.create(input());
    expect(created.id).toMatch(/^sch_/);
    expect(created.name).toBe('Ночная проверка');
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBe(created.createdAt);
    expect(created.target).toEqual({ mode: 'bound', sessionId: 's1' });
  });

  it('get/list/remove — базовый CRUD', async () => {
    const created = await store.create(input());
    expect((await store.get(created.id))?.id).toBe(created.id);
    expect(await store.list()).toHaveLength(1);
    expect(await store.get('missing')).toBeNull();

    expect(await store.remove(created.id)).toBe(true);
    expect(await store.get(created.id)).toBeNull();
    expect(await store.remove(created.id)).toBe(false);
  });

  it('store пуст без файла (list → []), get → null', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.get('sch_x')).toBeNull();
  });

  it('hasEnabledTargetFor: включённое bound/queue → true; disabled/ephemeral/чужая сессия → false', async () => {
    await store.create(input({ target: { mode: 'bound', sessionId: 's1' } }));
    await store.create(input({ name: 'q', target: { mode: 'queue', sessionId: 's2' } }));
    await store.create(
      input({ name: 'd', enabled: false, target: { mode: 'bound', sessionId: 's3' } }),
    );
    await store.create(input({ name: 'e', target: { mode: 'ephemeral', agentTemplate: 't' } }));

    expect(await store.hasEnabledTargetFor('s1')).toBe(true);
    expect(await store.hasEnabledTargetFor('s2')).toBe(true);
    expect(await store.hasEnabledTargetFor('s3')).toBe(false);
    expect(await store.hasEnabledTargetFor('s4')).toBe(false);
  });

  it('hasEnabledTargetFor: пустой store → false', async () => {
    expect(await store.hasEnabledTargetFor('s1')).toBe(false);
  });

  it('update сливает патч и обновляет updatedAt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const created = await store.create(input());
    expect(created.updatedAt).toBe('2026-01-01T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
    const updated = await store.update(created.id, { enabled: false, name: 'Другое' });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe('Другое');
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.updatedAt).toBe('2026-01-01T00:05:00.000Z');

    expect(await store.update('sch_missing', { enabled: false })).toBeNull();
  });

  it('markRun фиксирует lastRunAt/status/error/nextRunAt', async () => {
    const created = await store.create(input());
    const marked = await store.markRun(created.id, {
      at: '2026-01-01T01:00:00.000Z',
      status: 'error',
      error: 'boom',
      nextRunAt: '2026-01-01T02:00:00.000Z',
    });
    expect(marked?.lastRunAt).toBe('2026-01-01T01:00:00.000Z');
    expect(marked?.lastStatus).toBe('error');
    expect(marked?.lastError).toBe('boom');
    expect(marked?.nextRunAt).toBe('2026-01-01T02:00:00.000Z');

    expect(await store.markRun('sch_missing', { at: 'x', status: 'ok' })).toBeNull();
  });

  it('markRun без error сбрасывает прежний lastError', async () => {
    const created = await store.create(input());
    await store.markRun(created.id, { at: 't1', status: 'error', error: 'boom' });
    const ok = await store.markRun(created.id, { at: 't2', status: 'ok' });
    expect(ok?.lastError).toBeUndefined();
    expect(ok?.lastStatus).toBe('ok');
  });

  it('setNextRun устанавливает и очищает nextRunAt', async () => {
    const created = await store.create(input());
    const set = await store.setNextRun(created.id, '2026-01-01T03:00:00.000Z');
    expect(set?.nextRunAt).toBe('2026-01-01T03:00:00.000Z');

    const cleared = await store.setNextRun(created.id, undefined);
    expect(cleared?.nextRunAt).toBeUndefined();

    expect(await store.setNextRun('sch_missing', 'x')).toBeNull();
  });

  it('персистит данные между инстансами', async () => {
    const created = await store.create(input());
    const reloaded = new ScheduleStore({ dataDir: tmpDir });
    expect((await reloaded.get(created.id))?.name).toBe('Ночная проверка');
  });

  it('отклоняет id с path traversal', async () => {
    await expect(store.update('../evil', { enabled: false })).rejects.toThrow('Недопустимый id');
    await expect(store.remove('a/b')).rejects.toThrow('Недопустимый id');
    await expect(store.markRun('a\\b', { at: 'x', status: 'ok' })).rejects.toThrow('Недопустимый id');
  });

  it('пишет файл атомарно: нет .tmp-файлов, JSON валиден', async () => {
    await store.create(input());
    const files = await readdir(tmpDir);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    expect(files).toContain('schedules.json');
    const raw = JSON.parse(await readFile(join(tmpDir, 'schedules.json'), 'utf-8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.schedules).toHaveLength(1);
  });

  it('параллельные create не теряют записи (per-file lock)', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.create(input({ name: `s${i}` }))));
    const all = await store.list();
    expect(all).toHaveLength(10);
    expect(new Set(all.map((s) => s.id)).size).toBe(10);
  });

  it('crossProcess: две реплики, конкурентные create не теряют записи (общий file-лок)', async () => {
    const a = new ScheduleStore({ dataDir: tmpDir, crossProcess: true });
    const b = new ScheduleStore({ dataDir: tmpDir, crossProcess: true });

    // Барьер конкуренции: обе реплики стартуют в одном тике, 10 create идут
    // одновременно; общий file-лок (`mkdir`-каталог) обязан сериализовать
    // read-modify-write каждой реплики.
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => a.create(input({ name: `a${i}` }))),
      ...Array.from({ length: 5 }, (_, i) => b.create(input({ name: `b${i}` }))),
    ]);

    // Наблюдаемое состояние — сам файл на диске (не только чтение через инстанс):
    // ровно 10 записей с уникальными id. `create` резолвится только после
    // durable-записи (write tmp → rename), поэтому «ждать видимости» не нужно.
    const raw = JSON.parse(await readFile(join(tmpDir, 'schedules.json'), 'utf-8')) as {
      schedules: Array<{ id: string }>;
    };
    expect(raw.schedules).toHaveLength(10);
    expect(new Set(raw.schedules.map((s) => s.id)).size).toBe(10);

    const all = await a.list();
    expect(all).toHaveLength(10);
    expect(new Set(all.map((s) => s.id)).size).toBe(10);

    // Лок освобождён: каталог-лок не «залип» после всех мутаций.
    await expect(stat(join(tmpDir, 'scheduler', 'schedules.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('crossProcess: конкурентные markRun сохраняют nextRunAt последнего (нет lost update файла)', async () => {
    const a = new ScheduleStore({ dataDir: tmpDir, crossProcess: true });
    const b = new ScheduleStore({ dataDir: tmpDir, crossProcess: true });
    const created = await a.create(input());

    await Promise.all([
      a.markRun(created.id, { at: 't1', status: 'ok', nextRunAt: '2026-01-01T01:00:00.000Z' }),
      b.setNextRun(created.id, '2026-01-01T02:00:00.000Z'),
    ]);

    // Оба поля сохранены: мутации сериализованы, последняя запись не потеряла чужие изменения.
    const reloaded = new ScheduleStore({ dataDir: tmpDir }).get(created.id);
    const schedule = await reloaded;
    expect(schedule?.nextRunAt).toBeDefined();
    expect(schedule?.lastStatus).toBe('ok');
  });
});
