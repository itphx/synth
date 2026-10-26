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
import type { Session } from '@itphx/synth-shared';
import {
  deserializeSession,
  deserializeSessionWorktree,
  emptySessionChildren,
  serializeSession,
  type SessionRow,
} from './sessions-mapping.js';
import { rowValues, SESSION_FIELDS, SESSION_JSON_FIELDS } from './sessions.js';

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
