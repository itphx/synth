/**
 * Тул `question` в истории хода (ADR-112 × ADR-118 §1).
 *
 * Вопрос пользователю — обычный вызов инструмента: шаг с вызовом обязан
 * остаться в истории **видимым** (`metadata.tool_chain` нет), а его
 * `metadata.tool_results` — нести запись `question` с аргументами (вопросы и
 * варианты) и результатом (ответы пользователя). DTO (`serializeMessage`)
 * отдаёт эту запись в `tool_calls` — по ней UI рисует раскрывающуюся карточку.
 *
 * Два сценария: `question` — единственный вызов итерации; `question` вместе с
 * другим тулом (`todo_add`) в одной итерации.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { createToolRegistry } from '../tools/index.js';
import { QuestionService } from '../question/service.js';
import { MemoryQuestionRepository } from '../../storage/memory/questions.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import type { ContextBuilder } from '../context/builder.js';
import type { Message } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import { serializeMessage } from '../../server/serialize.js';

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
    parts: [makeTextPart('задай вопрос')],
    content: 'задай вопрос',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

const QUESTIONS = [
  {
    question: 'С какого модуля начинаем?',
    header: 'Модуль',
    options: [
      { value: 'qdevice', label: 'QDevice' },
      { value: 'other', label: 'Другое' },
    ],
  },
];

const ZERO_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Провайдер: первый шаг — вызовы инструментов, второй — финальный текст. */
class QuestionProvider extends BaseProvider {
  static toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  static calls = 0;

