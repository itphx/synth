/**
 * Тесты `task/run-cycle.ts` (ADR-095, шаг 5) — общего цикла саб-агента.
 *
 * Покрыты контракты, на которые опираются фасады `task`/`task-resume`:
 *   • разрешение retry-параметров (config.retry > extra.retry > единая политика);
 *   • цикл Tool Use: исполнение тулов, публикация событий, запись истории ребёнка;
 *   • doom-loop защита (MAX_DOOM_LOOP_COUNT);
 *   • permission-слой саб-агента: deny / ask-approved / ask-denied;
 *   • quality check и эскалация на fallback-модель (ADR-034);
 *   • hooks agent_completed/agent_failed (ADR-030);
 *   • отмена по abortSignal, лимит шагов, обработка ошибок провайдера.
 *
 * Изолированно: фейковые провайдеры/реестры, реальный SessionManager в
 * tmp-каталоге; без сети и LLM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MessageRole, generateId, nowISO, makeTextPart, MAX_STEER_INJECTIONS_PER_TURN } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult, TokenUsage, Message } from '@itphx/synth-shared';
import type { BaseProvider, LLMMessage, SystemPromptInput } from '../../../providers/base.js';
import type { AgentRegistry } from '../../agents/registry.js';
import type { ModelRouter } from '../../router/router.js';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { EventBus } from '../../../events/bus.js';
import { HookBus } from '../../hooks/hook-bus.js';
import { ToolRegistry } from '../registry.js';
import { LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS, MAX_DOOM_LOOP_COUNT } from '../../llm-error.js';
import { stubContextFiles } from '../../../test-helpers/storage-stubs.js';
import { runSubagent, SUBAGENT_MAX_ATTEMPTS, SUBAGENT_RETRY_DELAYS_MS, type SubagentRunConfig } from './run-cycle.js';
import type { TaskExtra } from './types.js';

interface Chunk {
  isFinal: boolean;
  content: string;
  toolCalls?: unknown[];
  usage?: TokenUsage;
  model?: string;
  reasoning?: string;
}

function userMessage(content: string): LLMMessage {
  return {
    id: '', role: 'user', content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false, pinned: false, branchId: '',
  };
}

function toolCallChunk(name: string, args: Record<string, unknown> = {}, id = 'c1'): Chunk {
  return {
    isFinal: true,
    content: '',
    toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** Провайдер с пошаговым сценарием: script[i] — чанки i-го вызова (последний повторяется). */
function scriptedProvider(script: Chunk[][]) {
  let calls = 0;
  // Снимок сообщений на момент вызова: массив `messages` в цикле мутируется
  // дальше (инъекции дописываются в него), поэтому смотреть нужно копию.
  const snapshots: LLMMessage[][] = [];
  const chatAsync = vi.fn((
    messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
  ) => {
    const idx = Math.min(calls, script.length - 1);
    calls += 1;
    snapshots.push(messages.map((m) => ({ ...m })));
    return (async function* () {
      for (const c of script[idx]!) yield c;
    })();
  });
  const provider = { model: 'test-model', name: 'test-provider', chatAsync } as unknown as BaseProvider;
  return { provider, calls: () => calls, chatAsync, snapshots };
}

/** Провайдер, бросающий ошибку (после опциональной прелюдии чанков). */
function throwingProvider(error: Error, prelude: Chunk[] = []) {
  const chatAsync = vi.fn(() => (async function* () {
    for (const c of prelude) yield c;
    throw error;
  })());
  return { model: 'm', name: 'p', chatAsync } as unknown as BaseProvider;
}

function makeAgentRegistry(): AgentRegistry {
  return {
    get: (id: string) => ({ id, agentMode: ['subagent'], subagentPrompt: 'SYS', capabilities: [] }),
    getSubagents: () => [],
    getToolsForAgent: () => [],
  } as unknown as AgentRegistry;
}

