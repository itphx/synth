import { PRIVATE_EGRESS_POLICY, checkEgressUrl } from '../net/egress-guard.js';
import type { HostResolver } from '../mcp/network-policy.js';

/**
 * ADR-052 (этап II) / PROP-100: SSRF-политика исходящих webhooks.
 *
 * Переиспользует единый egress-guard (`engine/net/egress-guard.ts`): блокируются
 * loopback/private/link-local диапазоны с DNS-резолвом всех A/AAAA. Дополнительно
 * по умолчанию требуется `https`. Флаг `allowPrivateTargets` (для dev) снимает
 * оба ограничения.
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

/**
 * Проверяет URL как цель webhook: схема http(s), при `allowPrivateTargets` —
 * разрешено всё; иначе обязателен `https` и адрес не в приватном диапазоне
 * (с DNS-резолвом).
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

  const check = await checkEgressUrl(url, PRIVATE_EGRESS_POLICY, {
    resolveHost: options.resolveHost,
  });
  return check.allowed
    ? { allowed: true, addresses: check.addresses }
    : { allowed: false, reason: check.reason };
}
