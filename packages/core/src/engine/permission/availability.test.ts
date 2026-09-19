import { describe, it, expect } from 'vitest';
import { computeToolAvailability } from './availability.js';

describe('computeToolAvailability (AD-070 §2.9.1)', () => {
  it('доступен по умолчанию', () => {
    expect(computeToolAvailability('read_file', ['file_read'], {})).toEqual({ available: true });
  });

  it('role: у агента нет ни одной capability тула → unavailable(role)', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], { agentCapabilities: ['file_read'] }),
    ).toEqual({ available: false, reason: 'role' });
  });

  it('role: пересечение capabilities → доступен', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], { agentCapabilities: ['file_read', 'file_write'] }),
    ).toEqual({ available: true });
  });

  it('role: тул без capabilities считается доступным', () => {
    expect(
      computeToolAvailability('custom_tool', [], { agentCapabilities: ['file_read'] }),
    ).toEqual({ available: true });
    expect(
      computeToolAvailability('custom_tool', undefined, { agentCapabilities: ['file_read'] }),
    ).toEqual({ available: true });
  });

  it('mode: plan-рестрикция write/edit → unavailable(mode)', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], {
        sessionMode: 'plan',
        planMode: 'auto',
        planApproved: false,
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('mode: strict без утверждённого плана блокирует write', () => {
    expect(
      computeToolAvailability('edit_file', ['file_write'], {
        sessionMode: 'act',
        planMode: 'strict',
        planApproved: false,
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('mode: act + auto → write доступен', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], {
        sessionMode: 'act',
        planMode: 'auto',
        planApproved: false,
      }),
    ).toEqual({ available: true });
  });

  it('mode: MCP-тул, выключенный в текущем режиме → unavailable(mode)', () => {
    expect(
      computeToolAvailability('github_create_issue', ['mcp'], {
        sessionMode: 'plan',
        mcpToolSettings: { github: { default: { plan: false, act: true } } },
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('mode: MCP-тул, включённый в текущем режиме → доступен', () => {
    expect(
      computeToolAvailability('github_create_issue', ['mcp'], {
        sessionMode: 'act',
        mcpToolSettings: { github: { default: { plan: true, act: true } } },
      }),
    ).toEqual({ available: true });
  });

  it('role приоритетнее mode (сначала ролевая проверка)', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], {
        sessionMode: 'plan',
        planMode: 'auto',
        agentCapabilities: ['file_read'],
      }),
    ).toEqual({ available: false, reason: 'role' });
  });
});
