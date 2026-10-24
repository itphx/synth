/**
 * ADR-105 (Ф4): HTTP-контур слоя внешних доступов.
 *
 * Единая фабрика для standalone-core и managed-backend (как `createMcpRoutes`/
 * `createServiceKeyRoutes`): RBAC задаётся через `opts.readGuard`/`opts.writeGuard`,
 * локализация — через `opts.messages`.
 *
 * **Секрет наружу не отдаётся никогда**: ответы содержат только
 * `ExternalCredentialMeta` (маска вместо токена). Значение токена доступно
 * лишь `reveal()` — подстановке в транспорт (ADR-105 §1).
 *
 * **Право — на границе** (инвариант 16): правило «кем распоряжается доступом»
 * живёт в `engine/oauth/credential-binding.ts` (`evaluateCredentialBind`),
 * здесь — только сбор актора и маппинг решения в код ответа.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  GlobalRole,
  oauthCredentialBindSchema,
  oauthCredentialCreateSchema,
} from '@itphx/synth-shared';
import type { ExternalCredentialMeta, ExternalCredentialOwner } from '@itphx/synth-shared';
import { evaluateCredentialBind } from '../../engine/oauth/credential-binding.js';
import type { CredentialBindActor } from '../../engine/oauth/credential-binding.js';
import { credentialAuditErrorCode, recordCredentialAudit } from '../../engine/oauth/audit.js';
import { CredentialConnectorBindError } from '../../engine/oauth/bind-connector.js';
import { PendingAuthorizationStore } from '../../engine/oauth/pending-flows.js';
import { buildAuthorizationUrl, createPkcePair } from '../../engine/oauth/pkce.js';
import type { OAuthProviderRegistry } from '../../engine/oauth/registry.js';
import type { OAuthCredentialService } from '../../engine/oauth/service.js';
import { OAuthError } from '../../engine/oauth/types.js';
import type { ExternalCredentialRepository } from '../../storage/ports/external-credential-repository.js';
import type { CredentialAuditRepository } from '../../storage/ports/credential-audit-repository.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface OAuthRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения (core — русские литералы, backend — i18n). */
export interface OAuthRouteMessages {
  invalidRequest: (c: Context) => string;
  providerUnknown: (c: Context, provider: string) => string;
  providerError: (c: Context, detail: string) => string;
  credentialNotFound: (c: Context) => string;
  forbidden: (c: Context) => string;
  flowInvalid: (c: Context) => string;
  flowExpired: (c: Context) => string;
  deviceUnsupported: (c: Context) => string;
  credentialRevoked: (c: Context) => string;
  reauthorizationRequired: (c: Context) => string;
  noRefreshToken: (c: Context) => string;
  connectorNotFound: (c: Context) => string;
  bindForbidden: (c: Context) => string;
  bindConflict: (c: Context) => string;
}

export interface OAuthRoutesDeps {
  /** Порт слоя доступов (ADR-096) — чтение метаданных. */
  credentials: ExternalCredentialRepository;
  /** Сервис слоя доступов (выдача/refresh/отзыв). */
  service: OAuthCredentialService;
  /** Реестр описаний OAuth-провайдеров (каталог `oauth.providers`). */
  providers: OAuthProviderRegistry;
  /** Актор запроса: пользователь инстанса или service-key (ADR-052). */
  resolveActor: (c: Context) => CredentialBindActor | Promise<CredentialBindActor>;
  /** Хранилище незавершённых выдач (PKCE/device); не задано — создаётся свой. */
  pending?: PendingAuthorizationStore;
  /**
   * Привязка доступа к MCP-коннектору (обновление записи реестра MCP).
   *
   * Правило изменения коннектора живёт у вызывающего (backend — автор записи
   * или ADMIN); здесь — только вызов. Ошибка — `OAuthBindError`.
   */
  bindConnector?: (input: {
    connectorId: string;
    credentialId: string;
    actor: CredentialBindActor;
    c: Context;
  }) => Promise<void>;
  /** Право **читать** проект (участник с правом чтения). */
  canReadProject?: (c: Context, projectId: string) => boolean | Promise<boolean>;
  /** Право **изменять содержимое** проекта (`OWNER`/`EDITOR`, `LEAD`/`ADMIN`). */
  canEditProject?: (c: Context, projectId: string) => boolean | Promise<boolean>;
  /**
   * ADR-105 (Ф4): журнал операций со слоем доступов (append-only) — привязка
   * доступа к коннектору пишется как `bind`. Не задан — не журналируется.
   */
  audit?: CredentialAuditRepository;
  /**
   * Вид владения создаваемым доступом: `local` — standalone (единственный
   * владелец, инвариант 19), `user` — managed (владелец — пользователь).
   */
  ownerKind?: 'user' | 'local';
}

