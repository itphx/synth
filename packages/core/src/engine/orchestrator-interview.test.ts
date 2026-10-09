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
import { createToolRegistry } from './tools/index.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import type { ContextBuilder } from './context/builder.js';
import type { ContextConfig } from './context/config.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { AgentDefinition, Message, PlanMode, Session, SessionMode } from '@itphx/synth-shared';

/** Контекст доступности тулов, который call-site передаёт в `_interviewEligible`. */
interface InterviewToolAccess {
  agentDef: AgentDefinition | undefined;
  sessionMode: SessionMode;
  planMode: PlanMode;
  planApproved: boolean;
  workspaceReady: boolean;
}

interface OrchestratorPrivate {
  _interviewEligible(session: Session, message: Message | undefined, toolAccess: InterviewToolAccess): boolean;
  _schedulerCurrentTurn(session: Session, message?: Message): boolean;
}

function makeAgent(capabilities: string[]): AgentDefinition {
  return { id: 'test-agent', displayName: 'Test', capabilities: capabilities as AgentDefinition['capabilities'], enabled: true, isOverridden: false };
}

/** Доступность как в реальном ходе: тул `profile_update` открыт агенту. */
function access(agentDef: AgentDefinition = makeAgent(['user'])): InterviewToolAccess {
  return { agentDef, sessionMode: 'act', planMode: 'auto', planApproved: false, workspaceReady: true };
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
  return { id: 's1', messages, settings: {}, mode: 'act' } as unknown as Session;
}

describe('ChatOrchestrator — интервью и ход планировщика', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let orchestrator: ChatOrchestrator;
  let priv: OrchestratorPrivate;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-interview-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      contextConfig: {} as unknown as ContextConfig,
      defaultWorkingDir: tmpDir,
      toolRegistry: createToolRegistry(),
    });
    priv = orchestrator as unknown as OrchestratorPrivate;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('_interviewEligible', () => {
    it('первое user-сообщение, других разговорных нет → true', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([msg]), msg, access())).toBe(true);
    });

    it('есть другой разговорный ответ (assistant) → false', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      const assistant = makeMessage(MessageRole.ASSISTANT);
      expect(priv._interviewEligible(makeSession([msg, assistant]), msg, access())).toBe(false);
    });

    it('сообщение Scheduler (metadata.scheduler) → false', () => {
      const msg = makeMessage(MessageRole.USER, { scheduler: true });
      expect(priv._interviewEligible(makeSession([msg]), msg, access())).toBe(false);
    });

    it('сообщение от автора Scheduler → false', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'Scheduler' });
      expect(priv._interviewEligible(makeSession([msg]), msg, access())).toBe(false);
    });

    it('системные сообщения не считаются разговорными', () => {
      const sys = makeMessage(MessageRole.SYSTEM);
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([sys, msg]), msg, access())).toBe(true);
    });

    it('без message: ровно одно user-сообщение → true', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([msg]), undefined, access())).toBe(true);
    });

    it('без message: user + assistant → false', () => {
      const user = makeMessage(MessageRole.USER, { author: 'user' });
      const assistant = makeMessage(MessageRole.ASSISTANT);
      expect(priv._interviewEligible(makeSession([user, assistant]), undefined, access())).toBe(false);
    });

    it('без message: пустая история → false', () => {
      expect(priv._interviewEligible(makeSession([]), undefined, access())).toBe(false);
    });

    it('без message: единственное сообщение — Scheduler → false', () => {
      const msg = makeMessage(MessageRole.USER, { scheduler: true });
      expect(priv._interviewEligible(makeSession([msg]), undefined, access())).toBe(false);
    });

    it('агент с capability user → интервью true', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([msg]), msg, access(makeAgent(['user'])))).toBe(true);
    });

    it('агент без capability user → интервью false', () => {
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([msg]), msg, access(makeAgent(['file_read'])))).toBe(false);
    });

    it('capability user отключена админом (tools.disabled) → интервью false', () => {
      orchestrator.setToolsDisabled({ capabilities: ['user'], tools: [] });
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([msg]), msg, access())).toBe(false);
    });

    it('тул profile_update отключён по имени (tools.disabled) → интервью false', () => {
      orchestrator.setToolsDisabled({ capabilities: [], tools: ['profile_update'] });
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(priv._interviewEligible(makeSession([msg]), msg, access())).toBe(false);
    });

    it('без реестра инструментов → fail-closed (false)', () => {
      const noRegistry = new ChatOrchestrator({
        sessionManager,
        eventBus: new EventBus(),
        contextBuilder: makeCtxBuilder(),
        providerLoader: () => null,
        contextConfig: {} as unknown as ContextConfig,
        defaultWorkingDir: tmpDir,
      }) as unknown as OrchestratorPrivate;
      const msg = makeMessage(MessageRole.USER, { author: 'user' });
      expect(noRegistry._interviewEligible(makeSession([msg]), msg, access())).toBe(false);
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
