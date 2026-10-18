/**
 * PROP-102 §10: идемпотентный бэкфилл роллапов (`synth analytics rebuild`) —
 * повторный прогон не удваивает счётчики, `--dry-run` ничего не пишет, без
 * `--yes` команда отказывает, окно `--from` ограничивает сутки, а аудит
 * дополняет сообщения только положительной разницей.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId, makeTextPart, MessageRole } from '@itphx/synth-shared';
import type { Message, TokenUsage } from '@itphx/synth-shared';
import { createMemoryStorage } from '../storage/storage-context.js';
import { SessionManager } from '../sessions/manager.js';
import { rebuildAnalyticsRollups } from './rebuild.js';
import { runAnalyticsRebuildCommand } from './rebuild-command.js';

const NOW = new Date('2026-10-18T12:00:00.000Z');

/** Тестовый стенд: memory-хранилище + менеджер сессий. */
function makeEnv() {
  const storage = createMemoryStorage();
  return { storage, manager: new SessionManager(storage.sessions) };
}

function usage(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

/** Сообщение с явным `createdAt` (сутки роллапа — по нему). */
function msg(
  partial: Partial<Message> & Pick<Message, 'role' | 'content' | 'createdAt'>,
): Message {
  return {
    id: generateId(),
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(partial.content)],
    disabled: false,
    pinned: false,
    hidden: false,
    ...partial,
  } as Message;
}

type Env = ReturnType<typeof makeEnv>;

/** Создать сессию и проставить исторические даты (createdAt/archivedAt). */
async function createSession(
  { storage, manager }: Env,
  data: Parameters<SessionManager['createSession']>[0] & { createdAt?: string; archivedAt?: string },
) {
  const session = await manager.createSession(data);
  if (data.createdAt) session.createdAt = data.createdAt;
  if (data.archivedAt) session.archivedAt = data.archivedAt;
  await storage.sessions.save(session);
  return session;
}

async function addMessage(env: Env, sessionId: string, message: Message): Promise<void> {
  await env.manager.addMessage(sessionId, message);
}

/** Базовая история: usage/activity за два дня + архив + сессия саб-агента. */
async function seedHistory(env: Env) {
  const parent = await createSession(env, {
    userId: 'u1',
    projectId: 'p1',
    createdAt: '2026-10-10T09:00:00.000Z',
    archivedAt: '2026-10-12T08:00:00.000Z',
  });

  await addMessage(env, parent.id, msg({
    role: MessageRole.USER,
    content: 'вопрос',
    author: 'local',
    createdAt: '2026-10-10T10:00:00.000Z',
  }));
  await addMessage(env, parent.id, msg({
    role: MessageRole.ASSISTANT,
    content: 'ответ',
    agentRole: 'assistant',
    model: 'm1',
    usage: usage(100, 10),
    toolCalls: [{ id: 't1', name: 'read_file' }],
    metadata: { duration_ms: 1000, cost_usd: 0.5, cost_currency: 'USD', status: 'completed' },
    createdAt: '2026-10-10T10:01:00.000Z',
  }));
  await addMessage(env, parent.id, msg({
    role: MessageRole.TOOL,
    content: 'файл',
    toolCallId: 't1',
    createdAt: '2026-10-10T10:02:00.000Z',
  }));
  await addMessage(env, parent.id, msg({
    role: MessageRole.ASSISTANT,
    content: 'ревью',
    agentRole: 'reviewer',
    model: 'm2',
    usage: usage(50, 5),
    metadata: { status: 'error' },
    createdAt: '2026-10-11T09:00:00.000Z',
  }));

  // Сессия саб-агента (`agent_spawned` → мера `turns`).
  await createSession(env, {
    userId: 'u1',
    projectId: 'p1',
    parentId: parent.id,
    sessionOrigin: 'subagent',
    createdAt: '2026-10-11T09:30:00.000Z',
  });

  return parent;
}

