/**
 * ADR-030 Этап 2b: `session_start` / `session_end` из SessionManager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import { HookBus } from '../engine/hooks/hook-bus.js';

describe('SessionManager — ADR-030 session hooks', () => {
  let tmpDir: string;
  let bus: HookBus;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-hooks-'));
    bus = new HookBus();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('эмитит session_start при создании и session_end при удалении', async () => {
    const started: Array<{ sessionId: string; projectId?: string; agent?: string }> = [];
    const ended: Array<{ sessionId: string }> = [];
    bus.on('session_start', (ctx) => { started.push(ctx); }, { mode: 'async' });
    bus.on('session_end', (ctx) => { ended.push(ctx); }, { mode: 'async' });

    const manager = new SessionManager(new FileStore({ dataDir: tmpDir }), { hooks: bus });
    const session = await manager.createSession({ projectId: 'p1', settings: { agentRole: 'developer' } });
    await manager.deleteSession(session.id);
    // emitAsync — fire-and-forget: даём обработчикам выполниться.
    await new Promise((r) => setTimeout(r, 20));

    expect(started).toHaveLength(1);
    expect(started[0]!.sessionId).toBe(session.id);
    expect(started[0]!.projectId).toBe('p1');
    expect(started[0]!.agent).toBe('developer');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.sessionId).toBe(session.id);
  });

  it('без hooks поведение прежнее: сессия создаётся и удаляется', async () => {
    const manager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const session = await manager.createSession({ title: 'S' });
    expect(session.id).toBeTruthy();
    await manager.deleteSession(session.id);
    expect(await manager.getSession(session.id)).toBeNull();
  });

  it('ADR-089: archiveSession эмитит session_end (один раз)', async () => {
    const ended: Array<{ sessionId: string }> = [];
    bus.on('session_end', (ctx) => { ended.push(ctx); }, { mode: 'async' });

    const manager = new SessionManager(new FileStore({ dataDir: tmpDir }), { hooks: bus });
    const session = await manager.createSession({});
    await manager.archiveSession(session.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toHaveLength(1);
    expect(ended[0]!.sessionId).toBe(session.id);

    // Идемпотентная архивация не эмитит повторно.
    await manager.archiveSession(session.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toHaveLength(1);
  });
});