function makeRegistry(spec: Record<string, () => ToolResult | Promise<ToolResult>>): { registry: ToolRegistry; counters: Record<string, number> } {
  const registry = new ToolRegistry();
  const counters: Record<string, number> = {};
  for (const [name, exec] of Object.entries(spec)) {
    registry.register({
      name,
      description: name,
      parameters: z.object({}).passthrough(),
      capabilities: [],
      execute: async () => {
        counters[name] = (counters[name] ?? 0) + 1;
        return exec();
      },
    } as unknown as ToolDefinition);
  }
  return { registry, counters };
}

let tmpDir: string;
let sessionManager: SessionManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-runcycle-'));
  sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'parent-1',
    messageId: 'm1',
    abortSignal: new AbortController().signal,
    workingDir: tmpDir,
    ...over,
  };
}

function makeExtra(over: Record<string, unknown>): TaskExtra {
  return {
    agentRegistry: makeAgentRegistry(),
    ...over,
  } as unknown as TaskExtra;
}

function makeConfig(over: Partial<SubagentRunConfig> & { extra: TaskExtra }): SubagentRunConfig {
  return {
    subagentType: 'explore',
    description: 'do it',
    contextMode: 'none',
    maxSteps: 5,
    llmSystemPrompt: 'SYS',
    initialMessages: [userMessage('hello')],
    provider: over.extra.provider,
    parentSessionId: 'parent-1',
    ctx: makeCtx(),
    ...over,
  } as SubagentRunConfig;
}

describe('run-cycle — единая политика retry и doom-loop (константы)', () => {
  it('SUBAGENT_MAX_ATTEMPTS/DELAYS совпадают с LLM-политией (не разъезжаются)', () => {
    expect(SUBAGENT_MAX_ATTEMPTS).toBe(LLM_MAX_ATTEMPTS);
    expect(SUBAGENT_RETRY_DELAYS_MS).toEqual(LLM_RETRY_DELAYS_MS);
    expect(MAX_DOOM_LOOP_COUNT).toBe(3);
  });
});

describe('run-cycle — успешное завершение без дочерней сессии', () => {
  it('финальный ответ без tool calls: результат и metadata', async () => {
    const { provider, calls } = scriptedProvider([[{ isFinal: true, content: 'final answer', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, model: 'test-model' }]]);

    const result = await runSubagent(makeConfig({ extra: makeExtra({ provider }) }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<task_result>');
    expect(result.content).toContain('final answer');
    expect(result.metadata).toMatchObject({
      subagent_type: 'explore',
      description: 'do it',
      context_mode: 'none',
      steps: 0,
      final_content: 'final answer',
      subagent_model: 'test-model',
    });
    expect(result.metadata!.child_session_id).toBeUndefined();
    expect((result.metadata!.subagent_usage as TokenUsage).inputTokens).toBe(10);
    expect(calls()).toBe(1);
  });

  it('пустой финальный ответ → понятный текст task.empty_response', async () => {
    const { provider } = scriptedProvider([[{ isFinal: true, content: '' }]]);
    const result = await runSubagent(makeConfig({ extra: makeExtra({ provider }) }));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('empty subagent response');
  });

  it('сохраняет финальный ответ и usage в дочернюю сессию', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { provider } = scriptedProvider([[{
      isFinal: true, content: 'child answer', model: 'test-model',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    }]]);

    const result = await runSubagent(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parent.id }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    const saved = (await sessionManager.getSession(child.id))!;
    const assistant = saved.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.content).toBe('child answer');
    expect((assistant.usage as TokenUsage).inputTokens).toBe(7);
    expect(result.metadata!.child_session_id).toBe(child.id);
    // Локальный cancel-токен не связан с abortSignal — ничего не отменено.
    expect(result.metadata!.interrupted).toBeUndefined();
  });
});

