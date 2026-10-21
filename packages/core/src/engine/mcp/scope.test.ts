/**
 * ADR-071 §2.4: разрешение эффективного набора MCP-серверов.
 *
 * Модель per-item: системный мастер (`systemEnabled`) → проектный hard-gate
 * (`project.enabled`) → сессионный opt-out → снапшот (`session.defaultOn`)
 * или явное включение (`session.enabled`). Уровень — по приоритету
 * `system > project > session`, отключённые не исчезают и получают причину.
 */

import { describe, it, expect } from 'vitest';
import { resolveMcpProjectScope, resolveMcpScope, type McpScopeServer } from './scope.js';

function server(
  name: string,
  opts: Partial<Omit<McpScopeServer, 'name'>> = {},
): McpScopeServer {
  return {
    name,
    origin: opts.origin ?? 'instance',
    systemEnabled: opts.systemEnabled ?? true,
  };
}

function byName(
  decisions: ReturnType<typeof resolveMcpScope>,
  name: string,
) {
  return decisions.find((d) => d.name === name)!;
}

describe('resolveMcpScope (ADR-071 §2.4)', () => {
  it('сид сессии (defaultOn) включает системный сервер', () => {
    const result = resolveMcpScope([server('sys')], null, { defaultOn: ['sys'] });
    expect(byName(result, 'sys')).toMatchObject({ level: 'system', enabled: true, origin: 'instance' });
    expect(byName(result, 'sys').reason).toBeUndefined();
  });

  it('системный сервер без сида/включения → disabled/not_default', () => {
    const result = resolveMcpScope([server('sys')], null, {});
    expect(byName(result, 'sys')).toMatchObject({ level: 'system', enabled: false, reason: 'not_default' });
  });

  it('systemEnabled=false → disabled/system_disabled (жёстко, даже при session.enabled)', () => {
    const result = resolveMcpScope(
      [server('sys', { systemEnabled: false })],
      null,
      { enabled: ['sys'] },
    );
    expect(byName(result, 'sys')).toMatchObject({ enabled: false, reason: 'system_disabled' });
  });

  it('project.enabled (hard-gate) + session.defaultOn → level=project, enabled', () => {
    const result = resolveMcpScope(
      [server('community', { origin: 'user' })],
      { enabled: ['community'], defaultOn: [] },
      { defaultOn: ['community'] },
    );
    expect(byName(result, 'community')).toMatchObject({ level: 'project', enabled: true, origin: 'user' });
  });

  it('project.defaultOn НЕ читается при резолвинге (только snapshot сессии)', () => {
    const result = resolveMcpScope(
      [server('community', { origin: 'user' })],
      { enabled: ['community'], defaultOn: ['community'] },
      {},
    );
    // Проект разрешает сервер, но сессия его не засеяла/не включила → off.
    expect(byName(result, 'community')).toMatchObject({ level: 'project', enabled: false, reason: 'not_default' });
  });

  it('project.enabled=[] (явный off) блокирует и session.enabled → project_disabled', () => {
    const result = resolveMcpScope(
      [server('community', { origin: 'user' })],
      { enabled: [], defaultOn: [] },
      { enabled: ['community'], defaultOn: ['community'] },
    );
    expect(byName(result, 'community')).toMatchObject({ enabled: false, reason: 'project_disabled' });
  });

  it('project без настроек (undefined) — гейт не задан, session.enabled работает', () => {
    const result = resolveMcpScope(
      [server('personal', { origin: 'user' })],
      null,
      { enabled: ['personal'] },
    );
    expect(byName(result, 'personal')).toMatchObject({ level: 'session', enabled: true });
  });

  it('origin=instance всегда level=system', () => {
    const result = resolveMcpScope(
      [server('shared', { origin: 'instance' })],
      { enabled: ['shared'], defaultOn: [] },
      { enabled: ['shared'] },
    );
    expect(byName(result, 'shared').level).toBe('system');
  });

  it('opt-out сессии сильнее сида/включения → session_optout', () => {
    const result = resolveMcpScope(
      [server('sys')],
      null,
      { defaultOn: ['sys'], enabled: ['sys'], disabled: ['sys'] },
    );
    expect(byName(result, 'sys')).toMatchObject({ enabled: false, reason: 'session_optout' });
  });

  it('config.enabled=false без мастер-гейта не блокирует (сид, не гейт)', () => {
    // config.enabled — только сид записи реестра; в резолвинге не участвует.
    // Мастер (реестр) включён, проект не ограничивает → решает сессия.
    const off = resolveMcpScope([server('sys')], null, {});
    expect(byName(off, 'sys')).toMatchObject({ enabled: false, reason: 'not_default' });

    const on = resolveMcpScope([server('sys')], null, { enabled: ['sys'] });
    expect(byName(on, 'sys')).toMatchObject({ enabled: true });
    expect(byName(on, 'sys').reason).toBeUndefined();
  });

  it('приоритет причин: system_disabled > project_disabled', () => {
    const result = resolveMcpScope(
      [server('x', { origin: 'user', systemEnabled: false })],
      { enabled: [], defaultOn: [] },
      {},
    );
    expect(byName(result, 'x').reason).toBe('system_disabled');
  });

  it('отключённые серверы не исчезают из выдачи', () => {
    const result = resolveMcpScope(
      [server('sys'), server('community', { origin: 'user' })],
      null,
      {},
    );
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.name).sort()).toEqual(['community', 'sys']);
  });
});

/**
 * ADR-101 §10: проектный скоуп MCP — без сессионного слоя (у шага пайплайна
 * нет сессии): системный мастер + проектный hard-gate.
 */
describe('resolveMcpProjectScope (ADR-101 §10)', () => {
  it('проект разрешает сервер, система включена → enabled (без сессионного сида)', () => {
    const result = resolveMcpProjectScope(
      [server('community', { origin: 'user' })],
      { enabled: ['community'], defaultOn: [] },
    );
    expect(byName(result, 'community')).toMatchObject({ level: 'project', enabled: true });
    expect(byName(result, 'community').reason).toBeUndefined();
  });

  it('сервер вне проекта → project_disabled', () => {
    const result = resolveMcpProjectScope(
      [server('community', { origin: 'user' })],
      { enabled: ['other'], defaultOn: [] },
    );
    expect(byName(result, 'community')).toMatchObject({ enabled: false, reason: 'project_disabled' });
  });

  it('системный мастер выключен → system_disabled (приоритет выше проектного)', () => {
    const result = resolveMcpProjectScope(
      [server('community', { origin: 'user', systemEnabled: false })],
      { enabled: ['community'], defaultOn: [] },
    );
    expect(byName(result, 'community')).toMatchObject({ enabled: false, reason: 'system_disabled' });
  });

  it('без проектного скоупа (legacy) → системно-включённые серверы доступны', () => {
    const result = resolveMcpProjectScope([server('sys'), server('off', { systemEnabled: false })], null);
    expect(byName(result, 'sys')).toMatchObject({ enabled: true });
    expect(byName(result, 'off')).toMatchObject({ enabled: false, reason: 'system_disabled' });
  });
});
