/**
 * Извлечение id сессии, о которой сообщает событие шины (`EventBus`), — единая
 * точка для авто-подписки транспортных хабов (managed `EventHub`, standalone
 * `/ws/events`).
 *
 * Зачем: дочерние сессии саб-агентов создаются тулом `task` напрямую через
 * `SessionManager`, минуя роуты, и клиент изначально на них не подписан. Тул
 * `task` публикует `session.created` (payload — `serializeSession(child)` ребёнка)
 * в канал родителя ДО старта LLM-стрима ребёнка, поэтому авто-подписка успевает
 * (паритет: `engine/tools/task/fork.ts`). Также child-события (`child.message.added`,
 * `subagent.resume.*`) несут `child_session_id`.
 *
 * Инвариант: путь, который публикует `session.created`, не требует отдельной
 * правки в каждом хабе — хабы читают id и владельца отсюда.
 */

/** Структурный минимум события шины, нужный для извлечения (совместим с `BusEvent`). */
export interface SessionEventLike {
  type: string;
  data?: Record<string, unknown>;
}

/** Типизированные payload'ы дочерних событий (ключи — из эмиттеров тула `task`). */
interface SessionCreatedPayload {
  id?: unknown;
  owner_id?: unknown;
  user_id?: unknown;
}

interface ChildSessionUpdatedPayload {
  session?: { id?: unknown };
  child_session_id?: unknown;
}

interface ChildSessionRefPayload {
  child_session_id?: unknown;
}

/** Безопасное чтение непустой строки из `unknown`. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Извлечь id новой (дочерней) сессии из события, опубликованного в родительскую
 * сессию. `session.created` — payload `serializeSession` (id внутри);
 * `child.session.updated` несёт `session` (id внутри), `child.message.added` и
 * resume-события — `child_session_id`. Ключи каждого события читаются ровно в
 * одном месте (типизированные payload-интерфейсы выше).
 */
export function extractChildSessionId(event: SessionEventLike): string | undefined {
  const data = event.data;
  if (!data) return undefined;

  switch (event.type) {
    case 'session.created': {
      const payload = data as SessionCreatedPayload;
      return readString(payload.id);
    }
    case 'child.session.updated': {
      const payload = data as ChildSessionUpdatedPayload;
      return readString(payload.session?.id) ?? readString(payload.child_session_id);
    }
    case 'child.message.added':
    case 'subagent.resume.started':
    case 'subagent.resume.finished': {
      const payload = data as ChildSessionRefPayload;
      return readString(payload.child_session_id);
    }
    default:
      return undefined;
  }
}

/** Цель `session.created`/`session.fork.created`: id новой сессии и её владелец. */
export interface CreatedSessionTarget {
  /** id новой сессии. */
  id: string;
  /** Владелец (`owner_id`, иначе `user_id` из payload `serializeSession`). */
  owner: string;
}

/**
 * Извлечь новую сессию (`session.created`/`session.fork.created`) вместе с её
 * владельцем из payload `serializeSession` (`owner_id`/`user_id`). Возвращает
 * `undefined`, если это не создание сессии или владелец не указан (fail-closed:
 * без владельца подписывать нечего — видимость не расширяем).
 */
export function extractCreatedSession(event: SessionEventLike): CreatedSessionTarget | undefined {
  if (event.type !== 'session.created' && event.type !== 'session.fork.created') return undefined;
  const data = event.data;
  if (!data) return undefined;
  const payload = data as SessionCreatedPayload;
  const id = readString(payload.id);
  const owner = readString(payload.owner_id) ?? readString(payload.user_id);
  if (!id || !owner) return undefined;
  return { id, owner };
}
