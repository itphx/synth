import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { ExternalIdentity, ProfileStore } from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';
import type { IdentityClaimStore } from '../../storage/identity-claim-store.js';

/**
 * AD-089: маршруты идентичностей текущего пользователя (`/api/v2/me/identities`).
 * Единая реализация для core (standalone) и backend (managed); резолв
 * пользователя — через `opts.resolveUserId` (core — `local`, backend — AuthKit).
 *
 * Линковка (`POST /identities`) намеренно отсутствует: привязка внешней
 * идентичности идёт только через claim-flow (подтверждение владения id в
 * источнике) — `POST /identities/claim` с одноразовым кодом. Прямое
 * сопоставление чужого id — недопустимо.
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface IdentityRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface IdentityRouteMessages {
  identityNotFound: (c: Context) => string;
  /** AD-089 (claim-flow): код неизвестен/истёк/использован. */
  claimNotFound: (c: Context) => string;
  /** AD-089 (claim-flow): идентичность уже привязана к другому профилю. */
  claimConflict: (c: Context) => string;
  /** AD-089 (claim-flow): пустой код подтверждения. */
  claimCodeRequired: (c: Context) => string;
}

const DEFAULT_MESSAGES: IdentityRouteMessages = {
  identityNotFound: () => 'Идентичность не найдена',
  claimNotFound: () => 'Код подтверждения недействителен (неизвестен, истёк или использован)',
  claimConflict: () => 'Эта идентичность уже привязана к другому профилю',
  claimCodeRequired: () => 'Укажите код подтверждения',
};

const LOCAL_USER_ID = 'local';

export interface IdentityRoutesOptions {
  /** Резолв id текущего пользователя (standalone — `local`). */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<IdentityRouteMessages>;
  /**
   * AD-089 (claim-flow): хранилище одноразовых claim-кодов. Не передан —
   * `POST /identities/claim` не определяется (роут неактивен).
   */
  claimStore?: IdentityClaimStore;
}

/**
 * AD-089: список, отвязка и подтверждение внешних идентичностей текущего
 * пользователя.
 *
 * - `GET /identities` → `{ identities: ExternalIdentity[] }`;
 * - `DELETE /identities/:provider/:externalId` → отвязка (только свои);
 *   404, если идентичность не найдена;
 * - `POST /identities/claim` `{code}` → подтверждение владения внешней
 *   идентичностью (claim-flow): код одноразовый и выдан на сервере ingest'ом,
 *   `provider`/`externalId` берутся из записи, а не из тела запроса.
 */
export function createIdentityRoutes(
  auth: IdentityRoutesAuth,
  profileStore: ProfileStore,
  opts: IdentityRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: IdentityRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const resolveUserId = opts.resolveUserId ?? (() => LOCAL_USER_ID);

  // GET /api/v2/me/identities — идентичности текущего пользователя.
  app.get('/identities', auth.requireAuth, async (c) => {
    const userId = await resolveUserId(c);
    const profile = await profileStore.loadProfile(userId);
    return c.json({ identities: profile?.identities ?? [] });
  });

  // DELETE /api/v2/me/identities/:provider/:externalId — отвязка (только свои).
  app.delete('/identities/:provider/:externalId', auth.requireAuth, async (c) => {
    const userId = await resolveUserId(c);
    const provider = decodeURIComponent(c.req.param('provider') ?? '');
    const externalId = decodeURIComponent(c.req.param('externalId') ?? '');
    const updated = await profileStore.unlinkIdentity(userId, provider, externalId);
    if (!updated) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: messages.identityNotFound(c) } },
        404,
      );
    }
    return c.json({ identities: updated.identities ?? [] });
  });

  // POST /api/v2/me/identities/claim — подтверждение владения идентичностью.
  // Код одноразовый: `consume` гасит его; повторно использовать нельзя.
  if (opts.claimStore) {
    const claimStore = opts.claimStore;

    app.post('/identities/claim', auth.requireAuth, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.claimCodeRequired(c) } },
          400,
        );
      }

      const code = typeof (body as { code?: unknown })?.code === 'string'
        ? ((body as { code: string }).code)
        : '';
      if (!code.trim()) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.claimCodeRequired(c) } },
          400,
        );
      }

      const userId = await resolveUserId(c);
      const claim = await claimStore.consume(code, { userId });
      if (!claim) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: messages.claimNotFound(c) } },
          404,
        );
      }

      // AD-089: идентичность привязывается к текущему профилю; конфликт с другим
      // профилем (`linkIdentity` вернул `null`) → 409. Пара берётся из серверной
      // записи claim, не из тела запроса — подставить чужой id нельзя.
      const identity: ExternalIdentity = {
        provider: claim.provider,
        externalId: claim.externalId,
        linkedAt: nowISO(),
        linkedBy: userId,
      };
      const updated = await profileStore.linkIdentity(userId, identity);
      if (!updated) {
        return c.json(
          { error: { code: 'CONFLICT', message: messages.claimConflict(c) } },
          409,
        );
      }

      return c.json({ identity }, 201);
    });
  }

  return app;
}
