import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { createToolRegistry } from './tools/index.js';
import { ContextConfig } from './context/config.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { PermissionConfig, ToolDefinition, Message } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart, ToolCapability } from '@itphx/synth-shared';
import { sessionMessagesToLlm } from './orchestrator/prompt-info.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeMessage(): Message {
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

/**
 * Провайдер для теста deny + пустой финальный ответ:
 * вызовы 0..2 — execute_shell с опасной командой (deny по системной
 * shell-политике definitions/shell-policy.json), вызов 3 — пустой
 * контент без toolCalls (модель «сдалась» после серии deny).
 */
class MockDenyLoopProvider extends BaseProvider {
  static calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (MockDenyLoopProvider.calls < 3) {
      const n = MockDenyLoopProvider.calls;
      return {
        content: '',
        toolCalls: [{
          id: `call_d${n}`,
          function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'rm -rf /' }) },
        }],
      };
    }
    return { content: '', toolCalls: undefined };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    MockDenyLoopProvider.calls++;
    return { content: next.content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: next.toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    MockDenyLoopProvider.calls++;
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockdenyloop';
  }
}

/**
 * Провайдер для теста abort:
 * вызов 0 — завершённая итерация: текст + execute_shell (deny);
 * вызов 1 — медленный стрим текста, прерывается abort'ом.
 */
class MockAbortProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'x', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockAbortProvider.calls++;
    if (n === 0) {
      yield {
        content: 'Шаг 1: анализ команды', isFinal: true,
        toolCalls: [{ id: 'call_a0', function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'rm -rf /' }) } }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    const parts = ['Полный', ' частичный', ' ответ', ' — модель', ' уже', ' написала', ' это'];
    for (const p of parts) {
      if (ct?.cancelled) return;
      yield { content: p, isFinal: false, model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      await new Promise((r) => setTimeout(r, 10));
    }
    yield { content: 'Конец', isFinal: true, model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  getProviderName(): string {
    return 'mockabort';
  }
}

/**
 * Провайдер, который НЕ отдаёт `model` в промежуточных чанках (как реальные
 * openai/anthropic) — проверка fallback-цепочки модели при отмене (Bug 2):
 * иначе cost_usd не считается, а message.model = null.
 */
class MockAbortNoModelProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'x', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const parts = ['Первая', ' часть', ' ответа'];
    for (const p of parts) {
      if (ct?.cancelled) return;
      yield { content: p, isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      await new Promise((r) => setTimeout(r, 10));
    }
    yield { content: 'конец', isFinal: true, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockabortnomodel';
  }
}

/**
 * Провайдер для отмены ДО первого токена: не отдаёт ни одного чанка, ждёт
 * отмены и завершается. Так «Стоп» приходит раньше контента/размышлений/тулов.
 */
class MockAbortBeforeFirstTokenProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    MockAbortBeforeFirstTokenProvider.calls++;
    // Ни одного чанка: держим стрим открытым до отмены.
    while (!ct?.cancelled) {
      await new Promise((r) => setTimeout(r, 5));
    }
    yield* [] as import('@itphx/synth-shared').LLMChunk[];
  }

  getProviderName(): string {
    return 'mockabortbefore';
  }
}

/** Провайдер: 3 одинаковых вызова read_file (НЕ deny), затем текст — для проверки сохранения doom loop. */
class MockDoomProvider extends BaseProvider {
  static calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (MockDoomProvider.calls < 3) {
      const n = MockDoomProvider.calls;
      return {
        content: '',
        toolCalls: [{
          id: `call_r${n}`,
          function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'x.txt' }) },
        }],
      };
    }
    return { content: 'Готово' };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    MockDoomProvider.calls++;
    return { content: next.content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: next.toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    MockDoomProvider.calls++;
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockdoom';
  }
}

/**
 * Провайдер для регресса шага 2а: 1-я итерация — текст + tool call (deny-команда,
 * реальные команды не выполняются), 2-я — падение LLM. Пошаговая запись обязана
 * оставить assistant(tool_calls) и tool-результат в истории до финала.
 */
class MockFailAfterToolProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockFailAfterToolProvider.calls++;
    if (n === 0) {
      yield {
        content: 'Шаг 1: проверяю команду', isFinal: true,
        toolCalls: [{ id: 'call_f0', function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'rm -rf /' }) } }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    throw new Error('network fail: provider unavailable');
  }

  getProviderName(): string {
    return 'mockfailaftertool';
  }
}

/**
 * Один tool call (deny-команда, реально не выполняется) → финальный текст:
 * проверка ровно одной пары assistant(tool_calls) → tool и отсутствия дублей.
 */
class MockOneToolThenTextProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Готово', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockOneToolThenTextProvider.calls++;
    if (n === 0) {
      yield {
        content: 'Шаг 1: проверяю команду', isFinal: true,
        toolCalls: [{ id: 'call_o0', function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'rm -rf /' }) } }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    yield {
      content: 'Готово', isFinal: true,
      model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mockonetool';
  }
}

/**
 * Провайдер со сценарием (массив шагов): каждый `chatAsync` отдаёт один шаг.
 * Нужен для точечных сценариев (кривой tool call, исключение тула, батч тулов).
 */
class MockScriptProvider extends BaseProvider {
  static script: Array<{ content: string; toolCalls?: Record<string, unknown>[] }> = [];
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const step = MockScriptProvider.script[Math.min(MockScriptProvider.calls, MockScriptProvider.script.length - 1)]!;
    MockScriptProvider.calls++;
    return {
      content: step.content,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: step.toolCalls,
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const step = MockScriptProvider.script[Math.min(MockScriptProvider.calls, MockScriptProvider.script.length - 1)]!;
    MockScriptProvider.calls++;
    yield {
      content: step.content,
      isFinal: true,
      toolCalls: step.toolCalls,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mockscript';
  }
}

/** Провайдер: всегда возвращает пустой контент без toolCalls (модель «не ответила»). */
class MockEmptyProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: '', isFinal: true, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockempty';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  tmpDir: string;
  sessionId: string;
}