  static reset(): void {
    QuestionProvider.calls = 0;
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Принято', model: this.model, usage: ZERO_USAGE };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = QuestionProvider.calls++;
    if (n === 0) {
      yield {
        content: '',
        isFinal: true,
        model: this.model,
        usage: ZERO_USAGE,
        toolCalls: QuestionProvider.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
      return;
    }
    // Второй шаг — после tool-результатов.
    const hasToolResult = messages.some((m) => m.role === 'tool');
    expect(hasToolResult).toBe(true);
    yield {
      content: 'Принято: начинаем с QDevice',
      isFinal: true,
      model: this.model,
      usage: ZERO_USAGE,
    };
  }

  getProviderName(): string {
    return 'mockquestion';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  questionService: QuestionService;
  eventBus: EventBus;
  sessionId: string;
  tmpDir: string;
  userMessageId: string;
}

async function makeHarness(): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-question-history-'));
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const eventBus = new EventBus();
  const questionService = new QuestionService({
    repository: new MemoryQuestionRepository(),
    eventBus,
    timeoutMs: 0,
  });
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => ({ name, type: 'mockquestion', baseUrl: '', apiKey: '', defaultModel: 'm' }) as never,
    toolRegistry: createToolRegistry(),
    questionService,
    defaultWorkingDir: tmpDir,
  });
  const session = await sessionManager.createSession({
    title: 'QuestionHistory',
    settings: { provider: 'mockquestion', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  const msg = makeUserMessage();
  await sessionManager.addMessage(session.id, msg);
  return {
    orchestrator,
    sessionManager,
    questionService,
    eventBus,
    sessionId: session.id,
    tmpDir,
    userMessageId: msg.id,
  };
}

/** Автоответ на `user_question.asked` — как пользователь в UI. */
function autoAnswer(h: Harness): () => void {
  // Подписка на шину сессии: отвечаем на первый же заданный вопрос.
  let answering = false;
  return h.eventBus.subscribe(h.sessionId, (event) => {
    if (event.type !== 'user_question.asked' || answering) return;
    answering = true;
    const questionId = event.data.question_id as string | undefined;
    if (!questionId) return;
    void h.questionService.answer(questionId, [['qdevice']]);
  });
}

async function run(
  h: Harness,
  signal: AbortSignal = new AbortController().signal,
): Promise<import('../orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.id === h.userMessageId)!;
  return processMessage(fresh, userMsg, signal, () => {});
}

/** Шаг с вызовами инструментов (assistant-сообщение итерации). */
function stepWithCalls(messages: Message[]): Message | undefined {
  return messages.find(
    (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
  );
}

function findQuestionRecord(step: Message): Record<string, unknown> | undefined {
  const results = step.metadata?.tool_results as Array<Record<string, unknown>> | undefined;
  return results?.find((r) => r.name === 'question');
}

describe('question в истории хода: шаг виден, аргументы и ответы сохранены', () => {
  beforeEach(() => {
    ProviderFactory.register('mockquestion', QuestionProvider);
    QuestionProvider.reset();
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('mockquestion');
  });

  it('question — единственный тул итерации: карточка есть в истории и DTO', async () => {
    QuestionProvider.toolCalls = [
      { id: 'call_q', name: 'question', args: { questions: QUESTIONS } },
    ];
    const h = await makeHarness();
    const unsubscribe = autoAnswer(h);
    const result = await run(h);
    unsubscribe();
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const step = stepWithCalls(session.messages);
    expect(step).toBeDefined();
    // Шаг с вызовами инструментов виден — карточка не прячется как tool-chain.
    expect(step!.metadata?.tool_chain).toBeUndefined();

    const record = findQuestionRecord(step!);
    expect(record).toBeDefined();
    expect(record!.args).toMatchObject({ questions: QUESTIONS });
    const resultMeta = (record!.result as { metadata?: Record<string, unknown> }).metadata;
    expect(resultMeta?.answers).toEqual([['qdevice']]);

    // DTO отдаёт запись в tool_calls — по ней UI строит карточку.
    const dto = serializeMessage(step!, 0);
    const calls = dto.tool_calls as Array<Record<string, unknown>> | null;
    expect(calls).not.toBeNull();
    const questionCall = calls!.find((c) => c.name === 'question');
    expect(questionCall).toBeDefined();
    expect(questionCall!.args).toMatchObject({ questions: QUESTIONS });
    expect(
      (questionCall!.result as { metadata?: Record<string, unknown> }).metadata?.answers,
    ).toEqual([['qdevice']]);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('question вместе с todo_add в одной итерации: обе записи сохранены', async () => {
    QuestionProvider.toolCalls = [
      { id: 'call_q', name: 'question', args: { questions: QUESTIONS } },
      {
        id: 'call_todo',
        name: 'todo_add',
        args: { todos: [{ content: 'Начать с QDevice', status: 'pending' }] },
      },
    ];
    const h = await makeHarness();
    const unsubscribe = autoAnswer(h);
    const result = await run(h);
    unsubscribe();
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const step = stepWithCalls(session.messages);
    expect(step).toBeDefined();
    expect(step!.metadata?.tool_chain).toBeUndefined();

    const results = step!.metadata?.tool_results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.name)).toEqual(['question', 'todo_add']);
    const questionRecord = findQuestionRecord(step!)!;
    expect((questionRecord.result as { metadata?: Record<string, unknown> }).metadata?.answers)
      .toEqual([['qdevice']]);

    const dto = serializeMessage(step!, 0);
    const calls = dto.tool_calls as Array<Record<string, unknown>> | null;
    expect(calls?.map((c) => c.name)).toEqual(['question', 'todo_add']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('«Стоп» во время ожидания question: карточка с args остаётся в истории шага', async () => {
    QuestionProvider.toolCalls = [
      { id: 'call_q', name: 'question', args: { questions: QUESTIONS } },
    ];
    const h = await makeHarness();
    const controller = new AbortController();
    const processing = run(h, controller.signal);

    // Дождаться постановки вопроса (запись появилась) — и нажать «Стоп».
    let pending = await h.questionService.listPending(h.sessionId);
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      pending = await h.questionService.listPending(h.sessionId);
    }
    expect(pending.length).toBe(1);
    controller.abort();
    await processing;

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const step = stepWithCalls(session.messages);
    expect(step).toBeDefined();
    // Шаг с карточкой инструмента виден, результат вызова не потерян.
    expect(step!.metadata?.tool_chain).toBeUndefined();
    const record = findQuestionRecord(step!);
    expect(record).toBeDefined();
    expect(record!.args).toMatchObject({ questions: QUESTIONS });

    // Карточки не дублируются в финальном сообщении хода (ADR-118 §1).
    const finals = session.messages.filter(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) === 0,
    );
    expect(finals.length).toBeGreaterThan(0);
    for (const final of finals) {
      expect(final.metadata?.tool_results).toBeUndefined();
    }

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
