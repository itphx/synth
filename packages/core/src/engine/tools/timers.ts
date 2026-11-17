/**
 * PROP-141 (этап 6): тулы `timer` и `alarm` — автоматизации, которые будят агента.
 *
 * Два тула с параметром `action` (решение владельца):
 * - `timer` — **относительный** отсчёт («через 15 минут»);
 * - `alarm` — **абсолютное** время или повтор («завтра в 09:00», «каждые
 *   10 минут»).
 *
 * Оба — одна сущность (`kind: 'timer' | 'alarm'`); различаются видом и
 * правилом повтора. Общий порт — `engine/timers/` (PROP-141, Часть B).
 *
 * ## Отличие от расписания (`schedule_*`, ADR-051)
 *
 * У расписания есть **свой текст задания** (что именно запускать). Здесь несёт
 * только **комментарий** — смысл срабатывания восстанавливает сам агент по
 * комментарию и истории сессии. Поэтому комментарий — единственный «смысл»
 * автоматизации: писать его так, чтобы через сутки было понятно, что делать.
 *
 * ## Границы
 *
 * - **Проект обязателен** (PROP-141): инстансных автоматизаций нет — у
 *   автоматизации есть проект и сессия. Сессия без проекта → понятный отказ.
 * - **Скоуп — своя сессия.** Список показывает автоматизации текущей сессии;
 *   чужая (другая сессия/проект) выглядит как отсутствующая — её существование
 *   не раскрывается (то же правило, что у `process.tool.not_found`).
 * - **Мутации — через движок** (`TimerService`): лимиты, валидация и пересчёт
 *   `firesAt` — его дело; тул в порт напрямую не пишет (инвариант 2).
 * - **Тексты — только через ключи `shared/i18n`** (ADR-041).
 */