describe('run-cycle — цикл Tool Use', () => {
  it('исполняет тул, публикует события и пишет tool-chain в дочернюю сессию', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { provider, calls } = scriptedProvider([
      [toolCallChunk('noop', { x: 1 })],
      [{ isFinal: true, content: 'done' }],
    ]);
    const { registry, counters } = makeRegistry({ noop: () => ({ content: 'noop ok' }) });
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider,
        sessionManager,
        sessionId: parent.id,
        toolRegistry: registry,
        callId: 'call-1',
        publish: (type: string, data: Record<string, unknown>) => published.push({ type, data }),
      }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    expect(counters.noop).toBe(1);
    expect(calls()).toBe(2);
    expect(result.content).toContain('done');

    // Порядок/состав событий цикла и вложенность под parent_call_id.
    const started = published.find((p) => p.type === 'tool_call.started')!;
    expect(started.data.name).toBe('noop');
    expect(started.data.parent_call_id).toBe('call-1');
    expect(started.data.arguments).toEqual({ x: 1 });
    const toolResult = published.find((p) => p.type === 'tool_call.result')!;
    expect((toolResult.data.result as ToolResult).content).toBe('noop ok');
    expect(published.some((p) => p.type === 'tool_call.loop')).toBe(true);

    // История дочерней сессии: assistant(tool_chain) → tool → финал.
    const saved = (await sessionManager.getSession(child.id))!;
    const toolMsg = saved.messages.find((m) => m.role === MessageRole.TOOL)!;
    expect(toolMsg.content).toBe('noop ok');
    expect(toolMsg.metadata!.tool_name).toBe('noop');
    expect(saved.messages.find((m) => m.role === MessageRole.ASSISTANT && m.metadata?.tool_chain === true)).toBeDefined();

    // metadata результата несёт свёрнутую цепочку тулов.
    const toolCalls = result.metadata!.tool_calls as Array<{ name: string; args: Record<string, unknown> }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe('noop');
    expect(toolCalls[0]!.args).toEqual({ x: 1 });
  });

  it('doom-loop: одинаковый вызов MAX_DOOM_LOOP_COUNT раз блокируется без исполнения', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    // Четыре вызова: 3 одинаковых tool_call подряд → на третьем срабатывает doom,
    // четвёртый — финальный ответ.
    const { provider } = scriptedProvider([
      [toolCallChunk('noop')],
      [toolCallChunk('noop')],
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'done' }],
    ]);
    const { registry, counters } = makeRegistry({ noop: () => ({ content: 'ok' }) });
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider, sessionManager, sessionId: parent.id, toolRegistry: registry,
        publish: (type: string, data: Record<string, unknown>) => published.push({ type, data }),
      }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    // Первые MAX_DOOM_LOOP_COUNT-1 вызовов исполнились, третий — заблокирован.
    expect(counters.noop).toBe(MAX_DOOM_LOOP_COUNT - 1);
    expect(published.filter((p) => p.type === 'tool_call.started' && p.data.name === 'noop')).toHaveLength(2);

    const saved = (await sessionManager.getSession(child.id))!;
    const doom = saved.messages.find((m) => m.role === MessageRole.TOOL && m.content.includes('called 3 time'));
    expect(doom).toBeDefined();
    expect(result.content).toContain('done');
    expect(result.metadata!.tool_calls).toHaveLength(2);
  });

  it('неизвестный тул → tool.not_found, цикл не падает', async () => {
    const { provider } = scriptedProvider([
      [toolCallChunk('ghost_tool')],
      [{ isFinal: true, content: 'done' }],
    ]);
    const { registry } = makeRegistry({});

    const result = await runSubagent(makeConfig({
      extra: makeExtra({ provider, toolRegistry: registry }),
    }));

    expect(result.isError).toBeFalsy();
    const toolCalls = result.metadata!.tool_calls as Array<{ result: { content: string; isError?: boolean } }>;
    expect(toolCalls[0]!.result.isError).toBe(true);
    expect(toolCalls[0]!.result.content).toContain('ghost_tool');
  });

  it('maxSteps=1: принудительный финальный шаг-отчёт (без инструментов) + маркер steps_limit', async () => {
    // Провайдер на первом шаге просит тул (лимит шагов не даёт бесконечного
    // цикла), на втором — отвечает текстом: это финальный шаг-отчёт.
    const { provider, calls, chatAsync } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'ОТЧЁТ: сделано 1 из 3, осталось доделать' }],
    ]);
    const { registry, counters } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    const result = await runSubagent(makeConfig({
      maxSteps: 1,
      extra: makeExtra({ provider, toolRegistry: registry }),
    }));

    expect(counters.noop).toBe(1);
    // Два вызова LLM: основной шаг + шаг-отчёт.
    expect(calls()).toBe(2);
    // Шаг-отчёт — «только текст»: инструменты не передаются.
    expect(chatAsync.mock.calls[1]![2]).toBeUndefined();
    expect(result.content).toContain('ОТЧЁТ: сделано 1 из 3');
    expect(result.content).toContain('[steps_limit]');
    expect(result.metadata!.step_limit_reached).toBe(true);
    expect(result.metadata!.steps).toBe(1);
    expect(result.metadata!.final_content).toContain('ОТЧЁТ: сделано 1 из 3');
  });

  it('шаг-отчёт: требование «только текст» подставляется в системный промпт', async () => {
    const { provider, chatAsync } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'отчёт' }],
    ]);
    const { registry } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    await runSubagent(makeConfig({
      maxSteps: 1,
      extra: makeExtra({
        provider,
        toolRegistry: registry,
        contextConfig: stubContextFiles({
          getMaxStepsPrompt: () => 'ЛИМИТ ШАГОВ ({limit}) — ТОЛЬКО ТЕКСТ',
        }),
      }),
    }));

    const reportSystemPrompt = chatAsync.mock.calls[1]![1] as string;
    expect(reportSystemPrompt).toContain('ЛИМИТ ШАГОВ (1) — ТОЛЬКО ТЕКСТ');
    expect(reportSystemPrompt).toContain('SYS');
  });

  it('maxSteps=1: toolCall на шаге-отчёте не исполняется, цикл не падает', async () => {
    // Модель проигнорировала требование и снова попросила инструмент —
    // вызов не исполняется, результат — маркер «шаги исчерпаны».
    const { provider, calls } = scriptedProvider([
      [toolCallChunk('noop')],
      [toolCallChunk('noop')],
    ]);
    const { registry, counters } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    const result = await runSubagent(makeConfig({
      maxSteps: 1,
      extra: makeExtra({ provider, toolRegistry: registry }),
    }));

    expect(counters.noop).toBe(1);
    expect(calls()).toBe(2);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('exhausted the step limit (1)');
    expect(result.metadata!.step_limit_reached).toBe(true);
  });
});

