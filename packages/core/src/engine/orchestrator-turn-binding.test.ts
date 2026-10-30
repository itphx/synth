/**
 * ADR-118 §1/§5/§10: привязка сообщений хода к `turnId`/`stepIndex`/`status`.
 *
 * Регрессия: `ChatOrchestrator._saveAssistantMessage` (обёртка над
 * `persistence.saveAssistantMessage`) не принимала последний параметр `step`,
 * поэтому объект `{turnId, stepIndex, status, messageId}`, который передаёт
 * эпилог/ветки отмены и ошибки, молча отбрасывался — в истории `turn_id`,
 * `step_index` и `status` оставались `null`.
 *
 * Проверяется сквозной путь (реальный оркестратор + FileStore):
 *  - успешный ход: сообщение шага получает `turnId`, `stepIndex: 0`,
 *    `status: 'completed'`; реплика пользователя — тот же `turnId`;
 *  - tool-loop из двух шагов: у двух assistant-сообщений разные `stepIndex`;
 *  - отмена — `status: 'cancelled'`, ошибка LLM — `status: 'error'`;
 *  - `turn.started`/`step.started`/`step.finished` несут те же `messageId`,
 *    что сохранены в сообщениях (финальное сообщение = сообщение шага).
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
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { LLMChunk, Message } from '@itphx/synth-shared';

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
    parts: [makeTextPart('Привет')],
    content: 'Привет',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

const ZERO = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Один шаг: сразу финальный текст. */
class SingleStepProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ответ', model: this.model, usage: ZERO };
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: 'ответ', isFinal: true, usage: ZERO, model: this.model };
  }

  getProviderName(): string {
    return 'mockstep1';
  }
}

/** Два шага: вызов тула, затем финальный текст (tool-loop). */
class TwoStepProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ответ', model: this.model, usage: ZERO };
  }

  async *chatAsync(messages: LLMMessage[]): AsyncGenerator<LLMChunk> {
    const hasToolResult = messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      yield {
        content: 'Сейчас прочитаю файл',
        isFinal: false,
        toolCalls: [{
          id: 'call_step',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/x.txt' }) },
        }],
        usage: ZERO,
        model: this.model,
      };
      return;
    }
    yield { content: 'Готово', isFinal: true, usage: ZERO, model: this.model };
  }

  getProviderName(): string {
    return 'mockstep2';
  }
}

/**
 * Отмена во время второго шага: первый шаг — tool call, второй — частичный
 * текст и «зависание» до сигнала отмены (гонки с таймером нет).
 */
class CancelSecondStepProvider extends BaseProvider {
  static onSecondIteration: (() => void) | null = null;

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: ZERO };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: unknown,
    _tools?: unknown,
    _debugCollector?: unknown,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    const hasToolResult = messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      yield {
        content: 'выполняю тул',
        isFinal: false,
        toolCalls: [{
          id: 'call_cancel',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        }],
        usage: ZERO,
        model: this.model,
      };
      return;
    }
    yield { content: 'частичный ответ до отмены', isFinal: false, usage: ZERO, model: this.model };
    CancelSecondStepProvider.onSecondIteration?.();
    while (!cancellationToken?.cancelled) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  getProviderName(): string {
    return 'mockcancel';
  }
}

/** Сбой провайдера: частичный текст, затем non-recoverable ошибка. */
class FailingProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    throw new Error('401 Unauthorized');
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: 'частичный ответ', isFinal: false, usage: ZERO, model: this.model };
    throw new Error('401 Unauthorized');
  }

  getProviderName(): string {
    return 'mockfailstep';
  }
}

/** Пустой финальный ответ: черновик не создаётся (контента нет). */
class EmptyAnswerProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: ZERO };
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: '', isFinal: true, usage: ZERO, model: this.model };
  }

  getProviderName(): string {
    return 'mockempty';
  }
}

type Published = { event: string; data: Record<string, unknown> };

