/**
 * Онбординг-интервью и ход планировщика: приватные хелперы оркестратора
 * `_interviewEligible` / `_schedulerCurrentTurn`.
 *
 * `_interviewEligible` — интервью показывается только в первом ходе сессии от
 * пользователя (не Scheduler/системное). `_schedulerCurrentTurn` — текущий ход
 * инициирован планировщиком (`metadata.scheduler === true`).
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
import type { ContextConfig } from './context/config.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message, Session } from '@itphx/synth-shared';

interface OrchestratorPrivate {
  _interviewEligible(session: Session, message?: Message): boolean;
  _schedulerCurrentTurn(session: Session, message?: Message): boolean;
}

function makeCtxBuilder(): ContextBuilder {
  return {
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeMessage(
  role: MessageRole,
  opts: { author?: string; scheduler?: boolean } = {},
): Message {
  const metadata: Record<string, unknown> = {};
  if (opts.scheduler) metadata.scheduler = true;
  return {
    id: generateId(),
    role,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('text')],
    content: 'text',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...(opts.author ? { author: opts.author } : {}),
    metadata,
  };
}

function makeSession(messages: Message[]): Session {
  return { id: 's1', messages } as unknown as Session;
}

describe('ChatOrchestrator — интервью и ход планировщика', () => {
  let tmpDir: string;
  let orchestrator: ChatOrchestrator;
  let priv: OrchestratorPrivate;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-interview-'));
    const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      contextConfig: {} as unknown as ContextConfig,
      defaultWorkingDir: tmpDir,
    });
    priv = orchestrator as unknown as OrchestratorPrivate;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('_interviewEligible', () => {
    it('первое user-сообщение, других разговорных нет → true', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([msg]), msg)).toBe(true);
    });

    it('есть другой разговорный ответ (assistant) → false', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      const assistant = makeMessage(MessageRole.ASSISTANT);
      expect(priv._interviewEligible(makeSession([msg, assistant]), msg)).toBe(false);
    });

    it('сообщение Scheduler (metadata.scheduler) → false', () => {
      const msg = makeMessage(MessageRole.USER, { scheduler: true });
      expect(priv._interviewEligible(makeSession([msg]), msg)).toBe(false);
    });

    it('сообщение от автора Scheduler → false', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'Scheduler' });
      expect(priv._interviewEligible(makeSession([msg]), msg)).toBe(false);
    });

    it('системные сообщения не считаются разговорными', () => {
      const sys = makeMessage(MessageRole.SYSTEM);
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([sys, msg]), msg)).toBe(true);
    });

    it('без message: ровно одно user-сообщение → true', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([msg]))).toBe(true);
    });

    it('без message: user + assistant → false', () => {
      const user = makeMessage(MessageRole.USER, { author: 'user' });
      const assistant = makeMessage(MessageRole.ASSISTANT);
      expect(priv._interviewEligible(makeSession([user, assistant]))).toBe(false);
    });

    it('без message: пустая история → false', () => {
      expect(priv._interviewEligible(makeSession([]))).toBe(false);
    });

    it('без message: единственное сообщение — Scheduler → false', () => {
      const msg = makeMessage(MessageRole.USER, { scheduler: true });
      expect(priv._interviewEligible(makeSession([msg]))).toBe(false);
    });
  });

  describe('_schedulerCurrentTurn', () => {
    it('message.metadata.scheduler === true → true', () => {
      const msg = makeMessage(MessageRole.USER, { scheduler: true });
      expect(priv._schedulerCurrentTurn(makeSession([msg]), msg)).toBe(true);
    });

    it('message без метки планировщика → false', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._schedulerCurrentTurn(makeSession([msg]), msg)).toBe(false);
    });

    it('без message: последнее разговорное — Scheduler → true', () => {
      const msg = makeMessage(MessageRole.USER, { scheduler: true });
      expect(priv._schedulerCurrentTurn(makeSession([msg]))).toBe(true);
    });

    it('без message: последнее разговорное — assistant → false', () => {
      const sched = makeMessage(MessageRole.USER, { scheduler: true });
      const assistant = makeMessage(MessageRole.ASSISTANT);
      expect(priv._schedulerCurrentTurn(makeSession([sched, assistant]))).toBe(false);
    });

    it('без message: разговорных нет → false', () => {
      expect(priv._schedulerCurrentTurn(makeSession([makeMessage(MessageRole.SYSTEM)]))).toBe(false);
    });
  });
});