describe('run-cycle — permission-слой саб-агента (ADR-029)', () => {
  it('deny: тул не исполняется, deny-результат возвращается модели и уходит в metadata', async () => {
    const { provider, calls } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'done' }],
    ]);
    const { registry, counters } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider,
        toolRegistry: registry,
        permissionConfig: { rules: { noop: 'deny' }, askTimeoutMs: 500 },
      }),
    }));

    expect(counters.noop).toBeUndefined();
    expect(calls()).toBe(2);
    const toolCalls = result.metadata!.tool_calls as Array<{ result: { content: string; isError?: boolean } }>;
    expect(toolCalls[0]!.result.isError).toBe(true);
    expect(toolCalls[0]!.result.content).toContain('Permission denied');
    expect(result.content).toContain('done');
  });

  it('ask approved (once=false): тул исполняется, allow-правило записывается в дочернюю сессию', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const bus = new EventBus();
    // Подписчик «UI»: отвечает на permission.asked в родительской сессии.
    bus.subscribe(parent.id, (e) => {
      if (e.type === 'permission.asked') {
        bus.publish(parent.id, 'permission.replied', {
          approval_id: (e.data as Record<string, unknown>).approval_id,
          action: 'allow',
          once: false,
        });
      }
    });
    const { provider } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'done' }],
    ]);
    const { registry, counters } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider, eventBus: bus, sessionManager, sessionId: parent.id, toolRegistry: registry,
        permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 },
      }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    expect(counters.noop).toBe(1);
    expect(result.content).toContain('done');
    const saved = (await sessionManager.getSession(child.id))!;
    expect(saved.settings.permission!.rules.noop).toBe('allow');
  });

  it('ask denied пользователем: тул не исполняется, цикл прерывается stopped_by_deny', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const bus = new EventBus();
    bus.subscribe(parent.id, (e) => {
      if (e.type === 'permission.asked') {
        bus.publish(parent.id, 'permission.replied', {
          approval_id: (e.data as Record<string, unknown>).approval_id,
          action: 'deny',
        });
      }
    });
    const { provider, calls } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'should not happen' }],
    ]);
    const { registry, counters } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider, eventBus: bus, sessionManager, sessionId: parent.id, toolRegistry: registry,
        permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 },
      }),
      parentSessionId: parent.id,
    }));

    expect(counters.noop).toBeUndefined();
    // Вторая LLM-итерация не запускается — отказ прерывает цикл.
    expect(calls()).toBe(1);
    expect(result.content).toContain('the user denied the tool execution request');
  });

  it('ask без подписчиков: отказ без прерывания цикла (subagentUserDenied=false)', async () => {
    const bus = new EventBus(); // ни одного подписчика
    const { provider, calls } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'done' }],
    ]);
    const { registry, counters } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider, eventBus: bus, toolRegistry: registry, sessionId: 'parent-1',
        permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 500 },
      }),
    }));

    expect(counters.noop).toBeUndefined();
    expect(calls()).toBe(2);
    expect(result.content).toContain('done');
  });
});

