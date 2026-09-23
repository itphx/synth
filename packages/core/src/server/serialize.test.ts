import { describe, it, expect } from 'vitest';
import { serializeMessage } from './serialize.js';
import { generateId, nowISO, makeTextPart, MessageRole, type Message } from '@itphx/synth-shared';

function message(over: Partial<Message> = {}): Message {
  return {
    id: generateId(), role: MessageRole.ASSISTANT, seq: 1, origin: 'local',
    parts: [makeTextPart('x')], content: 'x', createdAt: nowISO(),
    disabled: false, pinned: false, hidden: false, ...over,
  };
}

describe('serializeMessage — ephemeral (AD-046 §7.1)', () => {
  it('отдаёт ephemeral:true для локального ответа команды', () => {
    const out = serializeMessage(message({ ephemeral: true }), 0) as Record<string, unknown>;
    expect(out.ephemeral).toBe(true);
  });

  it('обычное сообщение → ephemeral:false', () => {
    const out = serializeMessage(message(), 0) as Record<string, unknown>;
    expect(out.ephemeral).toBe(false);
  });
});
