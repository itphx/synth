/**
 * AD-071 §2.4: разрешение эффективного набора MCP-серверов.
 *
 * Формула: `(instance.defaultOn ∪ project.defaultOn ∪ session.enabled) − session.disabled`,
 * уровень — по приоритету `system > project > session`, отключённые не исчезают
 * и получают причину (AD-071 §2.2).
 */

import { describe, it, expect } from 'vitest';
import { resolveMcpScope, type McpScopeServer } from './scope.js';

function server(
  name: string,
  opts: Partial<Omit<McpScopeServer, 'name'>> = {},
): McpScopeServer {
  return {
    name,
    origin: opts.origin ?? 'instance',
    enabledByDefault: opts.enabledByDefault ?? false,
    configEnabled: opts.configEnabled ?? true,
  };
}

function byName(
  decisions: ReturnType<typeof resolveMcpScope>,
  name: string,
) {
  return decisions.find((d) => d.name === name)!;
}

describe('resolveMcpScope (AD-071 §2.4)', () => {
  it('instance.defaultOn: системный сервер включён по умолчанию', () => {
    const result = resolveMcpScope(
      [server('sys', { origin: 'instance', enabledByDefault: true })],
      null,
      {},
    );
    expect(byName(result, 'sys')).toMatchObject({
      level: 'system',
      enabled: true,
      origin: 'instance',
    });
    expect(byName(result, 'sys').reason).toBeUndefined();
  });

  it('системный сервер без enabledByDefault → disabled/not_default', () => {
    const result = resolveMcpScope([server('sys')], null, {});
    expect(byName(result, 'sys')).toMatchObject({
      level: 'system',
      enabled: false,
      reason: 'not_default',
    });
  });

  it('project.defaultOn: пользовательский сервер → level=project, enabled', () => {
    const result = resolveMcpScope(
      [server('community', { origin: 'user' })],
      { enabled: ['community'], defaultOn: ['community'] },
      {},
    );
    expect(byName(result, 'community')).toMatchObject({
      level: 'project',
      enabled: true,
      origin: 'user',
    });
  });

  it('session.enabled: пользовательский сервер → level=session, enabled', () => {
    const result = resolveMcpScope(
      [server('personal', { origin: 'user' })],
      null,
      { enabled: ['personal'] },
    );
    expect(byName(result, 'personal')).toMatchObject({
      level: 'session',
      enabled: true,
    });
  });

  it('приоритет имён system > project > session: origin=instance всегда system', () => {
    const result = resolveMcpScope(
      [server('shared', { origin: 'instance', enabledByDefault: true })],
      { enabled: ['shared'], defaultOn: ['shared'] },
      { enabled: ['shared'] },
    );
    expect(byName(result, 'shared').level).toBe('system');
  });

  it('приоритет project > session для пользовательского сервера', () => {
    const result = resolveMcpScope(
      [server('community', { origin: 'user' })],
      { enabled: ['community'], defaultOn: [] },
      { enabled: ['community'] },
    );
    // Уровень определяется проектом (enabled), несмотря на session.enabled.
    expect(byName(result, 'community')).toMatchObject({
      level: 'project',
      enabled: true,
    });
  });

  it('opt-out системного сервера: enabled=false, reason=session_optout', () => {
    const result = resolveMcpScope(
      [server('sys', { origin: 'instance', enabledByDefault: true })],
      null,
      { disabled: ['sys'] },
    );
    expect(byName(result, 'sys')).toMatchObject({
      level: 'system',
      enabled: false,
      reason: 'session_optout',
    });
  });

  it('opt-out сильнее project.defaultOn', () => {
    const result = resolveMcpScope(
      [server('community', { origin: 'user' })],
      { enabled: ['community'], defaultOn: ['community'] },
      { disabled: ['community'] },
    );
    expect(byName(result, 'community')).toMatchObject({
      level: 'project',
      enabled: false,
      reason: 'session_optout',
    });
  });

  it('config.enabled=false → disabled/config (приоритет над session_optout)', () => {
    const result = resolveMcpScope(
      [server('sys', { origin: 'instance', enabledByDefault: true, configEnabled: false })],
      null,
      { disabled: ['sys'] },
    );
    expect(byName(result, 'sys')).toMatchObject({
      enabled: false,
      reason: 'config',
    });
  });

  it('проектный сервер в enabled, но не в defaultOn → disabled/project_disabled', () => {
    const result = resolveMcpScope(
      [server('community', { origin: 'user' })],
      { enabled: ['community'], defaultOn: [] },
      {},
    );
    expect(byName(result, 'community')).toMatchObject({
      level: 'project',
      enabled: false,
      reason: 'project_disabled',
    });
  });

  it('отключённые серверы не исчезают из выдачи', () => {
    const result = resolveMcpScope(
      [server('sys', { enabledByDefault: true }), server('community', { origin: 'user' })],
      null,
      {},
    );
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.name).sort()).toEqual(['community', 'sys']);
  });

  it('project.defaultOn включает системный сервер (уровень остаётся system)', () => {
    const result = resolveMcpScope(
      [server('sys', { origin: 'instance', enabledByDefault: false })],
      { enabled: [], defaultOn: ['sys'] },
      {},
    );
    expect(byName(result, 'sys')).toMatchObject({ level: 'system', enabled: true });
  });
});
