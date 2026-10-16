import type { Session, SessionReference } from '@itphx/synth-shared';

/**
 * Фильтр списка сессий. Доменный параметр, а не generic-KV: будущему SQL-бэкенду
 * (`@future-backend`) он транслируется в `WHERE` и позволяет вернуть «лёгкие»
 * метаданные без выгрузки `messages`. Файловая реализация вправе сканировать.
 */
export interface SessionFilter {
  projectId?: string;
  userId?: string;
  /** Поиск по заголовку и содержимому сообщений. */
  search?: string;
  /** `null` — только корневые (без `parentId`); `undefined` — без фильтра. */
  parentId?: string | null;
}

/**
 * Порт хранилища сессий (реализация — `FileStore`).
 *
 * Домен сессий делает именно эти выборки (видимость, поиск, пагинация),
 * поэтому порт — предметный, а не `get/put/list(key)`.
 */
export interface SessionRepository {
  load(sessionId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(sessionId: string): Promise<void>;
  /**
   * Список сессий с фильтром; сортировка по `updatedAt` desc.
   * Возвращает **полную** сессию, включая историю (`messages`/`pendingMessages`/
   * `checkpoints`). Там, где история не нужна, использовать `listLight`.
   * @future-backend — фильтрация/сортировка в SQL; файловая реализация сканирует каталог.
   */
  list(filter?: SessionFilter): Promise<Session[]>;
  /**
   * **Лёгкий** список сессий: тот же набор id в том же порядке (`updatedAt` desc),
   * что у `list`, но **метаданные без истории** — `messages`/`pendingMessages`/
   * `checkpoints` пусты. Контракт общий для всех backend'ов (проверяется suite
   * `storage/contract`).
   *
   * Использовать только там, где сообщения не нужны (видимость, подписки,
   * архивация/TTL, чистка локов, учёт дерева). Для выдачи сессии целиком —
   * `load`/`list`.
   * @future-backend — выборка без join `messages`/child-таблиц (файловая
   * реализация всё равно десериализует запись целиком).
   */
  listLight(filter?: SessionFilter): Promise<Session[]>;
  /**
   * Поиск по содержимому (заголовок + сообщения). Возвращает **полную** сессию
   * (с `messages`): поиск идёт по тексту сообщений.
   * @future-backend — полнотекстовый поиск в БД; файловая реализация сканирует.
   */
  search(query: string, filter?: SessionFilter): Promise<Session[]>;
  exists(sessionId: string): Promise<boolean>;
  /**
   * Сессии пользователя (владелец = `userId` или один из `ownerIds`).
   * @future-backend — выборка по индексу владельца; сканирование — деталь файловой реализации.
   */
  listForUser(userId: string, ownerIds?: string[]): Promise<Session[]>;
  /**
   * «Свои + сессии проектов участия» (ADR-089, командная видимость).
   * @future-backend — JOIN по участию в проекте; файловая реализация сканирует.
   */
  listForUserScope(userId: string, projectIds: string[], ownerIds?: string[]): Promise<Session[]>;
  addReference(sessionId: string, ref: SessionReference): Promise<void>;
  removeReference(sessionId: string, refSessionId: string): Promise<void>;
  getReferences(sessionId: string): Promise<SessionReference[]>;
}
