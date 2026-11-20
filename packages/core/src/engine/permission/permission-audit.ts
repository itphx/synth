/**
 * Журнал **решений по подтверждениям прав** (`scope:'permission'`
 * security-аудита).
 *
 * До этого модуля `scope:'permission'` содержал единственный вид записи —
 * `action:'grant'` (выдача сессионного shell-гранта из оркестратора). Теперь
 * журнал — полноценная история **решений**: одно разрешённое ожидание
 * подтверждения = одна запись `action:'allow'|'deny'` с `after.outcome`
 * (`user`|`timeout`|`cascade`|`cancelled`) и, если решением «Разрешить в
 * сессии» действительно записаны правила, — `after.granted`. В режиме
 * `audit.permission.mode='all'` журналируются ещё и **автоматические**
 * решения по правилам (`after.outcome:'rule'`).
 *
 * Два входа:
 * - `createPermissionAuditSink(...)` — шов исполнения: его вызывает
 *   `PermissionApprovalManager` (при каждом разрешении ожидания) и циклы, где
 *   решение вычисляется по правилам (оркестратор, цикл саб-агента, пайплайн);
 * - `recordPermissionAudit(...)` — общий хелпер прямой записи для мутаций
 *   правил (`revoke` сессионного allow-правила, в следующем срезе — `update`
 *   правил инстанса).
 *
 * Инварианты:
 * - запись **не содержит секретов**: только метаданные решения (тул, правило,
 *   вид ask'а, каталоги/паттерны гранта; для `execute_shell` — сама команда,
 *   как и в прежней записи `grant`);
 * - запись **best-effort**: ошибка порта не ломает ход (только warn), как у
 *   прежнего `onPermissionGrant`;
 * - `action:'grant'` новыми записями **не пишется** (осталось в enum для
 *   исторических записей).
 */
import { generateId, nowISO } from '@itphx/synth-shared';

import { warning } from '../../logger.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type { AuditPermissionMode } from '../../storage/runtime-settings.js';
import type { ApprovalDecision, ApprovalRequest } from './approval.js';

/** Как разрешилось ожидание подтверждения (или как принято решение по правилу). */
export type PermissionAuditOutcome = 'user' | 'timeout' | 'cascade' | 'cancelled' | 'rule';

/** Правила, реально записанные в сессию решением «Разрешить в сессии». */
export interface PermissionAuditGrant {
  /** Командные паттерны правила `execute_shell`. */
  patterns: string[];
  /** Каталоги правила `permission.rules.external_directory` (`<dir>/*`). */
  directories: string[];
}

/**
 * Плоский снимок решения (`after` записи `scope:'permission'`). Секретов нет:
 * только метаданные решения и (для `execute_shell`) сама команда.
 */
export interface PermissionDecisionAuditSnapshot {
  /** Сессия, которой был адресован запрос (для решений по правилам — чья проверка). */
  sessionId: string;
  /** Идентификатор запроса подтверждения (`approval_<callId>`); у правила его нет. */
  approvalId?: string;
  /** Идентификатор tool-вызова. */
  callId?: string;
  /** Идентификатор хода (ADR-106 Ф0). */
  turnId?: string;
  /** Имя инструмента. */
  toolName: string;
  /** Сработавшее правило permission-слоя. */
  matchedRule?: string;
  /** id security-сообщения, объясняющего ask/deny. */
  messageId?: string;
  /** Вид ask'а от shell-guard (`dynamic`/`protected`/`mutation`/`cwd`/`external`). */
  askKind?: NonNullable<NonNullable<ApprovalRequest['trigger']>['askKind']>;
  /** Внешние пути проверки (shell-guard, `askPaths`). */
  askPaths?: string[];
  /** Команда `execute_shell` (как в прежней записи `grant`). */
  command?: string;
  /** true — разрешено «только один раз» (правило в сессию не писалось). */
  once?: boolean;
  /** Как разрешилось ожидание. */
  outcome: PermissionAuditOutcome;
  /** Правила, записанные в сессию (только для «Разрешить в сессии»). */
  granted?: PermissionAuditGrant;
}

