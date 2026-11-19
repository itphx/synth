/**
 * ADR-041 × opencode `tool.input-incomplete`: tool-call, аргументы которого
 * оборваны лимитом вывода.
 *
 * Проверяем на смонтированном цикле хода (`ChatOrchestrator`):
 *  - обрезанный payload (`finish_reason: length`) **не исполняется**, модели
 *    возвращается причина «обрезано лимитом вывода» с подсказкой разбить
 *    payload, а не ошибка схемы аргументов («malformed JSON»/`Required`);
 *  - полный tool-call, пришедший с тем же `finish_reason` (модель дописала
 *    вызов и упёрлась в лимит на тексте), исполняется как обычно.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
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
import type { CancellationToken, LLMMessage } from '../../providers/base.js';
import type { ContextBuilder } from '../context/builder.js';
import type { PermissionConfig, ToolDefinition, Message, LLMChunk } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart, ToolCapability } from '@itphx/synth-shared';

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
    parts: [makeTextPart('сделай работу')],
    content: 'сделай работу',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/** Тул-заглушка с регистрацией вызова: `args` — то, что дошло до исполнителя. */
function makeSpyTool(): { tool: ToolDefinition; calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    name: 'noop_tool',
    description: 'тестовый тул без побочных эффектов',
    parameters: z.object({ path: z.string().optional() }),
    capabilities: [ToolCapability.RUNTIME],
    async execute(args: Record<string, unknown>) {
      calls.push(args);
      return { content: 'noop_tool: ок' };
    },
  } as unknown as ToolDefinition;
  return { tool, calls };
}

/**
 * Провайдер с одним tool-вызовом: аргументы и причина завершения задаются
 * статикой (мультиплексирование между сценариями одного файла).
 */
class TruncatedCallProvider extends BaseProvider {
  static args = '{"path": "a.txt"';

  static finishReason: LLMChunk['finishReason'] = 'length';

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'done', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    const hasToolResult = messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      yield {
        content: '', isFinal: true,
        toolCalls: [{
          id: 'call_trunc',
          type: 'function',
          function: { name: 'noop_tool', arguments: TruncatedCallProvider.args },
        }],
        model: this.model,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: TruncatedCallProvider.finishReason,
      };
      return;
    }
    yield {
      content: 'Готово', isFinal: false,
      model: this.model,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    };
  }

  getProviderName(): string {
    return 'mocktruncatedcall';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  tmpDir: string;
  sessionId: string;
  calls: unknown[];
}

async function makeHarness(): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-input-incomplete-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('InputIncomplete', 'u1', { workspace: tmpDir });
  await projectStore.save(project);

  const { tool, calls } = makeSpyTool();
  const toolRegistry = createToolRegistry();
  toolRegistry.register(tool);

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => ({
      name, type: 'mocktruncatedcall', baseUrl: '', apiKey: '', defaultModel: 'm',
    }) as unknown as import('@itphx/synth-shared').ProviderConfig,
    toolRegistry,
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
  });

  const session = await sessionManager.createSession({
    title: 'InputIncomplete',
    projectId: project.id,
    settings: { provider: 'mocktruncatedcall', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  await sessionManager.addMessage(session.id, makeUserMessage());
  return { orchestrator, sessionManager, tmpDir, sessionId: session.id, calls };
}

async function run(h: Harness): Promise<import('../orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return processMessage(fresh, userMsg, new AbortController().signal, () => {});
}

/** Парные `tool`-сообщения истории (результаты вызовов). */
function toolMessages(messages: Message[]): Message[] {
  return messages.filter((m) => m.role === MessageRole.TOOL);
}

describe('обрезанный tool-call (tool.input_incomplete, ADR-041)', () => {
  beforeEach(() => {
    ProviderFactory.register('mocktruncatedcall', TruncatedCallProvider);
    TruncatedCallProvider.args = '{"path": "a.txt"';
    TruncatedCallProvider.finishReason = 'length';
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('mocktruncatedcall');
  });

  it('аргументы оборваны лимитом: вызов не исполняется, модели — причина про лимит', async () => {
    const h = await makeHarness();
    const result = await run(h);
    expect(result.error).toBeUndefined();

    // Тул не исполнялся: неполный payload нельзя трактовать как «вызов без args».
    expect(h.calls).toHaveLength(0);

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const results = toolMessages(session.messages);
    expect(results).toHaveLength(1);
    const content = results[0]!.content;

    // Причина — лимит вывода и подсказка разбить payload...
    expect(content).toContain('output token limit');
    expect(content).toContain('split it into smaller calls');
    // ...а не «некорректный JSON»/ошибка схемы аргументов.
    expect(content).not.toContain('malformed');
    expect(content).not.toContain('argument error');

    const i18n = results[0]!.metadata?.i18n as { key?: string; params?: Record<string, unknown> };
    expect(i18n.key).toBe('tool.input_incomplete');
    expect(i18n.params).toMatchObject({ tool: 'noop_tool' });

    // Ход продолжился: модель получила tool_result и дала финальный ответ.
    expect(session.messages.some(
      (m) => m.role === MessageRole.ASSISTANT && m.content.includes('Готово'),
    )).toBe(true);
  });

  it('полный tool-call при том же finish_reason исполняется как обычно', async () => {
    TruncatedCallProvider.args = '{"path":"a.txt"}';
    const h = await makeHarness();
    const result = await run(h);
    expect(result.error).toBeUndefined();

    // Аргументы целы — вызов дошёл до исполнителя (лимит вывода на текст шага
    // не делает tool-call неполным).
    expect(h.calls).toEqual([{ path: 'a.txt' }]);

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const results = toolMessages(session.messages);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain('noop_tool: ок');
    expect(results[0]!.content).not.toContain('output token limit');
    const i18n = results[0]!.metadata?.i18n as { key?: string } | undefined;
    expect(i18n?.key).not.toBe('tool.input_incomplete');
  });

  it('битый JSON без лимита вывода — прежнее поведение (не наш класс)', async () => {
    TruncatedCallProvider.args = '{"path": "a.txt"';
    TruncatedCallProvider.finishReason = 'end_turn';
    const h = await makeHarness();
    const result = await run(h);
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const results = toolMessages(session.messages);
    expect(results).toHaveLength(1);
    // Текста про лимит нет: причина — не обрезка (аргументы просто битые).
    expect(results[0]!.content).not.toContain('output token limit');
  });
});
