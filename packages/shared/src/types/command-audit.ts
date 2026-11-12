/**
 * PROP-136 (слайс 136a): append-only аудит **исполнений** команд
 * (`execute_shell`/`sandbox_exec`).
 *
 * Shell — произвольный код, поэтому вместо мнимой изоляции вводится
 * наблюдаемость: на каждый запуск пишется две записи — `started` (до запуска)
 * и `finished` (после), связанные одним `id`. Тела вывода не пишутся — только
 * размер, hash и признак обрезки. Команда хранится **обезличенной** (карта
 * обфускации сессии + редакция значений секретов) и обрезанной до
 * `COMMAND_AUDIT_MAX_COMMAND_BYTES`.
 *
 * Отдельный контракт, а не `SecurityAuditEntry`: тот описывает изменения
 * политик (before/after), а здесь — факт исполнения.
 */

/** Тулы, исполнение которых попадает в журнал (PROP-136). */
export const COMMAND_AUDIT_TOOLS = ['execute_shell', 'sandbox_exec'] as const;
export type CommandAuditTool = (typeof COMMAND_AUDIT_TOOLS)[number];

/** Решение permission-слоя, при котором команда исполнялась. */
export const COMMAND_AUDIT_DECISIONS = ['allow', 'deny', 'ask'] as const;
export type CommandAuditDecision = (typeof COMMAND_AUDIT_DECISIONS)[number];

/** Фаза записи: до запуска и после завершения. */
export const COMMAND_AUDIT_PHASES = ['started', 'finished'] as const;
export type CommandAuditPhase = (typeof COMMAND_AUDIT_PHASES)[number];

/** Предел сохраняемой команды, байт (полная обезличенная строка хешируется). */
export const COMMAND_AUDIT_MAX_COMMAND_BYTES = 4096;

/** Срок хранения журнала по умолчанию, дней. */
export const DEFAULT_COMMAND_AUDIT_RETENTION_DAYS = 30;

/**
 * Запись журнала исполнений.
 *
 * `id` — один на пару `started`/`finished`; `command`/`commandHash` —
 * обезличенная команда (у `sandbox_exec` — `commands.join(' && ')`).
 */
export interface CommandAuditEntry {
  /** `execution_id` — один на пару `started`/`finished`. */
  id: string;
  /** Время записи, ISO-8601. */
  ts: string;
  sessionId?: string;
  projectId?: string;
  actor?: string;
  agentRole?: string;
  profile?: string;
  tool: CommandAuditTool;
  /** Команда: обезличена, ≤ `COMMAND_AUDIT_MAX_COMMAND_BYTES`. */
  command: string;
  /** sha256 полной обезличенной команды (до обрезки). */
  commandHash: string;
  cwd: string;
  background: boolean;
  decision: CommandAuditDecision;
  decidedBy: 'permission';
  matchedRule?: string;
  durationMs?: number;
  exitCode?: number;
  bytesOut?: number;
  truncated?: boolean;
  outputSha256?: string;
  phase: CommandAuditPhase;
}
