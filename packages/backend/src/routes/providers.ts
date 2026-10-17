import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { JsonStoreLike } from '@itphx/synth-core';
import type { EgressPolicy, ProviderConfig } from '@itphx/synth-shared';
import {
  createProviderRoutes as createCoreProviderRoutes,
  checkEgressUrl,
  fetchWithEgressGuard,
  sanitizeEgressTarget,
  PRIVATE_EGRESS_POLICY,
} from '@itphx/synth-core';
import type { EgressLogSink } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';

/** Инъекция egress-политики/журнала для `/fetch-icon` (резолвер из deps). */
export interface ProviderRoutesEgressOptions {
  /** Живой резолвер `egress.tools` (per-request; без него — встроенный дефолт). */
  resolvePolicy?: () => Promise<EgressPolicy>;
  /** Приёмник журнала внешних запросов (scope `providers`). */
  log?: EgressLogSink;
}

/**
 * Backend-обёртка над core-фабрикой провайдеров: добавляет только RBAC
 * (мутации — ADMIN), rate limit на тест подключения и backend-only `fetch-icon`.
 *
 * URL провайдера проверяется общей egress-политикой (`egress.tools`, live),
 * без собственной копии списка приватных диапазонов.
 */
export function createProviderRoutes(
  kit: AuthKit,
  store: JsonStoreLike<ProviderConfig>,
  providerCache: Map<string, ProviderConfig>,
  egress: ProviderRoutesEgressOptions = {},
): Hono {
  const app = new Hono();

  // POST /api/v2/providers/fetch-icon — получить favicon с домена (admin).
  // Статический сегмент регистрируем до core-роутов (в т.ч. /:name).
  app.post('/fetch-icon', kit.requireAdmin, createRateLimiter(10, 60_000), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = body.url?.trim();
    if (!url) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.urlRequired', undefined, c) } }, 400);
    }

    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.invalidUrl', undefined, c) } }, 400);
    }

    // SSRF-защита: resolved egress-политика (включая exceptions и DNS-резолв).
    const policy = egress.resolvePolicy ? await egress.resolvePolicy() : PRIVATE_EGRESS_POLICY;
    const networkCheck = await checkEgressUrl(origin, policy);
    if (!networkCheck.allowed) {
      // Отказ до HTTP-запроса — фиксируем в журнале egress (ответ остаётся 400).
      if (egress.log) {
        const target = sanitizeEgressTarget(origin);
        try {
          await egress.log({
            scope: 'providers',
            host: target.host,
            url: target.url,
            method: 'GET',
            status: 'blocked',
            reason: networkCheck.reason,
            ...(networkCheck.matchedRule ? { matchedRule: networkCheck.matchedRule } : {}),
          });
        } catch (err) {
          console.warn(`[providers] egress log: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.invalidUrl', undefined, c) } }, 400);
    }

    try {
      const iconUrl = `${origin}/favicon.ico`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const resp = await fetchWithEgressGuard(iconUrl, {
        signal: controller.signal,
        headers: { Accept: 'image/*' },
      }, { policy, scope: 'providers', log: egress.log });
      clearTimeout(timer);

      if (resp.ok && resp.headers.get('content-type')?.includes('image')) {
        const buffer = await resp.arrayBuffer();
        const ct = resp.headers.get('content-type') || 'image/x-icon';
        const b64 = Buffer.from(buffer).toString('base64');
        return c.json({ icon: `data:${ct};base64,${b64}`, source: iconUrl });
      }

      // Попробовать найти <link rel="icon"> в HTML
      const htmlController = new AbortController();
      const htmlTimer = setTimeout(() => htmlController.abort(), 5000);

      const htmlResp = await fetchWithEgressGuard(origin, {
        signal: htmlController.signal,
        headers: { Accept: 'text/html' },
      }, { policy, scope: 'providers', log: egress.log });
      clearTimeout(htmlTimer);

      if (htmlResp.ok) {
        const html = await htmlResp.text();
        const match = html.match(/<link[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*href=["']([^"']+)["']/i)
          || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut\s+)?icon["']/i);

        if (match) {
          const href = match[1];
          if (href) {
            let resolved = href;
            if (resolved.startsWith('/')) resolved = `${origin}${resolved}`;
            else if (!resolved.startsWith('http')) resolved = `${origin}/${resolved}`;

            const iconResp = await fetchWithEgressGuard(resolved, {
              signal: AbortSignal.timeout(5000),
              headers: { Accept: 'image/*' },
            }, { policy, scope: 'providers', log: egress.log });
            if (iconResp.ok) {
              const buffer = await iconResp.arrayBuffer();
              const ct = iconResp.headers.get('content-type') || 'image/x-icon';
              const b64 = Buffer.from(buffer).toString('base64');
              return c.json({ icon: `data:${ct};base64,${b64}`, source: resolved });
            }
          }
        }
      }

      return c.json({ icon: null, error: t('errors.notFound.favicon', undefined, c) });
    } catch (err) {
      return c.json({
        icon: null,
        error: err instanceof Error ? err.message : t('errors.faviconFetchError', undefined, c),
      });
    }
  });

  // Общая логика (GET /, POST /, GET/DELETE /:name, POST /:name/test) — в core.
  app.route('/', createCoreProviderRoutes(
    { requireAuth: kit.requireAuth },
    store,
    providerCache,
    {
      writeGuard: kit.requireAdmin,
      detailGuard: kit.requireAdmin,
      testEnabled: true,
      testGuard: kit.requireAdmin,
      testMiddleware: [createRateLimiter(5, 60_000)],
      messages: {
        nameRequired: (c) => t('errors.validation.nameRequired', undefined, c),
        providerNotFound: (c) => t('errors.notFound.provider', undefined, c),
        providerDisabled: (c) => t('errors.providerDisabled', undefined, c),
        urlRequired: (c) => t('errors.validation.urlRequired', undefined, c),
        urlInvalid: (c) => t('errors.validation.invalidUrl', undefined, c),
        connectionError: (c) => t('errors.connectionError', undefined, c),
      },
    },
  ));

  return app;
}
