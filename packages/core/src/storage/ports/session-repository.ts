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
   * @future-backend — фильтрация/сортировка в SQL; файловая реализация сканирует каталог.
   */
  list(filter?: SessionFilter): Promise<Session[]>;
  /**
   * Поиск по содержимому (заголовок + сообщения).
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