describe('run-cycle — quality check и эскалация (ADR-034)', () => {
  function makeModelRouter(over: {
    checkQuality: (content: string) => { pass: boolean; reason: string };
    fallback?: BaseProvider | null;
  }): ModelRouter {
    return {
      checkQuality: vi.fn(async (content: string) => over.checkQuality(content)),
      getProvider: vi.fn(() => over.fallback ?? null),
    } as unknown as ModelRouter;
  }

  it('QA pass: контент не меняется, quality-блок с pass=true', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { provider } = scriptedProvider([[{ isFinal: true, content: 'draft answer' }]]);
    const modelRouter = makeModelRouter({ checkQuality: () => ({ pass: true, reason: 'ok' }) });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider, sessionManager, sessionId: parent.id, modelRouter,
        routerConfig: { escalation: { enabled: true } },
      }),
      childSessionId: child.id,
      parentSessionId: parent.id,
      routingDecisionInfo: { providerName: 'p', modelName: 'm', strategy: 'content' },
    }));

    expect(result.metadata!.qa_pass).toBe(true);
    expect(result.content).toContain('draft answer');
    expect(result.content).toContain('<quality pass="true"');
    // QC-поля проставляются на последнем assistant-сообщении ребёнка и
    // персистятся (FileStore), поэтому бейдж качества переживает перезагрузку.
    const childMsg = (await sessionManager.getSession(child.id))!.messages
      .filter((m) => m.role === MessageRole.ASSISTANT).at(-1);
    expect(childMsg?.qa_pass).toBe(true);
    expect(childMsg?.qa_reason).toBe('ok');
  });

  it('QA fail + fallback-модель: ответ эскалируется, routing_strategy=escalation_fallback', async () => {
    const fallbackProvider = {
      model: 'fb-model',
      name: 'fb-prov',
      chat: vi.fn(async () => ({ content: 'escalated answer', model: 'fb-model', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })),
    } as unknown as BaseProvider;
    const { provider } = scriptedProvider([[{ isFinal: true, content: 'draft answer' }]]);
    const modelRouter = makeModelRouter({ checkQuality: () => ({ pass: false, reason: 'too short' }), fallback: fallbackProvider });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider, modelRouter,
        routerConfig: { escalation: { enabled: true, fallbackProvider: 'fb-prov', fallbackModel: 'fb-model' } },
      }),
      routingDecisionInfo: { providerName: 'p', modelName: 'm', strategy: 'content' },
    }));

    expect(result.content).toContain('escalated answer');
    expect(result.content).toContain('<quality pass="true"');
    expect(result.metadata!.routing_strategy).toBe('escalation_fallback');
    expect(result.metadata!.routing_provider).toBe('fb-prov');
    expect(result.metadata!.routing_model).toBe('fb-model');
  });

  it('QA fail без fallback: ответ сохраняется + предупреждение в контенте', async () => {
    const { provider } = scriptedProvider([[{ isFinal: true, content: 'draft answer' }]]);
    const modelRouter = makeModelRouter({ checkQuality: () => ({ pass: false, reason: 'too short' }) });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider, modelRouter,
        routerConfig: { escalation: { enabled: true } },
      }),
      routingDecisionInfo: { providerName: 'p', modelName: 'm', strategy: 'content' },
    }));

    expect(result.metadata!.qa_pass).toBe(false);
    expect(result.content).toContain('draft answer');
    expect(result.content).toContain('failed the quality check');
  });

  it('escalation выключена: checkQuality не вызывается', async () => {
    const { provider } = scriptedProvider([[{ isFinal: true, content: 'draft' }]]);
    const checkQuality = vi.fn(async () => ({ pass: false, reason: 'x' }));
    const modelRouter = { checkQuality, getProvider: vi.fn() } as unknown as ModelRouter;

    const result = await runSubagent(makeConfig({
      extra: makeExtra({
        provider, modelRouter,
        routerConfig: { escalation: { enabled: false } },
      }),
      routingDecisionInfo: { providerName: 'p', modelName: 'm', strategy: 'content' },
    }));

    expect(checkQuality).not.toHaveBeenCalled();
    expect(result.metadata!.qa_pass).toBeUndefined();
  });
});

