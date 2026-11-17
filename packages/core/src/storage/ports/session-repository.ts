import type { Message, Session, SessionMeta, SessionReference } from '@itphx/synth-shared';

export type { SessionMeta };

/** Опции `SessionRepository.mutateMeta`. */
export interface MutateMetaOptions<T = unknown> {
  /**
   * Обновить `updatedAt` перед записью (по умолчанию `true`). `false` — оставить
   * значение мутатора/снимка: нужно служебным проходам, которые не должны
   * «оживлять» сессию в списках.
   */
  touchUpdatedAt?: boolean;
  /**
   * Нужно ли писать результат (`false` — мутатор только посчитал/проверил,
   * запись не выполняется). По умолчанию пишем всегда (паритет с прежним
   * поведением).
   *
   * `shouldWrite(value) === false` → записи нет: ни строка `sessions`, ни
   * `updatedAt` не меняются, а `session` в результате — снимок метаданных
   * **до** мутатора (без алиасинга с хранилищем). Нужно веткам, которые
   * исторически ничего не сохраняли на no-op (пустой inbox, отказ по лимиту,
   * повторный архив и т.п.): иначе безобидная проверка «оживляла» бы сессию
   * в списках и перезаписывала строку впустую.
   */
  shouldWrite?: (value: T) => boolean;
}

/** Результат `SessionRepository.mutateMeta`. */
export type MutateMetaResult<T> =
  | { found: false }
  | { found: true; value: T; session: SessionMeta };

/** Опции `SessionRepository.mutateHistory`. */
export interface MutateHistoryOptions<T> {
  /**
   * Ожидаемый максимум `ord` в хранилище (оптимистичная блокировка). Если
   * фактический `MAX(ord)` в свежем снимке больше — история изменилась после
   * того, как вызывающий её прочитал: мутатор не вызывается, результат —
   * `stale`.
   */
  expectMaxOrd?: number;
  /**
   * Нужно ли писать результат (`false` — мутатор только посчитал/проверил,
   * запись не выполняется). По умолчанию пишем всегда.
   */
  shouldWrite?: (value: T) => boolean;
}

/** Результат `SessionRepository.mutateHistory`. */
export type MutateHistoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'stale' };

/** Результат `SessionRepository.mutateMessage`. */
export type MutateMessageResult<T> =
  | { found: false }
  | { found: true; value: T; message: Message };

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
   * Атомарная правка **метаданных** сессии: чтение → синхронный мутатор →
   * запись под одним локом хранилища.
   *
   * Не читает и не пишет историю (`messages`/`checkpoints`) и связи
   * (`references`) — точечные записи сообщений (`appendMessage`) не теряются.
   * Это замена связке `load` + правка в памяти + `save`: `save` пишет переданный
   * снимок целиком и затирает параллельные точечные изменения (lost update).
   *
   * Семантика:
   * - мутатор **строго синхронный** (реализация под транзакцией/локом не ждёт
   *   I/O; async-мутатор считается ошибкой контракта);
   * - мутатор бросил — записи нет, ошибка пробрасывается;
   * - сессии нет — `found:false`, мутатор не вызывается;
   * - `opts.touchUpdatedAt` (по умолчанию `true`) выставляет `updatedAt` перед
   *   записью;
   * - `opts.shouldWrite(value) === false` → записи нет (`found:true`, `value` —
   *   как вернул мутатор, `session` — снимок **до** мутатора): ни строка
   *   `sessions`, ни `updatedAt` не меняются.
   *
   * Атомарность — **в пределах одного процесса** для FileStore и in-memory
   * реализаций (per-session `AsyncLock`): параллельные операции того же
   * процесса сериализуются. Межпроцессная координация есть только у PostgreSQL
   * (`pg_advisory_xact_lock` на сессию). Это ограничение, а не обещание
   * кластерной атомарности файлового хранилища.
   *
   * `stickyNotes` не входят в `SessionMeta` (в PostgreSQL это child-таблица —
   * правка заметок идёт своими операциями, не через `mutateMeta`).
   */
  mutateMeta<T>(
    sessionId: string,
    mutator: (meta: SessionMeta) => T,
    opts?: MutateMetaOptions<T>,
  ): Promise<MutateMetaResult<T>>;
  /**
   * Атомарная правка **истории** целиком: свежий полный документ читается
   * **внутри лока**, применяется синхронный мутатор, запись — атомарная.
   *
   * Инварианты:
   * - `seq` нормализуется позиционно `1..n` (порядок массива — порядок истории);
   * - `ord` ранее выданных сообщений **не** перенумеровывается (монотонный
   *   счётчик сессии, ADR-118 §2) — реализация его не трогает; сообщениям без
   *   конечного `ord` (добавлены мутатором/импортом) порт **выдаёт** `ord` сам,
   *   подряд в порядке массива, начиная с `max(ord среди сообщений с ord) + 1`
   *   (иначе сортировка по `ord` поставила бы их в начало истории);
   * - `id` сессии иммутабелен; при записи `updatedAt` обновляется;
   * - `opts.expectMaxOrd` — оптимистичная проверка: `MAX(ord)` в свежем снимке
   *   больше ожидаемого → `stale`, мутатор не вызывается;
   * - `opts.shouldWrite(value) === false` → запись не выполняется (`ok:true`,
   *   история **и** `updatedAt`/`seq` не меняются);
   * - мутатор бросил — записи нет, ошибка пробрасывается;
   * - сессии нет — `{ok:false, reason:'not_found'}`.
   *
   * Атомарность — **в пределах одного процесса** для FileStore и in-memory
   * реализаций (per-session `AsyncLock`); межпроцессная координация — только
   * PostgreSQL (`pg_advisory_xact_lock`). Снимок читается внутри критической
   * секции, поэтому параллельный `appendMessage` не теряется (lost update
   * исключён в рамках процесса).
   *
   * Для поточечной правки одного сообщения — `mutateMessage`/`updateMessage`,
   * для метаданных — `mutateMeta`: полная запись истории нужна только
   * операциям уровня «заменить/восстановить историю».
   */
  mutateHistory<T>(
    sessionId: string,
    mutator: (session: Session) => T,
    opts?: MutateHistoryOptions<T>,
  ): Promise<MutateHistoryResult<T>>;
  /**
   * Атомарная точечная правка **одного** сообщения по `id` (не по `seq`):
   * чтение → синхронный мутатор → запись под одним локом.
   *
   * `id`/`seq`/`createdAt`/`ord` исходной записи **иммутабельны** — изменения
   * этих полей мутатором игнорируются (как в `updateMessage`). Поздняя запись
   * черновика поверх терминального сообщения (`isStaleDraftWrite`) не
   * применяется: возвращается текущее сообщение, записи нет.
   *
   * Сессии/сообщения нет — `found:false`, мутатор не вызывается. Мутатор
   * бросил — записи нет, ошибка пробрасывается.
   */
  mutateMessage<T>(
    sessionId: string,
    messageId: string,
    mutator: (message: Message) => T,
  ): Promise<MutateMessageResult<T>>;
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
