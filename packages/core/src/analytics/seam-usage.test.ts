/**
 * PROP-102 §3: шов записи `usage` в точке персиста assistant-сообщения —
 * собственный usage + usage сабагентов (по своей модели/агенту), без двойного счёта.
 */

import { describe, expect, it } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import type { TokenUsage } from '@itphx/synth-shared';
import { createMemoryStorage } from '../storage/storage-context.js';
import { SessionManager } from '../sessions/manager.js';
import { EventBus } from '../events/bus.js';
import { DebugCollector } from '../debug.js';
import { AnalyticsRecorder } from './recorder.js';
import { saveAssistantMessage } from '../engine/orchestrator/persistence.js';

const NOW = new Date('2026-10-18T09:00:00.000Z');

describe('saveAssistantMessage → usage-роллап', () => {
  it('пишет собственный usage и usage сабагентов отдельными бакетами', async () => {
    const storage = createMemoryStorage();
    const analytics = new AnalyticsRecorder({ repo: storage.analyticsRollups, now: () => NOW });
    const sessionManager = new SessionManager(storage.sessions);
    const session = await sessionManager.createSession({ userId: 'u1', projectId: 'p1' });

    const usage: TokenUsage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
    const subagentUsage: TokenUsage = { inputTokens: 50, outputTokens: 5, totalTokens: 55 };
    const toolResults = [
      {
        name: 'task',
        result: {
          metadata: {
            child_session_id: 'child-1',
            subagent_usage: subagentUsage,
            subagent_model: 'sub-model',
            subagent_type: 'developer',
          },
        },
      },
    ];

    await saveAssistantMessage(
      {
        sessionManager,
        eventBus: new EventBus(),
        obfMapStore: null,
        modelPriceLoader: null,
        analytics,
      },
      session.id,
      'ответ',
      'stream-1',
      'assistant',
      usage,
      'main-model',
      undefined,
      new DebugCollector(false),
      false,
      'provider',
      MessageRole.ASSISTANT,
      undefined,
      true,
      toolResults,
    );

    const rows = await storage.analyticsRollups.query({
      family: 'usage',
      groupBy: ['user', 'project', 'model', 'agent'],
    });
    expect(rows).toHaveLength(2);

    const own = rows.find((row) => row.dimensions.model === 'main-model')!;
    expect(own.dimensions).toEqual({
      user: 'u1',
      project: 'p1',
      model: 'main-model',
      agent: 'assistant',
    });
    expect(own.measures).toMatchObject({ input_tokens: 100, output_tokens: 10, requests: 1, messages: 1 });

    const sub = rows.find((row) => row.dimensions.model === 'sub-model')!;
    expect(sub.dimensions.agent).toBe('developer');
    expect(sub.measures).toMatchObject({ input_tokens: 50, output_tokens: 5, requests: 1 });
    // Сообщение саб-агента не считается за assistant-сообщение родителя.
    expect(sub.measures.messages).toBeUndefined();

    const total = (await storage.analyticsRollups.query({ family: 'usage' }))[0]!;
    expect(total.measures.input_tokens).toBe(150);
    expect(total.measures.requests).toBe(2);
  });
});