export interface OAuthRoutesOptions {
  messages?: Partial<OAuthRouteMessages>;
  /** Guard на чтение (GET); по умолчанию — `requireAuth`. */
  readGuard?: Middleware;
  /** Guard на мутации (POST/DELETE); по умолчанию — `requireAuth`. */
  writeGuard?: Middleware;
}

/** Ошибка привязки доступа к MCP-коннектору (маппится в код ответа). */
export { CredentialConnectorBindError as OAuthBindError } from '../../engine/oauth/bind-connector.js';

const DEFAULT_MESSAGES: OAuthRouteMessages = {
  invalidRequest: () => 'Некорректное тело запроса',
  providerUnknown: (_c, provider) => `OAuth-провайдер «${provider}» не зарегистрирован`,
  providerError: (_c, detail) => `Провайдер вернул ошибку: ${detail}`,
  credentialNotFound: () => 'Внешний доступ не найден',
  forbidden: () => 'Недостаточно прав для операции с внешним доступом',
  flowInvalid: () => 'Выдача доступа не найдена или уже использована',
  flowExpired: () => 'Срок выдачи доступа истёк — начните заново',
  deviceUnsupported: () => 'Провайдер не поддерживает device flow',
  credentialRevoked: () => 'Доступ отозван — требуется новая авторизация',
  reauthorizationRequired: () => 'Доступ требует переавторизации: refresh отклонён провайдером',
  noRefreshToken: () => 'У доступа нет refresh-токена',
  connectorNotFound: () => 'MCP-коннектор не найден',
  bindForbidden: () => 'Привязать доступ к этому коннектору нельзя',
  bindConflict: () => 'Не удалось привязать доступ к коннектору',
};

/** `ADMIN`/`LEAD` — инстансный уровень. */
function isElevated(actor: CredentialBindActor): boolean {
  return (
    actor.roles.includes(GlobalRole.ADMIN) || actor.roles.includes(GlobalRole.LEAD)
  );
}

/** Владелец доступа — текущий актор (пользовательский или локальный). */
function isOwner(credential: ExternalCredentialMeta, actor: CredentialBindActor): boolean {
  const owner = credential.owner;
  if (owner.kind !== 'user' && owner.kind !== 'local') return false;
  return owner.id === actor.userId;
}

/**
 * ADR-105 (Ф4): HTTP-контур слоя внешних доступов.
 *
 * Роуты:
 * - `POST /credentials` — выдача доступа: старт (PKCE/device) или завершение;
 * - `GET /credentials` — список метаданных (свои; `ADMIN`/`LEAD` — все);
 * - `GET /credentials/:id` — метаданные одной записи;
 * - `POST /credentials/:id/refresh` — форсированное обновление токена;
 * - `DELETE /credentials/:id` — отзыв (локальный + best-effort RFC 7009);
 * - `POST /credentials/:id/bind` — привязка к MCP-коннектору.
 */
