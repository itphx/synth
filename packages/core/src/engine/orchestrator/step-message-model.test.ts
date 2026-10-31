/**
 * ADR-118 §1 — модель «шаг = сообщение, финал хода = последний шаг».
 *
 * Инварианты, которые здесь закреплены (регресс-тесты):
 *  1. Финальное сообщение хода несёт `parts`/`reasoning` ТОЛЬКО финальной
 *     итерации; блоки прошлых шагов живут в сообщениях своих шагов.
 *  2. Сводка вызовов инструментов (`metadata.tool_results`) — в сообщении
 *     СВОЕГО шага (только вызовы этой итерации, вместе с `result`); в
 *     финальном сообщении её нет. То же — для `intermediate_text_blocks`.
 *  3. После старта хода живой стрим несёт метку хода: `currentStream.turnId`
 *     (`turn_...`), а DTO сессии отдаёт её как `current_stream.turn_id`
 *     (UI восстанавливает ход после перезагрузки страницы).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import { createToolRegistry } from '../tools/index.js';
import { ContextConfig } from '../context/config.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import type { ContextBuilder } from '../context/builder.js';
import type { PermissionConfig, ToolDefinition, Message, Session } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart, ToolCapability } from '@itphx/synth-shared';
import { serializeSession } from '../../server/serialize.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('выполни задачу')],
    content: 'выполни задачу',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

function makeNoopTool(): ToolDefinition {
  return {
    name: 'noop_tool',
    description: 'тестовый тул без побочных эффектов',
    parameters: z.object({}),
    capabilities: [ToolCapability.RUNTIME],
    async execute() {
      return { content: 'noop_tool: ок' };
    },
  } as unknown as ToolDefinition;
}

const ZERO_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * Провайдер сценария из трёх шагов: два шага с вызовом инструмента и
 * рассуждением, третий — финальный текст со своим рассуждением.
 */
class ThreeStepProvider extends BaseProvider {
  static calls = 0;

  static reset(): void {
    ThreeStepProvider.calls = 0;
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Готово', model: this.model, usage: ZERO_USAGE };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = ThreeStepProvider.calls++;
    if (n === 0) {
      yield {
        content: 'Шаг 1', reasoning: 'размышление 1', isFinal: true,
        model: this.model, usage: ZERO_USAGE,
        toolCalls: [{
          id: 'call_0', type: 'function',
          function: { name: 'noop_tool', arguments: '{}' },
        }],
      };
      return;
    }
    if (n === 1) {
      yield {
        content: 'Шаг 2', reasoning: 'размышление 2', isFinal: true,
        model: this.model, usage: ZERO_USAGE,
        toolCalls: [{
          id: 'call_1', type: 'function',
          function: { name: 'noop_tool', arguments: '{}' },
        }],
      };
      return;
    }
    yield {
      content: 'Готово', reasoning: 'размышление 3', isFinal: true,
      model: this.model, usage: ZERO_USAGE,
    };
  }