import { z } from 'zod';
import {
  ToolCapability,
  TIMER_COMMENT_MAX,
  TIMER_MAX_INTERVAL_SEC,
  TIMER_MIN_INTERVAL_SEC,
} from '@itphx/synth-shared';
import type {
  Timer,
  TimerFilter,
  TimerRepeat,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@itphx/synth-shared';
import type { TimerService } from '../timers/service.js';
import type { TimerErrorCode } from '../timers/types.js';
import { TimerValidationError } from '../timers/types.js';
import type { TimerRepository } from '../../storage/ports/timer-repository.js';
import type { SessionManager } from '../../sessions/manager.js';
import { isAborted, abortedResult } from './abort.js';
import { argErrorResult } from './arg-error.js';
import type { PrincipalExtra } from './project-resolve.js';
import { resolveViewer } from './project-resolve.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/**
 * Зависимости тулов таймеров из `ToolContext.extra` (упаковка — оркестратор).
 *
 * - `timerService` — движок таймеров/будильников (PROP-141): создание,
 *   правка, отмена (лимиты и валидация — его дело).
 * - `timers` — порт реестра таймеров (ADR-096): список и чтение записей.
 * - `sessionManager` — менеджер сессий: владелец сессии (`ownerId`
 *   автоматизации).
 *
 * Не заданы — контур автоматизаций в этой сборке недоступен
 * (`timer.tool.deps_unavailable`).
 */
export interface TimerToolsExtra extends PrincipalExtra {
  timerService?: TimerService;
  timers?: TimerRepository;
  sessionManager?: SessionManager;
}

/** Единый отказ «контур автоматизаций недоступен в этой сборке». */
function depsUnavailable(): ToolResult {
  return {
    content: sm('timer.tool.deps_unavailable'),
    isError: true,
    metadata: { i18n: i18nMeta('timer.tool.deps_unavailable') },
  };
}

/** Единый отказ «у сессии нет проекта» (автоматизации — только в проекте). */
function noProject(): ToolResult {
  return {
    content: sm('timer.tool.no_project'),
    isError: true,
    metadata: { i18n: i18nMeta('timer.tool.no_project') },
  };
}

/**
 * Единый отказ «автоматизация не найдена».
 *
 * Один текст для «нет такого id» и «чужой автоматизации» — существование
 * чужого ресурса не раскрывается.
 */
function notFound(id: string): ToolResult {
  return {
    content: sm('timer.tool.not_found', { id }),
    isError: true,
    metadata: { i18n: i18nMeta('timer.tool.not_found', { id }) },
  };
}

/**
 * Отказ по коду доменной ошибки движка таймеров → текст для модели.
 *
 * Коды разбирает **вызывающий** (тул), а не движок: движок не знает ни формат
 * ответа, ни коды API (то же правило, что у `script.tool.*`).
 */
const TIMER_ERROR_KEYS = {
  timer_invalid_comment: 'timer.tool.invalid_comment',
  timer_invalid_interval: 'timer.tool.invalid_interval',
  timer_invalid_time: 'timer.tool.invalid_time',
  timer_invalid_timezone: 'timer.tool.invalid_timezone',
  timer_invalid_horizon: 'timer.tool.invalid_horizon',
  timer_invalid_target: 'timer.tool.invalid_target',
  timer_limit_exceeded: 'timer.tool.limit_exceeded',
} as const satisfies Record<TimerErrorCode, string>;

/**
 * Отказ движка (`TimerValidationError`/`TimerLimitExceededError`) → результат
 * тула: текст по i18n-ключу + машинный код в `metadata.code`.
 *
 * `null` — ошибка не доменная (её пробрасывают дальше).
 */
function engineErrorResult(err: unknown): ToolResult | null {
  if (!(err instanceof TimerValidationError)) return null;
  const key = TIMER_ERROR_KEYS[err.code];
  if (err.code === 'timer_limit_exceeded') {
    const limit = String((err as { limit?: number }).limit ?? '');
    return {
      content: sm(key, { limit }),
      isError: true,
      metadata: { i18n: i18nMeta(key, { limit }), code: err.code },
    };
  }
  const field = err.field ?? 'value';
  return {
    content: sm(key, { field }),
    isError: true,
    metadata: { i18n: i18nMeta(key, { field }), code: err.code },
  };
}

/** Scope тула автоматизации: движок + порт + проект/сессия/владелец. */
interface TimerToolScope {
  /** Движок таймеров (создание/правка/отмена). */
  service: TimerService;
  /** Порт реестра таймеров (список/чтение). */
  repository: TimerRepository;
  /** Проект сессии — обязателен (инстансных автоматизаций нет). */
  projectId: string;
  /** Сессия-получатель сообщения при срабатывании. */
  sessionId: string;
  /** Владелец (принципал-человек; в standalone — `local`). */
  ownerId: string;
}

/** Результат `loadScope`: готовый scope либо готовый отказ. */
type ScopeResult = { ok: true; scope: TimerToolScope } | { ok: false; result: ToolResult };

/**
 * Владелец автоматизации — владелец сессии/текущий пользователь.
 *
 * Тот же резолвер, что у соседних тулов (`resolveViewer`): принципал хода →
 * владелец сессии → `local` (standalone-дефолт).
 */
async function resolveOwnerId(ctx: ToolContext, extra: TimerToolsExtra): Promise<string> {
  const viewer = await resolveViewer(ctx, extra);
  return viewer.userId || 'local';
}

/**
 * Загрузить scope тула: движок, порт, проект, сессия, владелец.
 *
 * Отказ — когда считать нечем: контур недоступен (`deps_unavailable`) либо у
 * сессии нет проекта (`no_project` — автоматизации бывают только в проекте).
 */
async function loadScope(ctx: ToolContext, extra: TimerToolsExtra): Promise<ScopeResult> {
  const service = extra.timerService;
  const repository = extra.timers;
  if (!service || !repository) return { ok: false, result: depsUnavailable() };

  const projectId = ctx.projectId;
  if (!projectId) return { ok: false, result: noProject() };

  const sessionId = ctx.sessionId;
  if (!sessionId) return { ok: false, result: depsUnavailable() };

  const ownerId = await resolveOwnerId(ctx, extra);
  return { ok: true, scope: { service, repository, projectId, sessionId, ownerId } };
}

/** Автоматизация в области доступа сессии (чужая — как отсутствующая). */
function inScope(timer: Timer, scope: TimerToolScope): boolean {
  return timer.sessionId === scope.sessionId;
}

/** Правило повтора строкой (для списка). */
function describeRepeat(repeat: TimerRepeat): string {
  if (repeat.mode === 'daily') return `daily ${repeat.time} ${repeat.timezone}`;
  if (repeat.mode === 'every') return `every ${repeat.everySec}s`;
  return 'once';
}

/** Предел длины комментария в строке списка, символов. */
const MAX_COMMENT_CHARS = 120;

/** Обрезать текст до предела (многоточие — «обрезано»). */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Строка автоматизации для списка: машиночитаемые `key=value`. */
function formatTimerLine(timer: Timer): string {
  return [
    `- ${timer.id}`,
    `status=${timer.status}`,
    `fires_at=${timer.firesAt}`,
    `repeat=${describeRepeat(timer.repeat)}`,
    `comment=${truncate(timer.comment, MAX_COMMENT_CHARS)}`,
  ].join(' | ');
}

/** Список автоматизаций сессии (по виду и статусу). */
async function listTimers(
  scope: TimerToolScope,
  kind: 'timer' | 'alarm',
  includeCancelled: boolean,
): Promise<Timer[]> {
  const filter: TimerFilter = {
    sessionId: scope.sessionId,
    kind,
    ...(includeCancelled ? {} : { status: 'active' }),
  };
  return scope.repository.list(filter);
}

/** Итог списка автоматизаций — текст для модели + метаданные. */
function listResult(timers: Timer[]): ToolResult {
  if (timers.length === 0) {
    return {
      content: sm('timer.tool.list_empty'),
      metadata: { count: 0, timers: [], i18n: i18nMeta('timer.tool.list_empty') },
    };
  }
  const lines = [
    sm('timer.tool.list_header', { count: String(timers.length) }),
    ...timers.map(formatTimerLine),
  ];
  return {
    content: lines.join('\n'),
    metadata: {
      count: timers.length,
      timers: timers.map((timer) => ({
        id: timer.id,
        kind: timer.kind,
        status: timer.status,
        firesAt: timer.firesAt,
      })),
    },
  };
}

// ─────────────────────────────── timer ───────────────────────────────

const timerToolSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    delay: z
      .number()
      .int()
      .min(TIMER_MIN_INTERVAL_SEC)
      .max(TIMER_MAX_INTERVAL_SEC)
      .describe('Seconds from now until the reminder fires (10…2592000)'),
    comment: z
      .string()
      .min(1)
      .max(TIMER_COMMENT_MAX)
      .describe(
        'What to do when the timer fires — the only meaning of this automation. '
        + 'Write it so that it is still clear a day later.',
      ),
    name: z.string().min(1).optional().describe('Optional short name of the timer'),
  }),
  z.object({
    action: z.literal('list'),
    include_cancelled: z
      .boolean()
      .optional()
      .describe(
        'Include cancelled, paused and already fired timers (default: only the active ones of this session)',
      ),
  }),
  z.object({
    action: z.literal('cancel'),
    timer_id: z.string().min(1).describe('Id of the timer to cancel (tmr_...)'),
  }),
]);

