/**
 * ADR-041 × continuation: продолжение хода после ответа, срезанного лимитом
 * вывода (`finish_reason: length`/`max_tokens`).
 *
 * Проводка хелперов в **цикл хода** основной сессии (паритет с opencode
 * `CONTINUE_AFTER_OUTPUT_LIMIT`):
 *  - первый и второй обрезанный ответ **не финализируют ход**: в историю
 *    кладётся служебное сообщение продолжения (`output_limit_notice`,
 *    шаблон `prompts/system/OUTPUT_LIMIT.{lang}.md`) и ход идёт следующим
 *    LLM-вызовом без нового пользовательского ввода;
 *  - третий обрезанный ответ подряд — исход `output_limit`: финальный текст
 *    `session.output_limit_exhausted`, статус сообщения `limit`,
 *    durable-запись причины остановки (PROP-143);
 *  - обычный ответ (`end_turn`) не затронут;
 *  - обрезанный ответ **с** вызовами инструментов продолжением не считается
 *    (серия не растёт) — обрезанный tool-call отдельная задача;
 *  - пустой ответ идёт своим путём (`session.empty_response`) и с серией
 *    продолжений не смешивается;
 *  - продолжение **не расходует** лимит шагов агента (`maxSteps`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmFinishReason, Message, TokenUsage } from '@itphx/synth-shared';
import { generateId, MessageRole, makeTextPart, nowISO } from '@itphx/synth-shared';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { ChatOptions, LLMMessage, SystemPromptInput } from '../providers/base.js';
import { t as sm } from './system-messages.js';
import { OUTPUT_LIMIT_NOTICE_TYPE } from './output-limit-notice.js';
import { STOP_MESSAGE_TYPE } from './stop-reason.js';
import type { ContextBuilder } from './context/builder.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';

interface ScriptStep {
  content?: string;
  /** Причина завершения шага (нормализованный словарь провайдера). */
  finishReason?: LlmFinishReason;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  usage?: TokenUsage & { reasoningTokens?: number };
}

interface RecordedCall {
  messages: LLMMessage[];
  options?: ChatOptions;
}

/** Провайдер по скрипту: шаг N отдаёт шаг N (последний повторяется). */
class OutputLimitScriptProvider extends BaseProvider {
  private static _script: ScriptStep[] = [];
  private static _step = 0;
  static calls: RecordedCall[] = [];

  static configure(script: ScriptStep[]): void {
    this._script = script;
    this._step = 0;
    this.calls = [];
  }