describe('rebuildAnalyticsRollups — usage/activity', () => {
  it('восстанавливает суточные бакеты из сообщений и жизненного цикла', async () => {
    const env = makeEnv();
    await seedHistory(env);

    const result = await rebuildAnalyticsRollups({
      repo: env.storage.analyticsRollups,
      sessions: env.storage.sessions,
      now: () => NOW,
    });

    expect(result.dryRun).toBe(false);
    expect(result.from).toBe('2026-10-10');
    expect(result.to).toBe('2026-10-18');
    expect(result.days).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    // Сверка с computeSessionStats на согласованной истории не даёт расхождений.
    expect(result.statsMismatched).toBe(0);
    expect(result.warnings).toEqual([]);

    const usageRows = await env.storage.analyticsRollups.query({
      family: 'usage',
      groupBy: ['day'],
    });
    expect(usageRows).toHaveLength(2);
    expect(usageRows[0]!.dimensions).toEqual({ day: '2026-10-10' });
    expect(usageRows[0]!.measures).toEqual({
      input_tokens: 100,
      output_tokens: 10,
      requests: 1,
      messages: 1,
      duration_ms: 1000,
    });
    expect(usageRows[0]!.costByCurrency).toEqual({ USD: 0.5 });
    expect(usageRows[1]!.measures).toEqual({
      input_tokens: 50,
      output_tokens: 5,
      requests: 1,
      messages: 1,
    });
    expect(usageRows[1]!.costByCurrency).toBeUndefined();

    const activityRows = await env.storage.analyticsRollups.query({
      family: 'activity',
      groupBy: ['day'],
    });
    expect(activityRows.map((row) => row.dimensions.day)).toEqual([
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
    expect(activityRows[0]!.measures).toEqual({
      sessions_created: 1,
      messages_user: 1,
      messages_assistant: 1,
      messages_tool: 1,
      tool_calls: 1,
    });
    expect(activityRows[1]!.measures).toEqual({
      sessions_created: 1,
      messages_assistant: 1,
      errors: 1,
      turns: 1,
    });
    expect(activityRows[2]!.measures).toEqual({ sessions_archived: 1 });
  });

  it('идемпотентен: повторный прогон не удваивает счётчики', async () => {
    const env = makeEnv();
    await seedHistory(env);

    const options = {
      repo: env.storage.analyticsRollups,
      sessions: env.storage.sessions,
      now: () => NOW,
    };
    const first = await rebuildAnalyticsRollups(options);
    const usageAfterFirst = await env.storage.analyticsRollups.query({ family: 'usage' });
    const activityAfterFirst = await env.storage.analyticsRollups.query({ family: 'activity' });

    const second = await rebuildAnalyticsRollups(options);
    const usageAfterSecond = await env.storage.analyticsRollups.query({ family: 'usage' });
    const activityAfterSecond = await env.storage.analyticsRollups.query({ family: 'activity' });

    expect(second.rows).toEqual(first.rows);
    expect(usageAfterSecond).toEqual(usageAfterFirst);
    expect(activityAfterSecond).toEqual(activityAfterFirst);
    // Ключи не размножаются: итог по семейству не удваивается.
    expect(usageAfterSecond).toHaveLength(1);
    expect(usageAfterSecond[0]!.measures).toMatchObject({
      input_tokens: 150,
      output_tokens: 15,
      requests: 2,
      messages: 2,
    });
    expect(usageAfterSecond[0]!.costByCurrency).toEqual({ USD: 0.5 });
  });

  it('usage саб-агента считается один раз — по сообщениям его собственной сессии', async () => {
    const env = makeEnv();
    const parent = await createSession(env, {
      userId: 'u1',
      projectId: 'p1',
      createdAt: '2026-10-10T09:00:00.000Z',
    });
    const child = await createSession(env, {
      userId: 'u1',
      projectId: 'p1',
      parentId: parent.id,
      sessionOrigin: 'subagent',
      createdAt: '2026-10-10T10:05:00.000Z',
    });
    // Сообщение саб-агента (персистится мимо шва родителя).
    await addMessage(env, child.id, msg({
      role: MessageRole.ASSISTANT,
      content: 'саб-ответ',
      agentRole: 'developer',
      model: 'm-sub',
      usage: usage(7, 3),
      createdAt: '2026-10-10T10:06:00.000Z',
    }));
    // Ответ родителя с task-результатом (в журнале записи это дало бы отдельный
    // бакет сабагента — бэкфилл берёт его из сообщений ребёнка, без двойного счёта).
    await addMessage(env, parent.id, msg({
      role: MessageRole.ASSISTANT,
      content: 'ответ',
      agentRole: 'assistant',
      model: 'm-main',
      usage: usage(20, 2),
      metadata: {
        tool_results: [{
          name: 'task',
          result: {
            metadata: {
              child_session_id: child.id,
              subagent_usage: usage(7, 3),
              subagent_model: 'm-sub',
              subagent_type: 'developer',
            },
          },
        }],
      },
      createdAt: '2026-10-10T10:07:00.000Z',
    }));

    const result = await rebuildAnalyticsRollups({
      repo: env.storage.analyticsRollups,
      sessions: env.storage.sessions,
      now: () => NOW,
    });

    expect(result.statsMismatched).toBe(0);
    const byModel = await env.storage.analyticsRollups.query({
      family: 'usage',
      groupBy: ['model'],
    });
    const main = byModel.find((row) => row.dimensions.model === 'm-main')!;
    const sub = byModel.find((row) => row.dimensions.model === 'm-sub')!;
    expect(main.measures).toMatchObject({ input_tokens: 20, output_tokens: 2, requests: 1 });
    // Саб-агент учтён ровно один раз (своим сообщением), а не ещё и task-результатом.
    expect(sub.measures).toMatchObject({ input_tokens: 7, output_tokens: 3, requests: 1 });
  });

  it('--dry-run считает сводку и ничего не пишет', async () => {    const env = makeEnv();
    await seedHistory(env);

    const result = await rebuildAnalyticsRollups({
      repo: env.storage.analyticsRollups,
      sessions: env.storage.sessions,
      dryRun: true,
      now: () => NOW,
    });

    expect(result.dryRun).toBe(true);
    expect(result.buckets).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(result.buckets);
    expect(await env.storage.analyticsRollups.query({ family: 'usage' })).toEqual([]);
    expect(await env.storage.analyticsRollups.query({ family: 'activity' })).toEqual([]);
  });

  it('--from ограничивает окно (включительно), но сверка stats остаётся по всей сессии', async () => {
    const env = makeEnv();
    const session = await createSession(env, {
      userId: 'u1',
      projectId: 'p1',
      createdAt: '2026-10-10T09:00:00.000Z',
    });
    for (const createdAt of ['2026-10-10T10:00:00.000Z', '2026-10-12T10:00:00.000Z']) {
      await addMessage(env, session.id, msg({
        role: MessageRole.ASSISTANT,
        content: 'ответ',
        agentRole: 'assistant',
        model: 'm1',
        usage: usage(10, 2),
        metadata: { cost_usd: 0.1, cost_currency: 'USD' },
        createdAt,
      }));
    }

    const result = await rebuildAnalyticsRollups({
      repo: env.storage.analyticsRollups,
      sessions: env.storage.sessions,
      from: '2026-10-11',
      now: () => NOW,
    });

    expect(result.from).toBe('2026-10-11');
    expect(result.messages).toBe(1);
    // Окно не влияет на диагностическую сверку: расхождения нет.
    expect(result.statsMismatched).toBe(0);

    const usageRows = await env.storage.analyticsRollups.query({
      family: 'usage',
      groupBy: ['day'],
    });
    expect(usageRows.map((row) => row.dimensions)).toEqual([{ day: '2026-10-12' }]);
    const activityRows = await env.storage.analyticsRollups.query({
      family: 'activity',
      groupBy: ['day'],
    });
    // `sessions_created` (10-10) вне окна — не пишется.
    expect(activityRows.map((row) => row.dimensions)).toEqual([{ day: '2026-10-12' }]);
  });
});

describe('rebuildAnalyticsRollups — согласование источников', () => {
  it('аудит добирает только положительную разницу с сообщениями', async () => {
    const env = makeEnv();
    const session = await createSession(env, {
      userId: 'u1',
      projectId: 'p1',
      createdAt: '2026-10-10T09:00:00.000Z',
    });
    await addMessage(env, session.id, msg({
      role: MessageRole.ASSISTANT,
      content: 'ответ m1',
      agentRole: 'assistant',
      model: 'm1',
      usage: usage(100, 10),
      metadata: { cost_usd: 0.5, cost_currency: 'USD' },
      createdAt: '2026-10-10T10:00:00.000Z',
    }));
    await addMessage(env, session.id, msg({
      role: MessageRole.ASSISTANT,
      content: 'ответ m3',
      agentRole: 'assistant',
      model: 'm3',
      usage: usage(200, 20),
      metadata: { cost_usd: 1, cost_currency: 'USD' },
      createdAt: '2026-10-10T11:00:00.000Z',
    }));

    const dir = await mkdtemp(join(tmpdir(), 'synth-analytics-audit-'));
    const auditPath = join(dir, 'llm-gateway.jsonl');
    // m1: аудит больше сообщений → добавка 50/0 токенов и 1.5 USD.
    // m3: аудит меньше сообщений → добавки нет (истина — сообщения).
    // m2: сообщений нет вовсе → добавка целиком.
    await writeFile(
      auditPath,
      [
        { ts: '2026-10-10T10:00:00.000Z', type: 'obfuscated', userId: 'u1', model: 'm1', tokensIn: 150, tokensOut: 10, costUsd: 2 },
        { ts: '2026-10-10T11:00:00.000Z', type: 'obfuscated', userId: 'u1', model: 'm3', tokensIn: 100, tokensOut: 5, costUsd: 0.2 },
        { ts: '2026-10-10T12:00:00.000Z', type: 'obfuscated', userId: 'u1', model: 'm2', tokensIn: 20, tokensOut: 5 },
        { ts: '2026-10-10T13:00:00.000Z', type: 'blocked', reason: 'без usage — игнорируется' },
      ].map((entry) => JSON.stringify(entry)).join('\n'),
      'utf8',
    );

    try {
      const result = await rebuildAnalyticsRollups({
        repo: env.storage.analyticsRollups,
        sessions: env.storage.sessions,
        auditLogPath: auditPath,
        now: () => NOW,
      });

      expect(result.auditEntries).toBe(4);
      expect(result.auditGaps).toBe(2);

      const byModel = await env.storage.analyticsRollups.query({
        family: 'usage',
        groupBy: ['model'],
      });
      const m1 = byModel.find((row) => row.dimensions.model === 'm1')!;
      expect(m1.measures.input_tokens).toBe(150);
      expect(m1.measures.output_tokens).toBe(10);
      expect(m1.measures.messages).toBe(1);
      expect(m1.costByCurrency).toEqual({ USD: 2 });
      const m3 = byModel.find((row) => row.dimensions.model === 'm3')!;
      expect(m3.measures.input_tokens).toBe(200);
      expect(m3.measures.output_tokens).toBe(20);
      expect(m3.costByCurrency).toEqual({ USD: 1 });
      const m2 = byModel.find((row) => row.dimensions.model === 'm2')!;
      expect(m2.measures).toEqual({ input_tokens: 20, output_tokens: 5 });
      // Запись аудита — не сообщение: `messages`/`requests` не растут.
      expect(m2.measures.messages).toBeUndefined();
      expect(m2.measures.requests).toBeUndefined();

      // Добавка аудита не приписывается проекту (в журнале его нет).
      const byProject = await env.storage.analyticsRollups.query({
        family: 'usage',
        groupBy: ['project'],
      });
      const noProject = byProject.find((row) => row.dimensions.project === undefined)!;
      expect(noProject.measures.input_tokens).toBe(70);
      expect(noProject.measures.output_tokens).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runAnalyticsRebuildCommand', () => {
  it('без --yes и без --dry-run отказывает и ничего не пишет', async () => {
    const env = makeEnv();
    await seedHistory(env);
    const errors: string[] = [];

    const code = await runAnalyticsRebuildCommand({
      dataDir: '/tmp/synth-analytics-rebuild',
      storage: env.storage,
      now: () => NOW,
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--dry-run');
    expect(errors.join('\n')).toContain('--yes');
    expect(await env.storage.analyticsRollups.query({ family: 'usage' })).toEqual([]);
  });

  it('--dry-run показывает сводку без записи', async () => {
    const env = makeEnv();
    await seedHistory(env);
    const output: string[] = [];

    const code = await runAnalyticsRebuildCommand({
      dataDir: '/tmp/synth-analytics-rebuild',
      storage: env.storage,
      dryRun: true,
      now: () => NOW,
      log: (message) => output.push(message),
    });

    expect(code).toBe(0);
    expect(output.join('\n')).toContain('[dry-run]');
    expect(output.join('\n')).toContain('dry-run: изменения не записаны');
    expect(await env.storage.analyticsRollups.query({ family: 'usage' })).toEqual([]);
  });

  it('--yes пишет бакеты, --json отдаёт сводку', async () => {
    const env = makeEnv();
    await seedHistory(env);
    const output: string[] = [];

    const code = await runAnalyticsRebuildCommand({
      dataDir: '/tmp/synth-analytics-rebuild',
      storage: env.storage,
      yes: true,
      json: true,
      now: () => NOW,
      log: (message) => output.push(message),
    });

    expect(code).toBe(0);
    const summary = JSON.parse(output.join('\n')) as {
      buckets: number;
      rows: Array<{ family: string }>;
      dryRun: boolean;
    };
    expect(summary.dryRun).toBe(false);
    expect(summary.buckets).toBeGreaterThan(0);
    expect(summary.rows.some((row) => row.family === 'usage')).toBe(true);
    expect((await env.storage.analyticsRollups.query({ family: 'usage' })).length).toBeGreaterThan(0);
  });

  it('невалидный --from — ошибка без записи', async () => {
    const env = makeEnv();
    await seedHistory(env);
    const errors: string[] = [];

    const code = await runAnalyticsRebuildCommand({
      dataDir: '/tmp/synth-analytics-rebuild',
      storage: env.storage,
      from: '2026-13-01',
      yes: true,
      now: () => NOW,
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('YYYY-MM-DD');
    expect(await env.storage.analyticsRollups.query({ family: 'usage' })).toEqual([]);
  });
});
