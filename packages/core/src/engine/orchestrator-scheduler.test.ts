/**
 * ADR-051: `_resolveSchedulerActive` — активность расписания для сессии: по
 * истории сообщений планировщика (`metadata.scheduler === true`) и по
 * late-bound резолверу `isSchedulerActive`. Проверяется косвенно через
 * `getPromptInfo` (манифест): при `true` в system-блоки попадает `scheduler`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import type { ContextBuilder } from './context/builder.js';
import type { ContextFileRepository } from '../storage/ports/context-file-repository.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message, Session } from '@itphx/synth-shared';
import { stubContextFiles } from '../test-helpers/storage-stubs.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(content: string, metadata?: Record<string, unknown>): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: metadata ?? {},
  };
}

const SCHEDULER_CONFIG: ContextFileRepository = stubContextFiles({
  getPlanGuide: () => '[PLAN GUIDE]',
  getModePolicy: () => '[MODE POLICY]',
  getClassificationInstructions: () => '[CLASSIFICATION]',
  getSchedulerNotice: () => '[SCHEDULER]',
  getSchedulerTurnNotice: () => '[SCHEDULER TURN]',
});

describe('ChatOrchestrator — schedulerActive (ADR-051)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-sched-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(
    isSchedulerActive?: (sessionId: string) => Promise<boolean>,
  ): ChatOrchestrator {
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      contextConfig: SCHEDULER_CONFIG,
      defaultWorkingDir: tmpDir,
      ...(isSchedulerActive ? { isSchedulerActive } : {}),
    });
  }

  async function createSession(): Promise<Session> {
    return sessionManager.createSession({ title: 'Sched', settings: { provider: 'x', model: 'm' } });
  }

  async function hasSchedulerBlock(
    orchestrator: ChatOrchestrator,
    sessionId: string,
  ): Promise<boolean> {
    const session = (await sessionManager.getSession(sessionId))!;
    const info = await orchestrator.getPromptInfo(session);
    return info.manifest.entries.some((entry) => entry.key === 'scheduler');
  }

  it('без резолвера и без сообщений Scheduler → блока нет', async () => {
    const session = await createSession();
    const orchestrator = makeOrchestrator();
    expect(await hasSchedulerBlock(orchestrator, session.id)).toBe(false);
  });

  it('история содержит metadata.scheduler → блок есть', async () => {
    const session = await createSession();
    await sessionManager.addMessage(session.id, makeUserMessage('job', { scheduler: true }));
    const orchestrator = makeOrchestrator();
    expect(await hasSchedulerBlock(orchestrator, session.id)).toBe(true);
  });

  it('резолвер isSchedulerActive=true → блок есть без сообщений', async () => {
    const session = await createSession();
    const orchestrator = makeOrchestrator(async (sessionId) => sessionId === session.id);
    expect(await hasSchedulerBlock(orchestrator, session.id)).toBe(true);
  });

  it('резолвер false и нет сообщений → блока нет', async () => {
    const session = await createSession();
    const orchestrator = makeOrchestrator(async () => false);
    expect(await hasSchedulerBlock(orchestrator, session.id)).toBe(false);
  });

  it('ошибка резолвера → неактивно (блока нет)', async () => {
    const session = await createSession();
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('boom');
    });
    expect(await hasSchedulerBlock(orchestrator, session.id)).toBe(false);
  });
});