describe('ChatOrchestrator — turnId/stepIndex/status сообщений хода (ADR-118)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-turn-binding-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('mockstep1', SingleStepProvider);
    ProviderFactory.register('mockstep2', TwoStepProvider);
    ProviderFactory.register('mockcancel', CancelSecondStepProvider);
    ProviderFactory.register('mockfailstep', FailingProvider);
  });

  afterEach(async () => {
    CancelSecondStepProvider.onSecondIteration = null;
    for (const name of ['mockstep1', 'mockstep2', 'mockcancel', 'mockfailstep']) {
      ProviderFactory['_providers'].delete(name);
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(
    providerType: string,
    opts: {
      beforeRun?: (orchestrator: ChatOrchestrator, streamId: string) => AbortSignal;
    } = {},
  ): Promise<{ events: Published[]; messages: Message[]; userMessage: Message }> {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({ name, type: providerType, baseUrl: '', apiKey: '', defaultModel: 'm' }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      title: 'TurnBinding',
      settings: { provider: providerType, model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const events: Published[] = [];
    const signal = opts.beforeRun?.(orchestrator, msg.metadata?.stream_id as string)
      ?? new AbortController().signal;
    await orchestrator.createProcessMessage()(fresh, msg, signal, (event, data) => {
      events.push({ event, data });
    });

    const updated = (await sessionManager.getSession(session.id))!;
    return {
      events,
      // ADR-070 §2.8: state-сообщения (agent_switch) — не часть диалога.
      messages: updated.messages.filter((m) => m.metadata?.state !== true),
      userMessage: msg,
    };
  }

  function eventOf(events: Published[], name: string, last = false): Published {
    const list = last ? [...events].reverse() : events;
    const found = list.find((e) => e.event === name);
    expect(found, `событие ${name} не опубликовано`).toBeDefined();
    return found!;
  }

  it('успешный ход: сообщение шага имеет turnId, stepIndex 0 и status completed', async () => {
    const { events, messages } = await run('mockstep1');

    const assistant = messages.find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.turnId).toEqual(expect.any(String));
    expect(assistant.stepIndex).toBe(0);
    expect(assistant.status).toBe('completed');

    // Финальное сообщение = сообщение шага: id из `step.started`/`step.finished`.
    const stepStarted = eventOf(events, 'step.started');
    const stepFinished = eventOf(events, 'step.finished');
    expect(stepStarted.data.messageId).toBe(assistant.id);
    expect(stepFinished.data.messageId).toBe(assistant.id);
    expect(stepFinished.data.stepIndex).toBe(0);
    expect(stepFinished.data.turnId).toBe(assistant.turnId);
  });

  it('реплика пользователя получает turnId хода (совпадает с assistant)', async () => {
    const { events, messages, userMessage } = await run('mockstep1');

    const storedUser = messages.find((m) => m.role === MessageRole.USER)!;
    const assistant = messages.find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(storedUser.turnId).toEqual(expect.any(String));
    expect(storedUser.turnId).toBe(assistant.turnId);
    // Объект, который держит вызывающая сторона, тоже размечен (один ход).
    expect(userMessage.turnId).toBe(assistant.turnId);
    // `turn.started` адресует реплику пользователя.
    expect(eventOf(events, 'turn.started').data.messageId).toBe(storedUser.id);
  });

  it('turnId реплики не перезаписывается, если уже проставлен', async () => {
    const session = await sessionManager.createSession({
      title: 'Preset',
      settings: { provider: 'mockstep1', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
    });
    const msg = makeUserMessage();
    msg.turnId = 'turn_manual';
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;
    await new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({ name, type: 'mockstep1', baseUrl: '', apiKey: '', defaultModel: 'm' }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
    }).createProcessMessage()(fresh, msg, new AbortController().signal, () => {});

    const storedUser = (await sessionManager.getSession(session.id))!
      .messages.find((m) => m.role === MessageRole.USER)!;
    expect(storedUser.turnId).toBe('turn_manual');
  });

  it('tool-loop из двух шагов: разные stepIndex у двух assistant-сообщений', async () => {
    const { events, messages } = await run('mockstep2');

    const assistants = messages.filter((m) => m.role === MessageRole.ASSISTANT);
    expect(assistants).toHaveLength(2);

    const [intermediate, final] = assistants;
    expect(intermediate!.stepIndex).toBe(0);
    expect(final!.stepIndex).toBe(1);
    expect(intermediate!.turnId).toEqual(expect.any(String));
    expect(final!.turnId).toBe(intermediate!.turnId);
    expect(final!.status).toBe('completed');

    const user = messages.find((m) => m.role === MessageRole.USER)!;
    expect(user.turnId).toBe(final!.turnId);

    // Оба шага адресуют свои сообщения: messageId шага 1 — из события.
    const stepsFinished = events.filter((e) => e.event === 'step.finished');
    expect(stepsFinished.map((e) => e.data.stepIndex)).toEqual([0, 1]);
    expect(stepsFinished[0]!.data.messageId).toBe(intermediate!.id);
    expect(stepsFinished[1]!.data.messageId).toBe(final!.id);
  });

  it('отмена: сохранённое сообщение шага имеет status cancelled', async () => {
    const controller = new AbortController();
    CancelSecondStepProvider.onSecondIteration = () => controller.abort();

    const { events, messages } = await run('mockcancel', { beforeRun: () => controller.signal });

    const assistants = messages.filter((m) => m.role === MessageRole.ASSISTANT);
    const cancelled = assistants.at(-1)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.turnId).toEqual(expect.any(String));
    expect(cancelled.stepIndex).toBe(1);

    const stepFinished = eventOf(events, 'step.finished', true);
    expect(stepFinished.data.status).toBe('cancelled');
    expect(stepFinished.data.messageId).toBe(cancelled.id);
  });

  it('пустой ответ без черновика: сообщение создаётся с messageId шага', async () => {
    ProviderFactory.register('mockempty', EmptyAnswerProvider);
    try {
      const { events, messages } = await run('mockempty');

      const assistant = messages.find((m) => m.role === MessageRole.ASSISTANT)!;
      // Фоллбек-текст подставлен, но id — тот же, что у событий шага.
      expect(assistant.content.length).toBeGreaterThan(0);
      expect(assistant.id).toBe(eventOf(events, 'step.started').data.messageId);
      expect(assistant.id).toBe(eventOf(events, 'step.finished').data.messageId);
      expect(assistant.status).toBe('completed');
      expect(assistant.stepIndex).toBe(0);
      expect(assistant.turnId).toEqual(expect.any(String));
    } finally {
      ProviderFactory['_providers'].delete('mockempty');
    }
  });

  it('ошибка LLM: сообщение об ошибке имеет status error и turnId хода', async () => {
    const { messages } = await run('mockfailstep');

    const assistants = messages.filter((m) => m.role === MessageRole.ASSISTANT);
    const errorMessage = assistants.find((m) => m.metadata?.interrupted !== true)!;
    expect(errorMessage.content).toContain('Unauthorized');
    expect(errorMessage.status).toBe('error');
    expect(errorMessage.turnId).toEqual(expect.any(String));
    expect(errorMessage.stepIndex).toBe(0);

    // Частичный черновик того же шага тоже терминальный (`error`).
    const interrupted = assistants.find((m) => m.metadata?.interrupted === true)!;
    expect(interrupted.status).toBe('error');
    expect(interrupted.turnId).toBe(errorMessage.turnId);

    const user = messages.find((m) => m.role === MessageRole.USER)!;
    expect(user.turnId).toBe(errorMessage.turnId);
  });
});
