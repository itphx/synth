/**
 * Этап 1 roadmap 0.13 (блок 3): тул `question` — вопрос пользователю посреди
 * хода. Проверяется перевод исхода сервиса в `tool_result`: ответ, отмена,
 * отсутствие сервиса и прерывание хода, а также опция `timeout` (срок ожидания
 * ответа задаёт сам тул; по умолчанию срока нет).
 */
import { describe, it, expect, vi } from 'vitest';
import { questionTool } from './question.js';
import { QuestionService } from '../question/service.js';
import { MemoryQuestionRepository } from '../../storage/memory/questions.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';

const QUESTIONS = [
  {
    question: 'Какой вариант?',
    header: 'Выбор',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  },
];

function createService(): QuestionService {
  let counter = 0;
  return new QuestionService({
    repository: new MemoryQuestionRepository(),
    eventBus: new EventBus(),
    timeoutMs: 60_000,
    generateId: () => `id-${++counter}`,
  });
}

function makeCtx(extra?: Record<string, unknown>, abortSignal?: AbortSignal): ToolContext {
  return {
    sessionId: 's1',
    messageId: generateId(),
    workingDir: '/tmp',
    ...(abortSignal ? { abortSignal } : {}),
    extra: { streamId: 'turn-1', callId: 'call-1', ...(extra ?? {}) },
  };
}

describe('question tool', () => {
  it('возвращает ответ пользователя в контенте и метаданных', async () => {
    const service = createService();
    const ctx = makeCtx({ questionService: service });

    const pending = questionTool.execute({ questions: QUESTIONS }, ctx);
    // Ответ приходит, пока тул ждёт.
    await new Promise((r) => setTimeout(r, 0));
    const records = await service.listPending('s1');
    await service.answer(records[0]!.id, [['a']]);

    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('The user answered the questions');
    expect(result.content).toContain('"Какой вариант?"="a"');
    expect(result.metadata?.question_id).toBe(records[0]!.id);
    expect(result.metadata?.answers).toEqual([['a']]);
  });

  it('отмена вопроса → isError с причиной', async () => {
    const service = createService();
    const ctx = makeCtx({ questionService: service });

    const pending = questionTool.execute({ questions: QUESTIONS }, ctx);
    await new Promise((r) => setTimeout(r, 0));
    const records = await service.listPending('s1');
    await service.cancel(records[0]!.id, 'user');

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('The user cancelled the question');
    expect(result.metadata?.reason).toBe('user');
    expect(result.metadata?.question_id).toBe(records[0]!.id);
  });

  it('без сервиса вопросов → isError (deps_unavailable)', async () => {
    const result = await questionTool.execute({ questions: QUESTIONS }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('The question mechanism is unavailable');
    expect(result.metadata?.i18n).toMatchObject({ key: 'question.deps_unavailable' });
  });

  it('прерванный ход (abort) → abortedResult', async () => {
    const service = createService();
    const controller = new AbortController();
    const ctx = makeCtx({ questionService: service }, controller.signal);

    const pending = questionTool.execute({ questions: QUESTIONS }, ctx);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();

    const result = await pending;
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    expect(result.content).toContain('stopped_by_user');
    // Вопрос снят — открытых вопросов не осталось.
    expect(await service.listPending('s1')).toHaveLength(0);
  });

  it('некорректные аргументы → isError (args_error)', async () => {
    const service = createService();
    const result = await questionTool.execute({ questions: [] }, makeCtx({ questionService: service }));
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'tool.args_error' });
  });

  it('тул объявлен с capability question и зарегистрирован в реестре', async () => {
    expect(questionTool.name).toBe('question');
    expect(questionTool.capabilities).toEqual(['question']);
    const { ALL_BUILTIN_TOOLS } = await import('./index.js');
    expect(ALL_BUILTIN_TOOLS.map((t) => t.name)).toContain('question');
  });
});

describe('question tool: опция timeout (срок ожидания ответа)', () => {
  it('timeout: 299000 → ошибка аргументов (минимум 5 минут)', async () => {
    const service = createService();
    const result = await questionTool.execute(
      { questions: QUESTIONS, timeout: 299_000 },
      makeCtx({ questionService: service }),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'tool.args_error' });
    // Вопрос не поставлен — ждать нечего.
    expect(await service.listPending('s1')).toHaveLength(0);
  });

  it('timeout: 300000 → срок ожидания передаётся в сервис', async () => {
    const service = createService();
    const spy = vi.spyOn(service, 'ask');
    const ctx = makeCtx({ questionService: service });

    const pending = questionTool.execute({ questions: QUESTIONS, timeout: 300_000 }, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]!.timeoutMs).toBe(300_000);

    const records = await service.listPending('s1');
    await service.answer(records[0]!.id, [['a']]);
    await pending;
  });

  it('без timeout → срок ожидания не задан (в сервис уходит undefined)', async () => {
    const service = createService();
    const spy = vi.spyOn(service, 'ask');
    const ctx = makeCtx({ questionService: service });

    const pending = questionTool.execute({ questions: QUESTIONS }, ctx);
    await new Promise((r) => setTimeout(r, 0));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]!.timeoutMs).toBeUndefined();

    const records = await service.listPending('s1');
    await service.answer(records[0]!.id, [['a']]);
    await pending;
  });

  it('JSON-схема тула: timeout с описанием и границами, необязательный', async () => {
    const { zodToJsonSchema } = await import('./json-schema.js');
    const schema = zodToJsonSchema(questionTool.parameters) as {
      properties: Record<string, { description?: string; minimum?: number; maximum?: number }>;
      required?: string[];
    };

    const timeout = schema.properties.timeout!;
    expect(timeout.description).toContain('Optional answer timeout in milliseconds');
    expect(timeout.description).toContain('waits indefinitely');
    expect(timeout.minimum).toBe(300_000);
    expect(timeout.maximum).toBe(86_400_000);
    // `timeout` необязателен — в `required` его нет.
    expect(schema.required).toEqual(['questions']);
  });
});