type TimerToolInput = z.infer<typeof timerToolSchema>;

export const timerTool: ToolDefinition = {
  name: 'timer',
  description:
    'Create a one-shot reminder that wakes this session up after N seconds ("come back to this in 15 minutes"). '
    + 'Use it instead of `sleep` or a blocking shell command whenever the work has to continue later — never block the '
    + 'current turn waiting, create a timer and let it wake you up. '
    + 'The comment is the only meaning of this automation: it must explain what to do when the timer fires, written so '
    + 'that it is still clear a day later. '
    + 'Actions: create (delay in seconds + comment), list (the timers of this session), cancel (timer_id).',
  parameters: timerToolSchema,
  capabilities: [ToolCapability.SCHEDULE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as TimerToolInput;

    const extra = (ctx.extra ?? {}) as TimerToolsExtra;
    const loaded = await loadScope(ctx, extra);
    if (!loaded.ok) return loaded.result;
    const scope = loaded.scope;

    if (params.action === 'create') {
      try {
        const timer = await scope.service.createTimer({
          kind: 'timer',
          ...(params.name !== undefined ? { name: params.name } : {}),
          comment: params.comment,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          ownerId: scope.ownerId,
          repeat: { mode: 'once' },
          delaySec: params.delay,
        });
        const text = sm('timer.tool.created', { id: timer.id, fires_at: timer.firesAt });
        return {
          content: text,
          metadata: {
            id: timer.id,
            fires_at: timer.firesAt,
            i18n: i18nMeta('timer.tool.created', { id: timer.id, fires_at: timer.firesAt }),
          },
        };
      } catch (err) {
        const failure = engineErrorResult(err);
        if (failure) return failure;
        throw err;
      }
    }

    if (params.action === 'list') {
      const timers = await listTimers(scope, 'timer', params.include_cancelled === true);
      return listResult(timers);
    }

    // cancel
    const existing = await scope.repository.get(params.timer_id);
    if (!existing || existing.kind !== 'timer' || !inScope(existing, scope)) {
      return notFound(params.timer_id);
    }
    const removed = await scope.service.removeTimer(params.timer_id);
    if (!removed) return notFound(params.timer_id);
    const text = sm('timer.tool.cancelled', { id: params.timer_id });
    return {
      content: text,
      metadata: {
        id: params.timer_id,
        i18n: i18nMeta('timer.tool.cancelled', { id: params.timer_id }),
      },
    };
  },
};

