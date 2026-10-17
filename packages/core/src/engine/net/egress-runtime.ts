/**
 * Process-level конфигурация egress-подсистемы.
 *
 * Composition root (`server/app/deps.ts`, `backend/app/deps.ts`) один раз
 * регистрирует живой резолвер (читает `settings.json` на каждый вызов) и
 * приёмник журнала. Потребители без явной инъекции (web_fetch/web_search,
 * skills, instructions) берут политику отсюда — **при каждой операции**, без
 * стартового снимка и без кэша.
 *
 * Значения по умолчанию — встроенные дефолты (fail-closed), журнал выключен.
 */

import type { EgressPolicy, McpNetworkPolicy, WebhooksEgressPolicy } from '@itphx/synth-shared';
import {
  DEFAULT_EGRESS_TOOLS_POLICY,
  DEFAULT_EGRESS_WEBHOOKS_POLICY,
  DEFAULT_MCP_NETWORK_POLICY,
} from '@itphx/synth-shared';
import type { EgressLogSink } from './egress-guard.js';
import type { EgressPolicyResolver } from './egress-policy.js';

export interface EgressRuntime {
  resolveTools(): Promise<EgressPolicy>;
  resolveWebhooks(): Promise<WebhooksEgressPolicy>;
  resolveMcp(): Promise<McpNetworkPolicy>;
  log?: EgressLogSink;
}

function builtinResolver(): Pick<EgressRuntime, 'resolveTools' | 'resolveWebhooks' | 'resolveMcp'> {
  return {
    async resolveTools() {
      return { ...DEFAULT_EGRESS_TOOLS_POLICY, list: [...DEFAULT_EGRESS_TOOLS_POLICY.list], exceptions: [] };
    },
    async resolveWebhooks() {
      return { ...DEFAULT_EGRESS_WEBHOOKS_POLICY, list: [...DEFAULT_EGRESS_WEBHOOKS_POLICY.list], exceptions: [] };
    },
    async resolveMcp() {
      return { ...DEFAULT_MCP_NETWORK_POLICY, list: [...DEFAULT_MCP_NETWORK_POLICY.list], exceptions: [] };
    },
  };
}

let _runtime: EgressRuntime = { ...builtinResolver() };

/** Зарегистрировать живой резолвер/журнал (composition root). */
export function configureEgressRuntime(config: {
  /** Частичный резолвер (недостающие методы — встроенные дефолты). */
  resolver?: Partial<EgressPolicyResolver>;
  log?: EgressLogSink;
}): void {
  const base = builtinResolver();
  const resolver = config.resolver;
  _runtime = {
    resolveTools: resolver?.resolveTools ? resolver.resolveTools.bind(resolver) : base.resolveTools,
    resolveWebhooks: resolver?.resolveWebhooks ? resolver.resolveWebhooks.bind(resolver) : base.resolveWebhooks,
    resolveMcp: resolver?.resolveMcp ? resolver.resolveMcp.bind(resolver) : base.resolveMcp,
    ...(config.log ? { log: config.log } : {}),
  };
}

/** Текущая конфигурация egress-подсистемы. */
export function getEgressRuntime(): EgressRuntime {
  return _runtime;
}

/** Сбросить к встроенным дефолтам (герметичные тесты). */
export function resetEgressRuntime(): void {
  _runtime = { ...builtinResolver() };
}

/** Resolved-политика встроенных инструментов (live, на каждый вызов). */
export function resolveToolsEgressPolicy(): Promise<EgressPolicy> {
  return _runtime.resolveTools();
}

/** Resolved-политика webhooks (live). */
export function resolveWebhooksEgressPolicy(): Promise<WebhooksEgressPolicy> {
  return _runtime.resolveWebhooks();
}

/** Resolved-политика MCP (live). */
export function resolveMcpEgressPolicy(): Promise<McpNetworkPolicy> {
  return _runtime.resolveMcp();
}

/** Текущий приёмник журнала (undefined — журнал выключен). */
export function currentEgressLog(): EgressLogSink | undefined {
  return _runtime.log;
}
