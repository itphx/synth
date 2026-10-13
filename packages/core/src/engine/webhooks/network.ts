import { DEFAULT_MCP_PRIVATE_CIDRS } from '@itphx/synth-shared';
import { evaluateMcpNetworkAccess } from '../mcp/network-policy.js';
import type { HostResolver } from '../mcp/network-policy.js';

/**
 * AD-052 (этап II): SSRF-политика исходящих webhooks.
 *
 * Переиспользует проверку MCP (`evaluateMcpNetworkAccess`, AD-071): блокируются
 * loopback/private/link-local диапазоны. Дополнительно по умолчанию требуется
 * `https`. Флаг `allowPrivateTargets` (для dev) снимает оба ограничения.
 */
export interface WebhookTargetCheckResult {
  allowed: boolean;
  reason?: string;
  addresses?: string[];
}

export interface WebhookTargetCheckOptions {
  /** Разрешить http и приватные/loopback адреса (dev). */
  allowPrivateTargets?: boolean;
  /** Инъекция DNS-резолвера (тесты). */
  resolveHost?: HostResolver;
}

const PRIVATE_POLICY = {
  mode: 'deny' as const,
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
};

/**
 * Проверяет URL как цель webhook: схема http(s), при `allowPrivateTargets` —
 * разрешено всё; иначе обязателен `https` и адрес не в приватном диапазоне.
 */
export async function evaluateWebhookTarget(
  url: string,
  options: WebhookTargetCheckOptions = {},
): Promise<WebhookTargetCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `Некорректный URL webhook: ${url}` };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { allowed: false, reason: `Недопустимая схема URL webhook: ${parsed.protocol}` };
  }

  if (options.allowPrivateTargets) return { allowed: true };

  if (parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'webhook требует https (http разрешён только при allowPrivateTargets)' };
  }

  const result = await evaluateMcpNetworkAccess(url, PRIVATE_POLICY, {
    resolveHost: options.resolveHost,
  });
  return result.allowed
    ? { allowed: true, addresses: result.addresses }
    : { allowed: false, reason: result.reason, addresses: result.addresses };
}