/** Событие решения по ожиданию подтверждения (ответ/таймаут/каскад/отмена). */
export interface PermissionDecisionAuditEvent {
  sessionId: string;
  request: ApprovalRequest;
  decision: ApprovalDecision;
  /**
   * true — ожидание разрешено **из кода**, а не человеком: переоценка соседних
   * запросов после гранта «Разрешить в сессии» (паритет с opencode, ветка
   * `always`). Такое решение — автоматическое по правилу: `outcome:'rule'`, и
   * пишется оно только в режиме `all`.
   */
  auto?: boolean;
  /**
   * Дополнительные поля снимка от вызывающего (например `askPaths`, которых нет
   * в запросе подтверждения). Не перекрывают вычисленные.
   */
  extra?: Pick<PermissionDecisionAuditSnapshot, 'askPaths'>;
}

/** Событие автоматического решения по правилу (режим `all`). */
export interface PermissionRuleAuditEvent {
  sessionId: string;
  toolName: string;
  /** `allow`/`deny` (для `ask` решение по правилу не принимается). */
  action: 'allow' | 'deny';
  matchedRule?: string;
  callId?: string;
  turnId?: string;
  command?: string;
}

/** Зависимости шва журнала решений. */
export interface PermissionAuditDeps {
  /** Порт журнала (security-аудит). Не задан — запись не выполняется. */
  repository?: SecurityAuditRepository;
  /**
   * Владелец/принципал сессии — `actor` записи. Не задан/не нашёлся —
   * `local` (как у прежнего `onPermissionGrant`).
   */
  actorOf?: (sessionId: string) => string | undefined | Promise<string | undefined>;
  /** Текущий режим журнала (`decisions`|`all`); не задан — `decisions`. */
  mode?: () => AuditPermissionMode;
  /** Логгер предупреждений (тесты). */
  warn?: (message: string) => void;
}

/** Шов журнала решений: исполнение решений по подтверждениям и по правилам. */
export interface PermissionAuditSink {
  /** Решение по ожиданию подтверждения (allow/deny + `outcome`). */
  decision(event: PermissionDecisionAuditEvent): void;
  /** Автоматическое решение по правилу — пишется только в режиме `all`. */
  rule(event: PermissionRuleAuditEvent): void;
  /** Дождаться завершения уже начатых записей (тесты/остановка процесса). */
  flush(): Promise<void>;
}

/** Что писать в журнал (общий вид для обеих точек входа). */
interface AuditRecordInput {
  /** Действие журнала: решение либо мутация правил. */
  action: 'allow' | 'deny' | 'revoke' | 'update';
  /** Актор изменения (владелец/принципал сессии, `local`, id пользователя). */
  actor: string;
  /** Снимок «до» (у решений — `null`). */
  before: unknown;
  /** Снимок «после» (плоский, без секретов). */
  after: unknown;
}

/**
 * Записать событие в security-аудит (`scope:'permission'`).
 *
 * Best-effort: ошибка порта **не пробрасывается** (только warn) — журнал не
 * должен ломать операцию. Возвращает промис для тестов/точек, где удобно
 * дождаться записи; вызывающие в ходе (`decision`/`rule`) его не ждут.
 */
