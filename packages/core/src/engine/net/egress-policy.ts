/**
 * Egress-политика: валидация записей и резолвер «живой» политики.
 *
 * Политика резолвится **из стора при каждой операции** (per-request), без
 * фонового опроса/кэша: runtime-значение (`settings.json`) → config-дефолт →
 * встроенный дефолт. `undefined` не означает «разрешено всё».
 */

import { isIP } from 'node:net';
import type {
  EgressPolicy,
  EgressPolicyScope,
  McpNetworkPolicy,
  WebhooksEgressPolicy,
} from '@itphx/synth-shared';
import {
  DEFAULT_EGRESS_TOOLS_POLICY,
  DEFAULT_EGRESS_WEBHOOKS_POLICY,
  DEFAULT_MCP_NETWORK_POLICY,
  EGRESS_POLICY_MODES,
  WEBHOOKS_EGRESS_POLICY_MODES,
} from '@itphx/synth-shared';
import { parseCidr } from '../mcp/network-policy.js';
import { mergeEgressPolicy } from '../../storage/runtime-settings.js';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';

/** Допустимый hostname (в т.ч. `*.suffix`): буквы/цифры/дефис/подчёркивание и точки. */
const HOSTNAME_RULE_RE = /^(\*\.)?[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/i;

/**
 * Валидна ли одна запись политики: точный hostname, `*.suffix`, CIDR или
 * IP-литерал. Пустые строки, regex-подобные и мусор — невалидны.
 */
export function isValidEgressRule(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const rule = raw.trim();
  if (!rule) return false;
  if (rule.includes('/')) {
    // CIDR: адресная часть обязана быть IP-литералом.
    const slash = rule.lastIndexOf('/');
    if (slash <= 0) return false;
    return isIP(rule.slice(0, slash)) !== 0 && parseCidr(rule) !== null;
  }
  if (isIP(rule) !== 0) return true;
  // `*.suffix` — wildcard только в начале и один.
  if (rule.startsWith('*.')) {
    return HOSTNAME_RULE_RE.test(rule) && rule.length > 2;
  }
  if (rule.includes('*')) return false;
  return HOSTNAME_RULE_RE.test(rule);
}

export type EgressPolicyValidation =
  | { ok: true; policy: EgressPolicy | WebhooksEgressPolicy }
  | { ok: false; message: string };

/**
 * Валидирует запись политики (`mode` + `list` + `exceptions`).
 * `off` допустим только для webhooks (`allowOff: true`); для tools/MCP — 400.
 */
export function validateEgressPolicy(
  value: unknown,
  opts: { allowOff?: boolean } = {},
): EgressPolicyValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'policy: ожидается { mode, list: string[], exceptions: string[] }' };
  }
  const p = value as Record<string, unknown>;
  const modes: readonly string[] = opts.allowOff ? WEBHOOKS_EGRESS_POLICY_MODES : EGRESS_POLICY_MODES;
  if (typeof p.mode !== 'string' || !modes.includes(p.mode)) {
    return {
      ok: false,
      message: opts.allowOff
        ? 'policy.mode: ожидается "deny" | "allow" | "off"'
        : 'policy.mode: ожидается "deny" | "allow"',
    };
  }
  if (!Array.isArray(p.list) || !p.list.every((x) => typeof x === 'string')) {
    return { ok: false, message: 'policy.list: ожидается string[]' };
  }
  if (p.exceptions !== undefined && (!Array.isArray(p.exceptions) || !p.exceptions.every((x) => typeof x === 'string'))) {
    return { ok: false, message: 'policy.exceptions: ожидается string[]' };
  }
  const list = (p.list as string[]).map((x) => x.trim());
  const exceptions = ((p.exceptions as string[] | undefined) ?? []).map((x) => x.trim());
  for (const rule of [...list, ...exceptions]) {
    if (!isValidEgressRule(rule)) {
      return { ok: false, message: `policy: невалидная запись "${rule}" (ожидается hostname, *.suffix, CIDR или IP)` };
    }
  }
  if (list.some((x) => x.length === 0) || exceptions.some((x) => x.length === 0)) {
    return { ok: false, message: 'policy: пустые записи в list/exceptions недопустимы' };
  }
  return {
    ok: true,
    policy: {
      mode: p.mode,
      list,
      exceptions,
    } as EgressPolicy | WebhooksEgressPolicy,
  };
}

/** Фоллбеки политики из config.yaml (уже нормализованные схемой). */
export interface EgressPolicyFallbacks {
  tools?: EgressPolicy;
  webhooks?: WebhooksEgressPolicy;
  mcp?: McpNetworkPolicy;
}

/** Живой резолвер egress-политик (читает стор на каждый вызов). */
export interface EgressPolicyResolver {
  resolveTools(): Promise<EgressPolicy>;
  resolveWebhooks(): Promise<WebhooksEgressPolicy>;
  resolveMcp(): Promise<McpNetworkPolicy>;
}

function normalizeTools(policy: EgressPolicy | undefined): EgressPolicy {
  return {
    mode: policy?.mode ?? DEFAULT_EGRESS_TOOLS_POLICY.mode,
    list: [...(policy?.list ?? DEFAULT_EGRESS_TOOLS_POLICY.list)],
    exceptions: [...(policy?.exceptions ?? [])],
  };
}

/**
 * Собирает резолвер политики поверх стора runtime-настроек.
 *
 * Runtime override приоритетнее config-фоллбека; при отсутствии обоих —
 * встроенный дефолт. Каждый вызов `resolve*` читает стор заново — изменения
 * применяются без рестарта (live).
 */
export function createEgressPolicyResolver(
  settingsStore: SettingsRepository,
  fallbacks: EgressPolicyFallbacks = {},
): EgressPolicyResolver {
  return {
    async resolveTools(): Promise<EgressPolicy> {
      const runtime = (await settingsStore.getEgressPolicy('tools')) as EgressPolicy | undefined;
      return normalizeTools(mergeEgressPolicy(fallbacks.tools, runtime));
    },
    async resolveWebhooks(): Promise<WebhooksEgressPolicy> {
      const runtime = (await settingsStore.getEgressPolicy('webhooks')) as WebhooksEgressPolicy | undefined;
      const merged = mergeEgressPolicy(fallbacks.webhooks, runtime);
      return {
        mode: merged?.mode ?? DEFAULT_EGRESS_WEBHOOKS_POLICY.mode,
        list: [...(merged?.list ?? DEFAULT_EGRESS_WEBHOOKS_POLICY.list)],
        exceptions: [...(merged?.exceptions ?? [])],
      };
    },
    async resolveMcp(): Promise<McpNetworkPolicy> {
      const runtime = await settingsStore.getMcpNetworkPolicy();
      const base = fallbacks.mcp ?? DEFAULT_MCP_NETWORK_POLICY;
      return {
        mode: runtime?.mode ?? base.mode,
        list: [...(runtime?.list ?? base.list)],
        exceptions: [...(runtime?.exceptions ?? base.exceptions ?? [])],
      };
    },
  };
}

/** Egress-политика скоупа настроек (`tools` оставляет тип `EgressPolicy`). */
export async function resolveEgressScope(
  resolver: EgressPolicyResolver,
  scope: EgressPolicyScope,
): Promise<EgressPolicy | WebhooksEgressPolicy> {
  return scope === 'tools' ? resolver.resolveTools() : resolver.resolveWebhooks();
}
