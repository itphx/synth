/**
 * ADR-095 (шаг 6a): собственные тесты модуля диагностики промпта.
 *
 * Проверяются контракты, а не реализация:
 *  - `sessionMessagesToLlm` — инвариант «нет осиротевших tool-сообщений»
 *    (ADR-070 §2.8/ADR-041): tool-результат валиден только после своего вызова
 *    в этой же выдаче, иначе уходит user-текстом с атрибуцией;
 *  - state-сообщения (`role: system`) → синтетический user `<system-state>`;
 *  - `buildPromptHistoryInfo` — read-only слой истории (зеркало отправки);
 *  - `lastPromptMeta` — promptMeta последнего ответа активного агента;
 *  - `instructionsMemoKey` — все входы резолва инструкций в ключе мемоизации.
 */

import { describe, it, expect } from 'vitest';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, PromptMeta, Session } from '@itphx/synth-shared';
import {
  sessionMessagesToLlm,
  buildPromptHistoryInfo,
  lastPromptMeta,
  instructionsMemoKey,
} from './prompt-info.js';
import { wrapStateContent } from '../context/state-messages.js';
import { DEFAULT_CHARS_PER_TOKEN } from '../context/token-ratio.js';

function msg(partial: Partial<Message> & { role: MessageRole; content: string }): Message {
  return {
    id: generateId(),
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(partial.content)],
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...partial,
  };
}

