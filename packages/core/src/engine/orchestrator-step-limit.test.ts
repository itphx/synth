/**
 * Финальный шаг по лимиту шагов в основном цикле оркестратора (механика
 * opencode): лимит агента (`AgentDefinition.maxSteps`) не обрывает ход
 * отдельным вызовом «без инструментов», а добавляет ещё один обычный шаг того
 * же цикла — `tools` остаются в запросе (кэшированный префикс провайдера),
 * вызов запрещается `toolChoice: 'none'`, инструкция «только текст» едет
 * assistant-сообщением.
 *
 * Здесь проверяется поведение на реальном цикле оркестратора (а не только
 * модуля инструкции): запрос шага-лимита, неисполнение tool call и штатное
 * завершение хода текстом отчёта.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { ChatOptions, LLMMessage, SystemPromptInput } from '../providers/base.js';
import { OpenAIProvider } from '../providers/openai.js';
import { t as sm } from './system-messages.js';
import type { ContextBuilder } from './context/builder.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import { generateId, MessageRole, nowISO, makeTextPart, type Message } from '@itphx/synth-shared';

interface ScriptStep {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  content?: string;
}

/** Записанный LLM-вызов шага: сообщения, инструменты и опции (6-й аргумент `chatAsync`). */
interface RecordedCall {
  messages: LLMMessage[];
  tools?: Record<string, unknown>[];
  options?: ChatOptions;
}

class StepLimitScriptProvider extends BaseProvider {
  private static _script: ScriptStep[] = [];
  private static _step = 0;
  /** Все вызовы `chatAsync` за прогон — в порядке шагов. */
  static calls: RecordedCall[] = [];

  static configure(script: ScriptStep[]): void {
    this._script = script;
    this._step = 0;
    this.calls = [];
  }

