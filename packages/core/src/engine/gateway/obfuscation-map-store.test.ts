// security-фикс 0.11.3 (регресс): `stripSessionSecrets` must remove the LLM
// Gateway obfuscation map AND the real secret values (`metadata.secrets`) from
// EVERY message-bearing collection of the session — not only from `messages[]`.
//
// Аудит типа `Session` (`packages/shared/src/types/session.ts`): носители
// сообщений — `messages[]`, `pendingMessages[]` и `checkpoints[].messages[]`.
// Раньше чистились только `messages[]`, поэтому карта обфускации и реальные
// значения плейсхолдеров уезжали из инстанса через экспорт сессии и портативный
// архив проекта (в чекпоинтах истории).
import { describe, expect, it } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import type { Message, Session } from '@itphx/synth-shared';
import { stripSessionSecrets } from './obfuscation-map-store.js';

/** Реальный секрет в карте обфускации сессии (плейсхолдер → значение). */
const REAL_SECRET = 'sk-live-DO-NOT-LEAK';
const PLACEHOLDER = '⟦SYNTH_SECRET_1⟧';

/** Сообщение с раскрытым секретом в `metadata.secrets` (ADR-036). */
function secretMessage(id: string, content: string): Message {
  return {
    id,
    role: MessageRole.ASSISTANT,
    seq: 1,
    origin: 'local',
    parts: [],
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    disabled: false,
    pinned: false,
    hidden: false,
    metadata: { secrets: { [PLACEHOLDER]: REAL_SECRET }, stream_id: 's1' },
  } as unknown as Message;
}

/** Пути всех узлов с ключом `secrets` внутри `metadata` (рекурсивно). */
function metadataSecretPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => metadataSecretPaths(item, `${path}[${i}]`));
  }
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, current] of Object.entries(obj)) {
    const nextPath = `${path}.${key}`;
    if (key === 'metadata' && current && typeof current === 'object' && !Array.isArray(current)
      && Object.hasOwn(current, 'secrets')) {
      out.push(nextPath);
    }
    out.push(...metadataSecretPaths(current, nextPath));
  }
  return out;
}

/** Пути всех узлов с ключом `obfuscationMap` (рекурсивно). */
function obfuscationMapPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => obfuscationMapPaths(item, `${path}[${i}]`));
  }
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, current] of Object.entries(obj)) {
    const nextPath = `${path}.${key}`;
    if (key === 'obfuscationMap') out.push(nextPath);
    out.push(...obfuscationMapPaths(current, nextPath));
  }
  return out;
}

/** Сессия с картой обфускации и секретами во всех коллекциях сообщений. */
function dirtySession(): Session {
  return {
    id: 's1',
    sessionOrigin: 'user',
    obfuscationMap: { [PLACEHOLDER]: REAL_SECRET },
    messages: [secretMessage('m1', 'ответ с секретом')],
    pendingMessages: [secretMessage('p1', 'в очереди с секретом')],
    checkpoints: [
      {
        id: 'cp1',
        sessionId: 's1',
        messages: [secretMessage('cm1', 'снимок с секретом')],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    stickyNotes: [],
    references: [],
    todos: [],
    status: {},
    settings: {} as Session['settings'],
    summarizationPending: false,
    canSummarize: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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
  } as unknown as Session;
}

describe('stripSessionSecrets (security-фикс 0.11.3)', () => {
  it('убирает карту обфускации и metadata.secrets из ВСЕХ коллекций сообщений', () => {
    const session = dirtySession();
    const stripped = stripSessionSecrets(session);

    // Рекурсивно: ни `obfuscationMap`, ни `metadata.secrets` нигде в payload'е.
    expect(obfuscationMapPaths(stripped)).toEqual([]);
    expect(metadataSecretPaths(stripped)).toEqual([]);
    expect(JSON.stringify(stripped)).not.toContain(REAL_SECRET);
  });

  it('регресс: metadata.secrets вырезается из checkpoints[].messages[]', () => {
    const stripped = stripSessionSecrets(dirtySession());
    const checkpoint = stripped.checkpoints[0]!;
    expect(checkpoint.messages).toHaveLength(1);
    expect(checkpoint.messages[0]!.metadata).toEqual({ stream_id: 's1' });
    expect(JSON.stringify(stripped.checkpoints)).not.toContain(REAL_SECRET);
  });

  it('регресс: metadata.secrets вырезается из pendingMessages[]', () => {
    const stripped = stripSessionSecrets(dirtySession());
    expect(stripped.pendingMessages).toHaveLength(1);
    expect(stripped.pendingMessages[0]!.metadata).toEqual({ stream_id: 's1' });
  });

  it('разговор сохраняется (тексты, порядок, количество сообщений)', () => {
    const stripped = stripSessionSecrets(dirtySession());
    expect(stripped.messages).toHaveLength(1);
    expect(stripped.messages[0]!.content).toBe('ответ с секретом');
    expect(stripped.messages[0]!.id).toBe('m1');
    expect(stripped.checkpoints[0]!.messages[0]!.content).toBe('снимок с секретом');
    expect(stripped.pendingMessages[0]!.content).toBe('в очереди с секретом');
  });

  it('исходный объект НЕ мутируется', () => {
    const session = dirtySession();
    stripSessionSecrets(session);
    expect(session.obfuscationMap).toEqual({ [PLACEHOLDER]: REAL_SECRET });
    expect((session.messages[0]!.metadata as Record<string, unknown>).secrets)
      .toEqual({ [PLACEHOLDER]: REAL_SECRET });
    expect((session.checkpoints[0]!.messages[0]!.metadata as Record<string, unknown>).secrets)
      .toEqual({ [PLACEHOLDER]: REAL_SECRET });
    expect((session.pendingMessages[0]!.metadata as Record<string, unknown>).secrets)
      .toEqual({ [PLACEHOLDER]: REAL_SECRET });
  });

  it('форма payload\'а не меняется: те же поля, тот же результат для чистой сессии', () => {
    const clean = {
      id: 's2',
      title: 'S',
      messages: [{ id: 'm', role: MessageRole.USER, metadata: { note: 'ok' } }],
      pendingMessages: [],
      checkpoints: [],
    } as unknown as Session;
    const stripped = stripSessionSecrets(clean);
    expect(Object.keys(stripped).sort()).toEqual(Object.keys(clean).sort());
    expect(stripped.messages[0]!.metadata).toEqual({ note: 'ok' });
  });
});
