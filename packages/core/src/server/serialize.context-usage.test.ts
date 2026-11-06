/**
 * ADR-119: `context_usage` в DTO детали сессии — **серверная** оценка занятости
 * контекстного окна.
 *
 * Источник истины — тот же счётчик, что триггерит авто-сжатие
 * (`ContextOptimizer.estimatePromptTokens`), и то же окно модели
 * (`getContextWindow`): после компактизации значение отражает «прямо сейчас»,
 * а не до-сжатый usage последнего assistant-сообщения.
 *
 * Поле аддитивное: без оптимизатора (списочные сводки) ключа в DTO нет.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  MessageRole,
  generateId,
  makeTextPart,
  nowISO,
  type Message,
  type Session,
  type SummarizationConfig,
} from '@itphx/synth-shared';
import { serializeSession } from './serialize.js';
import { ContextOptimizer } from '../engine/context/optimizer.js';
import type { ContextFileRepository } from '../storage/ports/context-file-repository.js';

function message(over: Partial<Message> = {}): Message {
  return {
    id: generateId(),
    role: MessageRole.ASSISTANT,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('x')],
    content: 'x',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...over,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    sessionOrigin: 'user',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {} as Session['settings'],
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  } as Session;
}

/** Оптимизатор с заданным окном модели (окно 0 — «неизвестно»). */
function makeOptimizer(windowTokens: number): ContextOptimizer {
  return new ContextOptimizer(
    {} as unknown as ContextFileRepository,
    () => null,
    {} as SummarizationConfig,
    () => windowTokens,
  );
}

/**
 * Компактизованная сессия: покрытые сообщения отключены, есть SUMMARY,
 * в хвосте — свежий ответ агента.
 *
 * Значение `estimatePromptTokens` здесь НЕ равно сумме usage всех сообщений:
 * замеры до резюме неактуальны (core, M2).
 */
function compactedSession(): Session {
  const covered1 = message({
    id: 'a1',
    disabled: true,
    usage: { inputTokens: 90_000, outputTokens: 1_000, totalTokens: 91_000 },
  });
  const covered2 = message({
    id: 'a2',
    disabled: true,
    usage: { inputTokens: 95_000, outputTokens: 1_000, totalTokens: 96_000 },
  });
  const summary = message({
    id: 'sum',
    role: MessageRole.SUMMARY,
    content: 'итог беседы',
    usage: { inputTokens: 186_000, outputTokens: 500, totalTokens: 186_500 },
  });
  const tail = message({
    id: 'a3',
    usage: { inputTokens: 20_000, outputTokens: 500, totalTokens: 20_500 },
  });
  return session({
    messages: [covered1, covered2, summary, tail],
    settings: {
      contextOptimization: 'summarization',
      model: 'mm',
    } as Session['settings'],
  });
}

describe('serializeSession — context_usage (ADR-119)', () => {
  it('без оптимизатора ключа context_usage в DTO нет (списочные сводки)', () => {
    const out = serializeSession(compactedSession()) as Record<string, unknown>;
    expect('context_usage' in out).toBe(false);
  });

  it('с оптимизатором отдаёт {tokens, limit, estimated}', () => {
    const optimizer = makeOptimizer(100_000);
    const out = serializeSession(compactedSession(), {
      contextOptimizer: optimizer,
    }) as Record<string, unknown>;
    expect(out.context_usage).toMatchObject({ limit: 100_000, estimated: false });
    expect(typeof (out.context_usage as { tokens: number }).tokens).toBe('number');
  });

  it('окно модели неизвестно (0) → фолбэк DEFAULT_CONTEXT_WINDOW и estimated: true', () => {
    const optimizer = makeOptimizer(0);
    const withoutModel = session({
      messages: [message({ id: 'a1', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } })],
      settings: {} as Session['settings'],
    });
    const out = serializeSession(withoutModel, {
      contextOptimizer: optimizer,
    }) as Record<string, unknown>;
    expect(out.context_usage).toMatchObject({
      limit: DEFAULT_CONTEXT_WINDOW,
      estimated: true,
    });
  });

  it('на компактизованной сессии значение = estimatePromptTokens (паритет с триггером)', () => {
    const optimizer = makeOptimizer(200_000);
    const sess = compactedSession();
    const out = serializeSession(sess, { contextOptimizer: optimizer }) as Record<string, unknown>;

    const expected = optimizer.estimatePromptTokens(sess);
    expect((out.context_usage as { tokens: number }).tokens).toBe(expected);
    expect(expected).toBeGreaterThan(0);

    // Не сумма usage всех сообщений: замеры до резюме неактуальны.
    const sumOfUsage = sess.messages.reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0);
    expect(sumOfUsage).toBeGreaterThan(expected);
  });
});