export async function recordPermissionAudit(
  deps: Pick<PermissionAuditDeps, 'repository' | 'warn'>,
  entry: AuditRecordInput,
): Promise<void> {
  const repository = deps.repository;
  if (!repository) return;
  const warn = deps.warn ?? ((message: string) => warning('PERMISSION', message));
  try {
    await repository.append({
      id: `sa_${generateId()}`,
      ts: nowISO(),
      actor: entry.actor || 'local',
      scope: 'permission',
      action: entry.action,
      source: 'runtime',
      before: entry.before,
      after: entry.after,
      version: 1,
    });
  } catch (err) {
    warn(
      `аудит решения по правам не записан: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `action` решения по подтверждению. */
function decisionAction(decision: ApprovalDecision): 'allow' | 'deny' {
  return decision.approved ? 'allow' : 'deny';
}

/** `outcome` решения: отмена/таймаут/каскад/ответ пользователя. */
function decisionOutcome(decision: ApprovalDecision): PermissionAuditOutcome {
  if (decision.cancelled) return 'cancelled';
  if (decision.timeout) return 'timeout';
  if (decision.cascaded) return 'cascade';
  return 'user';
}

/**
 * Правила, которые решение «Разрешить в сессии» запишет в сессию.
 *
 * Источник — **план гранта самого запроса** (`request.save`/
 * `request.saveDirectories`): он показывается человеку в полосе подтверждения
 * и по нему же оркестратор пишет правила. Пусто/`once` — правило в сессию не
 * пишется, `granted` не заполняется.
 */
function grantedOf(
  request: ApprovalRequest,
  decision: ApprovalDecision,
): PermissionAuditGrant | undefined {
  // `once: true` — «разрешить один раз»; `once` не задан — грант не выдаётся
  // (старый формат ответа `{approved:true}` без выбора «в сессии»).
  if (decision.once !== false) return undefined;
  const patterns = request.save ?? [];
  const directories = request.saveDirectories ?? [];
  if (patterns.length === 0 && directories.length === 0) return undefined;
  return { patterns: [...patterns], directories: [...directories] };
}

/** `true`, если у запроса есть команда `execute_shell` (для снимка решения). */
function commandOf(request: ApprovalRequest): string | undefined {
  if (request.toolName !== 'execute_shell') return undefined;
  const command = request.arguments?.command;
  return typeof command === 'string' ? command : undefined;
}

/** Снимок `after` решения по подтверждению (плоский, без секретов). */
export function permissionDecisionSnapshot(
  event: PermissionDecisionAuditEvent,
): PermissionDecisionAuditSnapshot {
  const { request, decision, sessionId } = event;
  const trigger = request.trigger;
  const granted = grantedOf(request, decision);
  const command = commandOf(request);
  const askPaths = event.extra?.askPaths;
  return {
    sessionId,
    approvalId: request.approvalId,
    callId: request.callId,
    ...(request.turnId ? { turnId: request.turnId } : {}),
    toolName: request.toolName,
    ...(trigger?.matchedRule ? { matchedRule: trigger.matchedRule } : {}),
    ...(trigger?.messageId ? { messageId: trigger.messageId } : {}),
    ...(trigger?.askKind ? { askKind: trigger.askKind } : {}),
    ...(askPaths && askPaths.length > 0 ? { askPaths: [...askPaths] } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(typeof decision.once === 'boolean' ? { once: decision.once } : {}),
    outcome: event.auto === true ? 'rule' : decisionOutcome(decision),
    ...(granted ? { granted } : {}),
  };
}

/**
 * Собрать шов журнала решений по подтверждениям прав.
 *
 * `repository` не задан (деградированный инстанс/тесты) — шов молча ничего не
 * пишет. Актор резолвится **внутри** записи (может быть асинхронным): запись
 * fire-and-forget, ход её не ждёт.
 */
export function createPermissionAuditSink(deps: PermissionAuditDeps): PermissionAuditSink {
  const warn = deps.warn ?? ((message: string) => warning('PERMISSION', message));
  const mode = (): AuditPermissionMode => deps.mode?.() ?? 'decisions';
  /** Незавершённые записи — для `flush()` (тесты/остановка). */
  const pending = new Set<Promise<void>>();

  const track = (promise: Promise<void>): void => {
    pending.add(promise);
    void promise.finally(() => {
      pending.delete(promise);
    });
  };

  const resolveActor = async (sessionId: string): Promise<string> => {
    if (!deps.actorOf) return 'local';
    try {
      const actor = await deps.actorOf(sessionId);
      return actor && actor !== '' ? actor : 'local';
    } catch {
      // Владельца не прочитали — решение всё равно должно попасть в журнал.
      return 'local';
    }
  };

  const write = (sessionId: string, build: (actor: string) => AuditRecordInput): void => {
    if (!deps.repository) return;
    track(
      (async () => {
        const actor = await resolveActor(sessionId);
        await recordPermissionAudit({ repository: deps.repository, warn }, build(actor));
      })(),
    );
  };

  return {
    decision: (event) => {
      if (!deps.repository) return;
      const after = permissionDecisionSnapshot(event);
      // Автоматическое решение по правилу (переоценка соседнего запроса) — тот
      // же режим журналирования, что у решений циклов (`all`).
      if (after.outcome === 'rule' && mode() !== 'all') return;
      const action = decisionAction(event.decision);
      write(after.sessionId, (actor) => ({ action, actor, before: null, after }));
    },

    rule: (event) => {
      if (!deps.repository) return;
      // `decisions` — журналим только вопросы человеку; автоматические решения
      // по правилам пишутся в режиме `all` (решение владельца).
      if (mode() !== 'all') return;
      const after: PermissionDecisionAuditSnapshot = {
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        toolName: event.toolName,
        ...(event.matchedRule ? { matchedRule: event.matchedRule } : {}),
        ...(event.command !== undefined ? { command: event.command } : {}),
        outcome: 'rule',
      };
      // Автоматическое решение принимает не человек — актор тот же, что у
      // решения по подтверждению (владелец/принципал сессии).
      write(event.sessionId, (actor) => ({
        action: event.action,
        actor,
        before: null,
        after,
      }));
    },

    flush: async () => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}