describe('run-cycle — hooks (ADR-030)', () => {
  it('успех: agent_completed с итоговым ответом', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const hooks = new HookBus();
    const completed = vi.fn();
    hooks.on('agent_completed', completed, { mode: 'async' });
    const { provider } = scriptedProvider([[{ isFinal: true, content: 'done' }]]);

    await runSubagent(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parent.id, hooks }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(completed.mock.calls[0]![0]).toMatchObject({ agentId: child.id, result: 'done' });
  });

  it('фатальная ошибка провайдера: agent_failed + isError-результат', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const hooks = new HookBus();
    const failed = vi.fn();
    hooks.on('agent_failed', failed, { mode: 'async' });
    const provider = throwingProvider(new Error('401 Unauthorized: invalid api key'));

    const result = await runSubagent(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parent.id, hooks }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    expect(result.isError).toBe(true);
    expect(result.metadata!.attempts).toBe(1);
    expect(result.metadata!.error_type).toBe('auth_error');
    expect(result.content).toContain('<status>error</status>');

    const saved = (await sessionManager.getSession(child.id))!;
    expect(saved.messages.some((m) => m.role === MessageRole.ERROR)).toBe(true);

    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(failed.mock.calls[0]![0]).toMatchObject({ agentId: child.id });
  });
});

