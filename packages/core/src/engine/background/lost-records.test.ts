/**
 * PROP-143: durable-запись о фоновом прогоне, потерянном при рестарте
 * (`engine/background/lost-records.ts`).
 *
 * Проверяется:
 *   • запись причины остановки (`reason: 'restart'`) в историю
 *     **сессии-владельца** с метаданными прогона;
 *   • идемпотентность по ключу `background:<id прогона>`;
 *   • изоляция ошибок: сбой записи одного прогона не мешает остальным.
 *
 * Изолированно: файловый порт сессий в tmp-каталоге, шина событий без
 * подписчиков, без сети.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundRunRecord, Message } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { STOP_MESSAGE_TYPE } from '../stop-reason.js';
import { appendLostRunRecords } from './lost-records.js';

/** Запись реестра фоновых прогонов (только нужные поля). */
function makeRecord(overrides: Partial<BackgroundRunRecord> & { id: string; sessionId: string }): BackgroundRunRecord {
  return {
    kind: 'subagent',
    status: 'orphaned',
    summary: 'interrupted by restart',
    startedAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:05.000Z',
    finishedAt: '2026-11-18T10:00:05.000Z',
    ...overrides,
  };
}

describe('appendLostRunRecords (PROP-143)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-lost-records-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Записи остановки в истории сессии. */
  async function stopRecords(sessionId: string): Promise<Message[]> {
    const session = await sessionManager.getSession(sessionId);
    return (session?.messages ?? []).filter((m) => m.metadata?.type === STOP_MESSAGE_TYPE);
  }

  it('пишет durable-запись в сессию-владельца с метаданными прогона', async () => {
    const session = await sessionManager.createSession({ title: 'Owner' });
    const record = makeRecord({
      id: 'bgr_1',
      sessionId: session.id,
      kind: 'subagent',
      childSessionId: 'child-1',
      description: 'Проверка репозитория',
    });

    const written = await appendLostRunRecords({
      sessionManager,
      eventBus,
      records: [record],
    });

    expect(written).toBe(1);
    const records = await stopRecords(session.id);
    expect(records).toHaveLength(1);
    const entry = records[0]!;
    expect(entry.metadata?.reason).toBe('restart');
    expect(entry.metadata?.background_run_id).toBe('bgr_1');
    expect(entry.metadata?.background_run_kind).toBe('subagent');
    expect(entry.metadata?.child_session_id).toBe('child-1');
    expect(entry.metadata?.description).toBe('Проверка репозитория');
    // Ключ дедупликации — по id прогона.
    expect(entry.metadata?.dedupe_key).toBe('background:bgr_1');
    // Конверт — то, что видит модель.
    expect(entry.content).toContain('<execution_stopped');
    expect(entry.content).toContain('reason="restart"');
  });

  it('технический маркер рестарта в тело конверта не идёт — там локализованный текст причины', async () => {
    const session = await sessionManager.createSession({ title: 'Owner' });
    // `recoverOnStart` уже подменил summary на технический маркер.
    const record = makeRecord({
      id: 'bgr_restart',
      sessionId: session.id,
      summary: 'interrupted by restart',
    });

    const written = await appendLostRunRecords({
      sessionManager,
      eventBus,
      records: [record],
    });

    expect(written).toBe(1);
    const records = await stopRecords(session.id);
    expect(records).toHaveLength(1);
    const content = records[0]!.content;
    // Локализованный текст причины (`stop.restarted`) — по ADR-041.
    expect(content).toContain('Execution was interrupted by an instance restart');
    // Технический маркер в тело не попал.
    expect(content).not.toContain('interrupted by restart');
    // Причина в атрибуте конверта — как и раньше.
    expect(content).toContain('reason="restart"');
  });

  it('содержательный итог прогона попадает в тело конверта', async () => {
    const session = await sessionManager.createSession({ title: 'Owner' });
    const record = makeRecord({
      id: 'bgr_output',
      sessionId: session.id,
      kind: 'process',
      summary: 'FAILED: exit code 1\nnpm ERR! missing script: build',
    });

    const written = await appendLostRunRecords({
      sessionManager,
      eventBus,
      records: [record],
    });

    expect(written).toBe(1);
    const records = await stopRecords(session.id);
    expect(records).toHaveLength(1);
    const content = records[0]!.content;
    expect(content).toContain('npm ERR! missing script: build');
    expect(content).toContain('reason="restart"');
  });

  it('запись фонового процесса несёт команду и процесс', async () => {
    const session = await sessionManager.createSession({ title: 'Owner' });
    const record = makeRecord({
      id: 'bgr_2',
      sessionId: session.id,
      kind: 'process',
      command: 'npm test',
      processId: 'proc_1',
    });

    const written = await appendLostRunRecords({
      sessionManager,
      eventBus,
      records: [record],
    });

    expect(written).toBe(1);
    const records = await stopRecords(session.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.metadata?.background_run_kind).toBe('process');
    expect(records[0]!.metadata?.command).toBe('npm test');
    expect(records[0]!.metadata?.process_id).toBe('proc_1');
  });

  it('две записи — две durable-записи (в разных сессиях-владельцах)', async () => {
    const first = await sessionManager.createSession({ title: 'A' });
    const second = await sessionManager.createSession({ title: 'B' });

    const written = await appendLostRunRecords({
      sessionManager,
      eventBus,
      records: [
        makeRecord({ id: 'bgr_a', sessionId: first.id }),
        makeRecord({ id: 'bgr_b', sessionId: second.id }),
      ],
    });

    expect(written).toBe(2);
    expect(await stopRecords(first.id)).toHaveLength(1);
    expect(await stopRecords(second.id)).toHaveLength(1);
    expect((await stopRecords(first.id))[0]!.metadata?.background_run_id).toBe('bgr_a');
    expect((await stopRecords(second.id))[0]!.metadata?.background_run_id).toBe('bgr_b');
  });

  it('повтор по тому же прогону не дублирует запись', async () => {
    const session = await sessionManager.createSession({ title: 'Owner' });
    const record = makeRecord({ id: 'bgr_1', sessionId: session.id });

    const first = await appendLostRunRecords({ sessionManager, eventBus, records: [record] });
    const second = await appendLostRunRecords({ sessionManager, eventBus, records: [record] });

    expect(first).toBe(1);
    // Запись уже есть — второй раз не пишется (ключ `background:<id>`).
    expect(second).toBe(0);
    expect(await stopRecords(session.id)).toHaveLength(1);
  });

  it('ошибка записи одного прогона не мешает остальным', async () => {
    const session = await sessionManager.createSession({ title: 'Owner' });
    const inner = sessionManager;
    let failed = false;
    // Мок: первая запись падает на дозаписи в историю.
    const failing = {
      getSession: (id: string) => inner.getSession(id),
      addMessage: (id: string, message: Message) => {
        if (!failed) {
          failed = true;
          throw new Error('store unavailable');
        }
        return inner.addMessage(id, message);
      },
    } as unknown as SessionManager;

    const written = await appendLostRunRecords({
      sessionManager: failing,
      eventBus,
      records: [
        makeRecord({ id: 'bgr_bad', sessionId: session.id }),
        makeRecord({ id: 'bgr_good', sessionId: session.id }),
      ],
      logger: { warn: () => {} },
    });

    expect(written).toBe(1);
    const records = await stopRecords(session.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.metadata?.background_run_id).toBe('bgr_good');
  });

  it('без логгера ошибка записи не роняет вызов', async () => {
    const session = await sessionManager.createSession({ title: 'Owner' });
    const failing = {
      getSession: async () => {
        throw new Error('store unavailable');
      },
      addMessage: async () => {
        throw new Error('store unavailable');
      },
    } as unknown as SessionManager;

    const written = await appendLostRunRecords({
      sessionManager: failing,
      eventBus,
      records: [makeRecord({ id: 'bgr_bad', sessionId: session.id })],
    });

    expect(written).toBe(0);
  });
});
