import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SynthEvent } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { ContextConfig } from '../context/config.js';
import { eventToMessage } from '../events/request-session.js';
import { buildSchedulerNotice } from './notice.js';

const event = (overrides: Partial<SynthEvent> = {}): SynthEvent => ({
  id: 'evt_1',
  source: 'cron',
  type: 'schedule_fired',
  payload: { scheduleId: 'sch_1', name: 'Nightly', text: 'go' },
  identity: {},
  dedupKey: 'dedup-1',
  ts: new Date().toISOString(),
  ...overrides,
});

describe('buildSchedulerNotice (AD-051)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let contextConfig: ContextConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-scheduler-notice-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    contextConfig = new ContextConfig({ userDataDir: join(tmpDir, 'context') });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('подставляет {name} и берёт язык сессии (en)', async () => {
    const session = await sessionManager.createSession({ title: 'S', settings: { language: 'en' } });
    const notice = await buildSchedulerNotice(sessionManager, contextConfig, session.id, event());

    expect(notice).toBeDefined();
    expect(notice).toContain('Nightly');
    expect(notice).not.toContain('{name}');
    expect(notice).not.toContain('планировщик');
  });

  it('fallback на scheduleId, когда payload.name отсутствует', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const notice = await buildSchedulerNotice(
      sessionManager,
      contextConfig,
      session.id,
      event({ payload: { scheduleId: 'sch_42', text: 'x' } }),
    );

    expect(notice).toBeDefined();
    expect(notice).toContain('sch_42');
  });

  it('undefined для не-cron события', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const notice = await buildSchedulerNotice(
      sessionManager,
      contextConfig,
      session.id,
      event({ source: 'webhook' }),
    );
    expect(notice).toBeUndefined();
  });

  it('undefined, когда шаблон для языка сессии пуст (fr)', async () => {
    const session = await sessionManager.createSession({ title: 'S', settings: { language: 'fr' } });
    const notice = await buildSchedulerNotice(sessionManager, contextConfig, session.id, event());
    expect(notice).toBeUndefined();
  });

  it('язык по умолчанию — ru, если у сессии не задан', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const notice = await buildSchedulerNotice(sessionManager, contextConfig, session.id, event());
    expect(notice).toBeDefined();
    expect(notice).toContain('планировщик');
  });

  it('обрезает хвостовой перевод строки ассета: между notice и текстом ровно два \\n', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const e = event({ payload: { scheduleId: 'sch_1', name: 'Nightly', text: 'собери отчёт' } });
    const notice = await buildSchedulerNotice(sessionManager, contextConfig, session.id, e);

    expect(notice).toBeDefined();
    expect(notice).toBe(notice!.trimEnd());
    expect(notice!.endsWith('\n')).toBe(false);

    const msg = eventToMessage(e, { schedulerNotice: notice });
    expect(msg.content).toContain('\n\nсобери отчёт');
    expect(msg.content).not.toContain('\n\n\n');
  });
});