// ─────────────────────────────── alarm ───────────────────────────────

/** Поля времени/повтора будильника (общие для `create` и `update`). */
const alarmTimeFields = {
  at: z
    .string()
    .min(1)
    .optional()
    .describe('Absolute fire time, ISO-8601 (for example 2026-11-18T09:00:00Z)'),
  time: z.string().min(1).optional().describe('Wall-clock time HH:MM — requires `timezone`'),
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe('IANA timezone of `time` (for example Europe/Moscow)'),
  repeat: z
    .enum(['once', 'daily', 'every'])
    .optional()
    .describe(
      'Repetition rule: once (needs `at`), daily (needs `time` + `timezone`), every (needs `every_sec`)',
    ),
  every_sec: z
    .number()
    .int()
    .min(TIMER_MIN_INTERVAL_SEC)
    .max(TIMER_MAX_INTERVAL_SEC)
    .optional()
    .describe('Interval in seconds for repeat=every (10…2592000)'),
};

const alarmToolSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    ...alarmTimeFields,
    comment: z
      .string()
      .min(1)
      .max(TIMER_COMMENT_MAX)
      .describe(
        'What to do when the alarm fires — the only meaning of this automation. '
        + 'Write it so that it is still clear a day later.',
      ),
    name: z.string().min(1).optional().describe('Optional short name of the alarm'),
  }),
  z.object({
    action: z.literal('list'),
    include_cancelled: z
      .boolean()
      .optional()
      .describe(
        'Include cancelled, paused and already fired alarms (default: only the active ones of this session)',
      ),
  }),
  z.object({
    action: z.literal('update'),
    alarm_id: z.string().min(1).describe('Id of the alarm to update (tmr_...)'),
    ...alarmTimeFields,
    comment: z
      .string()
      .min(1)
      .max(TIMER_COMMENT_MAX)
      .optional()
      .describe('New comment — what to do when the alarm fires'),
    name: z.string().min(1).optional().describe('New name of the alarm'),
  }),
  z.object({
    action: z.literal('cancel'),
    alarm_id: z.string().min(1).describe('Id of the alarm to cancel (tmr_...)'),
  }),
]);

