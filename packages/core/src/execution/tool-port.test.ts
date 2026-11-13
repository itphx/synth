import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@itphx/synth-shared';
import { resolveExecutionPort } from './tool-port.js';
import type { ExecutionPort } from './ports/index.js';
import type { ExecutionRouter, ExecutionPortTarget } from './router.js';

const port = (name: string): ExecutionPort => ({
  async execute() {
    return { stdout: name, stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
  },
});

const ctx = (extra: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: 'ses_1',
  messageId: 'msg_1',
  agentRole: 'assistant',
  workingDir: '/workspace',
  extra,
  ...overrides,
});

describe('resolveExecutionPort — fallback по роутеру', () => {
  it('порт из extra имеет приоритет', () => {
    const direct = port('direct');
    expect(resolveExecutionPort(ctx({ executionPort: direct }))).toBe(direct);
  });

  it('порт не проброшен, но есть роутер — порт по профилю хода', () => {
    const routed = port('routed');
    const targets: ExecutionPortTarget[] = [];
    const router: ExecutionRouter = {
      portFor(target?: ExecutionPortTarget) {
        if (target) targets.push(target);
        return routed;
      },
    };
    const result = resolveExecutionPort(
      ctx({ executionRouter: router, executionProfile: 'devops', executionWorkspaceSubPath: 'proj' }),
    );
    expect(result).toBe(routed);
    expect(targets[0]).toMatchObject({
      profile: 'devops',
      sessionId: 'ses_1',
      workspaceSubPath: 'proj',
    });
  });

  it('нет ни порта, ни роутера — inline', () => {
    expect(resolveExecutionPort(ctx({})).isRemote).toBe(false);
  });
});
