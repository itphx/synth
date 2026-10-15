import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { ExternalIdentity, ProfileStore } from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';
import type { IdentityClaimStore } from '../../storage/identity-claim-store.js';

/**
 * ADR-089: маршруты идентичностей текущего пользователя (`/api/v2/me/identities`).
 * Единая реализация для core (standalone) и backend (managed).
 *
 * ВАЖНО: резолвер `opts.resolveProfileId` возвращает **id профиля**
 * (`ProfileData.id`) текущего пользователя, а не OIDC `sub`/username/иной
 * идентификатор аутентификации. Профили хранятся под сгенерированным `id`
 * (`FileProfileStore.getOrCreateProfile` → `generateId()`) и ищутся по
 * `username`; подстановка `sub`/username в `loadProfile`/`linkIdentity` даёт
 * «профиль не найден» и ложный конфликт. Core-дефолт резолвит профиль
 * `local`, backend — профиль по `username` аутентифицированного пользователя.
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
  /** ADR-089 (claim-flow): код неизвестен/истёк/использован. */
  claimNotFound: (c: Context) => string;
  /** ADR-089 (claim-flow): идентичность уже привязана к другому профилю. */
  claimConflict: (c: Context) => string;
  /** ADR-089 (claim-flow): пустой код подтверждения. */
  claimCodeRequired: (c: Context) => string;
  /** Не удалось определить профиль текущего пользователя (пустой id). */
  unauthorized: (c: Context) => string;
}

const DEFAULT_MESSAGES: IdentityRouteMessages = {
  identityNotFound: () => 'Идентичность не найдена',
  claimNotFound: () => 'Код подтверждения недействителен (неизвестен, истёк или использован)',
  claimConflict: () => 'Эта идентичность уже привязана к другому профилю',
  claimCodeRequired: () => 'Укажите код подтверждения',
  unauthorized: () => 'Требуется аутентификация',
};

/** Username профиля standalone-пользователя (core); сам id генерируется стором. */
const LOCAL_PROFILE_USERNAME = 'local';

export interface IdentityRoutesOptions {
  /**
   * Резолв **id профиля** текущего пользователя (`ProfileData.id`), НЕ OIDC
   * `sub`/username. Пустая строка → роут ответит 401 `UNAUTHORIZED`. Core-дефолт
   * создаёт/резолвит профиль `local`.
   */
  resolveProfileId?: (c: Context) => string | Promise<string>;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<IdentityRouteMessages>;
  /**
   * ADR-089 (claim-flow): хранилище одноразовых claim-кодов. Не передан —
   * `POST /identities/claim` не определяется (роут неактивен).
   */
  claimStore?: IdentityClaimStore;
  /**
   * ADR-089 (claim-flow): необязательный rate-limit guard на `POST /identities/claim`
   * (per-user, напр. fixed window 60 c) — защита 6-символьного одноразового кода
   * от брутфорса. Core/backend передают свой middleware (в core — поверх
   * `KeyRateLimiter`, в backend — `createRateLimiter`); без него роут работает
   * без ограничения.
   */
  rateLimitGuard?: Middleware;
}

/**
 * ADR-089: список, отвязка и подтверждение внешних идентичностей текущего
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
  // Дефолт — standalone: резолвим/создаём профиль `local` и работаем с его id.
  const resolveProfileId = opts.resolveProfileId
    ?? (async () => (await profileStore.getOrCreateProfile({ username: LOCAL_PROFILE_USERNAME })).id);

  /** Пустой id профиля (не аутентифицирован) → 401, чтобы не искать профиль с пустым id. */
  const unauthorized = (c: Context) =>
    c.json({ error: { code: 'UNAUTHORIZED', message: messages.unauthorized(c) } }, 401);

  // GET /api/v2/me/identities — идентичности текущего пользователя.
  app.get('/identities', auth.requireAuth, async (c) => {
    const profileId = await resolveProfileId(c);
    if (!profileId.trim()) return unauthorized(c);
    const profile = await profileStore.loadProfile(profileId);
    return c.json({ identities: profile?.identities ?? [] });
  });

  // DELETE /api/v2/me/identities/:provider/:externalId — отвязка (только свои).
  app.delete('/identities/:provider/:externalId', auth.requireAuth, async (c) => {
    const profileId = await resolveProfileId(c);
    if (!profileId.trim()) return unauthorized(c);
    const provider = decodeURIComponent(c.req.param('provider') ?? '');
    const externalId = decodeURIComponent(c.req.param('externalId') ?? '');
    const updated = await profileStore.unlinkIdentity(profileId, provider, externalId);
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

    // ADR-089 (claim-flow): анти-брутфорс одноразового кода — rate-limit guard
    // (per-user) до обработчика. Регистрируется до роута, поэтому применяется
    // к `POST /identities/claim` (guard ключуется по аутентификации, не по IP).
    if (opts.rateLimitGuard) {
      app.use('/identities/claim', opts.rateLimitGuard);
    }

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

      const profileId = await resolveProfileId(c);
      // 401 — до consume: незалогиненный запрос не должен сжигать claim-код.
      if (!profileId.trim()) return unauthorized(c);
      const claim = await claimStore.consume(code, { userId: profileId });
      if (!claim) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: messages.claimNotFound(c) } },
          404,
        );
      }

      // ADR-089: идентичность привязывается к текущему профилю; конфликт с другим
      // профилем (`linkIdentity` вернул `null`) → 409. Пара берётся из серверной
      // записи claim, не из тела запроса — подставить чужой id нельзя.
      const identity: ExternalIdentity = {
        provider: claim.provider,
        externalId: claim.externalId,
        linkedAt: nowISO(),
        linkedBy: profileId,
      };
      const updated = await profileStore.linkIdentity(profileId, identity);
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