type AlarmToolInput = z.infer<typeof alarmToolSchema>;

/** Поля времени/повтора, как их видит тул. */
interface AlarmTimeInput {
  at?: string;
  time?: string;
  timezone?: string;
  repeat?: 'once' | 'daily' | 'every';
  every_sec?: number;
}

/** Результат сборки правила повтора: правило либо текст отказа. */
type RepeatResult = { ok: true; repeat: TimerRepeat } | { ok: false; error: string };

/**
 * Собрать правило повтора будильника из полей вызова.
 *
 * `repeat` необязателен: без него режим выводится из переданных полей
 * (`every_sec` → every, `time`/`timezone` → daily, иначе once). Несовместимые
 * комбинации (`at` вместе с `time`, `every_sec` вместе с `time`) — понятный
 * отказ: иначе будильник «просыпается не вовремя», и никто не поймёт почему.
 *
 * `current` — действующее правило правки: недостающие «парные» поля
 * (`time`/`timezone`/`every_sec`) берутся из него, поэтому смену часового
 * пояса можно задать одной строкой.
 */
function buildRepeat(input: AlarmTimeInput, current?: TimerRepeat): RepeatResult {
  const hasAt = input.at !== undefined;
  const hasTime = input.time !== undefined || input.timezone !== undefined;
  const hasEvery = input.every_sec !== undefined;

  let mode: 'once' | 'daily' | 'every';
  if (input.repeat) {
    mode = input.repeat;
  } else if (hasEvery) {
    mode = 'every';
  } else if (hasTime) {
    mode = 'daily';
  } else {
    mode = 'once';
  }

  if (mode === 'daily') {
    if (hasAt) return { ok: false, error: 'for repeat="daily" use `time` + `timezone`, not `at`' };
    if (hasEvery) return { ok: false, error: 'for repeat="daily" use `time` + `timezone`, not `every_sec`' };
    const time = input.time ?? (current?.mode === 'daily' ? current.time : undefined);
    const timezone = input.timezone ?? (current?.mode === 'daily' ? current.timezone : undefined);
    if (time === undefined) return { ok: false, error: 'for repeat="daily" `time` (HH:MM) is required' };
    if (timezone === undefined) {
      return { ok: false, error: 'for repeat="daily" `timezone` (IANA, e.g. Europe/Moscow) is required' };
    }
    return { ok: true, repeat: { mode: 'daily', time, timezone } };
  }

  if (mode === 'every') {
    if (hasAt) return { ok: false, error: 'for repeat="every" use `every_sec`, not `at`' };
    if (hasTime) return { ok: false, error: 'for repeat="every" use `every_sec`, not `time`/`timezone`' };
    const everySec = input.every_sec ?? (current?.mode === 'every' ? current.everySec : undefined);
    if (everySec === undefined) return { ok: false, error: 'for repeat="every" `every_sec` is required' };
    return { ok: true, repeat: { mode: 'every', everySec } };
  }

  // once
  if (hasTime) return { ok: false, error: 'for repeat="once" use `at`, not `time`/`timezone`' };
  if (hasEvery) return { ok: false, error: 'for repeat="once" use `at`, not `every_sec`' };
  return { ok: true, repeat: { mode: 'once' } };
}

