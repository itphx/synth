import { describe, expect, it } from 'vitest';

import {
  PLUGIN_HYBRID_MODES,
  PLUGIN_ID_HEADER,
  PLUGIN_INVOKE_SCOPE,
  evaluatePluginServerPolicy,
  isPluginAllowedByServerPolicy,
  parsePluginPolicySignal,
} from './plugin-hybrid.js';

/**
 * ADR-090 Ф7: контракт гибридной политики плагинов (Уровень 1 — cooperative,
 * Уровень 2 — server-scoped токены).
 */
describe('гибридная политика плагинов (ADR-090 Ф7)', () => {
  it('режимы политики: off|allowlist', () => {
    expect(PLUGIN_HYBRID_MODES).toEqual(['off', 'allowlist']);
    expect(PLUGIN_ID_HEADER).toBe('X-Synth-Plugin-Id');
    expect(PLUGIN_INVOKE_SCOPE).toBe('plugins:invoke');
  });

  it('политика неизвестна → unverified (cooperative: плагин работает)', () => {
    expect(evaluatePluginServerPolicy(undefined, 'demo')).toBe('unverified');
    expect(evaluatePluginServerPolicy(null, 'demo')).toBe('unverified');
    expect(isPluginAllowedByServerPolicy(undefined, 'demo')).toBe(true);
  });

  it('mode=off — сервер не ограничивает: allowed', () => {
    const policy = { mode: 'off' as const, allow: [] };
    expect(evaluatePluginServerPolicy(policy, 'demo')).toBe('allowed');
    expect(isPluginAllowedByServerPolicy(policy, 'demo')).toBe(true);
  });

  it('mode=allowlist: плагин вне списка — denied, внутри — allowed', () => {
    const policy = { mode: 'allowlist' as const, allow: ['allowed-plugin'] };
    expect(evaluatePluginServerPolicy(policy, 'allowed-plugin')).toBe('allowed');
    expect(evaluatePluginServerPolicy(policy, 'other-plugin')).toBe('denied');
    expect(isPluginAllowedByServerPolicy(policy, 'other-plugin')).toBe(false);
  });

  it('mode=allowlist с пустым списком — не разрешён никто', () => {
    const policy = { mode: 'allowlist' as const, allow: [] };
    expect(evaluatePluginServerPolicy(policy, 'demo')).toBe('denied');
  });

  it('сигнал дискавери: разбор и отказ на мусоре (старый сервер без поля)', () => {
    expect(parsePluginPolicySignal({ enabled: true, mode: 'allowlist' })).toEqual({
      enabled: true,
      mode: 'allowlist',
    });
    expect(parsePluginPolicySignal({ enabled: false, mode: 'off' })).toEqual({
      enabled: false,
      mode: 'off',
    });
    // Неизвестный режим/мусор → «неизвестно» (undefined), без падения.
    expect(parsePluginPolicySignal({ enabled: true, mode: 'weird' })).toBeUndefined();
    expect(parsePluginPolicySignal({})).toBeUndefined();
    expect(parsePluginPolicySignal(null)).toBeUndefined();
    expect(parsePluginPolicySignal([{ mode: 'off' }])).toBeUndefined();
  });
});
