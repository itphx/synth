import { checkEgressUrl } from '../net/egress-guard.js';
import type { HostResolver } from '../mcp/network-policy.js';
import type { EgressPolicy, WebhooksEgressPolicy } from '@itphx/synth-shared';

/**
 * ADR-052 (этап II) / PROP-100: SSRF-политика исходящих webhooks.
 *
 * Переиспользует единый egress-guard (`engine/net/egress-guard.ts`): политика
 * `egress.webhooks` (deny/allow + exceptions), DNS-резолв всех A/AAAA.
 * `mode: 'off'` (dev) — проверок нет и `https` не требуется. `undefined`
 * политика — fail-closed (а не «разрешено всё»).
 */
export interface WebhookTargetCheckResult {
  allowed: boolean;
  reason?: string;
  addresses?: string[];
  matchedRule?: string;
}

export interface WebhookTargetCheckOptions {
  /** Resolved-политика `egress.webhooks` (обязательна по смыслу). */
  policy?: WebhooksEgressPolicy;
  /** Инъекция DNS-резолвера (тесты). */
  resolveHost?: HostResolver;
}

/**
 * Проверяет URL как цель webhook: схема http(s); `off` — без ограничений;
 * иначе обязателен `https` и адрес проходит политику (с DNS-резолвом).
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

  const policy = options.policy;
  if (!policy) {
    return { allowed: false, reason: 'egress-политика webhooks не задана (fail-closed)' };
  }
  if (policy.mode === 'off') return { allowed: true };

  if (parsed.protocol !== 'https:') {
    return { allowed: false, reason: "webhook требует https (http разрешён только при egress.webhooks.mode='off')" };
  }

  // `off` уже обработан: далее — обычная deny/allow-политика.
  const check = await checkEgressUrl(url, policy as EgressPolicy, {
    resolveHost: options.resolveHost,
  });
  return check.allowed
    ? { allowed: true, addresses: check.addresses, matchedRule: check.matchedRule }
    : { allowed: false, reason: check.reason, matchedRule: check.matchedRule };
}
