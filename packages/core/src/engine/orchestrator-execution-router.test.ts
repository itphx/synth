/**
 * PROP-135 (Ф4a): шов «профиль сессии → порт исполнения» в оркестраторе.
 *
 * Проверяется ровно одно: порт, который кладёт роутер, **доходит до
 * `ctx.extra.executionPort`** тула, а выбор порта сделан по профилю сессии
 * (`session.settings.executorProfile`).
 *
 * Harness — тот же приём, что в соседних тестах оркестратора: фейковый
 * провайдер (шаг 0 — вызов тула-зонда, шаг 1 — финальный текст) и
 * зарегистрированный тул, который запоминает контекст.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import type { ExecutionPort } from '../execution/ports/index.js';
import type { ExecutionRouter } from '../execution/router.js';
import {
  generateId,
  MessageRole,
  nowISO,
  makeTextPart,
  ToolCapability,
  type Message,
  type ToolContext,
  type ToolDefinition,
} from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

/** Порт-сентинел: опознаётся по объекту, а не по содержимому. */
function sentinelPort(name: string): ExecutionPort {
  return {
    execute: async () => ({
      stdout: name,
      stderr: '',
      exitCode: 0,
      truncated: false,
      durationMs: 0,
    }),
  };
}

/** Провайдер: шаг 0 — вызов тула-зонда, шаг 1 — финальный текст. */
class RouterScriptProvider extends BaseProvider {
  static calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (RouterScriptProvider.calls++ === 0) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'call_router_0',
            function: { name: 'probe_exec', arguments: JSON.stringify({}) },
          },
        ],
      };
    }
    return { content: 'Готово' };
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    return {
      content: next.content,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: next.toolCalls,
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: unknown,
    _tools?: Array<Record<string, unknown>>,
    _debugCollector?: unknown,
    _ct?: unknown,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    yield {
      content: next.content,
      isFinal: true,
      toolCalls: next.toolCalls,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'routerscript';
  }
}

/** Тул-зонд: запоминает порт исполнения из контекста вызова. */
function makeProbeTool(onCall: (ctx: ToolContext) => void): ToolDefinition {
  return {
    name: 'probe_exec',
    description: 'тул-зонд: запоминает порт исполнения из контекста',
    parameters: z.object({}).passthrough(),
    capabilities: [ToolCapability.RUNTIME],
    async execute(_args: unknown, ctx: ToolContext) {
      onCall(ctx);
      return { content: 'probe: ok' };
    },
  } as unknown as ToolDefinition;
}

function makeUserMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('выполни probe_exec')],
    content: 'выполни probe_exec',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  sessionId: string;
}

async function makeHarness(opts: {
  router?: ExecutionRouter;
  executorProfile?: string;
  projectId?: string;
  onToolCall: (ctx: ToolContext) => void;
}): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-exec-router-'));
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const toolRegistry = createToolRegistry();
  toolRegistry.register(makeProbeTool(opts.onToolCall));
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus: new EventBus(),
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) =>
      ({
        name,
        type: 'routerscript',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      }) as unknown as import('@itphx/synth-shared').ProviderConfig,
    toolRegistry,
    agentRegistry: createAgentRegistry(toolRegistry),
    defaultWorkingDir: tmpDir,
    ...(opts.router ? { executionRouter: opts.router } : {}),
  });
  const session = await sessionManager.createSession({
    title: 'Execution router',
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    settings: {
      provider: 'routerscript',
      model: 'm',
      systemPrompt: 'test',
      agentRole: 'fixer',
      ...(opts.executorProfile ? { executorProfile: opts.executorProfile } : {}),
    },
  });
  await sessionManager.addMessage(session.id, makeUserMessage());
  return { orchestrator, sessionManager, sessionId: session.id };
}

describe('PROP-135 Ф4a: порт роутера доходит до тула', () => {
  beforeEach(() => {
    ProviderFactory.register('routerscript', RouterScriptProvider);
    RouterScriptProvider.calls = 0;
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('routerscript');
  });

  it('порт из executionRouter.portFor попадает в ctx.extra.executionPort', async () => {
    const port = sentinelPort('profile-port');
    const requested: Array<string | undefined> = [];
    const router: ExecutionRouter = {
      portFor(target?: { profile?: string }) {
        requested.push(target?.profile);
        return port;
      },
    };

    let seen: ExecutionPort | undefined;
    const harness = await makeHarness({
      router,
      executorProfile: 'devops',
      onToolCall: (ctx) => {
        seen = (ctx.extra as { executionPort?: ExecutionPort }).executionPort;
      },
    });

    const fresh = (await harness.sessionManager.getSession(harness.sessionId))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
    await harness.orchestrator
      .createProcessMessage()(fresh, userMsg, new AbortController().signal, () => {});

    expect(seen).toBe(port);
    // Роутер спрошен по профилю сессии.
    expect(requested).toContain('devops');
  });
  it('без роутера порт тула — instance-порт оркестратора (прежнее поведение)', async () => {
    let seen: ExecutionPort | undefined;
    const harness = await makeHarness({
      onToolCall: (ctx) => {
        seen = (ctx.extra as { executionPort?: ExecutionPort }).executionPort;
      },
    });

    const fresh = (await harness.sessionManager.getSession(harness.sessionId))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
    await harness.orchestrator
      .createProcessMessage()(fresh, userMsg, new AbortController().signal, () => {});

    expect(seen).toBeDefined();
    // Inline-порт по умолчанию (инстанс без `execution.mode=remote`).
    expect(seen!.isRemote).toBe(false);
  });

  /**
   * PROP-135 Ф4b-1: роутер получает **область** цели (`projectId`/`sessionId`)
   * — по ней строится ключ пула (проектный/сессионный пул).
   */
  it('portFor получает projectId и sessionId цели (ключ пула)', async () => {
    const port = sentinelPort('pool-port');
    const targets: Array<{ profile?: string; projectId?: string; sessionId?: string }> = [];
    const router: ExecutionRouter = {
      portFor(target) {
        targets.push(target ?? {});
        return port;
      },
    };

    const harness = await makeHarness({
      router,
      executorProfile: 'devops',
      projectId: 'prj_router',
      onToolCall: () => {},
    });

    const fresh = (await harness.sessionManager.getSession(harness.sessionId))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
    await harness.orchestrator
      .createProcessMessage()(fresh, userMsg, new AbortController().signal, () => {});

    expect(targets.length).toBeGreaterThan(0);
    const last = targets[targets.length - 1]!;
    expect(last.profile).toBe('devops');
    expect(last.projectId).toBe('prj_router');
    expect(last.sessionId).toBe(harness.sessionId);
  });

  it('сессия без проекта → projectId не задан (фоллбэк решает роутер)', async () => {
    const port = sentinelPort('pool-port');
    const targets: Array<{ profile?: string; projectId?: string; sessionId?: string }> = [];
    const router: ExecutionRouter = {
      portFor(target) {
        targets.push(target ?? {});
        return port;
      },
    };

    const harness = await makeHarness({
      router,
      onToolCall: () => {},
    });

    const fresh = (await harness.sessionManager.getSession(harness.sessionId))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
    await harness.orchestrator
      .createProcessMessage()(fresh, userMsg, new AbortController().signal, () => {});

    const last = targets[targets.length - 1]!;
    expect(last.projectId).toBeUndefined();
    expect(last.sessionId).toBe(harness.sessionId);
  });
});