function assistantWithTool(content: string, toolCallId: string, agentRole?: string): Message {
  return msg({
    role: MessageRole.ASSISTANT,
    content,
    ...(agentRole ? { agentRole } : {}),
    toolCalls: [
      { id: toolCallId, type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ],
  });
}

function makeSession(messages: Message[], extra: Partial<Session> = {}): Session {
  return {
    id: 's1',
    sessionOrigin: 'user',
    messages,
    pendingMessages: [],
    status: {},
    settings: {},
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    ...extra,
  } as Session;
}

describe('sessionMessagesToLlm — фильтрация и инвариант tool-chain', () => {
  it('disabled/hidden/INFO не уходят в LLM', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'видно', author: 'user' }),
      msg({ role: MessageRole.USER, content: 'скрыто', disabled: true }),
      msg({ role: MessageRole.USER, content: 'hidden', hidden: true }),
      msg({ role: MessageRole.INFO, content: 'info' }),
    ];

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm.map((m) => m.content)).toEqual(['видно']);
  });

  it('assistant с metadata.status=error не является частью диалога (ADR-041)', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'вопрос', author: 'user' }),
      msg({
        role: MessageRole.ASSISTANT,
        content: 'Timeout or connection drop',
        agentRole: 'developer',
        metadata: { status: 'error' },
      }),
      msg({ role: MessageRole.ASSISTANT, content: 'ответ', agentRole: 'developer' }),
    ];

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm.map((m) => m.content)).toEqual(['вопрос', 'ответ']);
  });

  it('state-сообщение (role system) → user с обёрткой <system-state> и без атрибуции', () => {
    const messages = [
      msg({
        role: MessageRole.SYSTEM,
        content: '[MODE] act',
        metadata: { type: 'mode_change', state: true },
      }),
      msg({ role: MessageRole.SYSTEM, content: 'без type', metadata: { state: true } }),
    ];

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm[0]).toMatchObject({ role: 'user', content: wrapStateContent('mode_change', '[MODE] act') });
    expect(llm[1]!.content).toBe(wrapStateContent('state', 'без type'));
    expect(llm[1]!.content).not.toContain('[anonymous]');
  });

  it('assistant(toolCalls) → assistant+toolUse, парный tool → role tool с toolCallId', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'задача', author: 'user' }),
      assistantWithTool('', 'call_1', 'developer'),
      msg({ role: MessageRole.TOOL, content: 'результат', toolCallId: 'call_1', agentRole: 'developer' }),
    ];

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm[1]!.role).toBe('assistant');
    expect(llm[1]!.toolUse).toHaveLength(1);
    expect(llm[2]).toMatchObject({ role: MessageRole.TOOL, toolCallId: 'call_1', content: 'результат' });
  });

  it('осиротевший tool (нет вызова выше) уходит user-текстом с атрибуцией', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'задача', author: 'user' }),
      msg({ role: MessageRole.TOOL, content: 'осиротевший', toolCallId: 'call_x', agentRole: 'developer' }),
      msg({ role: MessageRole.TOOL, content: 'без toolCallId' }),
    ];

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm[1]).toMatchObject({ role: 'user', content: '[developer]: осиротевший' });
    expect(llm[1]!.toolCallId).toBeUndefined();
    expect(llm[2]).toMatchObject({ role: 'user', content: '[anonymous]: без toolCallId' });
  });

  it('disabled-assistant не регистрирует свои toolCallId — его tool-результат не становится парным', () => {
    const messages = [
      assistantWithTool('', 'call_1', 'developer'),
      msg({ role: MessageRole.TOOL, content: 'результат', toolCallId: 'call_1', agentRole: 'developer' }),
    ];
    messages[0]!.disabled = true;

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm).toHaveLength(1);
    expect(llm[0]!.role).toBe('user');
    expect(llm[0]!.toolCallId).toBeUndefined();
  });

  it('assistant с toolCalls чужого агента сохраняет toolUse и получает префикс атрибуции только при непустом content', () => {
    const messages = [
      assistantWithTool('текст чужого агента', 'call_1', 'researcher'),
      msg({ role: MessageRole.TOOL, content: 'ok', toolCallId: 'call_1', agentRole: 'researcher' }),
    ];

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm[0]).toMatchObject({
      role: 'assistant',
      content: '[researcher]: текст чужого агента',
    });
    expect(llm[0]!.toolUse).toHaveLength(1);
    // tool-результат остаётся парным, несмотря на «чужой» assistant
    expect(llm[1]).toMatchObject({ role: MessageRole.TOOL, toolCallId: 'call_1' });
  });

  it('пустой content у чужого assistant с toolCalls — без префикса атрибуции', () => {
    const llm = sessionMessagesToLlm([assistantWithTool('', 'call_1', 'researcher')], 'developer', 'user');
    expect(llm[0]!.content).toBe('');
  });

  it('reasoning прокидывается только для своего assistant', () => {
    const messages = [
      msg({ role: MessageRole.ASSISTANT, content: 'свой', agentRole: 'developer', reasoning: 'r-own' }),
      msg({ role: MessageRole.ASSISTANT, content: 'чужой', agentRole: 'researcher', reasoning: 'r-foreign' }),
      msg({ role: MessageRole.ASSISTANT, content: 'легаси без agentRole', reasoning: 'r-legacy' }),
    ];

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm[0]!.reasoning).toBe('r-own');
    expect(llm[1]!.reasoning).toBeUndefined();
    // пустой agentRole = «своё» (легаси/сабагент) — иначе такие assistant порождали бы сирот
    expect(llm[2]!.reasoning).toBe('r-legacy');
    expect(llm[2]!.role).toBe('assistant');
  });

  it('чужой user (другой автор) → user с атрибуцией; свой user — без', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'мой', author: 'user' }),
      msg({ role: MessageRole.USER, content: 'чужой', author: 'telegram' }),
      msg({ role: MessageRole.USER, content: 'чужой-агент', author: 'x', agentRole: 'researcher' }),
      msg({ role: MessageRole.USER, content: 'без автора' }),
    ];

    const llm = sessionMessagesToLlm(messages, 'developer', 'user');
    expect(llm.map((m) => m.content)).toEqual([
      'мой',
      '{telegram}: чужой',
      '[researcher]: чужой-агент',
      '[anonymous]: без автора',
    ]);
  });
});