export function createOAuthRoutes(
  auth: OAuthRoutesAuth,
  deps: OAuthRoutesDeps,
  opts: OAuthRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: OAuthRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const pending = deps.pending ?? new PendingAuthorizationStore();
  const ownerKind = deps.ownerKind ?? 'user';

  const invalid = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidRequest(c) } }, 400);
  const notFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.credentialNotFound(c) } }, 404);
  const forbidden = (c: Context) =>
    c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);
  const conflict = (c: Context, message: string) =>
    c.json({ error: { code: 'CONFLICT', message } }, 409);

  /** Право **читать** метаданные доступа. */
  const canRead = async (
    c: Context,
    credential: ExternalCredentialMeta,
    actor: CredentialBindActor,
  ): Promise<boolean> => {
    if (isOwner(credential, actor)) return true;
    if (isElevated(actor)) return true;
    if (credential.projectId && deps.canReadProject) {
      return await deps.canReadProject(c, credential.projectId);
    }
    return false;
  };

  /** Право **распоряжаться** доступом (refresh/отзыв/привязка). */
  const canControl = async (
    c: Context,
    credential: ExternalCredentialMeta | null,
    actor: CredentialBindActor,
  ): Promise<'ok' | 'not_found' | 'forbidden'> => {
    const decision = await evaluateCredentialBind({
      credential,
      actor,
      ...(deps.canEditProject
        ? { canEditProject: (projectId: string) => deps.canEditProject!(c, projectId) }
        : {}),
    });
    if (decision.allowed) return 'ok';
    return decision.code === 'NOT_FOUND' ? 'not_found' : 'forbidden';
  };

  /** Маппинг ошибки OAuth-клиента в ответ (секретов в тексте нет). */
  const mapOAuthError = (c: Context, err: unknown) => {
    if (!(err instanceof OAuthError)) {
      return c.json(
        { error: { code: 'OAUTH_PROVIDER_ERROR', message: messages.providerError(c, 'внутренняя ошибка') } },
        400,
      );
    }
    switch (err.code) {
      case 'not_found':
        return notFound(c);
      case 'revoked':
        return conflict(c, messages.credentialRevoked(c));
      case 'invalid_grant':
        return conflict(c, messages.reauthorizationRequired(c));
      case 'no_refresh_token':
        return conflict(c, messages.noRefreshToken(c));
      default:
        return c.json(
          { error: { code: 'OAUTH_PROVIDER_ERROR', message: messages.providerError(c, err.code) } },
          400,
        );
    }
  };

  // GET /api/v2/oauth/credentials — список метаданных (без секретов).
  app.get('/credentials', readGuard, async (c) => {
    const actor = await deps.resolveActor(c);
    const all = await deps.credentials.list();
    const visible: ExternalCredentialMeta[] = [];
    for (const credential of all) {
      if (await canRead(c, credential, actor)) visible.push(credential);
    }
    return c.json({ credentials: visible, count: visible.length });
  });

  // POST /api/v2/oauth/credentials — выдача доступа (старт или завершение).
  app.post('/credentials', writeGuard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c);
    }
    const parsed = oauthCredentialCreateSchema.safeParse(body);
    if (!parsed.success) return invalid(c);
    const input = parsed.data;

    const actor = await deps.resolveActor(c);
    const description = deps.providers.get(input.provider);
    if (!description) {
      return c.json(
        {
          error: {
            code: 'OAUTH_PROVIDER_UNKNOWN',
            message: messages.providerUnknown(c, input.provider),
          },
        },
        400,
      );
    }

    // Вид владения: локальный (standalone) — всегда; инстансный — только
    // для `ADMIN`/`LEAD` (fail-closed).
    let owner: ExternalCredentialOwner;
    if (ownerKind === 'local') {
      owner = { kind: 'local', id: actor.userId };
    } else if (input.ownerKind === 'instance') {
      if (!isElevated(actor)) return forbidden(c);
      owner = { kind: 'instance', id: 'instance' };
    } else {
      owner = { kind: 'user', id: actor.userId };
    }

    if (input.flow === 'device') {
      return deviceFlow(c, input, actor, owner, description);
    }
    return authorizeFlow(c, input, actor, owner, description);
  });

  /** Старт/завершение выдачи по коду авторизации (PKCE). */
  async function authorizeFlow(
    c: Context,
    input: ReturnType<typeof oauthCredentialCreateSchema.parse>,
    actor: CredentialBindActor,
    owner: ExternalCredentialOwner,
    description: NonNullable<ReturnType<OAuthProviderRegistry['get']>>,
  ) {
    if (input.code) {
      if (!input.state) return invalid(c);
      const flow = pending.consume(input.state);
      if (!flow) return conflict(c, messages.flowInvalid(c));
      if (flow.provider !== input.provider) return conflict(c, messages.flowInvalid(c));
      // Выдача принадлежит тому, кто её начал: чужой `state` — нельзя.
      if (flow.createdBy !== actor.userId) return forbidden(c);
      try {
        const credential = await deps.service.exchangeAndStore({
          provider: input.provider,
          code: input.code,
          ...(flow.codeVerifier !== undefined ? { codeVerifier: flow.codeVerifier } : {}),
          ...(flow.redirectUri !== undefined ? { redirectUri: flow.redirectUri } : {}),
          ...(flow.scopes !== undefined ? { scopes: flow.scopes } : {}),
          owner: flow.owner,
          createdBy: actor.userId,
          ...(flow.connectorId !== undefined ? { connectorId: flow.connectorId } : {}),
          ...(flow.projectId !== undefined ? { projectId: flow.projectId } : {}),
        });
        return c.json({ flow: 'completed', credential }, 201);
      } catch (err) {
        return mapOAuthError(c, err);
      }
    }

    // Старт выдачи: PKCE-пара + `state`, URL авторизации.
    const pkce = createPkcePair();
    const flow = pending.create({
      kind: 'authorize',
      provider: input.provider,
      owner,
      createdBy: actor.userId,
      codeVerifier: pkce.codeVerifier,
      ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
    });
    const authorizationUrl = buildAuthorizationUrl(description, {
      pkce,
      // `state` выдачи = CSRF-значение authorize-запроса (RFC 6749 §10.12).
      state: flow.id,
      ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    });
    return c.json(
      {
        flow: 'started',
        authorizationUrl,
        state: flow.id,
        expiresAt: new Date(flow.expiresAt).toISOString(),
      },
      201,
    );
  }

  /** Старт/опрос device flow (RFC 8628). */
  async function deviceFlow(
    c: Context,
    input: ReturnType<typeof oauthCredentialCreateSchema.parse>,
    actor: CredentialBindActor,
    owner: ExternalCredentialOwner,
    description: NonNullable<ReturnType<OAuthProviderRegistry['get']>>,
  ) {
    if (!description.deviceAuthorizationUrl) {
      return c.json(
        { error: { code: 'OAUTH_DEVICE_FLOW_UNSUPPORTED', message: messages.deviceUnsupported(c) } },
        400,
      );
    }

    if (input.state) {
      const flow = pending.get(input.state);
      if (!flow || flow.kind !== 'device' || flow.provider !== input.provider) {
        return conflict(c, messages.flowInvalid(c));
      }
      if (flow.createdBy !== actor.userId) return forbidden(c);
      let tokens;
      try {
        tokens = await deps.providers.clientFor(input.provider).pollDeviceToken(
          flow.deviceCode as string,
        );
      } catch (err) {
        if (err instanceof OAuthError && err.code === 'authorization_pending') {
          return c.json(
            { flow: 'pending', interval: flow.interval ?? 5, expiresAt: new Date(flow.expiresAt).toISOString() },
            202,
          );
        }
        if (err instanceof OAuthError && err.code === 'slow_down') {
          flow.interval = (flow.interval ?? 5) + 5;
          return c.json(
            { flow: 'pending', interval: flow.interval, expiresAt: new Date(flow.expiresAt).toISOString() },
            202,
          );
        }
        return mapOAuthError(c, err);
      }
      pending.remove(input.state);
      try {
        const credential = await deps.service.storeTokens({
          provider: input.provider,
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.expiresIn !== undefined ? { expiresIn: tokens.expiresIn } : {}),
          ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
          ...(flow.scopes !== undefined ? { scopes: flow.scopes } : {}),
          owner: flow.owner,
          createdBy: actor.userId,
          ...(flow.connectorId !== undefined ? { connectorId: flow.connectorId } : {}),
          ...(flow.projectId !== undefined ? { projectId: flow.projectId } : {}),
        });
        return c.json({ flow: 'completed', credential }, 201);
      } catch (err) {
        return mapOAuthError(c, err);
      }
    }

    // Старт device flow: код устройства у провайдера.
    let device;
    try {
      device = await deps.providers.clientFor(input.provider).startDeviceAuthorization(
        input.scopes,
      );
    } catch (err) {
      return mapOAuthError(c, err);
    }
    const flow = pending.create({
      kind: 'device',
      provider: input.provider,
      owner,
      createdBy: actor.userId,
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      ...(device.verificationUriComplete !== undefined
        ? { verificationUriComplete: device.verificationUriComplete }
        : {}),
      interval: device.interval,
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
    });
    return c.json(
      {
        flow: 'started',
        state: flow.id,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        ...(device.verificationUriComplete !== undefined
          ? { verificationUriComplete: device.verificationUriComplete }
          : {}),
        interval: device.interval,
        expiresAt: new Date(flow.expiresAt).toISOString(),
      },
      201,
    );
  }

  // GET /api/v2/oauth/credentials/:id — метаданные одной записи.
  app.get('/credentials/:id', readGuard, async (c) => {
    const actor = await deps.resolveActor(c);
    const credential = await deps.credentials.get(c.req.param('id'));
    if (!credential) return notFound(c);
    if (!(await canRead(c, credential, actor))) return forbidden(c);
    return c.json(credential);
  });

  // POST /api/v2/oauth/credentials/:id/refresh — форсированное обновление токена.
  app.post('/credentials/:id/refresh', writeGuard, async (c) => {
    const actor = await deps.resolveActor(c);
    const id = c.req.param('id');
    const credential = await deps.credentials.get(id);
    const control = await canControl(c, credential, actor);
    if (control === 'not_found') return notFound(c);
    if (control === 'forbidden') return forbidden(c);
    try {
      const refreshed = await deps.service.refresh(id);
      return c.json({ credential: refreshed });
    } catch (err) {
      return mapOAuthError(c, err);
    }
  });

  // DELETE /api/v2/oauth/credentials/:id — отзыв (локальный + best-effort RFC 7009).
  app.delete('/credentials/:id', writeGuard, async (c) => {
    const actor = await deps.resolveActor(c);
    const id = c.req.param('id');
    const credential = await deps.credentials.get(id);
    const control = await canControl(c, credential, actor);
    if (control === 'not_found') return notFound(c);
    if (control === 'forbidden') return forbidden(c);
    try {
      const result = await deps.service.revoke(id);
      return c.json({ credential: result.meta, providerRevoked: result.providerRevoked });
    } catch (err) {
      return mapOAuthError(c, err);
    }
  });

  // POST /api/v2/oauth/credentials/:id/bind — привязка к MCP-коннектору.
  app.post('/credentials/:id/bind', writeGuard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c);
    }
    const parsed = oauthCredentialBindSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const actor = await deps.resolveActor(c);
    const id = c.req.param('id');
    const credential = await deps.credentials.get(id);
    const control = await canControl(c, credential, actor);
    if (control === 'not_found') return notFound(c);
    if (control === 'forbidden') return forbidden(c);
    if (!deps.bindConnector) {
      return c.json(
        { error: { code: 'SERVICE_UNAVAILABLE', message: messages.bindConflict(c) } },
        409,
      );
    }
    try {
      await deps.bindConnector({
        connectorId: parsed.data.connectorId,
        credentialId: id,
        actor,
        c,
      });
    } catch (err) {
      // ADR-105 (Ф4): неудачная привязка — тоже запись журнала (исход `error`).
      await recordCredentialAudit(deps.audit, {
        op: 'bind',
        credentialId: id,
        provider: credential?.provider ?? '',
        outcome: 'error',
        errorCode: credentialAuditErrorCode(err),
        connectorId: parsed.data.connectorId,
      });
      if (err instanceof CredentialConnectorBindError) {
        if (err.code === 'not_found') {
          return c.json(
            { error: { code: 'NOT_FOUND', message: messages.connectorNotFound(c) } },
            404,
          );
        }
        if (err.code === 'forbidden') {
          return c.json(
            { error: { code: 'FORBIDDEN', message: messages.bindForbidden(c) } },
            403,
          );
        }
        return c.json(
          { error: { code: 'CONFLICT', message: messages.bindConflict(c) } },
          409,
        );
      }
      throw err;
    }
    // ADR-105 (Ф4): успешная привязка — запись журнала (`bind`).
    await recordCredentialAudit(deps.audit, {
      op: 'bind',
      credentialId: id,
      provider: credential?.provider ?? '',
      outcome: 'ok',
      connectorId: parsed.data.connectorId,
    });
    return c.json({ credentialId: id, connectorId: parsed.data.connectorId, bound: true });
  });

  return app;
}