  private _currentStep(): ScriptStep {
    const idx = Math.min(
      StepLimitScriptProvider._step,
      Math.max(0, StepLimitScriptProvider._script.length - 1),
    );
    return StepLimitScriptProvider._script[idx] ?? {};
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'done', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: unknown,
    options?: ChatOptions,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    StepLimitScriptProvider.calls.push({ messages, tools, options });
    const step = this._currentStep();
    const stepIndex = StepLimitScriptProvider._step;
    const toolCalls = step.toolCalls?.map((t) => ({
      id: `call_${t.name}_${stepIndex}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
    StepLimitScriptProvider._step++;
    yield {
      content: step.content ?? '',
      isFinal: true,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls,
    };
  }

  getProviderName(): string {
    return 'steplimit';
  }
}

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(content = 'выполни задачу'): Message {
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
    metadata: { stream_id: generateId() },
  };
}

describe('ChatOrchestrator — финальный шаг по лимиту шагов (механика opencode)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let orchestrator: ChatOrchestrator;
  let agentRegistry: ReturnType<typeof createAgentRegistry>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-step-limit-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('steplimit', StepLimitScriptProvider);

    const toolRegistry = createToolRegistry();
    // Лимит шагов берётся из определения агента: подменяем maxSteps у `fixer`
    // (реестр хранит запись по id, `register` её заменяет). opencode-семантика:
    // `maxSteps: 2` — один рабочий шаг + шаг-лимит.
    agentRegistry = createAgentRegistry(toolRegistry);
    const fixer = agentRegistry.get('fixer')!;
    agentRegistry.register({ ...fixer, maxSteps: 2 });

    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => ({
        name,
        type: 'steplimit',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      toolRegistry,
      agentRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 },
      dataDir: tmpDir,
      defaultWorkingDir: tmpDir,
    });
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('steplimit');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runTurn(sessionId: string): Promise<void> {
    const msg = makeUserMessage();
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    const result = await orchestrator.createProcessMessage()(
      fresh, msg, new AbortController().signal, () => {},
    );
    expect(result.error).toBeUndefined();
  }

  function toolNames(tools: Record<string, unknown>[] | undefined): string[] {
    return (tools ?? []).map((t) => (t.function as { name: string }).name);
  }

  it('maxSteps=2: шаг-лимит — обычный шаг (tools в запросе, toolChoice=none), tool call не исполняется, ход завершается отчётом', async () => {
    // Шаг 1 — работа (tool call). Шаг 2 — лимит: провайдер, игнорируя
    // `toolChoice: 'none'`, вернул и текст отчёта, и tool call; вызов
    // исполняться не должен, текст — финальный ответ хода.
    StepLimitScriptProvider.configure([
      { toolCalls: [{ name: 'todo_add', args: { todos: [{ content: 'step-1' }] } }] },
      {
        content: 'ОТЧЁТ: лимит шагов исчерпан, сделано 1 из 3',
        toolCalls: [{ name: 'todo_add', args: { todos: [{ content: 'limit-step' }] } }],
      },
    ]);
    const session = await sessionManager.createSession({
      title: 'StepLimit',
      userId: 'u1',
      settings: { provider: 'steplimit', model: 'm', agentRole: 'fixer' },
    });

    await runTurn(session.id);

    const calls = StepLimitScriptProvider.calls;
    expect(calls).toHaveLength(2);

    // (а) На шаге-лимите инструменты остаются в запросе (не вырезаются).
    expect(calls[0]!.options).toBeUndefined();
    expect(calls[1]!.tools).toBeDefined();
    expect(toolNames(calls[1]!.tools).length).toBeGreaterThan(0);
    expect(toolNames(calls[1]!.tools)).toContain('todo_add');
    // (б) Вызов инструментов на этом шаге запрещён опцией.
    expect(calls[1]!.options).toEqual({ toolChoice: 'none' });

    // (в) tool call шага-лимита не исполнялся: в todo попал только шаг 1.
    const after = (await sessionManager.getSession(session.id))!;
    const todoContents = (after.todos ?? []).map((t) => t.content);
    expect(todoContents).toEqual(['step-1']);
    expect(todoContents).not.toContain('limit-step');

    // (г) Ход завершился штатно текстом отчёта (не фоллбеком «лимит итераций»).
    const finalMessage = [...after.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(finalMessage?.content).toContain('ОТЧЁТ: лимит шагов исчерпан');
    expect(finalMessage?.metadata?.status).not.toBe('error');

    // (г2) Паритет с opencode: assistant(tool_calls) шага-лимита сохранён и
    // получил парный `tool`-результат с ошибкой — вызов не исполнялся.
    const limitAssistant = after.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && m.content.includes('ОТЧЁТ: лимит шагов исчерпан'),
    );
    expect(limitAssistant?.toolCalls).toHaveLength(1);
    const limitCallId = (limitAssistant!.toolCalls![0] as { id: string }).id;
    const limitToolResult = after.messages.find(
      (m) => m.role === MessageRole.TOOL && m.toolCallId === limitCallId,
    );
    expect(limitToolResult).toBeDefined();
    expect(limitToolResult!.content).toBe(
      sm('tool.disabled_by_step_limit', { tool: 'todo_add', limit: '2' }),
    );
    expect(limitToolResult!.metadata?.isError).toBe(true);
    expect(limitToolResult!.metadata?.i18n).toMatchObject({ key: 'tool.disabled_by_step_limit' });

    // (д) На шаге-лимите последнее сообщение запроса — синтетический
    // assistant-префилл с требованием «только текст».
    const limitMessages = calls[1]!.messages;
    const last = limitMessages[limitMessages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('MAXIMUM STEPS REACHED');

    // (е) DeepSeek требует `reasoning_content` у **каждого** assistant-сообщения.
    // Старый код отправлял префилл без поля → 400 «The `reasoning_content` in
    // the thinking mode must be passed back to the API».
    const formatter = new OpenAIProvider({
      url: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: 'k',
      model: 'deepseek-flash',
    }) as unknown as { _formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>> };
    const formatted = formatter._formatMessages(limitMessages);
    const assistants = formatted.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBeGreaterThan(0);
    for (const entry of assistants) {
      expect(entry.reasoning_content).toBeDefined();
    }
  });

  it('maxSteps=2: пустой ответ на шаге-лимите → отчёт session.steps_limit + step_limit_reached', async () => {
    StepLimitScriptProvider.configure([
      { toolCalls: [{ name: 'todo_add', args: { todos: [{ content: 'step-1' }] } }] },
      { content: '' },
    ]);
    const session = await sessionManager.createSession({
      title: 'StepLimitEmpty',
      userId: 'u1',
      settings: { provider: 'steplimit', model: 'm', agentRole: 'fixer' },
    });

    await runTurn(session.id);

    const after = (await sessionManager.getSession(session.id))!;
    const finalMessage = [...after.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(finalMessage?.content).toBe(sm('session.steps_limit', { limit: '2' }));
    expect(finalMessage?.metadata?.status).toBe('limit');
    expect(finalMessage?.metadata?.step_limit_reached).toBe(true);
  });

  it('maxSteps=1: шаг-лимит наступает сразу — без tool call ход завершается ответом модели', async () => {
    // opencode-семантика: `step` с 1, `stepLimitReached = step >= maxSteps`,
    // поэтому при `maxSteps: 1` единственный шаг — финальный.
    agentRegistry.register({ ...agentRegistry.get('fixer')!, maxSteps: 1 });
    StepLimitScriptProvider.configure([{ content: 'готово' }]);
    const session = await sessionManager.createSession({
      title: 'StepLimitNoTools',
      userId: 'u1',
      settings: { provider: 'steplimit', model: 'm', agentRole: 'fixer' },
    });

    await runTurn(session.id);

    const calls = StepLimitScriptProvider.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ toolChoice: 'none' });

    const after = (await sessionManager.getSession(session.id))!;
    const finalMessage = [...after.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(finalMessage?.content).toBe('готово');
    expect(finalMessage?.metadata?.step_limit_reached).toBe(true);
  });

  it('maxSteps=1: tool call на единственном шаге не исполняется, но пара assistant→tool сохраняется', async () => {
    agentRegistry.register({ ...agentRegistry.get('fixer')!, maxSteps: 1 });
    StepLimitScriptProvider.configure([
      { toolCalls: [{ name: 'todo_add', args: { todos: [{ content: 'limit-only' }] } }] },
    ]);
    const session = await sessionManager.createSession({
      title: 'StepLimitOnly',
      userId: 'u1',
      settings: { provider: 'steplimit', model: 'm', agentRole: 'fixer' },
    });

    await runTurn(session.id);

    // Рабочих шагов нет — единственный вызов LLM это шаг-лимит.
    expect(StepLimitScriptProvider.calls).toHaveLength(1);
    expect(StepLimitScriptProvider.calls[0]!.options).toEqual({ toolChoice: 'none' });

    const after = (await sessionManager.getSession(session.id))!;
    // Вызов не исполнялся.
    expect((after.todos ?? []).map((t) => t.content)).toEqual([]);
    // Пара assistant(tool_calls) → tool сохранена.
    const limitAssistant = after.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(limitAssistant).toBeDefined();
    const limitCallId = (limitAssistant!.toolCalls![0] as { id: string }).id;
    const limitToolResult = after.messages.find(
      (m) => m.role === MessageRole.TOOL && m.toolCallId === limitCallId,
    );
    expect(limitToolResult?.content).toBe(
      sm('tool.disabled_by_step_limit', { tool: 'todo_add', limit: '1' }),
    );
    expect(limitToolResult?.metadata?.isError).toBe(true);

    const finalMessage = [...after.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(finalMessage.content).toBe(sm('session.steps_limit', { limit: '1' }));
    expect(finalMessage.metadata?.status).toBe('limit');
    expect(finalMessage.metadata?.step_limit_reached).toBe(true);
  });

  it('ADR-117: effort из reasoningLevel попадает в ChatOptions, смена между ходами подхватывается', async () => {
    StepLimitScriptProvider.configure([{ content: 'ok' }]);
    const session = await sessionManager.createSession({
      title: 'Effort',
      userId: 'u1',
      settings: { provider: 'steplimit', model: 'm', agentRole: 'fixer' },
    });
    // `createSession` собирает settings по whitelist — reasoningLevel задаём
    // через updateSession (как это делает PATCH /sessions/:id).
    await sessionManager.withLock(session.id, async (s) => {
      s.settings = { ...s.settings, reasoningLevel: 'high' };
      await sessionManager.updateSession(s);
    });

    await runTurn(session.id);
    expect(StepLimitScriptProvider.calls).toHaveLength(1);
    expect(StepLimitScriptProvider.calls[0]!.options).toEqual({ effort: 'high' });

    // Смена настройки между ходами: следующий LLM-вызов несёт новый effort.
    await sessionManager.withLock(session.id, async (s) => {
      s.settings = { ...s.settings, reasoningLevel: 'low' };
      await sessionManager.updateSession(s);
    });
    StepLimitScriptProvider.configure([{ content: 'ok-2' }]);
    await runTurn(session.id);
    expect(StepLimitScriptProvider.calls[0]!.options).toEqual({ effort: 'low' });

    // `none` — effort не вычисляется и опции не создаются (форма undefined сохранена).
    await sessionManager.withLock(session.id, async (s) => {
      s.settings = { ...s.settings, reasoningLevel: 'none' };
      await sessionManager.updateSession(s);
    });
    StepLimitScriptProvider.configure([{ content: 'ok-3' }]);
    await runTurn(session.id);
    expect(StepLimitScriptProvider.calls[0]!.options).toBeUndefined();
  });
});
