import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  eventBindingApiKeyCreateSchema,
  eventBindingApiKeyUpdateSchema,
  eventBindingInputSchema,
  eventIngestSchema,
  eventKeyIngestSchema,
  eventRouteRuleUpsertSchema,
} from '@itphx/synth-shared';
import type { EventBinding } from '@itphx/synth-shared';
import type { EventIngress } from '../../engine/events/ingest.js';
import type { EventIngestInput } from '../../engine/events/ingest.js';
import type { EventKeyCredential } from '../../engine/events/credential.js';
import { KeyRateLimiter } from '../../engine/events/key-rate-limiter.js';
import { EventApiKeyConflictError } from '../../storage/event-api-key-store.js';
import type { EventApiKeyStore } from '../../storage/event-api-key-store.js';
import type { EventBindingStore } from '../../storage/event-binding-store.js';
import type { EventJournalStore } from '../../storage/event-journal-store.js';
import type { RouteRuleStore } from '../../storage/route-rule-store.js';

/**
 * AD-089: маршруты приёма внешних событий и управления биндингами.
 * Единая реализация для core (standalone) и backend (managed): RBAC и rate limit
 * задаются через `opts.ingestGuard`/`opts.writeGuard`.
 *
 * AD-089/AD-052: приём события может аутентифицироваться API-ключом привязки
 * (`Authorization: Bearer synth_evt_…`) — тогда пользовательские креды не нужны,
 * а событие форсированно маршрутизируется в эту привязку (source/чат из неё).
 *
 * ВАЖНО: `GET /` намеренно не определяется — на этом пути в core/backend живёт
 * SSE-хаб (`GET /api/v2/events`).
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface EventRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface EventRouteMessages {
  invalidEvent: (c: Context) => string;
  invalidBinding: (c: Context) => string;
  bindingNotFound: (c: Context) => string;
  invalidRule: (c: Context) => string;
  ruleNotFound: (c: Context) => string;
  unknownAgent: (c: Context) => string;
  /** AD-089: неверный/неизвестный API-ключ привязки. */
  invalidKey: (c: Context) => string;
  /** AD-089: API-ключ привязки не найден. */
  keyNotFound: (c: Context) => string;
  /** AD-089/AD-052: неверное тело обновления API-ключа. */
  invalidKeyUpdate: (c: Context) => string;
  /** AD-089/AD-052: метка API-ключа уже занята (глобально по инстансу). */
  keyLabelConflict: (c: Context) => string;
  /** AD-089/AD-052: превышен лимит запросов по API-ключу привязки. */
  rateLimitedKey: (c: Context) => string;
  /** AD-089: приём внешних событий отключён мастер-выключателем. */
  eventsDisabled: (c: Context) => string;
}

export interface EventRoutesDeps {
  ingress: EventIngress;
  bindingStore: EventBindingStore;
  journal: EventJournalStore;
  /** AD-089: реестр правил маршрутизации (проектные/инстанс-правила). */
  routeRuleStore: RouteRuleStore;
  /** AD-089/AD-052: реестр API-ключей привязок для приёма событий. */
  apiKeyStore: EventApiKeyStore;
}

export interface EventRoutesOptions {
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<EventRouteMessages>;
  /** Guard на мутации биндингов/правил/ключей; по умолчанию — `requireAuth`. */
  writeGuard?: Middleware;
  /**
   * Guard на чтение API-ключей привязки (`GET /bindings/:id/keys`); по умолчанию
   * — `requireAuth`. Backend передаёт `requirePermission('ADMIN','LEAD')`:
   * список ключей — чувствительные метаданные (AD-089/AD-052).
   */
  keyReadGuard?: Middleware;
  /** Guard на приём события (fallback, когда ключ привязки не использован). */
  ingestGuard?: Middleware;
  /**
   * AD-089/AD-052: pre-guard на `POST /events` (обычно rate limit) — применяется
   * до решения о способе аутентификации (ключ привязки либо `ingestGuard`).
   */
  ingestPreGuard?: Middleware;
  /**
   * AD-089/AD-052: резолвер API-ключа привязки по plaintext-секрету. Возвращает
   * привязку и контекст машинной аутентификации (`EventKeyCredential`) либо
   * `null`. Не передан — приём по ключу недоступен.
   */
  resolveApiKeySecret?: (
    raw: string,
  ) => Promise<{ binding: EventBinding; credential: EventKeyCredential } | null>;
  /** AD-089: best-effort отметка использования ключа (`lastUsedAt`). */
  touchApiKey?: (id: string) => Promise<void>;
  /**
   * AD-089: проверка существования сессии при валидации цели правила
   * (`bound`/`queue`). Не передан — проверка пропускается (core без проверки).
   */
  sessionExists?: (id: string) => Promise<boolean>;
  /**
   * AD-089: резолвер `agentTemplate` → id существующего enabled-агента.
   * Не передан — шаблон принимается как есть (проверка пропускается).
   */
  resolveAgentTemplate?: (template: string) => string | null;
  /**
   * AD-089/AD-052: глобальный дефолт лимита запросов/мин на API-ключ привязки
   * (`events.keyRateLimitPerMinute`). Применяется, если у ключа нет своего
   * `rateLimitPerMinute`. Не передан/0 — без лимита.
   */
  getKeyRateLimitPerMinute?: () => number;
  /**
   * AD-089: мастер-выключатель приёма внешних событий (`events.enabled`).
   * При `false` `POST /` отвечает 503. Не передан — приём разрешён.
   */
  isEnabled?: () => boolean;
}

