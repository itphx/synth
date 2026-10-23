import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { checkPluginTokenBinding } from '@itphx/synth-core';
import { PLUGIN_TOKEN_ERROR_CODES } from '@itphx/synth-core';
import type { PluginServerPolicy } from '@itphx/synth-shared';
import { t } from '../lib/i18n.js';

/**
 * ADR-090 Ф7 (Уровень 2): guard server-scoped токена плагина — backend-обёртка
 * над core-проверкой {@link checkPluginTokenBinding}.
 *
 * Enforcement (сверка заголовка `X-Synth-Plugin-Id`, scope `plugins:invoke` и
 * серверного allow-list) остаётся в **core** — здесь только локализация
 * отказов (как у `scopeGuard`/`serviceProjectProjection`). Для интерактивных
 * кред (нет `serviceKey` в контексте) и для обычных service-key (без привязки
 * к плагину) guard — no-op.
 *
 * Правило **fail-closed**: ключ с привязкой `plugin_id` без корректного
 * заголовка отвергается всегда.
 */

/** Локализованный 403 по коду отказа core-проверки. */
function localizedDenial(c: Context, code: string): Response {
  if (code === PLUGIN_TOKEN_ERROR_CODES.scopeRequired) {
    return c.json(
      {
        error: {
          code: PLUGIN_TOKEN_ERROR_CODES.scopeRequired,
          message: t('errors.forbidden.scopeRequired', undefined, c),
        },
      },
      403,
    );
  }
  if (code === PLUGIN_TOKEN_ERROR_CODES.notAllowed) {
    return c.json(
      {
        error: {
          code: PLUGIN_TOKEN_ERROR_CODES.notAllowed,
          message: t('errors.forbidden.pluginNotAllowed', undefined, c),
        },
      },
      403,
    );
  }
  return c.json(
    {
      error: {
        code: PLUGIN_TOKEN_ERROR_CODES.idMismatch,
        message: t('errors.forbidden.pluginIdMismatch', undefined, c),
      },
    },
    403,
  );
}
/**
 * Guard plugin-bound токена (Ф7): монтируется **после** резолва
 * service-кредентал и **до** роутов, поэтому правило действует на все
 * серверные API, а не только на плагинные.
 *
 * `getPolicy` — живой серверный allow-list (`plugins.hybrid`); политика
 * меняется рестартом (инвариант 24), поэтому берётся из работающего рантайма.
 */
export function requirePluginTokenBinding(
  getPolicy: () => PluginServerPolicy | undefined,
) {
  return createMiddleware(async (c, next) => {
    const denied = checkPluginTokenBinding(c as unknown as Context, getPolicy());
    if (!denied) {
      await next();
      return;
    }
    let code: string = PLUGIN_TOKEN_ERROR_CODES.idMismatch;
    try {
      const body = (await denied.clone().json()) as { error?: { code?: string } };
      if (body?.error?.code) code = body.error.code;
    } catch {
      // Тело ответа нечитаемо — отказ по умолчанию (несовпадение plugin_id).
    }
    return localizedDenial(c as unknown as Context, code);
  });
}
