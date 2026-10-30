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

describe('serializeMessage — ephemeral (ADR-046 §7.1)', () => {
  it('отдаёт ephemeral:true для локального ответа команды', () => {
    const out = serializeMessage(message({ ephemeral: true }), 0) as Record<string, unknown>;
    expect(out.ephemeral).toBe(true);
  });

  it('обычное сообщение → ephemeral:false', () => {
    const out = serializeMessage(message(), 0) as Record<string, unknown>;
    expect(out.ephemeral).toBe(false);
  });
});

describe('serializeMessage — qa_pass/qa_reason (ADR-034)', () => {
  it('переносит qa_pass/qa_reason сохранённого сообщения', () => {
    const out = serializeMessage(message({ qa_pass: true, qa_reason: 'qc.all_passed' }), 0) as Record<string, unknown>;
    expect(out.qa_pass).toBe(true);
    expect(out.qa_reason).toBe('qc.all_passed');
  });

  it('провал QC → qa_pass:false и причина', () => {
    const out = serializeMessage(message({ qa_pass: false, qa_reason: 'too short' }), 0) as Record<string, unknown>;
    expect(out.qa_pass).toBe(false);
    expect(out.qa_reason).toBe('too short');
  });

  it('без QC-полей ключи отсутствуют (не null) — иначе UI включил бы бейдж', () => {
    const out = serializeMessage(message(), 0) as Record<string, unknown>;
    expect('qa_pass' in out).toBe(false);
    expect('qa_reason' in out).toBe(false);
  });
});

describe('serializeMessage — ord/turn_id/step_index/status (ADR-118)', () => {
  it('переносит поля хода и порядка записи', () => {
    const out = serializeMessage(message({
      ord: 7,
      turnId: 'turn-1',
      stepIndex: 2,
      status: 'completed',
    }), 0) as Record<string, unknown>;
    expect(out.ord).toBe(7);
    expect(out.turn_id).toBe('turn-1');
    expect(out.step_index).toBe(2);
    expect(out.status).toBe('completed');
  });

  it('незаданные поля → null (аддитивно, без падения на legacy-сообщениях)', () => {
    const out = serializeMessage(message(), 0) as Record<string, unknown>;
    expect(out.ord).toBeNull();
    expect(out.turn_id).toBeNull();
    expect(out.step_index).toBeNull();
    expect(out.status).toBeNull();
  });
});