const DEFAULT_MESSAGES: EventRouteMessages = {
  invalidEvent: () => 'Некорректное тело события',
  invalidBinding: () => 'Некорректное тело биндинга',
  bindingNotFound: () => 'Биндинг не найден',
  invalidRule: () => 'Некорректное тело правила маршрутизации',
  ruleNotFound: () => 'Правило маршрутизации не найдено',
  unknownAgent: () => 'Неизвестный агент в правиле маршрутизации',
  invalidKey: () => 'Неверный API-ключ',
  keyNotFound: () => 'API-ключ не найден',
  invalidKeyUpdate: () => 'Некорректное тело обновления API-ключа',
  keyLabelConflict: (c) => {
    const label = (c.get('eventKeyConflictLabel' as never) as string | undefined) ?? '';
    return label ? `Метка API-ключа уже используется: ${label}` : 'Метка API-ключа уже используется';
  },
  rateLimitedKey: () => 'Превышен лимит запросов по API-ключу',
  eventsDisabled: () => 'Приём внешних событий отключён',
};

const JOURNAL_LIMIT_DEFAULT = 50;
const JOURNAL_LIMIT_MAX = 500;

/** Bearer-токен из заголовка `Authorization` либо `null`. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** id текущего пользователя из контекста (`undefined` в core без RBAC). */
function currentUserId(c: Context): string {
  const user = c.get('user' as never) as { id?: unknown } | undefined;
  return typeof user?.id === 'string' && user.id ? user.id : 'unknown';
}