  private _currentStep(): ScriptStep {
    const idx = Math.min(
      OutputLimitScriptProvider._step,
      Math.max(0, OutputLimitScriptProvider._script.length - 1),
    );
    return OutputLimitScriptProvider._script[idx] ?? {};
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return {
      content: 'done',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: unknown,
    options?: ChatOptions,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    OutputLimitScriptProvider.calls.push({ messages, options });
    const step = this._currentStep();
    const stepIndex = OutputLimitScriptProvider._step;
    const toolCalls = step.toolCalls?.map((t) => ({
      id: `call_${t.name}_${stepIndex}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
    OutputLimitScriptProvider._step++;
    yield {
      content: step.content ?? '',
      isFinal: true,
      model: this.model,
      usage: step.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ...(step.finishReason ? { finishReason: step.finishReason } : {}),
      toolCalls,
    };
  }

  getProviderName(): string {
    return 'outputlimit';
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

describe('ChatOrchestrator — продолжение после лимита вывода (ADR-041)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let orchestrator: ChatOrchestrator;
  let agentRegistry: ReturnType<typeof createAgentRegistry>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-output-limit-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('outputlimit', OutputLimitScriptProvider);
    OutputLimitScriptProvider.configure([{ content: 'ответ', finishReason: 'end_turn' }]);

    const toolRegistry = createToolRegistry();
    agentRegistry = createAgentRegistry(toolRegistry);
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => ({
        name,
        type: 'outputlimit',
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
    ProviderFactory['_providers'].delete('outputlimit');
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

  async function createSession(title: string, agentRole = 'fixer'): Promise<string> {
    const session = await sessionManager.createSession({
      title,
      userId: 'u1',
      settings: { provider: 'outputlimit', model: 'm', agentRole },
    });
    return session.id;
  }

  async function messagesOf(sessionId: string): Promise<Message[]> {
    return (await sessionManager.getSession(sessionId))!.messages;
  }

  function notices(messages: Message[]): Message[] {
    return messages.filter((m) => m.metadata?.type === OUTPUT_LIMIT_NOTICE_TYPE);
  }

  function stopRecords(messages: Message[]): Message[] {
    return messages.filter((m) => m.metadata?.type === STOP_MESSAGE_TYPE);
  }

  function lastAssistant(messages: Message[]): Message | undefined {
    return [...messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
  }

  it('length → продолжение → успешный ответ: два notice, финал — третий ответ', async () => {
    OutputLimitScriptProvider.configure([
      {
        content: 'Часть 1',
        finishReason: 'length',
        usage: { inputTokens: 10, outputTokens: 4096, totalTokens: 4106, reasoningTokens: 4000 },
      },
      {
        content: 'Часть 2',
        finishReason: 'length',
        usage: { inputTokens: 10, outputTokens: 4096, totalTokens: 4106, reasoningTokens: 3000 },
      },
      { content: 'Итог', finishReason: 'end_turn' },
    ]);
    const sessionId = await createSession('OutputLimitContinue');

    await runTurn(sessionId);

    // Три вызова: два обрезанных ответа и успешное продолжение.
    expect(OutputLimitScriptProvider.calls).toHaveLength(3);

    const all = await messagesOf(sessionId);
    const limitNotices = notices(all);
    expect(limitNotices).toHaveLength(2);

    // Номера продолжений подставлены (attempt/max) — и в тексте шаблона, и в
    // метаданных (по ним UI рисует бейдж).
    expect(limitNotices[0]!.metadata).toMatchObject({ attempt: 1, max_attempts: 2 });
    expect(limitNotices[1]!.metadata).toMatchObject({ attempt: 2, max_attempts: 2 });
    expect(limitNotices[0]!.content).toContain('продолжение 1 из 2');
    expect(limitNotices[1]!.content).toContain('продолжение 2 из 2');
    // Расход шага подставлен в `{limit}`/`{reasoning}`.
    expect(limitNotices[0]!.content).toContain('4096');
    expect(limitNotices[0]!.content).toContain('4000');
    // Служебное сообщение — не реплика человека.
    expect(limitNotices[0]!.author).toBe('System');

    // Инструкция продолжения реально ушла модели: она есть в контексте
    // следующего вызова (иначе повтор упёрся бы в тот же лимит).
    const secondCall = OutputLimitScriptProvider.calls[1]!.messages;
    expect(secondCall.some((m) => m.content.includes('продолжение 1 из 2'))).toBe(true);

    // Ход завершён успешно текстом третьего ответа, а не «обрезком» и не
    // исходом `output_limit`.
    const final = lastAssistant(all);
    expect(final?.content).toBe('Итог');
    expect(final?.metadata?.status).toBe('completed');
    expect(final?.metadata?.i18n).toBeUndefined();
    expect(stopRecords(all)).toHaveLength(0);
  });

  it('3×length → исход output_limit: 3 вызова, session.output_limit_exhausted, запись reason=output_limit', async () => {
    OutputLimitScriptProvider.configure([
      { content: 'Обрезок 1', finishReason: 'length' },
      { content: 'Обрезок 2', finishReason: 'length' },
      { content: 'Обрезок 3', finishReason: 'length' },
    ]);
    const sessionId = await createSession('OutputLimitExhausted');

    await runTurn(sessionId);

    // Ровно три вызова: два продолжения и третья (исчерпывающая) попытка.
    expect(OutputLimitScriptProvider.calls).toHaveLength(3);

    const all = await messagesOf(sessionId);
    // Продолжений было два (третий обрезок — уже исход, а не продолжение).
    expect(notices(all)).toHaveLength(2);

    const final = lastAssistant(all);
    expect(final?.content).toBe(sm('session.output_limit_exhausted'));
    expect(final?.metadata?.status).toBe('limit');
    expect(final?.metadata?.i18n).toMatchObject({ key: 'session.output_limit_exhausted' });

    // PROP-143: durable-причина остановки — `output_limit`.
    const records = stopRecords(all);
    expect(records).toHaveLength(1);
    expect(records[0]!.metadata).toMatchObject({ reason: 'output_limit' });
    expect(records[0]!.content).toContain('reason="output_limit"');

    // Обрезанные ответы не потеряны: у каждого свой шаг с текстом в истории.
    const assistantContents = all
      .filter((m) => m.role === MessageRole.ASSISTANT)
      .map((m) => m.content);
    expect(assistantContents).toContain('Обрезок 1');
    expect(assistantContents).toContain('Обрезок 2');
    expect(assistantContents).toContain('Обрезок 3');
  });

  it('обычный ответ (end_turn) не затронут: один вызов, notice нет', async () => {
    OutputLimitScriptProvider.configure([{ content: 'Готово', finishReason: 'end_turn' }]);
    const sessionId = await createSession('OutputLimitNormal');

    await runTurn(sessionId);

    expect(OutputLimitScriptProvider.calls).toHaveLength(1);
    const all = await messagesOf(sessionId);
    expect(notices(all)).toHaveLength(0);
    expect(stopRecords(all)).toHaveLength(0);
    const final = lastAssistant(all);
    expect(final?.content).toBe('Готово');
    expect(final?.metadata?.status).toBe('completed');
  });

  it('length с tool-call в шаге не считается продолжением: серия не растёт', async () => {
    OutputLimitScriptProvider.configure([
      {
        content: '',
        finishReason: 'length',
        toolCalls: [{ name: 'todo_add', args: { todos: [{ content: 'шаг-1' }] } }],
      },
      { content: 'Готово', finishReason: 'end_turn' },
    ]);
    const sessionId = await createSession('OutputLimitToolCall');

    await runTurn(sessionId);

    // Обрезанный ответ с вызовами — обычная обработка шага (не продолжение).
    expect(OutputLimitScriptProvider.calls).toHaveLength(2);
    const all = await messagesOf(sessionId);
    expect(notices(all)).toHaveLength(0);
    expect(stopRecords(all)).toHaveLength(0);
    expect(lastAssistant(all)?.content).toBe('Готово');
    // Второй вызов — шаг агента: лимит шагов не подменён шагом-лимитом.
    expect(OutputLimitScriptProvider.calls[1]!.options).toBeUndefined();
  });

  it('пустой ответ не смешивается с продолжением: пустой финал своим путём', async () => {
    OutputLimitScriptProvider.configure([
      { content: 'Обрезок', finishReason: 'length' },
      // Пустой ответ: ни текста, ни вызовов, естественное завершение.
      { content: '', finishReason: 'end_turn' },
    ]);
    const sessionId = await createSession('OutputLimitEmpty');

    await runTurn(sessionId);

    const all = await messagesOf(sessionId);
    // Продолжение ровно одно (от обрезанного ответа), пустой финал его не
    // добавил: счётчики независимы.
    expect(notices(all)).toHaveLength(1);
    const final = lastAssistant(all);
    expect(final?.content).toBe(sm('session.empty_response'));
    expect(final?.metadata?.status).toBe('error');
    expect(final?.metadata?.i18n).toMatchObject({ key: 'session.empty_response' });
    expect(stopRecords(all)).toHaveLength(0);
  });

  it('продолжение не расходует лимит шагов агента (maxSteps=2)', async () => {
    // Агент с лимитом в 2 шага: первый шаг обрезан (`length`) — продолжение
    // не должно «съесть» второй шаг и превратить ход в `session.steps_limit`.
    const fixer = agentRegistry.get('fixer')!;
    agentRegistry.register({ ...fixer, maxSteps: 2 });
    try {
      OutputLimitScriptProvider.configure([
        { content: 'Часть 1', finishReason: 'length' },
        { content: 'Готово', finishReason: 'end_turn' },
      ]);
      const sessionId = await createSession('OutputLimitStepBudget');

      await runTurn(sessionId);

      expect(OutputLimitScriptProvider.calls).toHaveLength(2);
      // Второй вызов — обычный шаг агента, а не шаг-лимит (`toolChoice: 'none'`).
      expect(OutputLimitScriptProvider.calls[1]!.options).toBeUndefined();

      const all = await messagesOf(sessionId);
      const final = lastAssistant(all);
      expect(final?.content).toBe('Готово');
      expect(final?.metadata?.status).toBe('completed');
      expect(final?.metadata?.step_limit_reached).toBeUndefined();
    } finally {
      agentRegistry.register(fixer);
    }
  });
});