describe('run-cycle — steering дочерней сессии (ADR-104)', () => {
  /** Сообщение-инъекция в очередь ребёнка (`steerInbox`). */
  function steerMessage(content: string, metadata?: Record<string, unknown>): Message {
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
      metadata: { steer: true, ...(metadata ?? {}) },
    };
  }

  it('инъекция в очередь ребёнка попадает в LLM-контекст следующего шага и в историю', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { provider, snapshots } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'done' }],
    ]);
    // Пользователь вмешивается в ход ребёнка, пока тот выполняет инструмент.
    const { registry } = makeRegistry({
      noop: async () => {
        await sessionManager.enqueueSteerMessage(child.id, steerMessage('ищи в другом месте'));
        return { content: 'noop ok' };
      },
    });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parent.id, toolRegistry: registry }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('done');

    // Инъекция пришла после первого шага — в первый LLM-вызов она не попала.
    const firstCall = snapshots[0]!;
    expect(firstCall.some((m) => m.content === 'ищи в другом месте')).toBe(false);
    // …но попала в следующий запрос — это и есть «вмешательство в текущий ход».
    const secondCall = snapshots[1]!;
    expect(secondCall.some((m) => m.role === 'user' && m.content === 'ищи в другом месте')).toBe(true);

    // Персист в истории ребёнка — обычная user-реплика с маркером инъекции.
    const saved = (await sessionManager.getSession(child.id))!;
    const injected = saved.messages.find((m) => m.content === 'ищи в другом месте');
    expect(injected).toBeDefined();
    expect(injected!.role).toBe(MessageRole.USER);
    expect(injected!.metadata!.steer).toBe(true);
    // `seq` назначен по месту (у ввода, поставленного в очередь раньше, он
    // был бы устаревшим).
    expect(injected!.seq).toBe(saved.messages.indexOf(injected!) + 1);
    // Очередь ребёнка вычищена — инъекция не копится.
    expect(saved.steerInbox ?? []).toHaveLength(0);
  });

  it('маркер interrupt не прерывает прогон: инъекция применяется как обычная', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { provider, snapshots } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'done' }],
    ]);
    const { registry } = makeRegistry({
      noop: async () => {
        await sessionManager.enqueueSteerMessage(
          child.id,
          steerMessage('остановись', { steer: true, interrupt: true }),
        );
        return { content: 'noop ok' };
      },
    });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parent.id, toolRegistry: registry }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    // Прогон доходит до финального ответа — прерывания хода не было.
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('done');
    expect(result.metadata!.interrupted).toBeUndefined();
    expect(result.metadata!.stopped_by).toBeUndefined();

    // Инъекция применена как обычное вмешательство и сохранена с маркерами.
    const secondCall = snapshots[1]!;
    expect(secondCall.some((m) => m.role === 'user' && m.content === 'остановись')).toBe(true);
    const saved = (await sessionManager.getSession(child.id))!;
    const injected = saved.messages.find((m) => m.content === 'остановись');
    expect(injected!.metadata!.steer).toBe(true);
    expect(injected!.metadata!.interrupt).toBe(true);
  });

  it('превышение лимита инъекций: событие steer.dropped, прогон не падает', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const bus = new EventBus();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    bus.subscribe(child.id, (e) => { events.push({ type: e.type, data: e.data as Record<string, unknown> }); });
    // Лимит инъекций на ход — 5; кладём 6 (лимит самой очереди поднят,
    // чтобы лишнее дошло до границы шага и было отброшено там).
    for (let i = 0; i < MAX_STEER_INJECTIONS_PER_TURN + 1; i++) {
      await sessionManager.enqueueSteerMessage(child.id, steerMessage(`инъекция ${i}`), 10);
    }
    const { provider } = scriptedProvider([[{ isFinal: true, content: 'done' }]]);

    const result = await runSubagent(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parent.id, eventBus: bus }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('done');

    const dropped = events.find((e) => e.type === 'steer.dropped');
    expect(dropped).toBeDefined();
    expect(dropped!.data.reason).toBe('limit');
    expect(dropped!.data.dropped_count).toBe(1);
    expect(dropped!.data.limit).toBe(MAX_STEER_INJECTIONS_PER_TURN);

    // Применены ровно 5 инъекций (лимит хода), лишняя отброшена.
    const saved = (await sessionManager.getSession(child.id))!;
    const applied = saved.messages.filter((m) => m.metadata?.steer === true);
    expect(applied).toHaveLength(MAX_STEER_INJECTIONS_PER_TURN);
  });

  it('без дочерней сессии поведение прежнее: инъекция в родителя не попадает в ход саб-агента', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    await sessionManager.enqueueSteerMessage(parent.id, steerMessage('вмешательство в родителя'), 10);
    const { provider, snapshots, calls } = scriptedProvider([
      [toolCallChunk('noop')],
      [{ isFinal: true, content: 'done' }],
    ]);
    const { registry } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    const result = await runSubagent(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parent.id, toolRegistry: registry }),
      parentSessionId: parent.id,
    }));

    expect(calls()).toBe(2);
    expect(result.content).toContain('done');
    // Очередь родителя не тронута — её вычитает оркестратор родительской сессии.
    const parentAfter = (await sessionManager.getSession(parent.id))!;
    expect(parentAfter.steerInbox ?? []).toHaveLength(1);
    // В ход саб-агента чужое сообщение не попало.
    const secondCall = snapshots[1]!;
    expect(secondCall.some((m) => m.content === 'вмешательство в родителя')).toBe(false);
  });
});

