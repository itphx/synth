/**
 * Unit-тесты отображения сессии ↔ строка PostgreSQL (ADR-114): привязка к
 * worktree.
 *
 * Живая БД не нужна: проверяется маппинг `serializeSession`/`deserializeSession`
 * (тот же код, что в драйвере) и список колонок/типов (`SESSION_FIELDS`/
 * `SESSION_JSON_FIELDS`), чтобы колонка `worktree` (миграция `023`) реально
 * писалась и читалась.
 */

import { describe, expect, it } from 'vitest';
import type { Message, Session } from '@itphx/synth-shared';
import {
  deserializeMessage,
  deserializeSession,
  deserializeSessionWorktree,
  emptySessionChildren,
  messageRow,
  serializeMessage,
  serializeSession,
  type MessageRow,
  type SessionRow,
} from './sessions-mapping.js';
import {
  MESSAGE_FIELDS,
  MESSAGE_JSON_FIELDS,
  MESSAGE_MUTABLE_FIELDS,
  resolveOrd,
  rowValues,
  SESSION_FIELDS,
  SESSION_JSON_FIELDS,
} from './sessions.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'S',
    sessionOrigin: 'user',
    userId: 'u1',
    projectId: 'proj-1',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {},
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  } as Session;
}

/** Строка `sessions` из произвольного объекта (минимальный набор полей). */
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    title: 'S',
    icon: null,
    color: null,
    session_origin: 'user',
    parent_id: null,
    branch_point: null,
    plan_approved: null,
    mode: null,
    mode_by_principal: null,
    user_id: 'u1',
    owner_id: null,
    project_id: 'proj-1',
    todos: null,
    prompt_states: null,
    obfuscation_map: null,
    status: {},
    settings: {},
    mcp_servers: null,
    pending_messages: [],
    steer_inbox: [],
    current_stream: null,
    summarization_pending: false,
    can_summarize: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    archived_at: null,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    input_cost: 0,
    output_cost: 0,
    cache_read_cost: 0,
    cache_write_cost: 0,
    cache_hit_rate: null,
    ...overrides,
  } as SessionRow;
}