describe('buildPromptHistoryInfo — read-only слой истории', () => {
  it('messages.count совпадает с реальной отправкой, disabled/hidden/info — в excluded', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'вопрос', author: 'user' }),
      msg({ role: MessageRole.ASSISTANT, content: 'ответ', agentRole: 'developer' }),
      msg({ role: MessageRole.USER, content: 'off', disabled: true }),
      msg({ role: MessageRole.USER, content: 'hid', hidden: true }),
      msg({ role: MessageRole.INFO, content: 'info' }),
    ];
    const session = makeSession(messages, { userId: 'user' });

    const info = buildPromptHistoryInfo(session, 'developer');
    const sent = sessionMessagesToLlm(messages, 'developer', 'user');

    expect(info.messages.count).toBe(sent.length);
    expect(info.excluded).toEqual({ disabled: 1, hidden: 1, info: 1 });
  });

  it('отключённая user-реплика выключает весь свой ход в истории промпта', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'q1', author: 'user' }),
      msg({ role: MessageRole.ASSISTANT, content: 'a1', agentRole: 'developer' }),
      msg({ role: MessageRole.USER, content: 'q2', author: 'user', disabled: true }),
      msg({
        role: MessageRole.ASSISTANT,
        content: 'a2',
        agentRole: 'developer',
        toolCalls: [{ id: 't1', function: { name: 'read_file' } }],
      }),
      msg({ role: MessageRole.TOOL, content: 'result', toolCallId: 't1' }),
      msg({ role: MessageRole.USER, content: 'q3', author: 'user' }),
      msg({ role: MessageRole.ASSISTANT, content: 'a3', agentRole: 'developer' }),
    ];
    const session = makeSession(messages, { userId: 'user' });

    const info = buildPromptHistoryInfo(session, 'developer');

    // q2 + её assistant + tool-результат.
    expect(info.excluded.disabled).toBe(3);
    expect(info.messages.count).toBe(4);
  });

  it('chars включает content + JSON(toolUse) + reasoning; estTokens — по ratio', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'вопрос', author: 'user' }),
      msg({
        role: MessageRole.ASSISTANT,
        content: 'текст',
        agentRole: 'developer',
        reasoning: 'мысль',
        toolCalls: [{ id: 'c1', function: { name: 'read_file' } }],
      }),
    ];
    const session = makeSession(messages, { userId: 'user' });

    const info = buildPromptHistoryInfo(session, 'developer', DEFAULT_CHARS_PER_TOKEN);
    const expectedChars =
      'вопрос'.length
      + 'текст'.length
      + JSON.stringify([{ id: 'c1', function: { name: 'read_file' } }]).length
      + 'мысль'.length;

    expect(info.messages.chars).toBe(expectedChars);
    expect(info.messages.estTokens).toBe(Math.ceil(expectedChars / DEFAULT_CHARS_PER_TOKEN));
  });

  it('state-сообщения группируются по type, сортировка — по chars убыв.', () => {
    const messages = [
      msg({ role: MessageRole.SYSTEM, content: 'a', metadata: { type: 'mode_change', state: true } }),
      msg({ role: MessageRole.SYSTEM, content: 'bbbbb', metadata: { type: 'mode_change', state: true } }),
      msg({ role: MessageRole.SYSTEM, content: 'c', metadata: { type: 'todos_updated', state: true } }),
      msg({ role: MessageRole.SYSTEM, content: 'disabled', metadata: { type: 'todos_updated', state: true }, disabled: true }),
    ];
    const session = makeSession(messages);

    const info = buildPromptHistoryInfo(session, 'developer');
    expect(info.stateMessages.map((s) => s.type)).toEqual(['mode_change', 'todos_updated']);
    expect(info.stateMessages[0]!.count).toBe(2);
    expect(info.stateMessages[1]!.count).toBe(1);
  });

  it('нетекстовые части отправляемых сообщений считаются вложениями', () => {
    const withAttachment = msg({ role: MessageRole.USER, content: '', author: 'user' });
    withAttachment.parts = [
      { id: 'p1', type: 'text', data: null },
      { id: 'p2', type: 'tool_result', data: { a: 1 } },
    ];
    const skipped = msg({ role: MessageRole.USER, content: '', disabled: true });
    skipped.parts = [{ id: 'p3', type: 'tool_result', data: { b: 2 } }];
    const session = makeSession([withAttachment, skipped], { userId: 'user' });

    const info = buildPromptHistoryInfo(session, 'developer');
    expect(info.attachments.count).toBe(1);
    expect(info.attachments.chars).toBe(JSON.stringify({ a: 1 }).length);
  });

  it('плейсхолдеры секретов ⟦SYNTH_SECRET_N⟧ в отправляемых сообщениях считаются', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'ключ ⟦SYNTH_SECRET_1⟧ и ⟦SYNTH_SECRET_2⟧', author: 'user' }),
      msg({ role: MessageRole.USER, content: 'выключено ⟦SYNTH_SECRET_3⟧', disabled: true }),
    ];
    const session = makeSession(messages, { userId: 'user' });

    const info = buildPromptHistoryInfo(session, 'developer');
    expect(info.secretPlaceholders).toBe(2);
  });
});