export function createEventRoutes(
  auth: EventRoutesAuth,
  deps: EventRoutesDeps,
  opts: EventRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: EventRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  // Дефолты — requireAuth: в core RBAC не требуется, в backend передаются
  // requirePermission/rate limit явно.
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const keyReadGuard: Middleware = opts.keyReadGuard ?? auth.requireAuth;
  const ingestGuard: Middleware = opts.ingestGuard ?? auth.requireAuth;
  // AD-089/AD-052: per-key rate limit (fixed window 60 c), один на приложение.
  const keyRateLimiter = new KeyRateLimiter(60_000);

  // POST /api/v2/events — приём внешнего события (ingress). Аутентификация: API-ключ
  // привязки (если задан резолвер и пришёл Bearer) либо fallback `ingestGuard`.
  app.post('/', async (c) => {
    // MASTER: приём внешних событий может быть отключён (`events.enabled: false`).
    if (opts.isEnabled && !opts.isEnabled()) {
      return c.json({ error: { code: 'UNAVAILABLE', message: messages.eventsDisabled(c) } }, 503);
    }

    // 0. Pre-guard (rate limit) — до решения о способе аутентификации.
    if (opts.ingestPreGuard) {
      let prePassed = false;
      const preRes = await opts.ingestPreGuard(c, async () => {
        prePassed = true;
      });
      if (!prePassed) return preRes ?? c.body(null, 429);
    }

    // 1. Способ аутентификации.
    const token = bearerToken(c.req.header('Authorization'));
    let binding: EventBinding | undefined;
    let credential: EventKeyCredential | undefined;
    if (token && opts.resolveApiKeySecret) {
      const resolved = await opts.resolveApiKeySecret(token);
      if (!resolved) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: messages.invalidKey(c) } }, 401);
      }
      binding = resolved.binding;
      credential = resolved.credential;
      // AD-089/AD-052: per-key rate limit (свой у ключа либо глобальный дефолт).
      const limit = credential.rateLimitPerMinute ?? opts.getKeyRateLimitPerMinute?.() ?? 0;
      if (limit > 0 && !keyRateLimiter.check(credential.keyId, limit)) {
        return c.json({ error: { code: 'RATE_LIMITED', message: messages.rateLimitedKey(c) } }, 429);
      }
      // Пробрасываем привязку в контекст (для хуков/логов); поля не читаются роутом.
      c.set('eventBinding' as never, binding as never);
      if (opts.touchApiKey) {
        // Best-effort: сбой отметки использования не влияет на приём.
        try {
          await opts.touchApiKey(credential.keyId);
        } catch {
          /* ignore */
        }
      }
    } else {
      // Ключа нет — прежний fallback (`ingestGuard`, обычно requireAuth).
      let passed = false;
      const res = await ingestGuard(c, async () => {
        passed = true;
      });
      if (!passed) {
        return res ?? c.json({ error: { code: 'UNAUTHORIZED', message: messages.invalidKey(c) } }, 401);
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidEvent(c) } }, 400);
    }

    // 2. Валидация и маршрутизация. Привязка (ключ) форсирует source/чат.
    let input: EventIngestInput;
    let forcedBinding: EventBinding | undefined;
    if (binding) {
      const parsed = eventKeyIngestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidEvent(c) } }, 400);
      }
      // body.source не должен противоречить привязке.
      if (parsed.data.source && parsed.data.source !== binding.source) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidEvent(c) } }, 400);
      }
      // identity: ключи чата/треда из привязки, если не заданы в теле.
      const identity = {
        ...(binding.chatKey ? { chatKey: binding.chatKey } : {}),
        ...(binding.threadKey ? { threadKey: binding.threadKey } : {}),
        ...(parsed.data.identity ?? {}),
      };
      input = { ...parsed.data, source: binding.source, identity };
      forcedBinding = binding;
    } else {
      const parsed = eventIngestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidEvent(c) } }, 400);
      }
      input = parsed.data;
    }

    try {
      // AD-089/AD-052: аудит использования ключа (id + идентичность отправителя).
      const audit = credential
        ? {
            keyId: credential.keyId,
            ...(credential.principalId ? { principalId: credential.principalId } : {}),
          }
        : undefined;
      const { event, decision, session } = await deps.ingress.ingest(input, {
        binding: forcedBinding,
        ...(audit ? { audit } : {}),
      });
      // Наружу — без внутренних полей сессии, только id.
      return c.json({ event, decision, sessionId: session?.id ?? null }, 201);
    } catch (err) {
      return c.json({
        error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
      }, 500);
    }
  });

  // GET /api/v2/events/bindings — список биндингов.
  app.get('/bindings', auth.requireAuth, async (c) => {
    const bindings = await deps.bindingStore.list();
    return c.json({ bindings });
  });

  // POST /api/v2/events/bindings — upsert биндинга (по source+chatKey/threadKey).
  app.post('/bindings', writeGuard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidBinding(c) } }, 400);
    }

    const parsed = eventBindingInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidBinding(c) } }, 400);
    }

    const input = parsed.data;
    // Существующую привязку по ключу заменяем (id сохраняется) — это upsert.
    const existing = input.threadKey || input.chatKey
      ? await deps.bindingStore.findByKey({
          source: input.source,
          chatKey: input.chatKey,
          threadKey: input.threadKey,
        })
      : null;
    const binding = await deps.bindingStore.upsert({ ...input, id: existing?.id });
    return c.json(binding, existing ? 200 : 201);
  });

  // DELETE /api/v2/events/bindings/:id — удаление биндинга (+ каскад ключей).
  app.delete('/bindings/:id', writeGuard, async (c) => {
    const id = c.req.param('id');
    const removed = await deps.bindingStore.remove(id);
    if (!removed) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.bindingNotFound(c) } }, 404);
    }
    // AD-089/AD-052: ключи привязки без привязки недействительны — каскад.
    await deps.apiKeyStore.removeByBinding(id);
    return c.body(null, 204);
  });

  // GET /api/v2/events/bindings/:id/keys — ключи привязки (без секретов).
  app.get('/bindings/:id/keys', keyReadGuard, async (c) => {
    const keys = await deps.apiKeyStore.listByBinding(c.req.param('id'));
    return c.json({ keys });
  });

  // POST /api/v2/events/bindings/:id/keys — создание ключа (секрет — единожды).
  app.post('/bindings/:id/keys', writeGuard, async (c) => {
    const bindingId = c.req.param('id');
    if (!(await deps.bindingStore.get(bindingId))) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.bindingNotFound(c) } }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidKey(c) } }, 400);
    }

    const parsed = eventBindingApiKeyCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidKey(c) } }, 400);
    }

    try {
      const created = await deps.apiKeyStore.create({
        bindingId,
        label: parsed.data.label,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.expiresAt !== undefined ? { expiresAt: parsed.data.expiresAt } : {}),
        ...(parsed.data.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: parsed.data.rateLimitPerMinute }
          : {}),
        createdBy: currentUserId(c),
      });
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof EventApiKeyConflictError) {
        c.set('eventKeyConflictLabel' as never, err.label as never);
        return c.json({ error: { code: 'CONFLICT', message: messages.keyLabelConflict(c) } }, 409);
      }
      throw err;
    }
  });

  // PATCH /api/v2/events/bindings/:id/keys/:keyId — обновление метаданных ключа.
  app.patch('/bindings/:id/keys/:keyId', writeGuard, async (c) => {
    const bindingId = c.req.param('id');
    const keyId = c.req.param('keyId');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidKeyUpdate(c) } }, 400);
    }

    const parsed = eventBindingApiKeyUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidKeyUpdate(c) } }, 400);
    }

    try {
      const updated = await deps.apiKeyStore.update(bindingId, keyId, parsed.data);
      if (!updated) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.keyNotFound(c) } }, 404);
      }
      return c.json(updated);
    } catch (err) {
      if (err instanceof EventApiKeyConflictError) {
        c.set('eventKeyConflictLabel' as never, err.label as never);
        return c.json({ error: { code: 'CONFLICT', message: messages.keyLabelConflict(c) } }, 409);
      }
      throw err;
    }
  });

  // POST /api/v2/events/bindings/:id/keys/:keyId/revoke — мягкий отзыв ключа.
  app.post('/bindings/:id/keys/:keyId/revoke', writeGuard, async (c) => {
    const bindingId = c.req.param('id');
    const keyId = c.req.param('keyId');
    const revoked = await deps.apiKeyStore.revoke(bindingId, keyId);
    if (!revoked) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.keyNotFound(c) } }, 404);
    }
    const key = await deps.apiKeyStore.get(bindingId, keyId);
    return c.json(key);
  });

  // DELETE /api/v2/events/bindings/:id/keys/:keyId — удаление ключа.
  app.delete('/bindings/:id/keys/:keyId', writeGuard, async (c) => {
    const removed = await deps.apiKeyStore.remove(c.req.param('id'), c.req.param('keyId'));
    if (!removed) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.keyNotFound(c) } }, 404);
    }
    return c.body(null, 204);
  });

  // GET /api/v2/events/routes — список правил маршрутизации.
  app.get('/routes', auth.requireAuth, async (c) => {
    const rules = await deps.routeRuleStore.list();
    return c.json({ rules });
  });

  // POST /api/v2/events/routes — upsert правила (по `id` — обновление, иначе создание).
  app.post('/routes', writeGuard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidRule(c) } }, 400);
    }

    const parsed = eventRouteRuleUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidRule(c) } }, 400);
    }

    const input = parsed.data;

    // Цель `bound`/`queue` ссылается на сессию — при наличии проверки она должна существовать.
    if (opts.sessionExists && (input.target.mode === 'bound' || input.target.mode === 'queue')) {
      if (!(await opts.sessionExists(input.target.sessionId))) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidRule(c) } }, 400);
      }
    }

    // Непустой `agentTemplate` ephemeral-цели должен резолвиться в enabled-агента.
    if (
      input.target.mode === 'ephemeral' &&
      opts.resolveAgentTemplate &&
      typeof input.target.agentTemplate === 'string' &&
      input.target.agentTemplate.trim().length > 0 &&
      opts.resolveAgentTemplate(input.target.agentTemplate.trim()) === null
    ) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.unknownAgent(c) } }, 400);
    }

    const existing = input.id ? await deps.routeRuleStore.get(input.id) : null;
    const rule = await deps.routeRuleStore.upsert(input);
    return c.json(rule, existing ? 200 : 201);
  });

  // DELETE /api/v2/events/routes/:id — удаление правила.
  app.delete('/routes/:id', writeGuard, async (c) => {
    const removed = await deps.routeRuleStore.remove(c.req.param('id'));
    if (!removed) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.ruleNotFound(c) } }, 404);
    }
    return c.body(null, 204);
  });

  // GET /api/v2/events/journal?limit= — последние записи журнала (default 50, cap 500).
  app.get('/journal', auth.requireAuth, async (c) => {
    const raw = c.req.query('limit');
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    const limit = Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, JOURNAL_LIMIT_MAX)
      : JOURNAL_LIMIT_DEFAULT;
    const entries = await deps.journal.list(limit);
    return c.json({ entries });
  });

  return app;
}