async function makeHarness(providerName: string, toolRegistry = createToolRegistry()): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-deny-abort-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  // ADR-075: file/shell/git-тулы доступны только при заданном workspace проекта.
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('DenyAbort', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: providerName, baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry,
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
    // Цены модели 'm' — проверка cost_usd при отмене (Bug 2/3).
    modelPriceLoader: (model: string) => (model === 'm' ? { inputPrice: 1, outputPrice: 2 } : null),
  });
  const session = await sessionManager.createSession({
    title: 'DenyAbort',
    projectId: project.id,
    settings: { provider: providerName, model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  const msg = makeMessage();
  await sessionManager.addMessage(session.id, msg);
  return { orchestrator, sessionManager, eventBus, tmpDir, sessionId: session.id };
}

async function run(
  h: Harness,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
): Promise<import('./orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return processMessage(fresh, userMsg, signal, publishChunk);
}

/**
 * ADR-118 §4: ход — последовательность шагов, поэтому в журнале может быть
 * несколько `step.finished` (по одному на вызов LLM). Финальный статус шага и
 * хода читаем из последних событий (замена `stream.done`).
 */
function stepFinished(
  chunks: Array<{ event: string; data: Record<string, unknown> }>,
): Record<string, unknown> {
  const found = [...chunks].reverse().find((c) => c.event === 'step.finished');
  expect(found, 'step.finished не опубликован').toBeDefined();
  return found!.data;
}

function turnFinished(
  chunks: Array<{ event: string; data: Record<string, unknown> }>,
): Record<string, unknown> {
  const found = [...chunks].reverse().find((c) => c.event === 'turn.finished');
  expect(found, 'turn.finished не опубликован').toBeDefined();
  return found!.data;
}

describe('ChatOrchestrator: deny × doom loop + abort (баги фикса)', () => {
  beforeEach(() => {
    ProviderFactory.register('mockdenyloop', MockDenyLoopProvider);
    ProviderFactory.register('mockabort', MockAbortProvider);
    ProviderFactory.register('mockabortnomodel', MockAbortNoModelProvider);
    ProviderFactory.register('mockabortbefore', MockAbortBeforeFirstTokenProvider);
    ProviderFactory.register('mockdoom', MockDoomProvider);
    ProviderFactory.register('mockempty', MockEmptyProvider);
    ProviderFactory.register('mockfailaftertool', MockFailAfterToolProvider);
    ProviderFactory.register('mockonetool', MockOneToolThenTextProvider);
    ProviderFactory.register('mockscript', MockScriptProvider);
    MockDenyLoopProvider.calls = 0;
    MockAbortProvider.calls = 0;
    MockAbortNoModelProvider.calls = 0;
    MockAbortBeforeFirstTokenProvider.calls = 0;
    MockDoomProvider.calls = 0;
    MockFailAfterToolProvider.calls = 0;
    MockOneToolThenTextProvider.calls = 0;
    MockScriptProvider.calls = 0;
    MockScriptProvider.script = [];
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockdenyloop');
    ProviderFactory['_providers'].delete('mockabort');
    ProviderFactory['_providers'].delete('mockabortnomodel');
    ProviderFactory['_providers'].delete('mockabortbefore');
    ProviderFactory['_providers'].delete('mockdoom');
    ProviderFactory['_providers'].delete('mockempty');
    ProviderFactory['_providers'].delete('mockfailaftertool');
    ProviderFactory['_providers'].delete('mockonetool');
    ProviderFactory['_providers'].delete('mockscript');
  });

  it('deny 3+ раза: каждый deny даёт tool_call.result с объяснением политики, без «Цикл прерван»; пустой ответ модели подставлен', async () => {
    const h = await makeHarness('mockdenyloop');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // Все 3 deny-вызова публикуют tool_call.result (в т.ч. 3-й — раньше его глушил doom loop)
    const denyResults = chunks
      .filter((c) => c.event === 'tool_call.result')
      .map((c) => c.data.result as { content: string; isError?: boolean });
    expect(denyResults).toHaveLength(3);
    for (const r of denyResults) {
      expect(r.isError).toBe(true);
      expect(r.content).toContain('Permission denied');
      // Инструкция модели для deny
      expect(r.content).toContain('The action is prohibited by the security policy');
      // Никаких «Цикл прерван» без объяснения
      expect(r.content).not.toContain('Цикл прерван');
    }
    // tool_call.started публикуется и для 3-го вызова
    const starts = chunks.filter((c) => c.event === 'tool_call.started');
    expect(starts).toHaveLength(3);

    // Пустой финальный ответ модели подставлен (текст — в assistant-сообщении:
    // ADR-118 §4 в `step.finished` контента нет). Статус отказа: ход
    // `stopped` (ADR-070 §2.6), шаг — `completed` (ошибки не было) — вместо
    // прежнего `status: 'stopped'` в `stream.done`.
    expect(turnFinished(chunks).status).toBe('stopped');
    expect(stepFinished(chunks).status).toBe('completed');

    // В истории нет пустого assistant-сообщения
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain);
    expect(assistant).toBeDefined();
    expect(assistant!.content.length).toBeGreaterThan(0);
    expect(assistant!.content).toContain('Could not proceed');
    expect(assistant!.metadata?.status).toBe('stopped');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  // Шаг 2а: пошаговая запись — падение на 2-й итерации не теряет уже
  // полученный assistant(tool_calls) и tool-результат (без ожидания финала).
  it('падение на 2-й итерации: assistant(tool_calls) и tool-результат уже в истории', async () => {
    const h = await makeHarness('mockfailaftertool');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeDefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    // Промежуточный шаг с вызовом инструмента — assistant с `toolCalls`.
    // Маркер `tool_chain` ставится ТОЛЬКО шагам БЕЗ видимого текста: у этого
    // шага есть текст ('Шаг 1') — значит, маркера нет (иначе ответ агента
    // исчезнет из транскрипта после перезагрузки страницы).
    const chainAssistant = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(chainAssistant).toBeDefined();
    expect(chainAssistant!.toolCalls).toHaveLength(1);
    expect(chainAssistant!.content).toContain('Шаг 1');
    expect(chainAssistant!.model).toBe('m');
    expect(chainAssistant!.metadata?.tool_chain).toBeUndefined();

    const toolMsg = session.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolCallId).toBe('call_f0');
    expect(toolMsg!.metadata?.tool_chain).toBe(true);
    expect(toolMsg!.content).toContain('Permission denied');

    // Порядок: assistant(tool_calls) → tool.
    const assistantIdx = session.messages.indexOf(chainAssistant!);
    const toolIdx = session.messages.indexOf(toolMsg!);
    expect(toolIdx).toBe(assistantIdx + 1);

    // Финальное сообщение — ошибка LLM (без вызовов инструментов).
    const finalAssistant = [...session.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) === 0,
    );
    expect(finalAssistant?.metadata?.status).toBe('error');

    // Пары для LLM целы: assistant с toolUse → парный tool, без осиротевших tool.
    const llm = sessionMessagesToLlm(session.messages, 'fixer');
    const toolUseIdx = llm.findIndex((m) => m.role === 'assistant' && (m.toolUse?.length ?? 0) > 0);
    expect(toolUseIdx).toBeGreaterThanOrEqual(0);
    expect(llm[toolUseIdx + 1]).toMatchObject({ role: 'tool', toolCallId: 'call_f0' });
    expect(llm.filter((m) => m.role === 'tool')).toHaveLength(1);
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  // Шаг 2а: обычное завершение — история ровно assistant(toolCalls) → tool →
  // финальный assistant, без дублей; metadata финального не изменилась.
  it('обычное завершение с одним tool call: assistant(tool_calls) → tool → финальный assistant', async () => {
    const h = await makeHarness('mockonetool');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    // Промежуточный шаг — assistant с `toolCalls`; финальный — assistant без
    // вызовов. Маркер `tool_chain` у шага с текстом НЕ ставится (текст шага —
    // реальный ответ агента, его нельзя скрывать из транскрипта).
    const chainAssistants = session.messages.filter(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    const toolMessages = session.messages.filter((m) => m.role === MessageRole.TOOL);
    const finalAssistants = session.messages.filter(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) === 0,
    );
    expect(chainAssistants).toHaveLength(1);
    expect(toolMessages).toHaveLength(1);
    expect(finalAssistants).toHaveLength(1);

    const chainAssistant = chainAssistants[0]!;
    const toolMsg = toolMessages[0]!;
    const finalAssistant = finalAssistants[0]!;
    expect(chainAssistant.toolCalls).toHaveLength(1);
    expect(toolMsg.toolCallId).toBe('call_o0');
    expect(toolMsg.metadata?.tool_name).toBe('execute_shell');
    expect(session.messages.indexOf(toolMsg)).toBe(session.messages.indexOf(chainAssistant) + 1);
    expect(session.messages.indexOf(finalAssistant)).toBe(session.messages.indexOf(toolMsg) + 1);

    // Финальное сообщение — без tool_chain.
    expect(finalAssistant.metadata?.tool_chain).toBeUndefined();
    // Промежуточный шаг с текстом — тоже без tool_chain (текст видим).
    expect(chainAssistant.metadata?.tool_chain).toBeUndefined();
    // ADR-118 §1: «финал хода = последний шаг» — сводка вызовов и текстов
    // **хода** живёт в сообщении СВОЕГО шага. В финальном сообщении её нет:
    // иначе карточки инструментов и тексты прошлых шагов дублировались бы.
    expect(finalAssistant.metadata?.tool_results).toBeUndefined();
    expect(finalAssistant.metadata?.intermediate_text_blocks).toBeUndefined();
    // Вызовы шага — в его собственном сообщении (только эта итерация).
    const stepToolResults = chainAssistant.metadata?.tool_results as Array<{
      id: string;
      name: string;
      iteration: number;
      result?: { content: string; isError?: boolean };
    }> | undefined;
    expect(stepToolResults).toBeDefined();
    expect(stepToolResults).toHaveLength(1);
    expect(stepToolResults![0]!.id).toBe('call_o0');
    expect(stepToolResults![0]!.name).toBe('execute_shell');
    expect(stepToolResults![0]!.iteration).toBe(0);
    expect(stepToolResults![0]!.result?.isError).toBe(true);
    expect(stepToolResults![0]!.result?.content).toContain('Permission denied');

    const llm = sessionMessagesToLlm(session.messages, 'fixer');
    expect(llm.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(llm.filter((m) => m.role === 'assistant' && (m.toolUse?.length ?? 0) === 0)).toHaveLength(1);
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('abort во время генерации после deny: текст текущей итерации в сообщении отмены, deny — в tool_results шага', async () => {
    const h = await makeHarness('mockabort');
    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    let sawToolResult = false;
    let textDeltas = 0;

    const promise = run(h, ac.signal, (event, data) => {
      chunks.push({ event, data });
      if (event === 'tool_call.result') sawToolResult = true;
      // ADR-118 §4: текст идёт `part.delta` (прежний `stream.chunk` удалён);
      // вторая итерация — дельты после первого tool-результата.
      if (event === 'part.delta' && sawToolResult) {
        textDeltas++;
        if (textDeltas >= 2) setTimeout(() => ac.abort(), 5);
      }
    });

    const result = await promise;
    expect(result.error).toBeUndefined();

    // ADR-118 §1: в сообщении отмены — только текст **текущей** итерации.
    // Текст завершённого шага уже сохранён его сообщением (шаг = сообщение),
    // склейка была бы дублем в ленте.
    const cancelled = chunks.find((c) => c.event === 'stream.cancelled')!;
    const cancelledContent = cancelled.data.content as string;
    expect(cancelledContent).toContain('Полный');
    expect(cancelledContent).not.toContain('Шаг 1: анализ команды');
    // ADR-070 §2.6: отмена → status 'cancelled'.
    expect(cancelled.data.status).toBe('cancelled');

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(assistant).toBeDefined();
    expect(assistant!.content).toContain('Полный');
    expect(assistant!.content).not.toContain('Шаг 1: анализ команды');
    expect(assistant!.content).not.toContain('Конец');
    expect(assistant!.metadata?.status).toBe('cancelled');

    // ADR-118 §1: сводка вызовов хода — в сообщении СВОЕГО шага; в сообщении
    // отмены её нет.
    const meta = assistant!.metadata as Record<string, unknown>;
    expect(meta.tool_results).toBeUndefined();
    // При отмене blocks НЕ дублируются: они уже вошли в content (иначе UI
    // режима 'bottom' склеил бы их с content повторно)
    expect(meta.intermediate_text_blocks).toBeUndefined();

    // deny сохранился в tool_results сообщения шага, где вызов и был.
    const stepAssistant = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(stepAssistant).toBeDefined();
    const stepToolResults = stepAssistant!.metadata?.tool_results as Array<{
      name: string;
      result?: { content: string; isError?: boolean };
    }> | undefined;
    expect(stepToolResults).toBeDefined();
    expect(stepToolResults!.length).toBeGreaterThan(0);
    expect(stepToolResults![0]!.name).toBe('execute_shell');
    expect(stepToolResults![0]!.result?.isError).toBe(true);
    expect(stepToolResults![0]!.result?.content).toContain('Permission denied');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  // Bug 2/3/4: провайдер не отдаёт model/usage в промежуточных чанках, отмена
  // до финального чанка — модель берётся из fallback, usage оценивается,
  // stream.cancelled несёт usage/duration/cost.
  it('отмена без model/usage в чанках: fallback модели, оценка usage и cost в сообщении и stream.cancelled', async () => {
    const h = await makeHarness('mockabortnomodel');
    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    let textDeltas = 0;

    const promise = run(h, ac.signal, (event, data) => {
      chunks.push({ event, data });
      // ADR-118 §4: текст шага — `part.delta` (прежний `stream.chunk` удалён).
      if (event === 'part.delta') {
        textDeltas++;
        if (textDeltas >= 2) setTimeout(() => ac.abort(), 5);
      }
    });

    const result = await promise;
    expect(result.error).toBeUndefined();

    // Bug 3: stream.cancelled несёт статистику, как прежний stream.done.
    const cancelled = chunks.find((c) => c.event === 'stream.cancelled')!;
    expect(cancelled).toBeDefined();
    expect(cancelled.data.model).toBe('m');
    expect(typeof cancelled.data.duration_ms).toBe('number');
    expect(cancelled.data.usage_estimated).toBe(true);
    const eventUsage = cancelled.data.usage as { inputTokens: number; outputTokens: number };
    expect(eventUsage.inputTokens).toBeGreaterThan(0);
    expect(eventUsage.outputTokens).toBeGreaterThan(0);
    expect(typeof cancelled.data.cost_usd).toBe('number');
    expect(cancelled.data.cost_usd as number).toBeGreaterThan(0);

    // Bug 2: сохранённое сообщение получает модель (fallback) и cost_usd.
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    )!;
    expect(assistant).toBeDefined();
    expect(assistant.model).toBe('m');
    expect(assistant.usage!.inputTokens).toBeGreaterThan(0);
    expect(assistant.metadata?.usage_estimated).toBe(true);
    expect(typeof assistant.metadata?.cost_usd).toBe('number');
    expect(assistant.metadata?.status).toBe('cancelled');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  // ADR-070 §2.6: отмена ДО первого токена не должна терять ход — assistant-
  // сообщение сохраняется (status cancelled, usage/estimated/duration/cost),
  // публикуется message.added до stream.cancelled.
  it('отмена до первого токена: assistant-сообщение со status cancelled, usage/estimated/duration/cost', async () => {
    const h = await makeHarness('mockabortbefore');
    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    // Единая последовательность событий из двух каналов (publishChunk и EventBus).
    const sequence: string[] = [];
    h.eventBus.subscribe(h.sessionId, (e) => sequence.push(e.type));

    // Аборт по первому же событию шага (`step.started` — замена удалённого
    // `stream.usage`) — до чанков/тулов.
    const promise = run(h, ac.signal, (event, data) => {
      chunks.push({ event, data });
      sequence.push(event);
      if (event === 'step.started') setTimeout(() => ac.abort(), 5);
    });

    const result = await promise;
    expect(result.error).toBeUndefined();
    expect(MockAbortBeforeFirstTokenProvider.calls).toBe(1);

    // stream.cancelled несёт статистику.
    const cancelled = chunks.find((c) => c.event === 'stream.cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled!.data.status).toBe('cancelled');
    expect(typeof cancelled!.data.duration_ms).toBe('number');
    expect(cancelled!.data.usage_estimated).toBe(true);
    const eventUsage = cancelled!.data.usage as { inputTokens: number };
    expect(eventUsage.inputTokens).toBeGreaterThan(0);
    expect(typeof cancelled!.data.cost_usd).toBe('number');
    expect(cancelled!.data.cost_usd as number).toBeGreaterThan(0);

    // Ровно одно assistant-сообщение хода (без tool_chain), с контентом ''.
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistants = session.messages.filter(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(assistants).toHaveLength(1);
    const a = assistants[0]!;
    expect(a.content).toBe('');
    expect(a.metadata?.status).toBe('cancelled');
    expect(a.metadata?.usage_estimated).toBe(true);
    expect(typeof a.metadata?.duration_ms).toBe('number');
    expect(typeof a.metadata?.cost_usd).toBe('number');
    expect((a.metadata?.cost_usd as number)).toBeGreaterThan(0);
    expect(a.usage!.inputTokens).toBeGreaterThan(0);

    // message.added опубликован раньше stream.cancelled (UI успевает создать
    // сообщение, затем cancelStream лишь дополняет его — без дубля).
    const addedIdx = sequence.indexOf('message.added');
    const cancelledIdx = sequence.indexOf('stream.cancelled');
    expect(addedIdx).toBeGreaterThanOrEqual(0);
    expect(cancelledIdx).toBeGreaterThan(addedIdx);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('двойной cancel до первого токена: ровно одно assistant-сообщение', async () => {
    const h = await makeHarness('mockabortbefore');
    const fresh = (await h.sessionManager.getSession(h.sessionId))!;
    const streamId = (fresh.messages.find((m) => m.role === MessageRole.USER)!.metadata as Record<string, unknown>)
      .stream_id as string;

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const promise = run(h, new AbortController().signal, (event, data) => {
      chunks.push({ event, data });
      if (event === 'step.started') {
        // Двойной/повторный «Стоп»: второй cancel — no-op.
        h.orchestrator.cancel(streamId);
        h.orchestrator.cancel(streamId);
      }
    });

    await promise;

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistants = session.messages.filter(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.metadata?.status).toBe('cancelled');
    expect(chunks.filter((c) => c.event === 'stream.cancelled')).toHaveLength(1);
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('отмена с контентом: по-прежнему ровно одно assistant-сообщение', async () => {
    const h = await makeHarness('mockabortnomodel');
    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    let textDeltas = 0;
    const promise = run(h, ac.signal, (event, data) => {
      chunks.push({ event, data });
      // ADR-118 §4: текст шага — `part.delta` (прежний `stream.chunk` удалён).
      if (event === 'part.delta') {
        textDeltas++;
        if (textDeltas >= 2) setTimeout(() => ac.abort(), 5);
      }
    });
    await promise;

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistants = session.messages.filter(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content.length).toBeGreaterThan(0);
    expect(assistants[0]!.metadata?.status).toBe('cancelled');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('doom loop для НЕ-deny повторяющихся вызовов: 3-й вызов тоже даёт tool_call.result (error) и парный tool в истории', async () => {
    const h = await makeHarness('mockdoom');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // Первые два вызова read_file выполнились, третий заглушён doom loop —
    // результат всё равно публикуется (ADR: пара assistant(tool_calls) → tool
    // обязана существовать, иначе следующий LLM-вызов падает у провайдера).
    const toolResults = chunks.filter((c) => c.event === 'tool_call.result');
    expect(toolResults).toHaveLength(3);
    expect((toolResults[2]!.data.result as { isError?: boolean }).isError).toBe(true);

    // Провайдер вызван 4 раза: 3 tool-итерации + финальный текст
    expect(MockDoomProvider.calls).toBe(4);

    // Нормальное завершение текстом (ADR-118 §4: контент — в сообщении шага,
    // события шага/хода несут только терминальные статусы).
    expect(stepFinished(chunks).status).toBe('completed');
    expect(turnFinished(chunks).status).toBe('completed');
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const finalAssistant = [...session.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(finalAssistant!.content).toBe('Готово');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('пустой ответ модели без deny — подставляется общий fallback, в истории нет пустого assistant-сообщения', async () => {
    const h = await makeHarness('mockempty');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // ADR-118 §4: контент в сообщении шага, события шага/хода — статусы.
    // ADR-070 §2.6: пустой ответ модели → ход и шаг `error`.
    expect(stepFinished(chunks).status).toBe('error');
    expect(turnFinished(chunks).status).toBe('error');

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('Could not complete the request: the model response was empty');
    expect(assistant!.metadata?.status).toBe('error');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('doom-loop: парный tool персистится, sessionMessagesToLlm даёт валидный диалог', async () => {
    const h = await makeHarness('mockdoom');
    const result = await run(h, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    // Третий (doom) вызов тоже имеет tool-сообщение.
    const thirdTool = session.messages.find((m) => m.role === MessageRole.TOOL && m.toolCallId === 'call_r2');
    expect(thirdTool).toBeDefined();
    expect(thirdTool!.content).toContain('Loop broken');

    const llm = sessionMessagesToLlm(session.messages, 'fixer', 'user');
    for (let i = 0; i < llm.length; i++) {
      const m = llm[i]!;
      if (m.role !== 'assistant' || !m.toolUse?.length) continue;
      const ids = m.toolUse.map((tc) => tc.id as string);
      // Все tool-результаты батча — сразу за assistant(toolUse), без user между.
      let cursor = i + 1;
      const seen: string[] = [];
      while (cursor < llm.length && llm[cursor]!.role === 'tool') {
        seen.push(llm[cursor]!.toolCallId as string);
        cursor++;
      }
      expect(seen).toEqual(ids);
    }
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('кривой tool call без function.name: error-результат tool.malformed_call, пара не рвётся', async () => {
    MockScriptProvider.script = [
      { content: '', toolCalls: [{ id: 'call_bad' }] },
      { content: 'Готово' },
    ];
    const h = await makeHarness('mockscript');
    const result = await run(h, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const tool = session.messages.find((m) => m.role === MessageRole.TOOL && m.toolCallId === 'call_bad');
    expect(tool).toBeDefined();
    expect(tool!.content).toContain('malformed tool call');

    const llm = sessionMessagesToLlm(session.messages, 'fixer', 'user');
    const assistant = llm.find((m) => m.role === 'assistant' && m.toolUse?.some((tc) => tc.id === 'call_bad'));
    expect(assistant).toBeDefined();
    const idx = llm.indexOf(assistant!);
    expect(llm[idx + 1]).toMatchObject({ role: 'tool', toolCallId: 'call_bad' });
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('исключение в туле: error-результат tool.exec_error, ход продолжается', async () => {
    MockScriptProvider.script = [
      {
        content: '',
        toolCalls: [{ id: 'call_boom', function: { name: 'boom', arguments: '{}' } }],
      },
      { content: 'Готово' },
    ];
    const registry = createToolRegistry();
    registry.register({
      name: 'boom',
      description: 'always throws',
      parameters: z.object({}).passthrough(),
      capabilities: [],
      async execute() { throw new Error('boom!'); },
    } as unknown as ToolDefinition);
    const h = await makeHarness('mockscript', registry);
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const tool = session.messages.find((m) => m.role === MessageRole.TOOL && m.toolCallId === 'call_boom');
    expect(tool).toBeDefined();
    expect(tool!.content).toContain('execution error');
    expect(tool!.content).toContain('boom!');

    const llm = sessionMessagesToLlm(session.messages, 'fixer', 'user');
    const idx = llm.findIndex((m) => m.role === 'assistant' && m.toolUse?.some((tc) => tc.id === 'call_boom'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(llm[idx + 1]).toMatchObject({ role: 'tool', toolCallId: 'call_boom' });
    // Ход не упал — модель получила результат и ответила текстом
    // (ADR-118 §4: контент — в сообщении шага, события несут статусы).
    expect(stepFinished(chunks).status).toBe('completed');
    expect(turnFinished(chunks).status).toBe('completed');
    const finalAssistant = [...session.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(finalAssistant!.content).toBe('Готово');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('plan_enter + второй тул в одном батче: mode_change пишется после всех tool-результатов', async () => {
    MockScriptProvider.script = [
      {
        content: '',
        toolCalls: [
          { id: 'call_plan', function: { name: 'plan_enter', arguments: '{}' } },
          { id: 'call_list', function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) } },
        ],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness('mockscript');
    const result = await run(h, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistantIdx = session.messages.findIndex(
      (m) => m.role === MessageRole.ASSISTANT && m.toolCalls?.some((tc) => tc.id === 'call_plan'),
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const planIdx = session.messages.findIndex((m) => m.role === MessageRole.TOOL && m.toolCallId === 'call_plan');
    const listIdx = session.messages.findIndex((m) => m.role === MessageRole.TOOL && m.toolCallId === 'call_list');
    // Первое mode_change могло быть записано при входе в ход (syncStateMessages) —
    // ищем именно durable state-сообщение ПОСЛЕ батча тулов.
    const stateIdx = session.messages.findIndex(
      (m, i) => i > assistantIdx && m.metadata?.type === 'mode_change',
    );
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(stateIdx).toBeGreaterThan(planIdx);
    expect(stateIdx).toBeGreaterThan(listIdx);

    // Между assistant(tool_calls) и его tool-результатами нет user/state.
    expect(session.messages[assistantIdx + 1]!.toolCallId).toBe('call_plan');
    expect(session.messages[assistantIdx + 2]!.toolCallId).toBe('call_list');
    expect(stateIdx).toBe(assistantIdx + 3);
    await rm(h.tmpDir, { recursive: true, force: true });
  });
});

/** Тул, который «работает», пока его не прервут через ctx.abortSignal. */
function makeSlowAbortableTool(): ToolDefinition {
  return {
    name: 'slow_tool',
    description: 'тестовый долгий тул — завершается при отмене',
    parameters: z.object({}),
    capabilities: [ToolCapability.RUNTIME],
    async execute(_args: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { content: 'slow_tool: прерван отменой' };
    },
  } as unknown as ToolDefinition;
}

/**
 * Провайдер для теста отмены ВО ВРЕМЯ исполнения тула:
 * вызов 0 — текст + slow_tool; вызов 1 — не должен произойти
 * (если баг вернулся, провайдер повиснет до отмены — тест это детектирует).
 */
class MockToolCancelProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockToolCancelProvider.calls++;
    if (n === 0) {
      yield {
        content: 'Запускаю долгий тул', isFinal: true,
        toolCalls: [{ id: 'call_slow', function: { name: 'slow_tool', arguments: '{}' } }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    // Второй итерации быть не должно: до её начала отмена уже зафиксирована.
    // Если баг вернулся — цикл родителя дойдёт сюда и провайдер повиснет.
    while (!ct?.cancelled) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return;
  }

  getProviderName(): string {
    return 'mocktoolcancel';
  }
}

describe('ChatOrchestrator: отмена во время исполнения тула', () => {
  beforeEach(() => {
    ProviderFactory.register('mocktoolcancel', MockToolCancelProvider);
    MockToolCancelProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mocktoolcancel');
  });

  it('abort во время тулa: публикуется stream.cancelled (не «ответ модели пуст» через stream.done), tool-chain сохранён', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'synth-tool-cancel-'));
    const store = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(store);
    const eventBus = new EventBus();
    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeSlowAbortableTool());
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'mocktoolcancel', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
      defaultWorkingDir: tmpDir,
      contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
    });
    const session = await sessionManager.createSession({
      title: 'ToolCancel',
      settings: { provider: 'mocktoolcancel', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
    });
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);

    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const fresh = (await sessionManager.getSession(session.id))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;

    const promise = processMessage(fresh, userMsg, ac.signal, (event, data) => {
      chunks.push({ event, data });
      // Тул запущен — жмём «Стоп»
      if (event === 'tool_call.started') {
        setTimeout(() => ac.abort(), 10);
      }
    });
    await promise;

    // Сабагент-тул прерван, вторая LLM-итерация не началась
    expect(MockToolCancelProvider.calls).toBe(1);

    // Завершение — как отмена: stream.cancelled, БЕЗ stream.done с «ответ модели пуст»
    const cancelled = chunks.find((c) => c.event === 'stream.cancelled');
    expect(cancelled).toBeDefined();
    expect((cancelled!.data as Record<string, unknown>).stream_id).toBe(
      (msg.metadata as Record<string, unknown>).stream_id,
    );
    expect((cancelled!.data as Record<string, unknown>).status).toBe('cancelled');
    const done = chunks.find((c) => c.event === 'stream.done');
    expect(done).toBeUndefined();

    // Результат тулa опубликован (UI видит, чем тул завершился)
    const toolResult = chunks.find((c) => c.event === 'tool_call.result');
    expect(toolResult).toBeDefined();
    expect(((toolResult!.data as Record<string, unknown>).result as { content: string }).content)
      .toContain('прерван отменой');

    // История: tool-chain сохранён (assistant с toolCalls + tool), без фейкового финала
    const updated = (await sessionManager.getSession(session.id))!;
    const toolMsg = updated.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('прерван отменой');
    // Шаг 2а: tool-результат записан сразу (tool_chain), пара assistant(tool_calls) уже есть.
    expect(toolMsg!.metadata?.tool_chain).toBe(true);
    // Промежуточный шаг — assistant с вызовами инструментов. Маркер
    // `tool_chain` у него НЕ ставится: у шага есть текст ('Запускаю долгий
    // тул') — такой шаг нельзя скрывать из транскрипта.
    const chainAssistant = updated.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(chainAssistant).toBeDefined();
    expect(chainAssistant!.toolCalls).toHaveLength(1);
    expect(chainAssistant!.metadata?.tool_chain).toBeUndefined();
    expect(updated.messages.indexOf(toolMsg!)).toBe(updated.messages.indexOf(chainAssistant!) + 1);
    const cancelledAssistant = [...updated.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) === 0,
    );
    expect(cancelledAssistant).toBeDefined();
    expect(cancelledAssistant!.metadata?.status).toBe('cancelled');
    // ADR-118 §1: сводка вызовов хода — в сообщении СВОЕГО шага; в сообщении
    // отмены её нет (иначе карточки инструментов дублировались бы в ленте).
    expect(cancelledAssistant!.metadata?.tool_results).toBeUndefined();
    // Результат прерванного тула — в сообщении шага, где вызов и был.
    const stepToolResults = chainAssistant!.metadata?.tool_results as Array<{
      name: string;
      result?: { content: string };
    }> | undefined;
    expect(stepToolResults).toBeDefined();
    expect(stepToolResults).toHaveLength(1);
    expect(stepToolResults![0]!.name).toBe('slow_tool');
    expect(stepToolResults![0]!.result?.content).toContain('прерван отменой');
    // Отмена не должна плодить записи с одинаковым id: id сообщения шага уже
    // занят tool-chain записью — новая запись отмены получает свой.
    const ids = updated.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    await rm(tmpDir, { recursive: true, force: true });
  });
});
