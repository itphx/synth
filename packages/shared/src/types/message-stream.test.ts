/**
 * ADR-118: контрактная часть «Потока сообщений v2» — сверка возможностей
 * инстанса (fail-closed) и состав модельных типов.
 */
import { describe, it, expect } from 'vitest';
import {
  MESSAGE_MODEL_VERSION,
  supportsMessageModel,
  type MessageStatus,
  type PromptMode,
  type TurnStatus,
  type PromptAcceptedResponse,
  type MessageAcceptedPayload,
  type QueueStatePayload,
  type MessageDeliveredPayload,
  type TurnStartedPayload,
  type TurnFinishedPayload,
  type StepStartedPayload,
  type StepFinishedPayload,
  type PartDeltaPayload,
  type PartUpdatedPayload,
} from './message-stream.js';
import { MessageRole } from './message.js';

describe('ADR-118: сверка возможностей инстанса (fail-closed)', () => {
  it('текущая версия модели сообщений — 2', () => {
    expect(MESSAGE_MODEL_VERSION).toBe(2);
  });

  it('отсутствие capabilities → false (fail-closed)', () => {
    expect(supportsMessageModel(undefined)).toBe(false);
    expect(supportsMessageModel(null)).toBe(false);
  });

  it('отсутствие поля messageModel → false (старая версия инстанса)', () => {
    expect(supportsMessageModel({})).toBe(false);
    expect(supportsMessageModel({ eventSeq: true, replay: true, version: '0.12.5' })).toBe(false);
  });

  it('старая/чужая версия модели → false', () => {
    expect(supportsMessageModel({ messageModel: 1 })).toBe(false);
    expect(supportsMessageModel({ messageModel: 3 })).toBe(false);
  });

  it('совпадение версии модели → true', () => {
    expect(supportsMessageModel({ messageModel: MESSAGE_MODEL_VERSION })).toBe(true);
    expect(
      supportsMessageModel({
        messageModel: 2,
        eventSeq: true,
        replay: true,
        version: '0.13.0',
      }),
    ).toBe(true);
  });
});

describe('ADR-118: модельные типы хода', () => {
  it('статусы сообщения: streaming/completed/cancelled/error', () => {
    const statuses: MessageStatus[] = ['streaming', 'completed', 'cancelled', 'error'];
    expect(statuses).toEqual(['streaming', 'completed', 'cancelled', 'error']);
  });

  it('режимы приёма: queue/steer/interrupt', () => {
    const modes: PromptMode[] = ['queue', 'steer', 'interrupt'];
    expect(modes).toEqual(['queue', 'steer', 'interrupt']);
  });

  it('терминальные статусы хода: completed/cancelled/error/stopped', () => {
    const statuses: TurnStatus[] = ['completed', 'cancelled', 'error', 'stopped'];
    expect(statuses).toEqual(['completed', 'cancelled', 'error', 'stopped']);
  });
});

describe('ADR-118: payload’ы событий assignable к Record<string, unknown>', () => {
  it('payload приёма: messageId/mode/position', () => {
    const accepted: PromptAcceptedResponse & MessageAcceptedPayload = {
      messageId: 'msg-1',
      mode: 'queue',
      position: null,
    };
    const asRecord: Record<string, unknown> = accepted;
    expect(asRecord.messageId).toBe('msg-1');
    expect(asRecord.position).toBeNull();
  });

  it('payload очереди несёт только счётчики', () => {
    const queue: QueueStatePayload = { pendingCount: 2, steerCount: 1 };
    const asRecord: Record<string, unknown> = queue;
    expect(asRecord).toEqual({ pendingCount: 2, steerCount: 1 });
  });

  it('payload доставки: messageId/ord/role/author', () => {
    const delivered: MessageDeliveredPayload = {
      messageId: 'msg-2',
      ord: 7,
      role: MessageRole.USER,
      author: 'Иван',
    };
    const asRecord: Record<string, unknown> = delivered;
    expect(asRecord.ord).toBe(7);
  });

  it('payload хода и шага', () => {
    const turnStarted: TurnStartedPayload = { turnId: 'turn-1', messageId: 'msg-3' };
    const turnFinished: TurnFinishedPayload = { turnId: 'turn-1', status: 'completed' };
    const stepStarted: StepStartedPayload = {
      turnId: 'turn-1',
      stepIndex: 0,
      messageId: 'msg-4',
    };
    const stepFinished: StepFinishedPayload = {
      turnId: 'turn-1',
      stepIndex: 0,
      messageId: 'msg-4',
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    };
    const records: Record<string, unknown>[] = [turnStarted, turnFinished, stepStarted, stepFinished];
    expect(records).toHaveLength(4);
    expect(records[3]!.status).toBe('completed');
  });

  it('payload части: дельта и обновление', () => {
    const delta: PartDeltaPayload = {
      messageId: 'msg-5',
      partId: 'msg-5:text:0',
      field: 'text',
      delta: 'Привет',
    };
    const updated: PartUpdatedPayload = {
      messageId: 'msg-5',
      partId: 'msg-5:text:0',
      part: { id: 'msg-5:text:0', type: 'text', data: 'Привет' },
    };
    const records: Record<string, unknown>[] = [delta, updated];
    expect(records[0]!.delta).toBe('Привет');
    expect(records[1]!.partId).toBe('msg-5:text:0');
  });
});
