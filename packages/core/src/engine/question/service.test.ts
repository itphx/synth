/**
 * Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» (`ask_user`).
 *
 * Проверяется жизненный цикл вопроса: постановка → ожидание ответа →
 * ответ/отмена, валидация ответа, таймаут, отмена хода (AbortSignal),
 * восстановление при старте и события `user_question.*` в шине сессии.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../events/bus.js';
import { MemoryQuestionRepository } from '../../storage/memory/questions.js';
import { QuestionService, MAX_FREE_ANSWER_LENGTH } from './service.js';
import {
  QuestionAlreadySettledError,
  QuestionInvalidAnswerError,
  QuestionNotFoundError,
} from './types.js';
import type { QuestionItem } from '@itphx/synth-shared';

const QUESTIONS: QuestionItem[] = [
  {
    question: 'Какой вариант?',
    header: 'Выбор',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  },
];

function createService(opts?: { timeoutMs?: number }) {
  const repository = new MemoryQuestionRepository();
  const eventBus = new EventBus();
  let counter = 0;
  const service = new QuestionService({
    repository,
    eventBus,
    timeoutMs: opts?.timeoutMs ?? 60_000,
    // Уникальные id: иначе вопросы перетирают друг друга в порту.
    generateId: () => `id-${++counter}`,
  });
  return { repository, eventBus, service };
}

describe('QuestionService — постановка вопроса и ожидание ответа', () => {
  it('вопрос сохраняется как pending и публикуется user_question.asked', async () => {
    const { repository, eventBus, service } = createService();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe('s1', (e) => events.push({ type: e.type, data: e.data }));

    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    // Ожидание идёт — ответ придёт из теста.
    await Promise.resolve();

    const asked = events.find((e) => e.type === 'user_question.asked');
    expect(asked).toBeDefined();
    expect(asked!.data.question_id).toMatch(/^qst_/);
    expect(asked!.data.session_id).toBe('s1');
    expect(asked!.data.questions).toHaveLength(1);

    const records = await repository.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('pending');
    expect(records[0]!.questions).toHaveLength(1);

    await service.answer(records[0]!.id, [['a']]);
    const outcome = await pending;
    expect(outcome.status).toBe('answered');
  });

  it('user_question.asked несёт created_at и expires_at (при таймауте)', async () => {
    const { eventBus, service } = createService({ timeoutMs: 60_000 });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe('s1', (e) => events.push({ type: e.type, data: e.data }));

    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();

    const asked = events.find((e) => e.type === 'user_question.asked');
    expect(asked).toBeDefined();
    // Момент постановки — всегда.
    expect(asked!.data.created_at).toBeTruthy();
    // Срок ожидания — при таймауте.
    expect(asked!.data.expires_at).toBeTruthy();
    expect(new Date(String(asked!.data.expires_at)).getTime()).toBeGreaterThan(
      new Date(String(asked!.data.created_at)).getTime(),
    );

    const records = await service.listPending('s1');
    await service.cancel(records[0]!.id, 'test');
    await pending;
  });

  it('ответ сохраняется, публикуется user_question.answered и разблокирует ожидание', async () => {
    const { repository, eventBus, service } = createService();
    const events: string[] = [];
    eventBus.subscribe('s1', (e) => events.push(e.type));

    const pending = service.ask({ sessionId: 's1', turnId: 'turn-1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    const answered = await service.answer(record.id, [['a']], 'user-1');
    expect(answered.status).toBe('answered');
    expect(answered.answers).toEqual([['a']]);
    expect(answered.answeredBy).toBe('user-1');
    expect(answered.answeredAt).toBeTruthy();

    const outcome = await pending;
    expect(outcome.status).toBe('answered');
    if (outcome.status === 'answered') expect(outcome.answers).toEqual([['a']]);
    expect(events).toContain('user_question.answered');
  });

  it('повторный ответ → QuestionAlreadySettledError', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    await service.answer(record.id, [['a']]);
    await expect(service.answer(record.id, [['b']])).rejects.toBeInstanceOf(QuestionAlreadySettledError);
    await pending;
  });

  it('неверное число ответов → QuestionInvalidAnswerError', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    await expect(service.answer(record.id, [['a'], ['b']])).rejects.toBeInstanceOf(QuestionInvalidAnswerError);
    await expect(service.answer(record.id, [])).rejects.toBeInstanceOf(QuestionInvalidAnswerError);
    await service.cancel(record.id, 'test');
    await pending;
  });

  it('свободный ответ (значение вне options) принимается', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    // «Type your own answer»: любая непустая строка валидна.
    const answered = await service.answer(record.id, [['свой ответ']]);
    expect(answered.status).toBe('answered');
    expect(answered.answers).toEqual([['свой ответ']]);

    const outcome = await pending;
    expect(outcome.status).toBe('answered');
  });

  it('пустой/пробельный ответ → QuestionInvalidAnswerError (empty_answer)', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    await expect(service.answer(record.id, [['']])).rejects.toMatchObject({
      reason: 'empty_answer',
    });
    await expect(service.answer(record.id, [['   ']])).rejects.toMatchObject({
      reason: 'empty_answer',
    });
    await service.cancel(record.id, 'test');
    await pending;
  });

  it('слишком длинный свободный ответ → QuestionInvalidAnswerError (answer_too_long)', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    await expect(service.answer(record.id, [['x'.repeat(MAX_FREE_ANSWER_LENGTH + 1)]])).rejects.toMatchObject({
      reason: 'answer_too_long',
    });
    // Ровно предел — валидно.
    await service.answer(record.id, [['x'.repeat(MAX_FREE_ANSWER_LENGTH)]]);
    await pending;
  });

  it('не-строковое значение → QuestionInvalidAnswerError (invalid_answer)', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    await expect(service.answer(record.id, [[42 as unknown as string]])).rejects.toMatchObject({
      reason: 'invalid_answer',
    });
    await service.cancel(record.id, 'test');
    await pending;
  });

  it('одиночный вопрос с двумя значениями → QuestionInvalidAnswerError (too_many_answers)', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    await expect(service.answer(record.id, [['a', 'b']])).rejects.toMatchObject({
      reason: 'too_many_answers',
    });
    await service.cancel(record.id, 'test');
    await pending;
  });

  it('вопрос multiple: true принимает несколько значений', async () => {
    const { repository, service } = createService();
    const multiple: QuestionItem[] = [{ ...QUESTIONS[0]!, multiple: true }];
    const pending = service.ask({ sessionId: 's1', questions: multiple });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    const answered = await service.answer(record.id, [['a', 'b']]);
    expect(answered.answers).toEqual([['a', 'b']]);
    await pending;
  });

  it('пустой ответ на вопрос → QuestionInvalidAnswerError (empty_answer)', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    await expect(service.answer(record.id, [[]])).rejects.toMatchObject({
      reason: 'empty_answer',
    });
    await service.cancel(record.id, 'test');
    await pending;
  });

  it('ответ на несуществующий вопрос → QuestionNotFoundError', async () => {
    const { service } = createService();
    await expect(service.answer('qst-none', [['a']])).rejects.toBeInstanceOf(QuestionNotFoundError);
  });

  it('отмена вопроса: статус cancelled, причина и событие', async () => {
    const { repository, eventBus, service } = createService();
    const events: string[] = [];
    eventBus.subscribe('s1', (e) => events.push(e.type));

    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;

    const cancelled = await service.cancel(record.id, 'user');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('user');
    expect(cancelled.cancelledAt).toBeTruthy();

    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.reason).toBe('user');
    expect(events).toContain('user_question.cancelled');
  });

  it('отмена уже закрытого вопроса → QuestionAlreadySettledError', async () => {
    const { repository, service } = createService();
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    const record = (await repository.list())[0]!;
    await service.answer(record.id, [['a']]);
    await expect(service.cancel(record.id)).rejects.toBeInstanceOf(QuestionAlreadySettledError);
    await pending;
  });

  it('cancelSession снимает все открытые вопросы сессии', async () => {
    const { service } = createService();
    const p1 = service.ask({ sessionId: 's1', questions: QUESTIONS });
    const p2 = service.ask({ sessionId: 's1', questions: QUESTIONS });
    const other = service.ask({ sessionId: 's2', questions: QUESTIONS });
    await Promise.resolve();

    const cancelled = await service.cancelSession('s1', 'aborted');
    expect(cancelled).toHaveLength(2);
    expect((await service.listPending('s1'))).toHaveLength(0);
    // Вопрос другой сессии не тронут.
    expect(await service.listPending('s2')).toHaveLength(1);

    await p1;
    await p2;
    await service.cancelSession('s2', 'test');
    await other;
  });

  it('recoverOnStart снимает открытые вопросы с причиной interrupted (идемпотентно)', async () => {
    const { repository, service } = createService();
    // Запись, оставшаяся от прошлого процесса (ожидание в памяти не пережило).
    await repository.save({
      id: 'qst_old',
      sessionId: 's1',
      questions: QUESTIONS,
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const recovered = await service.recoverOnStart();
    expect(recovered).toBe(1);
    const record = await repository.get('qst_old');
    expect(record?.status).toBe('cancelled');
    expect(record?.cancelReason).toBe('interrupted');
    // Повторный вызов — ничего не делает.
    expect(await service.recoverOnStart()).toBe(0);
  });
});

describe('QuestionService — таймаут и отмена хода', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('по таймауту вопрос снимается (cancelReason=timeout)', async () => {
    const { repository, service } = createService({ timeoutMs: 1000 });
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await vi.advanceTimersByTimeAsync(1500);

    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.reason).toBe('timeout');

    const record = (await repository.list())[0]!;
    expect(record.status).toBe('cancelled');
    expect(record.cancelReason).toBe('timeout');
  });

  it('AbortSignal отменяет вопрос (cancelReason=aborted)', async () => {
    const { repository, service } = createService({ timeoutMs: 0 });
    const controller = new AbortController();
    const pending = service.ask({
      sessionId: 's1',
      questions: QUESTIONS,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.reason).toBe('aborted');

    const record = (await repository.list())[0]!;
    expect(record.status).toBe('cancelled');
  });

  it('без таймаута (timeoutMs=0) вопрос ждёт бесконечно', async () => {
    const { service } = createService({ timeoutMs: 0 });
    let settled = false;
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(settled).toBe(false);
    // Снимаем, чтобы тест не оставлял висящее ожидание.
    const records = await service.listPending('s1');
    await service.cancel(records[0]!.id, 'test');
    await pending;
  });

  it('timeoutMs=0 — таймер не ставится, expiresAt не пишется', async () => {
    const { repository, service } = createService({ timeoutMs: 0 });
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await vi.advanceTimersByTimeAsync(0);

    const record = (await repository.list())[0]!;
    expect(record.status).toBe('pending');
    expect(record.expiresAt).toBeUndefined();

    const records = await service.listPending('s1');
    await service.cancel(records[0]!.id, 'test');
    await pending;
  });

  it('timeoutMs=0 — в user_question.asked нет expires_at, но есть created_at', async () => {
    const { eventBus, service } = createService({ timeoutMs: 0 });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe('s1', (e) => events.push({ type: e.type, data: e.data }));

    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await vi.advanceTimersByTimeAsync(0);

    const asked = events.find((e) => e.type === 'user_question.asked');
    expect(asked).toBeDefined();
    expect(asked!.data.created_at).toBeTruthy();
    expect(asked!.data.expires_at).toBeUndefined();

    const records = await service.listPending('s1');
    await service.cancel(records[0]!.id, 'test');
    await pending;
  });

  it('явный timeoutMs вопроса пишет expiresAt и по истечении отменяет с причиной timeout', async () => {
    const { repository, service } = createService({ timeoutMs: 0 });
    const pending = service.ask({
      sessionId: 's1',
      questions: QUESTIONS,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    const record = (await repository.list())[0]!;
    expect(record.expiresAt).toBeTruthy();

    await vi.advanceTimersByTimeAsync(1_500);
    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.reason).toBe('timeout');

    const cancelled = (await repository.list())[0]!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('timeout');
  });
});

describe('QuestionService — dispose', () => {
  it('dispose разрешает ожидания как отменённые', async () => {
    const { service } = createService({ timeoutMs: 0 });
    const pending = service.ask({ sessionId: 's1', questions: QUESTIONS });
    await Promise.resolve();
    service.dispose();
    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
  });
});
