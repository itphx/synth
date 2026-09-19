/**
 * AD-070 §2.6: агрегация статистики сессии — агенты, пользователи,
 * рекурсивный rollup usage саб-агентов (tool `task`), защита от циклов/глубины.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { computeSessionStats, MAX_SUBAGENT_DEPTH } from './stats.js';
import { FileStore } from '../storage/file-store.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';

function msg(partial: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
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
  } as Message;
}

function usage(input: number, output: number, cacheRead = 0): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadTokens: cacheRead,
  };
}

/** Цены за 1M токенов для модели `m`. */
const pricing = (model: string) =>
  model === 'm' ? { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.5 } : null;

describe('computeSessionStats (AD-070 §2.6)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-stats-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function load(session: Session): Promise<Session> {
    return (await sessionManager.getSession(session.id))!;
  }

  const deps = () => ({
    getSession: (id: string) => sessionManager.getSession(id),
    getModelPricing: pricing,
  });

  it('агрегирует по agent_role: usage, cost, cache_hit_rate, output_tps', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'hi', author: 'local' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT,
      content: 'dev answer',
      agentRole: 'developer',
      model: 'm',
      usage: usage(1000, 100, 400),
      metadata: { duration_ms: 2000 },
    }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT,
      content: 'review answer',
      agentRole: 'reviewer',
      model: 'm',
      usage: usage(500, 50),
      metadata: { duration_ms: 1000 },
    }));

    const stats = await computeSessionStats(await load(session), deps());

    const dev = stats.agents.find((a) => a.agent_role === 'developer')!;
    expect(dev.messages).toBe(1);
    expect(dev.input_tokens).toBe(1000);
    expect(dev.output_tokens).toBe(100);
    expect(dev.cache_read_tokens).toBe(400);
    expect(dev.cache_hit_rate).toBeCloseTo(0.4, 12);
    expect(dev.duration_ms).toBe(2000);
    expect(dev.output_tps).toBeCloseTo(50, 12);
    // 1000*1/1e6 + 100*2/1e6 + 400*0.5/1e6 = 0.0014
    expect(dev.cost_usd).toBeCloseTo(0.0014, 12);

    const rev = stats.agents.find((a) => a.agent_role === 'reviewer')!;
    expect(rev.messages).toBe(1);
    expect(rev.output_tps).toBeCloseTo(50, 12);
    expect(rev.cache_hit_rate).toBe(0);
  });

  it('tool-chain сообщения не считаются ответом агента, tool — не агент', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'hi', author: 'local' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT,
      content: 'intermediate',
      agentRole: 'developer',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      metadata: { tool_chain: true },
    }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.TOOL,
      content: 'tool result',
      agentRole: 'developer',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT,
      content: 'final',
      agentRole: 'developer',
      model: 'm',
      usage: usage(10, 5),
      metadata: { duration_ms: 1000 },
    }));

    const stats = await computeSessionStats(await load(session), deps());
    const dev = stats.agents.find((a) => a.agent_role === 'developer')!;
    expect(dev.messages).toBe(1);
    expect(dev.input_tokens).toBe(10);
  });

  it('атрибуция usage по автору user-сообщения (два автора)', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'a', author: 'alice' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'a1', agentRole: 'developer', model: 'm', usage: usage(100, 10),
    }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.TOOL, content: 'tool', agentRole: 'developer',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }));
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'b', author: 'bob' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'b1', agentRole: 'developer', model: 'm', usage: usage(200, 20),
    }));

    const stats = await computeSessionStats(await load(session), deps());
    const alice = stats.users.find((u) => u.author === 'alice')!;
    const bob = stats.users.find((u) => u.author === 'bob')!;

    expect(alice.messages).toBe(1);
    expect(alice.input_tokens).toBe(100);
    expect(alice.output_tokens).toBe(10);
    expect(bob.messages).toBe(1);
    expect(bob.input_tokens).toBe(200);
    expect(bob.output_tokens).toBe(20);
  });

  it('подтягивает usage дочерней сессии task (child_session_id)', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    const child = await sessionManager.createSession({ parentId: session.id, settings: { agentRole: 'task' } });
    await sessionManager.addMessage(child.id, msg({
      role: MessageRole.ASSISTANT, content: 'subagent answer', agentRole: 'task', model: 'm', usage: usage(300, 30),
    }));

    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'hi', author: 'local' }));
    // tool-chain tool-сообщение с child_session_id (как сохраняет _persistToolChain).
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.TOOL,
      content: 'task result',
      agentRole: 'developer',
      metadata: { tool_name: 'task', subagent_type: 'task', child_session_id: child.id },
    }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'final', agentRole: 'developer', model: 'm', usage: usage(100, 10),
      metadata: {
        tool_results: [{ name: 'task', result: { metadata: { child_session_id: child.id, subagent_type: 'task' } } }],
      },
    }));

    const stats = await computeSessionStats(await load(session), deps());
    const dev = stats.agents.find((a) => a.agent_role === 'developer')!;
    // Дедупликация: child найден и в tool-сообщении, и в tool_results → 1 сессия.
    expect(dev.subagent_sessions).toBe(1);
    expect(dev.subagent_tokens).toBe(330);
  });

  it('рекурсивно подтягивает внуков и ограничивает глубину', async () => {
    const root = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    // Цепочка root → c1 → c2 → ... → c7, у каждого потомка usage.
    let parentId = root.id;
    const chain: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const s = await sessionManager.createSession({ parentId, settings: { agentRole: 'task' } });
      chain.push(s.id);
      parentId = s.id;
    }
    // Ссылки: root → c1, c_i → c_{i+1}; у потомков — usage.
    await sessionManager.addMessage(root.id, msg({
      role: MessageRole.TOOL, content: 'task', agentRole: 'developer',
      metadata: { tool_name: 'task', child_session_id: chain[0] },
    }));
    for (let i = 0; i < chain.length; i++) {
      const next = chain[i + 1];
      if (next) {
        await sessionManager.addMessage(chain[i]!, msg({
          role: MessageRole.TOOL, content: 'task', agentRole: 'task',
          metadata: { tool_name: 'task', child_session_id: next },
        }));
      }
      await sessionManager.addMessage(chain[i]!, msg({
        role: MessageRole.ASSISTANT, content: 'a', agentRole: 'task', model: 'm', usage: usage(100, 10),
      }));
    }

    const stats = await computeSessionStats(await load(root), deps());
    const dev = stats.agents.find((a) => a.agent_role === 'developer')!;
    // Глубина ≤ MAX_SUBAGENT_DEPTH (5): учитываются c1..c5, не c6/c7.
    expect(dev.subagent_sessions).toBe(MAX_SUBAGENT_DEPTH);
    expect(dev.subagent_tokens).toBe(MAX_SUBAGENT_DEPTH * 110);
  });

  it('защита от циклов: ребёнок ссылается на корень', async () => {
    const root = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    const child = await sessionManager.createSession({ parentId: root.id, settings: { agentRole: 'task' } });
    // Ребёнок ссылается на корень как на своего ребёнка — цикл.
    await sessionManager.addMessage(child.id, msg({
      role: MessageRole.TOOL, content: 'loop', agentRole: 'task',
      metadata: { tool_name: 'task', child_session_id: root.id },
    }));
    await sessionManager.addMessage(child.id, msg({
      role: MessageRole.ASSISTANT, content: 'a', agentRole: 'task', model: 'm', usage: usage(50, 5),
    }));
    await sessionManager.addMessage(root.id, msg({
      role: MessageRole.TOOL, content: 'task', agentRole: 'developer',
      metadata: { tool_name: 'task', child_session_id: child.id },
    }));

    const stats = await computeSessionStats(await load(root), deps());
    const dev = stats.agents.find((a) => a.agent_role === 'developer')!;
    expect(dev.subagent_sessions).toBe(1);
    expect(dev.subagent_tokens).toBe(55);
  });

  it('нули: без usage и duration output_tps/cache_hit_rate = 0', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'no usage', agentRole: 'developer',
    }));

    const stats = await computeSessionStats(await load(session), deps());
    const dev = stats.agents.find((a) => a.agent_role === 'developer')!;
    expect(dev.output_tps).toBe(0);
    expect(dev.cache_hit_rate).toBe(0);
    expect(dev.duration_ms).toBe(0);
    expect(dev.cost_usd).toBe(0);
  });

  it('cost_usd берётся из metadata, если нет загрузчика цен', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'x', agentRole: 'developer', model: 'm', usage: usage(10, 1),
      metadata: { cost_usd: 0.25 },
    }));

    const stats = await computeSessionStats(await load(session), {
      getSession: (id) => sessionManager.getSession(id),
    });
    expect(stats.agents.find((a) => a.agent_role === 'developer')!.cost_usd).toBe(0.25);
  });

  it('resolveAuthorName подставляет display_name автора', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'a', author: 'alice' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'a1', agentRole: 'developer', model: 'm', usage: usage(100, 10),
    }));

    const stats = await computeSessionStats(await load(session), {
      ...deps(),
      resolveAuthorName: async (author) => (author === 'alice' ? 'Alice Smith' : null),
    });
    const alice = stats.users.find((u) => u.author === 'alice')!;
    expect(alice.display_name).toBe('Alice Smith');
  });

  it('без resolveAuthorName или при null — только author', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'a', author: 'alice' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'a1', agentRole: 'developer', model: 'm', usage: usage(100, 10),
    }));

    const withoutResolver = await computeSessionStats(await load(session), deps());
    expect(withoutResolver.users.find((u) => u.author === 'alice')!.display_name).toBeUndefined();

    const withNull = await computeSessionStats(await load(session), {
      ...deps(),
      resolveAuthorName: async () => null,
    });
    expect(withNull.users.find((u) => u.author === 'alice')!.display_name).toBeUndefined();
  });

  it('кэширует resolveAuthorName: один вызов на автора', async () => {
    const session = await sessionManager.createSession({ settings: { agentRole: 'developer' } });
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'a', author: 'alice' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'a1', agentRole: 'developer', model: 'm', usage: usage(100, 10),
    }));
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'b', author: 'alice' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'a2', agentRole: 'developer', model: 'm', usage: usage(50, 5),
    }));
    await sessionManager.addMessage(session.id, msg({ role: MessageRole.USER, content: 'c', author: 'bob' }));
    await sessionManager.addMessage(session.id, msg({
      role: MessageRole.ASSISTANT, content: 'b1', agentRole: 'developer', model: 'm', usage: usage(20, 2),
    }));

    const calls: string[] = [];
    const stats = await computeSessionStats(await load(session), {
      ...deps(),
      resolveAuthorName: async (author) => {
        calls.push(author);
        return null;
      },
    });

    expect(calls.filter((a) => a === 'alice')).toHaveLength(1);
    expect(calls.filter((a) => a === 'bob')).toHaveLength(1);
    expect(stats.users).toHaveLength(2);
  });
});