describe('lastPromptMeta', () => {
  const meta = (agentRole?: string): PromptMeta => ({
    ...(agentRole ? { agentRole } : {}),
    generation: 1,
    expected: 'miss',
    cachedTokens: 0,
    validated: true,
  });

  it('возвращает promptMeta последнего ответа; null если их нет', () => {
    const withMeta = msg({ role: MessageRole.ASSISTANT, content: 'a', agentRole: 'developer', promptMeta: meta('developer') });
    const session = makeSession([
      msg({ role: MessageRole.USER, content: 'q', author: 'user' }),
      withMeta,
    ]);

    expect(lastPromptMeta(session, 'developer')).toBe(withMeta.promptMeta);
    expect(lastPromptMeta(session)).toBe(withMeta.promptMeta);
    expect(lastPromptMeta(makeSession([]))).toBeNull();
  });

  it('пропускает promptMeta другого агента, но принимает записи без agentRole', () => {
    const legacy = msg({ role: MessageRole.ASSISTANT, content: 'l', promptMeta: meta() });
    const other = msg({ role: MessageRole.ASSISTANT, content: 'o', promptMeta: meta('researcher') });
    const session = makeSession([legacy, other]);

    // Последняя запись принадлежит другому агенту — она пропускается, берётся предыдущая
    expect(lastPromptMeta(session, 'developer')).toBe(legacy.promptMeta);
    // Запись без agentRole считается «своей» для любого агента (легаси/сабагент)
    expect(lastPromptMeta(makeSession([legacy, legacy]))).toBe(legacy.promptMeta);
    expect(lastPromptMeta(session, 'researcher')).toBe(other.promptMeta);
    expect(lastPromptMeta(session)).toBe(other.promptMeta);
  });
});

describe('instructionsMemoKey', () => {
  const base = {
    workingDir: '/w',
    contextWindow: 1000,
    model: 'm',
    language: 'ru',
    projectId: 'p1',
    injection: { enabled: true, mode: 'flag' as const },
  };

  it('детерминирован и нормализует отсутствующий projectId в пустую строку', () => {
    expect(instructionsMemoKey(base)).toBe(instructionsMemoKey({ ...base }));
    const withoutProject = {
      workingDir: base.workingDir,
      contextWindow: base.contextWindow,
      model: base.model,
      language: base.language,
      injection: base.injection,
    };
    expect(instructionsMemoKey(withoutProject)).toBe(
      instructionsMemoKey({ ...base, projectId: undefined }),
    );
  });

  it('изменение любого входа меняет ключ', () => {
    const key = instructionsMemoKey(base);
    const variants = [
      { ...base, workingDir: '/other' },
      { ...base, contextWindow: 2000 },
      { ...base, model: 'm2' },
      { ...base, language: 'en' },
      { ...base, projectId: 'p2' },
      { ...base, injection: { enabled: false, mode: 'flag' as const } },
      { ...base, injection: { enabled: true, mode: 'block' as const } },
    ];
    for (const variant of variants) {
      expect(instructionsMemoKey(variant)).not.toBe(key);
    }
  });
});