describe('run-cycle — отмена', () => {
  it('abortSignal уже абортирован: провайдер не вызывается, результат stopped_by_user', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { provider, calls } = scriptedProvider([[{ isFinal: true, content: 'never' }]]);
    const ac = new AbortController();
    ac.abort();

    const result = await runSubagent(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parent.id }),
      childSessionId: child.id,
      parentSessionId: parent.id,
      ctx: makeCtx({ abortSignal: ac.signal }),
    }));

    expect(calls()).toBe(0);
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.content).toContain(`<child_session_id>${child.id}</child_session_id>`);
    expect(result.metadata!.stopped_by).toBe('user');
    expect(result.metadata!.interrupted).toBe(true);

    // В истории ребёнка — маркер остановки.
    const saved = (await sessionManager.getSession(child.id))!;
    expect(saved.messages.some((m) => m.metadata?.stopped_by === 'user')).toBe(true);
  });

  it('отмена во время работы: дополнительного шага-отчёта нет', async () => {
    // Тул отменяет прогон на первом шаге — цикл прерывается, шаг-отчёт по
    // лимиту шагов не выполняется (лишний вызов LLM не делаем).
    const ac = new AbortController();
    const { provider, calls } = scriptedProvider([[toolCallChunk('noop')]]);
    const { registry, counters } = makeRegistry({
      noop: () => {
        ac.abort();
        return { content: 'ok' };
      },
    });

    const result = await runSubagent(makeConfig({
      maxSteps: 1,
      extra: makeExtra({ provider, toolRegistry: registry }),
      ctx: makeCtx({ abortSignal: ac.signal }),
    }));

    expect(counters.noop).toBe(1);
    expect(calls()).toBe(1);
    expect(result.metadata!.stopped_by).toBe('user');
    expect(result.metadata!.step_limit_reached).toBeUndefined();
  });

  it('отмена во время шага-отчёта: результат — протокол прерывания', async () => {
    const ac = new AbortController();
    let calls = 0;
    const chatAsync = vi.fn(() => {
      calls += 1;
      return (async function* () {
        if (calls === 1) {
          yield toolCallChunk('noop');
          return;
        }
        // Шаг-отчёт: отмена приходит во время стрима.
        ac.abort();
        yield { isFinal: true, content: 'частичный отчёт' };
      })();
    });
    const provider = { model: 'test-model', name: 'test-provider', chatAsync } as unknown as BaseProvider;
    const { registry } = makeRegistry({ noop: () => ({ content: 'ok' }) });

    const result = await runSubagent(makeConfig({
      maxSteps: 1,
      extra: makeExtra({ provider, toolRegistry: registry }),
      ctx: makeCtx({ abortSignal: ac.signal }),
    }));

    expect(calls).toBe(2);
    expect(result.metadata!.stopped_by).toBe('user');
    expect(result.metadata!.interrupted).toBe(true);
  });
});
