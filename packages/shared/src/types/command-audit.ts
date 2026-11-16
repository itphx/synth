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

/**
 * Тулы, исполнение которых попадает в журнал (PROP-136).
 *
 * Кроме шелл-тулов — терминальные действия (PROP-132): `terminal.open`
 * (открытие PTY), `terminal.input` (кадр ввода), `terminal.close` (закрытие).
 * Их пишет терминальный сервис через тот же журнал (адаптер
 * `createCommandAuditTerminalSink`) — те же метаданные, без содержимого.
 *
 * ADR-126 §5: `script.run` — запуск объявленного скрипта проекта (`!`).
 * Запись несёт **только метаданные**: имя скрипта, cwd, число аргументов
 * (сами аргументы — не пишутся), origin (`user`/`agent`), проект/сессия.
 */
export const COMMAND_AUDIT_TOOLS = [
  'execute_shell',
  'sandbox_exec',
  'terminal.open',
  'terminal.input',
  'terminal.close',
  'script.run',
] as const;
export type CommandAuditTool = (typeof COMMAND_AUDIT_TOOLS)[number];

/** Решение permission-слоя, при котором команда исполнялась. */
export const COMMAND_AUDIT_DECISIONS = ['allow', 'deny', 'ask'] as const;
export type CommandAuditDecision = (typeof COMMAND_AUDIT_DECISIONS)[number];

/** Фаза записи: до запуска и после завершения. */
export const COMMAND_AUDIT_PHASES = ['started', 'finished'] as const;
export type CommandAuditPhase = (typeof COMMAND_AUDIT_PHASES)[number];

/** Кто принял решение об исполнении (PROP-136b: `policy` — внешний чекер). */
export const COMMAND_AUDIT_DECIDED_BY = ['permission', 'policy'] as const;
export type CommandAuditDecidedBy = (typeof COMMAND_AUDIT_DECIDED_BY)[number];

/**
 * Вердикт внешнего чекера команд в записи журнала (PROP-136b, слайс 136b-2a).
 *
 * Аддитивное поле: без чекера (`decidedBy: 'permission'`) его нет. `kind` —
 * провайдер (`http`/`opa`), `ruleId` — сработавшее правило, `latencyMs` —
 * длительность сетевой проверки (кэш — `0`), `action` — вердикт.
 */
export interface CommandAuditProviderVerdict {
  kind: string;
  ruleId?: string;
  latencyMs?: number;
  action: 'allow' | 'deny';
}

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
  decidedBy: CommandAuditDecidedBy;
  matchedRule?: string;
  /** PROP-136b: вердикт внешнего чекера команд (нет — решение permission-слоя). */
  provider?: CommandAuditProviderVerdict;
  /** PROP-136b: причина отказа/пропуска чекера (без секретов; EN). */
  reason?: string;
  durationMs?: number;
  exitCode?: number;
  bytesOut?: number;
  truncated?: boolean;
  outputSha256?: string;
  phase: CommandAuditPhase;
}