export const alarmTool: ToolDefinition = {
  name: 'alarm',
  description:
    'Create an absolute or recurring wake-up for this session: once ("tomorrow at 09:00"), daily ("every day at 09:00, '
    + 'Europe/Moscow") or every ("every 10 minutes"). Unlike a schedule (schedule_*), an alarm carries only a comment '
    + '— no task text: you interpret the comment from the context and the history of the session yourself. '
    + 'The comment is the only meaning of this automation: write it so that it is still clear a day later. '
    + 'Actions: create (at or time+timezone, repeat, comment), list (the alarms of this session), update (alarm_id), '
    + 'cancel (alarm_id).',
  parameters: alarmToolSchema,
  capabilities: [ToolCapability.SCHEDULE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as AlarmToolInput;

    const extra = (ctx.extra ?? {}) as TimerToolsExtra;
    const loaded = await loadScope(ctx, extra);
    if (!loaded.ok) return loaded.result;
    const scope = loaded.scope;

    if (params.action === 'create') {
      const built = buildRepeat(params);
      if (!built.ok) return argErrorResult(this.name, built.error);
      try {
        const alarm = await scope.service.createTimer({
          kind: 'alarm',
          ...(params.name !== undefined ? { name: params.name } : {}),
          comment: params.comment,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          ownerId: scope.ownerId,
          repeat: built.repeat,
          ...(params.at !== undefined ? { at: params.at } : {}),
        });
        const text = sm('timer.tool.created', { id: alarm.id, fires_at: alarm.firesAt });
        return {
          content: text,
          metadata: {
            id: alarm.id,
            fires_at: alarm.firesAt,
            i18n: i18nMeta('timer.tool.created', { id: alarm.id, fires_at: alarm.firesAt }),
          },
        };
      } catch (err) {
        const failure = engineErrorResult(err);
        if (failure) return failure;
        throw err;
      }
    }

    if (params.action === 'list') {
      const alarms = await listTimers(scope, 'alarm', params.include_cancelled === true);
      return listResult(alarms);
    }

    if (params.action === 'cancel') {
      const existing = await scope.repository.get(params.alarm_id);
      if (!existing || existing.kind !== 'alarm' || !inScope(existing, scope)) {
        return notFound(params.alarm_id);
      }
      const removed = await scope.service.removeTimer(params.alarm_id);
      if (!removed) return notFound(params.alarm_id);
      const text = sm('timer.tool.cancelled', { id: params.alarm_id });
      return {
        content: text,
        metadata: {
          id: params.alarm_id,
          i18n: i18nMeta('timer.tool.cancelled', { id: params.alarm_id }),
        },
      };
    }

    // update
    const existing = await scope.repository.get(params.alarm_id);
    if (!existing || existing.kind !== 'alarm' || !inScope(existing, scope)) {
      return notFound(params.alarm_id);
    }

    const patch: {
      comment?: string;
      name?: string;
      repeat?: TimerRepeat;
      firesAt?: string;
    } = {};
    if (params.comment !== undefined) patch.comment = params.comment;
    if (params.name !== undefined) patch.name = params.name;

    // Правило повтора меняется только когда заданы поля времени/повтора.
    const timeTouched =
      params.at !== undefined
      || params.time !== undefined
      || params.timezone !== undefined
      || params.repeat !== undefined
      || params.every_sec !== undefined;
    if (timeTouched) {
      const built = buildRepeat(params, existing.repeat);
      if (!built.ok) return argErrorResult(this.name, built.error);
      patch.repeat = built.repeat;
      if (built.repeat.mode === 'once') {
        if (params.at !== undefined) {
          const at = new Date(params.at);
          if (Number.isNaN(at.getTime())) {
            return argErrorResult(this.name, `at: invalid ISO-8601 date-time «${params.at}»`);
          }
          patch.firesAt = at.toISOString();
        } else if (existing.repeat.mode !== 'once') {
          return argErrorResult(this.name, 'for repeat="once" `at` is required');
        }
      }
    }

    if (Object.keys(patch).length === 0) {
      return argErrorResult(this.name, 'nothing to change: pass `comment`, `name` or the fire time');
    }

    try {
      const updated = await scope.service.updateTimer(params.alarm_id, patch);
      if (!updated) return notFound(params.alarm_id);
      const text = sm('timer.tool.updated', { id: params.alarm_id });
      return {
        content: text,
        metadata: {
          id: params.alarm_id,
          fires_at: updated.firesAt,
          i18n: i18nMeta('timer.tool.updated', { id: params.alarm_id }),
        },
      };
    } catch (err) {
      const failure = engineErrorResult(err);
      if (failure) return failure;
      throw err;
    }
  },
};