  getProviderName(): string {
    return 'mockthreestep';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  tmpDir: string;
  sessionId: string;
}

async function makeHarness(providerName: string): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-step-model-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const toolRegistry = createToolRegistry();
  toolRegistry.register(makeNoopTool());
  // ADR-075: file/shell/git-тулы доступны только при заданном workspace проекта.
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('StepModel', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => (
      { name, type: providerName, baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig
    ),
    toolRegistry,
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
  });
  const session = await sessionManager.createSession({
    title: 'StepModel',
    projectId: project.id,
    settings: { provider: providerName, model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  const msg = makeUserMessage();
  await sessionManager.addMessage(session.id, msg);
  return { orchestrator, sessionManager, tmpDir, sessionId: session.id };
}

/** Прогон хода: возвращает сессию после хода. */
async function runTurn(h: Harness): Promise<Session> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  const result = await processMessage(fresh, userMsg, new AbortController().signal, () => {});
  expect(result.error).toBeUndefined();
  return (await h.sessionManager.getSession(h.sessionId))!;
}

/** Сообщения шагов хода (assistant) в порядке истории. */
function stepMessages(session: Session): Message[] {
  return session.messages.filter((m) => m.role === MessageRole.ASSISTANT);
}

describe('ADR-118 §1: финал хода = последний шаг', () => {
  beforeEach(() => {
    ProviderFactory.register('mockthreestep', ThreeStepProvider);
    ThreeStepProvider.reset();
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('mockthreestep');
  });

  it('финальное сообщение несёт reasoning только финальной итерации; блоки прошлых шагов — в их сообщениях', async () => {
    const h = await makeHarness('mockthreestep');
    const session = await runTurn(h);

    const assistants = stepMessages(session);
    expect(assistants).toHaveLength(3);

    // Шаги 1 и 2: у каждого — своё рассуждение.
    const step1 = assistants[0]!;
    const step2 = assistants[1]!;
    expect(step1.parts.filter((p) => p.type === 'reasoning').map((p) => p.data)).toEqual(['размышление 1']);
    expect(step1.reasoning).toBe('размышление 1');
    expect(step2.parts.filter((p) => p.type === 'reasoning').map((p) => p.data)).toEqual(['размышление 2']);
    expect(step2.reasoning).toBe('размышление 2');

    // Финал: рассуждение ТОЛЬКО своей (третьей) итерации.
    const finalMessage = assistants[2]!;
    expect(finalMessage.content).toBe('Готово');
    expect(finalMessage.parts.filter((p) => p.type === 'reasoning').map((p) => p.data)).toEqual(['размышление 3']);
    expect(finalMessage.reasoning).toBe('размышление 3');
    // Сводок хода в финале нет — они живут в сообщениях своих шагов.
    expect(finalMessage.metadata?.tool_results).toBeUndefined();
    expect(finalMessage.metadata?.intermediate_text_blocks).toBeUndefined();

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('tool_results сообщения шага — только вызовы этой итерации (с result); у финального их нет', async () => {
    const h = await makeHarness('mockthreestep');
    const session = await runTurn(h);

    const assistants = stepMessages(session);
    expect(assistants).toHaveLength(3);

    const step1Results = assistants[0]!.metadata?.tool_results as Array<{
      id: string; name: string; iteration: number; result?: { content: string };
    }>;
    expect(step1Results).toHaveLength(1);
    expect(step1Results[0]!.id).toBe('call_0');
    expect(step1Results[0]!.name).toBe('noop_tool');
    expect(step1Results[0]!.iteration).toBe(0);
    expect(step1Results[0]!.result?.content).toBe('noop_tool: ок');

    const step2Results = assistants[1]!.metadata?.tool_results as Array<{
      id: string; iteration: number; result?: { content: string };
    }>;
    expect(step2Results).toHaveLength(1);
    expect(step2Results[0]!.id).toBe('call_1');
    expect(step2Results[0]!.iteration).toBe(1);
    expect(step2Results[0]!.result?.content).toBe('noop_tool: ок');

    // Финальное сообщение хода вызовов не несёт.
    expect(assistants[2]!.metadata?.tool_results).toBeUndefined();

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('current_stream.turn_id заполнен после старта хода (DTO сессии)', async () => {
    const h = await makeHarness('mockthreestep');
    // Живой стрим заводит очередь (ADR-118 §10) — метка хода ставится в него.
    await h.sessionManager.withLock(h.sessionId, async (s) => {
      s.currentStream = {
        streamId: 'stream_test',
        message: 'выполни задачу',
        agentRole: 'fixer',
        startedAt: nowISO(),
        cancelled: false,
      };
      await h.sessionManager.saveSession(s);
    });

    const session = await runTurn(h);

    // Метка хода — в живом стриме сессии.
    expect(session.currentStream).toBeDefined();
    expect(session.currentStream!.turnId).toMatch(/^turn_/);

    // DTO сессии отдаёт её как `current_stream.turn_id`.
    const dto = serializeSession(session);
    const currentStream = dto.current_stream as { turn_id: string | null } | null;
    expect(currentStream).not.toBeNull();
    expect(currentStream!.turn_id).toBe(session.currentStream!.turnId);
    expect(currentStream!.turn_id).toMatch(/^turn_/);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('current_stream без метки хода → turn_id: null; без стрима → current_stream: null', async () => {
    const h = await makeHarness('mockthreestep');

    // Живой стрим без метки хода (окно между стартом хода и его разметкой) —
    // поле аддитивное, `null`, а не падение.
    await h.sessionManager.withLock(h.sessionId, async (s) => {
      s.currentStream = {
        streamId: 'stream_test',
        message: 'выполни задачу',
        agentRole: 'fixer',
        startedAt: nowISO(),
        cancelled: false,
      };
      await h.sessionManager.saveSession(s);
    });
    const withStream = (await h.sessionManager.getSession(h.sessionId))!;
    const dto = serializeSession(withStream);
    expect((dto.current_stream as { turn_id: string | null }).turn_id).toBeNull();

    // Без живого стрима — `current_stream: null`.
    const withoutStream = (await h.sessionManager.getSession(h.sessionId))!;
    withoutStream.currentStream = undefined;
    expect(serializeSession(withoutStream).current_stream).toBeNull();

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
