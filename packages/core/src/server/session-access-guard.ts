// Авторизация сессий как инвариант на префиксе роутера, а не вызов «по списку»
// в каждом хендлере. Guard вешается один раз (`app.use('/:id', …)` +
// `app.use('/:id/*', …)`) до регистрации маршрутов, поэтому покрывает все
// `:id`-маршруты (включая будущие). Один факт нарушения доступа → один код (403),
// отсутствие сессии → 404; смешения 403/404 для «чужой/недоступна» нет.
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { Session } from '@itphx/synth-shared';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Локализуемые сообщения guard'а доступа к сессии (core — литералы, backend — i18n). */
export interface SessionAccessMessages {
  sessionNotFound: (c: Context) => string;
  forbidden: (c: Context) => string;
}

/**
 * Вид доступа к ресурсу сессии, выводится из HTTP-метода на prefix-guard'е:
 * чтение (`GET`/`HEAD`) или мутация (`POST`/`PATCH`/`PUT`/`DELETE`). Это позволяет
 * развести read/write в ОДНОЙ точке (guard), а не размазывать по хендлерам:
 * участник проекта с ролью просмотра (VIEWER) читает, но не мутирует.
 */
export type SessionAccessKind = 'read' | 'write';

/** `GET`/`HEAD` — чтение; всё остальное (POST/PATCH/PUT/DELETE) — мутация. */
export function accessKindOf(method: string): SessionAccessKind {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' ? 'read' : 'write';
}

/** Функция проверки доступа к сессии (владелец/роль/участие в проекте). */
export type SessionAccessPredicate = (
  session: Session,
  c: Context,
  userId: string,
  access: SessionAccessKind,
) => boolean | Promise<boolean>;

export interface SessionAccessPredicateOptions {
  /**
   * Базовое правило (backend — владелец|ADMIN). Не задано — standalone-дефолт:
   * владелец `local` или сессия без владельца — доступ.
   */
  canAccess?: SessionAccessPredicate;
  /**
   * Доп. правило (например, участие в проекте) — если базовое отказало.
   * Получает `access`: для `read` — «проектное чтение» (любая роль участника),
   * для `write` — «проектное редактирование» (OWNER/EDITOR).
   */
  resolveCanAccessExtra?: SessionAccessPredicate;
  /** Standalone-идентификатор локального пользователя (`local`). */
  localUserId?: string;
}

/**
 * Единое правило доступа к содержимому сессии (владелец → роль → участие в
 * проекте). Standalone (без `canAccess`): сессии с владельцем `local` или без
 * владельца доступны (легаси-данные), иначе — владелец/`resolveCanAccessExtra`.
 */
export function createSessionAccessPredicate(
  opts: SessionAccessPredicateOptions = {},
): SessionAccessPredicate {
  const localUserId = opts.localUserId ?? 'local';
  return async (session, c, userId, access) => {
    if (opts.canAccess) {
      if (await opts.canAccess(session, c, userId, access)) return true;
    } else {
      const owner = session.ownerId ?? session.userId;
      if (!owner || owner === localUserId) return true;
    }
    if (opts.resolveCanAccessExtra) return opts.resolveCanAccessExtra(session, c, userId, access);
    return false;
  };
}

export interface SessionAccessGuardOptions {
  /** Имя path-параметра с id сессии (`id` в sessions, `sessionId` в messages/queue). */
  param?: string;
  /** Загрузка сессии по id (обычно `sessionManager.getSession`). */
  resolveSession: (id: string) => Promise<Session | null>;
  /** Итоговое правило доступа (см. `createSessionAccessPredicate`). */
  isAllowed: SessionAccessPredicate;
  /** userId запроса (core — `local`; backend — id из AuthKit). */
  resolveUserId: (c: Context) => string | Promise<string>;
  messages: SessionAccessMessages;
  /**
   * id, для которых локальная проверка невозможна (remote-ref `remote:<uuid>`) —
   * запрос пропускается: сессия живёт на удалённой стороне, доступ проверяет она.
   */
  skipForId?: (id: string) => boolean;
}

/**
 * Prefix-guard доступа к сессии по path-параметру. Регистрируется ДО маршрутов и
 * вешается вместе с `requireAuth` (`app.use('/:id', auth.requireAuth, guard)`) —
 * иначе guard выполнился бы раньше аутентификации и `resolveUserId` не имел бы
 * пользователя. Возвращает 404 (нет сессии) или 403 (нет доступа) единообразно.
 */
export function createSessionAccessGuard(opts: SessionAccessGuardOptions): Middleware {
  const param = opts.param ?? 'id';
  return createMiddleware(async (c, next) => {
    const id = c.req.param(param);
    if (!id || opts.skipForId?.(id)) {
      await next();
      return;
    }
    const session = await opts.resolveSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: opts.messages.sessionNotFound(c) } }, 404);
    }
    const userId = await opts.resolveUserId(c);
    const access = accessKindOf(c.req.method);
    if (await opts.isAllowed(session, c, userId, access)) {
      await next();
      return;
    }
    return c.json({ error: { code: 'FORBIDDEN', message: opts.messages.forbidden(c) } }, 403);
  });
}
