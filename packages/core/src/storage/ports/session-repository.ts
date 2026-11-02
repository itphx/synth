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
 *
 * ADR-118 §2: порядок записи в историю — **два** поля. `seq` — позиционный
 * (порядок в массиве истории, перенумеровывается при вставке/удалении),
 * `ord` — монотонный счётчик сессии: его выдаёт порт при материализации
 * записи (`appendMessage`) и он **иммутабелен** — ранее выданные значения не
 * перенумеровываются, обновление сообщения (`updateMessage`) его не перебивает.
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
   *
   * ADR-118 §2: порт выдаёт **`ord`** — монотонный счётчик сессии
   * (`max(ord)+1`), в момент материализации записи в историю. `ord`
   * иммутабелен: ранее выданные значения не перенумеровываются (вставка в
   * середину не сдвигает нумерацию). `seq` при этом остаётся
   * **позиционным** (совместимость с `UNIQUE (session_id, seq)`).
   */
  appendMessage(sessionId: string, message: Message): Promise<Message | null>;
  /**
   * Точечно обновить существующее сообщение (полная замена изменяемых полей).
   * Цель — по `seq` (уникален в сессии), fallback по `id`. Не меняет `id`/`seq`/
   * `createdAt` исходной записи; обновляет `session.updatedAt`. Возвращает
   * обновлённое сообщение или `null`, если сессии/сообщения нет.
   *
   * ADR-118: `ord` исходной записи сохраняется — он иммутабелен после выдачи.
   * Для записи, которой `ord` ещё не выдан (legacy-строка), принимается
   * значение из обновления — так проставляет `ord` миграция данных.
   */
  updateMessage(sessionId: string, message: Message): Promise<Message | null>;
  /**
   * Точечное чтение метаданных сессии (**без истории**): `messages`/
   * `pendingMessages`/`checkpoints` пусты, child-таблицы не читаются. Нужна
   * путям записи, которым требуются только атрибуты сессии (например, оси
   * аналитики) и нельзя читать всю историю. В отличие от `listLight`, очередь
   * тоже не возвращается — нужна она только recovery/автозапуску.
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
   * что у `list`, но **метаданные без истории** — `messages`/`checkpoints`
   * пусты, child-таблицы не читаются. **Очередь сохраняется**
   * (`pendingMessages`/`steerInbox`): она хранится в самой записи сессии, мала
   * и нужна recovery/автозапуску, иначе теряется in-flight сообщение.
   * Контракт общий для всех backend'ов (проверяется suite `storage/contract`).
   *
   * Использовать только там, где история сообщений не нужна (видимость,
   * подписки, архивация/TTL, чистка локов, учёт дерева, стартовое
   * восстановление очередей). Для выдачи сессии целиком — `load`/`list`.
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
