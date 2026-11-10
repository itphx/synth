/**
 * Порт хранилища ожиданий подтверждения прав (ADR-029, ADR-096 — слой хранения).
 *
 * Ожидание подтверждения — **отдельный объект**, а не часть документа сессии:
 * запись в документе сессии — полная перезапись истории (`save`), а результаты
 * параллельных тулов пишутся точечно (`appendMessage`, ADR-118). Полная запись
 * из seam'а, взятая до точечных записей, затирала бы их → гонка lost update.
 * Поэтому ожидания лежат в **отдельном сторе** и документ сессии не трогают
 * вовсе.
 *
 * Семантика (общая для всех backend'ов):
 * - `save` — upsert по `approvalId` (полная перезапись записи);
 * - `list` — записи ожиданий; фильтр — по сессии (`sessionId` не задан — все);
 * - `delete` — идемпотентно: удаление отсутствующей записи — не ошибка;
 * - `clear` — снятие всех записей (сессии — если `sessionId` задан, иначе всех).
 */
export interface PendingApprovalRecord {
  /** id ожидания (`approval_…`). */
  approvalId: string;
  /** Сессия, которой адресован запрос. */
  sessionId: string;
  /** Владелец сессии (владелец — человек, ADR-089) — для фильтрации по доступу. */
  ownerId?: string;
  /** Тул, который просит разрешения (`execute_shell`, `read_file`, …). */
  toolName: string;
  /** Аргументы вызова (для shell — `{ command }`). */
  arguments: Record<string, unknown>;
  /** Текст причины (как в `permission.asked`). */
  reason: string;
  /**
   * Структурная причина ask'а («виновник») — machine-readable: id сообщения,
   * параметры подстановки, сработавшее правило, вид ask'а.
   */
  trigger?: {
    messageId?: string;
    params?: Record<string, string>;
    matchedRule?: string;
    askKind?: 'dynamic' | 'protected' | 'mutation' | 'cwd';
  };
  /** ISO-8601 момент публикации запроса. */
  askedAt: string;
  /** Срок ожидания ответа (мс); `0` — без таймаута. */
  timeoutMs: number;
  /** Ход (turn), к которому относится запрос. */
  turnId?: string;
  /** Принципал хода (ADR-106) — id принципала. */
  principal?: string;
}

/**
 * Порт ожиданий подтверждения прав.
 *
 * Стор — **не** документ сессии: ожидание переживает рестарт инстанса, но не
 * должно попадать в гонку с записью истории сессии.
 */
export interface PendingApprovalRepository {
  /** Upsert по `approvalId` (создание или перезапись). */
  save(record: PendingApprovalRecord): Promise<void>;
  /** Удаление записи; отсутствующая — не ошибка (идемпотентно). */
  delete(approvalId: string): Promise<void>;
  /**
   * Список записей; фильтр — по сессии (`sessionId` не задан — все записи).
   */
  list(sessionId?: string): Promise<PendingApprovalRecord[]>;
  /**
   * Снятие всех записей (сессии — если `sessionId` задан, иначе всех).
   * Возвращает число фактически снятых записей.
   */
  clear(sessionId?: string): Promise<number>;
}
