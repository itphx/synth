import type { Message, Session, SessionReference } from '@itphx/synth-shared';

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
  /**
   * Полная замена сессии, включая историю (`messages`/`pendingMessages`/
   * `checkpoints` и прочие child-наборы). Семантика «перезаписать всё»
   * сохраняется для импорта/ветвления/материализации; для пошаговой
   * персистентности одного сообщения — `appendMessage`/`updateMessage`.
   */
  save(session: Session): Promise<void>;
  /**
   * Точечно добавить сообщение в конец истории (без перезаписи остальных).
   * Назначает `id` (если нет), `seq` = max(seq)+1, `origin` (если нет),
   * обновляет `session.updatedAt`. Возвращает сохранённое сообщение или `null`,
   * если сессии нет.
   */
  appendMessage(sessionId: string, message: Message): Promise<Message | null>;
  /**
   * Точечно обновить существующее сообщение (полная замена изменяемых полей).
   * Цель — по `seq` (уникален в сессии), fallback по `id`. Не меняет `id`/`seq`/
   * `createdAt` исходной записи; обновляет `session.updatedAt`. Возвращает
   * обновлённое сообщение или `null`, если сессии/сообщения нет.
   */
  updateMessage(sessionId: string, message: Message): Promise<Message | null>;
  /**
   * Точечное чтение метаданных сессии (**без истории**): `messages`/
   * `pendingMessages`/`checkpoints` пусты, child-таблицы не читаются. Пара к
   * `listLight`; нужна путям записи, которым требуются только атрибуты сессии
   * (например, оси аналитики) и нельзя читать всю историю.
   * @future-backend — одна выборка по PK без join child-таблиц (файловая
   * реализация всё равно разбирает JSON, но не десериализует сообщения).
   */
  loadLight(sessionId: string): Promise<Session | null>;
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
