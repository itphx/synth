/**
 * Нормализация первого сообщения истории (ADR-119, сжатие контекста).
 *
 * После сжатия хвост может начинаться с `assistant` (срез по шагу в
 * `ContextOptimizer._buildCompressionBoundary`): прежнее правило «хвост
 * начинается с user» разворачивало хвост на весь длинный ход.
 *
 * Проверяем чистую функцию `resolveHistoryNormalization`:
 *  - хвост с `assistant` → резюме уходит из системного блока в синтетическое
 *    user-сообщение чекпоинта в начале истории (Anthropic требует `user`
 *    первым);
 *  - хвост с `user` → прежнее поведение (резюме в системном блоке);
 *  - без резюме — ничего не меняем.
 */

import { describe, it, expect } from 'vitest';
import { MessageRole, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { firstLiveMessageRole, resolveHistoryNormalization } from './history-normalize.js';
import { sessionMessagesToLlm } from './prompt-info.js';

function msg(
  id: string,
  role: MessageRole,
  content: string,
  patch: Partial<Message> = {},
): Message {
  return {
    id,
    role,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...patch,
  } as Message;
}

describe('resolveHistoryNormalization', () => {
  it('хвост с assistant → резюме в чекпоинт (первое сообщение — user)', () => {
    const messages = [
      msg('sum', MessageRole.SUMMARY, 'итог беседы'),
      msg('a1', MessageRole.ASSISTANT, 'шаг агента'),
      msg('t1', MessageRole.TOOL, 'результат', { toolCallId: 'c1' }),
      msg('u1', MessageRole.USER, 'текущий вопрос'),
    ];

    const norm = resolveHistoryNormalization({ messages, summaryContent: 'итог беседы' });

    // Системный блок `summary` пуст — резюме ушло в чекпоинт.
    expect(norm.summaryContent).toBe('');
    expect(norm.checkpoint).not.toBeNull();
    expect(norm.checkpoint!.role).toBe('user');
    expect(norm.checkpoint!.content).toContain('[CONTEXT CHECKPOINT]');
    expect(norm.checkpoint!.content).toContain('итог беседы');

    // Сборка запроса как в `process-setup`: чекпоинт в начало, история — как есть.
    const live = messages.filter((m) => m.role !== MessageRole.SUMMARY);
    const llmMessages = [norm.checkpoint!, ...sessionMessagesToLlm(live)];
    expect(llmMessages[0]!.role).toBe('user');
    expect(llmMessages[0]!.content).toContain('[CONTEXT CHECKPOINT]');
    // Последнее сообщение — по-прежнему user-реплика текущего хода.
    expect(llmMessages[llmMessages.length - 1]!.role).toBe('user');
    expect(llmMessages[llmMessages.length - 1]!.content).toBe('текущий вопрос');
  });

  it('хвост с user → прежнее поведение (резюме в системном блоке)', () => {
    const messages = [
      msg('sum', MessageRole.SUMMARY, 'итог беседы'),
      msg('u1', MessageRole.USER, 'вопрос'),
      msg('a1', MessageRole.ASSISTANT, 'ответ'),
    ];

    const norm = resolveHistoryNormalization({ messages, summaryContent: 'итог беседы' });

    expect(norm.summaryContent).toBe('итог беседы');
    expect(norm.checkpoint).toBeNull();
  });

  it('без резюме — ничего не меняем', () => {
    const messages = [
      msg('a1', MessageRole.ASSISTANT, 'шаг агента'),
      msg('u1', MessageRole.USER, 'вопрос'),
    ];

    const norm = resolveHistoryNormalization({ messages, summaryContent: '' });

    expect(norm.summaryContent).toBe('');
    expect(norm.checkpoint).toBeNull();
  });

  it('первая живая роль: SUMMARY/disabled/hidden/ephemeral/INFO не считаются', () => {
    const messages = [
      msg('sum', MessageRole.SUMMARY, 'итог'),
      msg('i1', MessageRole.INFO, 'служебное'),
      msg('d1', MessageRole.ASSISTANT, 'выключенный', { disabled: true }),
      msg('h1', MessageRole.ASSISTANT, 'скрытый', { hidden: true }),
      msg('e1', MessageRole.ASSISTANT, 'эфемерный', { ephemeral: true }),
      msg('u1', MessageRole.USER, 'вопрос'),
    ];

    expect(firstLiveMessageRole(messages)).toBe(MessageRole.USER);
    const norm = resolveHistoryNormalization({ messages, summaryContent: 'итог' });
    expect(norm.summaryContent).toBe('итог');
    expect(norm.checkpoint).toBeNull();
  });
});