describe('PG-маппинг сообщения: модель хода и шага (ADR-118)', () => {
  function makeMessage(overrides: Partial<Message> = {}): Message {
    return {
      id: 'msg-1',
      role: 'assistant',
      seq: 1,
      origin: 'local',
      parts: [],
      content: 'answer',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ...overrides,
    } as Message;
  }

  it('serializeMessage кладёт ord/turn_id/step_index/status (snake_case)', () => {
    const row = serializeMessage(makeMessage({
      ord: 7,
      turnId: 'turn-1',
      stepIndex: 2,
      status: 'completed',
    }));

    expect(row.ord).toBe(7);
    expect(row.turn_id).toBe('turn-1');
    expect(row.step_index).toBe(2);
    expect(row.status).toBe('completed');
  });

  it('round-trip: порядок/ход/шаг/статус переживают запись/чтение', () => {
    const message = makeMessage({
      ord: 7,
      turnId: 'turn-1',
      stepIndex: 2,
      status: 'streaming',
    });
    const row = messageRow(message, 'sess-1');
    const loaded = deserializeMessage({
      ...(row as unknown as MessageRow),
      parts: serializeMessage(message).parts,
    });

    expect(loaded.ord).toBe(7);
    expect(loaded.turnId).toBe('turn-1');
    expect(loaded.stepIndex).toBe(2);
    expect(loaded.status).toBe('streaming');
  });

  it('legacy-строка без колонок читается как undefined (без дефолтов)', () => {
    const loaded = deserializeMessage({
      id: 'msg-legacy',
      seq: 1,
      role: 'assistant',
      origin: 'local',
      content: 'старый',
      parts: [],
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(loaded.ord).toBeUndefined();
    expect(loaded.turnId).toBeUndefined();
    expect(loaded.stepIndex).toBeUndefined();
    expect(loaded.status).toBeUndefined();
  });

  it('неизвестный статус читается как undefined (fail-soft)', () => {
    const loaded = deserializeMessage({
      id: 'msg-1',
      seq: 1,
      role: 'assistant',
      origin: 'local',
      content: 'x',
      parts: [],
      status: 'мусор',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(loaded.status).toBeUndefined();
  });

  it('колонки есть в списке и не в jsonb-наборе', () => {
    for (const field of ['ord', 'turn_id', 'step_index', 'status']) {
      expect(MESSAGE_FIELDS).toContain(field);
      expect(MESSAGE_JSON_FIELDS.has(field)).toBe(false);
    }
  });

  it('ord не перенумеровывается обновлением: в изменяемых колонках его нет', () => {
    // `updateMessage` пишет `ord` отдельной фразой `COALESCE(messages.ord, …)` —
    // уже выданное значение не перетирается (ADR-118 §2).
    expect(MESSAGE_MUTABLE_FIELDS).not.toContain('ord');
    expect(MESSAGE_MUTABLE_FIELDS).toContain('turn_id');
    expect(MESSAGE_MUTABLE_FIELDS).toContain('step_index');
    expect(MESSAGE_MUTABLE_FIELDS).toContain('status');
  });
});

describe('resolveOrd: монотонный счётчик порядка записи (ADR-118 §2)', () => {
  it('выданный вызывателем ord не перетирается', () => {
    expect(resolveOrd(5, 9)).toBe(5);
  });

  it('ord без значения берётся из max(ord)+1 по сессии', () => {
    expect(resolveOrd(undefined, 9)).toBe(9);
    expect(resolveOrd(null, 9)).toBe(9);
    expect(resolveOrd(Number.NaN, 9)).toBe(9);
  });

  it('явно заданный ord = 0 сохраняется (паритет с файловой реализацией)', () => {
    // Файловая реализация (`prepareMessageForAppend`) тоже сохраняет явно
    // заданное число: «не выдан» — это `undefined`, а не 0.
    expect(resolveOrd(0, 1)).toBe(0);
  });
});

describe('PG-маппинг сессии: привязка к worktree (ADR-114)', () => {
  it('serializeSession кладёт привязку в snake_case-объект', () => {
    const row = serializeSession(
      makeSession({
        worktree: {
          worktreeId: 'wkt_1',
          projectId: 'proj-1',
          repoPath: 'repo',
          directory: '/ws/.worktrees/proj-1/feature-x',
          branch: 'feature/x',
        },
      }),
    );

    expect(row.worktree).toEqual({
      worktree_id: 'wkt_1',
      project_id: 'proj-1',
      repo_path: 'repo',
      directory: '/ws/.worktrees/proj-1/feature-x',
      branch: 'feature/x',
    });
  });

  it('round-trip: привязка переживает запись/чтение', () => {
    const worktree = {
      worktreeId: 'wkt_1',
      projectId: 'proj-1',
      repoPath: 'repo',
      directory: '/ws/.worktrees/proj-1/feature-x',
      branch: 'feature/x',
    };
    const row = serializeSession(makeSession({ worktree }));
    const loaded = deserializeSession(makeRow({ worktree: row.worktree }), emptySessionChildren());
    expect(loaded.worktree).toEqual(worktree);
  });

  it('колонка `worktree` есть в списке колонок и она jsonb', () => {
    expect(SESSION_FIELDS).toContain('worktree');
    expect(SESSION_JSON_FIELDS.has('worktree')).toBe(true);

    // Значение уходит в БД jsonb-строкой, а не «undefined».
    const row = serializeSession(
      makeSession({
        worktree: {
          worktreeId: 'wkt_1',
          projectId: 'proj-1',
          directory: '/ws/.worktrees/proj-1/x',
          branch: 'main',
        },
      }),
    );
    const [value] = rowValues(row, ['worktree'], SESSION_JSON_FIELDS);
    expect(typeof value).toBe('string');
    expect(JSON.parse(value as string).worktree_id).toBe('wkt_1');
  });

  it('запись без привязки → NULL, чтение → undefined (прежнее поведение)', () => {
    const row = serializeSession(makeSession());
    expect(row.worktree).toBeNull();

    const [value] = rowValues(row, ['worktree'], SESSION_JSON_FIELDS);
    expect(value).toBeNull();

    const loaded = deserializeSession(makeRow({ worktree: null }), emptySessionChildren());
    expect(loaded.worktree).toBeUndefined();
  });

  it('частичные значения терпятся: без worktree_id/directory привязка игнорируется', () => {
    expect(deserializeSessionWorktree({ project_id: 'p', branch: 'main' })).toBeUndefined();
    expect(deserializeSessionWorktree({ worktree_id: 'wkt_1' })).toBeUndefined();
    expect(deserializeSessionWorktree(null)).toBeUndefined();
    expect(deserializeSessionWorktree('строка')).toBeUndefined();

    // Недостающие project_id/branch — пустая строка (поле необязательное).
    expect(deserializeSessionWorktree({ worktree_id: 'wkt_1', directory: '/d' })).toEqual({
      worktreeId: 'wkt_1',
      projectId: '',
      directory: '/d',
      branch: '',
    });
  });
});

describe('PG-маппинг сообщения: подпись thinking (Anthropic)', () => {
  function makeMessage(overrides: Partial<Message> = {}): Message {
    return {
      id: 'msg-1',
      role: 'assistant',
      seq: 1,
      origin: 'local',
      parts: [],
      content: 'answer',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ...overrides,
    } as Message;
  }

  it('serializeMessage кладёт подпись и redacted-блоки (snake_case)', () => {
    const row = serializeMessage(makeMessage({
      reasoning: 'размышление',
      reasoningSignature: 'sig-1',
      reasoningRedacted: ['opaque-1', 'opaque-2'],
    }));

    expect(row.reasoning).toBe('размышление');
    expect(row.reasoning_signature).toBe('sig-1');
    expect(row.reasoning_redacted).toEqual(['opaque-1', 'opaque-2']);
  });

  it('round-trip: подпись (в т.ч. пустая) и redacted-блоки переживают запись/чтение', () => {
    const serialized = serializeMessage(makeMessage({
      reasoning: 'r',
      reasoningSignature: 'sig-1',
      reasoningRedacted: ['opaque-1'],
    }));
    const row = messageRow(makeMessage({
      reasoning: 'r',
      reasoningSignature: 'sig-1',
      reasoningRedacted: ['opaque-1'],
    }), 'sess-1');

    const loaded = deserializeMessage({
      ...(row as unknown as MessageRow),
      parts: serialized.parts,
    });
    expect(loaded.reasoning).toBe('r');
    expect(loaded.reasoningSignature).toBe('sig-1');
    expect(loaded.reasoningRedacted).toEqual(['opaque-1']);

    // Пустая подпись — валидное значение, не «нет подписи».
    const empty = deserializeMessage({
      ...(row as unknown as MessageRow),
      parts: serialized.parts,
      reasoning_signature: '',
      reasoning_redacted: null,
    });
    expect(empty.reasoningSignature).toBe('');
    expect(empty.reasoningRedacted).toBeUndefined();
  });

  it('legacy-строка без колонок читается как undefined (без дефолтов)', () => {
    const loaded = deserializeMessage({
      id: 'msg-legacy',
      seq: 1,
      role: 'assistant',
      origin: 'local',
      content: 'старый',
      parts: [],
      reasoning: 'старое размышление',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(loaded.reasoning).toBe('старое размышление');
    expect(loaded.reasoningSignature).toBeUndefined();
    expect(loaded.reasoningRedacted).toBeUndefined();
    // reasoning-часть восстанавливается из `reasoning` (legacy-ветка без parts).
    expect(loaded.parts).toEqual([
      expect.objectContaining({ type: 'text', data: 'старый' }),
      expect.objectContaining({ type: 'reasoning', data: 'старое размышление' }),
    ]);
  });

  it('колонки есть в списке и jsonb-наборе: `reasoning_redacted` уходит в БД jsonb', () => {
    expect(MESSAGE_FIELDS).toContain('reasoning_signature');
    expect(MESSAGE_FIELDS).toContain('reasoning_redacted');
    expect(MESSAGE_JSON_FIELDS.has('reasoning_redacted')).toBe(true);
    expect(MESSAGE_JSON_FIELDS.has('reasoning_signature')).toBe(false);

    const row = serializeMessage(makeMessage({ reasoningRedacted: ['opaque-1'] })) as
      unknown as Record<string, unknown>;
    const [signature, redacted] = rowValues(
      row,
      ['reasoning_signature', 'reasoning_redacted'],
      MESSAGE_JSON_FIELDS,
    );
    expect(signature).toBeNull();
    expect(typeof redacted).toBe('string');
    expect(JSON.parse(redacted as string)).toEqual(['opaque-1']);
  });
});

describe('PG-маппинг сообщения: части reasoning с metadata (Anthropic)', () => {
  function makeMessage(overrides: Partial<Message> = {}): Message {
    return {
      id: 'msg-1',
      role: 'assistant',
      seq: 1,
      origin: 'local',
      parts: [],
      content: 'answer',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ...overrides,
    } as Message;
  }

  const messageWithReasoningParts = (): Message => makeMessage({
    parts: [
      { id: 'p-text', type: 'text', data: 'ответ' },
      { id: 'p-a', type: 'reasoning', data: 'блок A', metadata: { signature: 'sig-a' } },
      { id: 'p-b', type: 'reasoning', data: 'блок B', metadata: { signature: 'sig-b' } },
      // redacted_thinking — часть без текста, только opaque-данные.
      { id: 'p-r', type: 'reasoning', data: '', metadata: { redacted: 'opaque-1' } },
    ],
    content: 'ответ',
  });

  it('serializeMessage кладёт metadata части в jsonb-форму', () => {
    const row = serializeMessage(messageWithReasoningParts());
    expect(row.parts).toEqual([
      { id: 'p-text', type: 'text', data: 'ответ' },
      { id: 'p-a', type: 'reasoning', data: 'блок A', metadata: { signature: 'sig-a' } },
      { id: 'p-b', type: 'reasoning', data: 'блок B', metadata: { signature: 'sig-b' } },
      { id: 'p-r', type: 'reasoning', data: '', metadata: { redacted: 'opaque-1' } },
    ]);
  });

  it('round-trip: подписи блоков переживают запись/чтение, content без reasoning', () => {
    const serialized = serializeMessage(messageWithReasoningParts());
    const row = messageRow(messageWithReasoningParts(), 'sess-1');
    const loaded = deserializeMessage({
      ...(row as unknown as MessageRow),
      parts: serialized.parts,
    });

    const reasoning = loaded.parts.filter((part) => part.type === 'reasoning');
    expect(reasoning.map((part) => part.data)).toEqual(['блок A', 'блок B', '']);
    // Подпись принадлежит своему блоку — порядок и значения сохранены.
    expect(reasoning.map((part) => part.metadata)).toEqual([
      { signature: 'sig-a' },
      { signature: 'sig-b' },
      { redacted: 'opaque-1' },
    ]);

    // `content` — только текст ответа: reasoning-части служебные и в строковую
    // производную не подмешиваются.
    expect(loaded.content).toBe('ответ');
    expect(loaded.content).not.toContain('<reasoning>');
  });

  it('часть reasoning без metadata (legacy) читается как undefined', () => {
    const legacy = makeMessage({
      parts: [
        { id: 'p-text', type: 'text', data: 'ответ' },
        { id: 'p-old', type: 'reasoning', data: 'старый блок' },
      ],
      content: 'ответ',
    });
    const serialized = serializeMessage(legacy);
    expect('metadata' in serialized.parts[1]!).toBe(false);

    const row = messageRow(legacy, 'sess-1');
    const loaded = deserializeMessage({
      ...(row as unknown as MessageRow),
      parts: serialized.parts,
    });
    const reasoning = loaded.parts.find((part) => part.type === 'reasoning')!;
    expect(reasoning.data).toBe('старый блок');
    expect(reasoning.metadata).toBeUndefined();
    expect(loaded.content).toBe('ответ');
  });
});
