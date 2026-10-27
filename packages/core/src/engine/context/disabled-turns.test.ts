import { describe, expect, it } from 'vitest';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

import { suppressDisabledTurns } from './disabled-turns.js';

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

function toolMsg(callId: string, content = 'tool result'): Message {
  return msg({ role: MessageRole.TOOL, content, toolCallId: callId });
}

describe('suppressDisabledTurns', () => {
  it('отключённая user-реплика подавляет assistant/tool/error до следующей user', () => {
    const state = msg({ role: MessageRole.SYSTEM, content: 'mode', metadata: { type: 'mode_change' } });
    const messages = [
      msg({ role: MessageRole.USER, content: 'q1' }),
      msg({ role: MessageRole.ASSISTANT, content: 'a1' }),
      msg({ role: MessageRole.USER, content: 'q2', disabled: true }),
      msg({ role: MessageRole.ASSISTANT, content: 'a2' }),
      toolMsg('t1'),
      state,
      msg({ role: MessageRole.ERROR, content: 'err' }),
      msg({ role: MessageRole.USER, content: 'q3' }),
      msg({ role: MessageRole.ASSISTANT, content: 'a3' }),
    ];

    const result = suppressDisabledTurns(messages);

    expect(result[1]!.disabled).toBe(false);
    expect(result[3]!.disabled).toBe(true);
    expect(result[4]!.disabled).toBe(true);
    // Состояние сессии — не часть выключенного хода.
    expect(result[5]!.disabled).toBe(false);
    expect(result[6]!.disabled).toBe(true);
    expect(result[7]!.disabled).toBe(false);
    expect(result[8]!.disabled).toBe(false);
  });

  it('отключённый assistant с toolCalls подавляет свои tool-результаты', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'q' }),
      msg({
        role: MessageRole.ASSISTANT,
        content: 'call',
        disabled: true,
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      }),
      toolMsg('t1'),
      toolMsg('t2'),
    ];

    const result = suppressDisabledTurns(messages);

    expect(result[2]!.disabled).toBe(true);
    expect(result[3]!.disabled).toBe(false);
  });

  it('не мутирует исходные сообщения', () => {
    const assistant = msg({ role: MessageRole.ASSISTANT, content: 'a' });
    const messages = [
      msg({ role: MessageRole.USER, content: 'q', disabled: true }),
      assistant,
    ];

    const result = suppressDisabledTurns(messages);

    expect(result[1]!.disabled).toBe(true);
    expect(assistant.disabled).toBe(false);
    expect(result[1]).not.toBe(assistant);
  });

  it('следующая включённая user-реплика снова открывает ход', () => {
    const messages = [
      msg({ role: MessageRole.USER, content: 'q1', disabled: true }),
      msg({ role: MessageRole.ASSISTANT, content: 'a1' }),
      msg({ role: MessageRole.USER, content: 'q2' }),
      msg({ role: MessageRole.ASSISTANT, content: 'a2' }),
    ];

    const result = suppressDisabledTurns(messages);

    expect(result[1]!.disabled).toBe(true);
    expect(result[3]!.disabled).toBe(false);
  });
});
