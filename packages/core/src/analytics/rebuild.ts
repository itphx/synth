/**
 * ADR-102 §10: идемпотентный бэкфилл суточных роллапов аналитики
 * (`synth analytics rebuild`).
 *
 * ── Источники и политика согласования ────────────────────────────────────────
 *
 * `usage` — **истина сообщения**. Для каждого сохранённого сообщения с usage
 * берутся токены, модель, агент, длительность и стоимость
 * (`metadata.cost_usd`/`metadata.cost_currency`, ADR-070 §2.6); сутки — UTC-день
 * `createdAt` сообщения; оси — `user`/`project` сессии, `model`/`agent`
 * сообщения. Сессии саб-агентов учитываются своими сообщениями, поэтому каждое
 * сообщение считается ровно один раз (скрытые tool-chain сообщения не пишутся —
 * паритет с точкой записи `saveAssistantMessage`).
 *
 * `activity` — восстановление из истории сессии: `sessions_created`
 * (`createdAt`), `sessions_archived` (`archivedAt`), `messages_user`/
 * `messages_assistant`/`messages_tool` (персист сообщений, tool-chain исключён —
 * паритет с `SessionManager.addMessage`), `tool_calls` (`toolCalls` сообщений),
 * `turns` (сессии `sessionOrigin='subagent'`), `errors`/`aborts` (по
 * `metadata.status` сохранённого ответа: `error`/`limit` и `cancelled`).
 *
 * **Gateway-аудит** (`readAuditLog`, ADR-036) — **дополнение**, а не второй
 * независимый итог: журнал не несёт осей `project`/`agent` и заполняется не для
 * каждого запроса, поэтому суммы сообщений приоритетнее. На ключ
 * `(day, user, model)` считается только **положительная разница по каждому
 * полю**: `gap = max(0, аудит − сообщения)` для `input_tokens`, `output_tokens`
 * и стоимости в USD. Отрицательная разница не вычитается (сообщения — истина),
 * нулевая — бакет не создаётся. Добавка пишется в бакет без `project`/`agent`
 * (в аудите их нет) и не увеличивает `requests`/`messages`.
 *
 * Сверка с `computeSessionStats` (`sessions/stats.ts`) — **диагностика**, а не
 * источник сумм: `stats` рекурсивно включает саб-агентов и пересчитывает
 * стоимость по текущим ценам, поэтому расхождение фиксируется в отчёте
 * (`statsMismatched`/`warnings`), но суммы не правит.
 *
 * `decision` не пересобирается (источник — in-memory снимок `decisionMetrics`,
 * истории нет), `prompt` — проекция `usage` на чтении (ADR-102 §2).
 *
 * ── Идемпотентность ─────────────────────────────────────────────────────────
 * Бакеты за окно считаются **целиком** в памяти и записываются портом через
 * `set` (точная перезапись по ключу `(family, day, dimensions)`), поэтому
 * повторный прогон даёт те же значения и не удваивает счётчики. `increment` в
 * бэкфилле не используется. Ключи, у которых больше нет источника (например,
 * удалённые сессии), не удаляются: их убирает retention-прунер
 * (`analyticsRetentionCutoff`).
 */

import type { AnalyticsFamily, AnalyticsRollupBucket, Message, Session } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import { readAuditLog } from '../engine/gateway/audit-logger.js';
import { computeSessionStats } from '../sessions/stats.js';
import type { AnalyticsRollupRepository, SessionRepository } from '../storage/ports/index.js';
import { rollupBucketKey } from '../storage/analytics-rollup-helpers.js';
import {
  activityMeasureForMessage,
  buildDimensions,
  usageMeasures,
  type AnalyticsAxes,
} from './recorder.js';
import { AnalyticsValidationError, isValidDay, utcDay } from './service.js';

/** Семейства, которые пересобираются из истории (ADR-102 §2/§10). */
export type RebuildableFamily = Extract<AnalyticsFamily, 'usage' | 'activity'>;

/** Опции бэкфилла роллапов. */
export interface AnalyticsRebuildOptions {
  /** Порт роллапов — единственная точка записи (ADR-096, инвариант 2). */
  repo: AnalyticsRollupRepository;
  /** Порт сессий — история для `usage`/`activity`. */
  sessions: SessionRepository;
  /**
   * Путь к JSONL-журналу LLM Gateway (ADR-036). Не задан/файла нет — аудит не
   * учитывается (пустой источник, не ошибка).
   */
  auditLogPath?: string;
  /**
   * Начало окна включительно (`YYYY-MM-DD`, UTC). Не задано — вся история.
   * Фильтруются сутки бакета (сообщения, жизненный цикл сессии, записи аудита).
   */
  from?: string;
  /** Только расчёт и сводка — порт не вызывается (ничего не пишется). */
  dryRun?: boolean;
  /** Источник текущего времени (тесты); по умолчанию `new Date()`. */
  now?: () => Date;
}

/** Сводка бэкфилла — для `--json` и человекочитаемого вывода CLI. */
export interface AnalyticsRebuildResult {
  /** Начало окна: `--from` либо первый день с данными (сегодня, если данных нет). */
  from: string;
  /** Конец окна — сегодня (UTC). */
  to: string;
  dryRun: boolean;
  /** Сутки, по которым есть бакеты (по возрастанию). */
  days: string[];
  /** Число пересчитанных бакетов. */
  buckets: number;
  /** Пересчитанные бакеты — то, что записано (или было бы записано) портом. */
  rows: AnalyticsRollupBucket[];
  /** Обработано сессий. */
  sessions: number;
  /** Учтено сообщений (в окне). */
  messages: number;
  /** Прочитано записей аудита (в окне). */
  auditEntries: number;
  /** Бакетов, дополненных аудитом (положительная разница с сообщениями). */
  auditGaps: number;
  /** Сессий, сверенных с `computeSessionStats`. */
  statsChecked: number;
  /** Сессий, где суммы сообщений и `computeSessionStats` разошлись. */
  statsMismatched: number;
  /** Диагностика расхождений источников (суммы не правятся). */
  warnings: string[];
}

/** Накопитель «день + оси» для аудита: покрытие сообщениями и добавка. */
interface AuditCoverage {
  input: number;
  output: number;
  usd: number;
}

/** Группа записей аудита по ключу `(day, user, model)`. */
interface AuditGroup extends AuditCoverage {
  key: string;
  day: string;
  userId?: string;
  model?: string;
}

/** Суммы сообщений сессии (для сверки с `computeSessionStats`). */
interface SessionTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

function emptyTotals(): SessionTokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function totalsSum(totals: SessionTokenTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning;
}

/** Конечное число (защита от `NaN`/`Infinity` в старых данных). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Сутки UTC из ISO-метки; отсутствующая/битая дата — `null` (пропуск). */
function dayOf(iso: string | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return utcDay(new Date(ts));
}

/** Стоимость сообщения из `metadata.cost_usd`/`metadata.cost_currency` (ADR-070 §2.6). */
function messageCosts(metadata: Record<string, unknown> | undefined): Record<string, number> {
  const cost = metadata?.cost_usd;
  if (!isFiniteNumber(cost) || cost === 0) return {};
  const currency = typeof metadata?.cost_currency === 'string' ? metadata.cost_currency : 'USD';
  return { [currency]: cost };
}

/** Длительность ответа из `metadata.duration_ms` (мс). */
function messageDurationMs(msg: Message): number | undefined {
  const duration = msg.metadata?.duration_ms;
  return isFiniteNumber(duration) && duration >= 0 ? duration : undefined;
}

/** Ключ покрытия для аудита: `(day, user, model)` — осей project/agent в журнале нет. */
function coverageKey(day: string, userId: string | undefined, model: string | undefined): string {
  return `${day}\u0000${userId ?? ''}\u0000${model ?? ''}`;
}

/**
 * Накопитель бакетов в памяти: ключ — `(family, day, dimensions)` (тот же, что у
 * порта), меры суммируются. В порт уходят только полностью посчитанные бакеты
 * (`set`), поэтому повторный прогон не удваивает значения.
 */
class RebuildAccumulator {
  private readonly _buckets = new Map<string, AnalyticsRollupBucket>();
  private readonly _from: string | undefined;

  constructor(from?: string) {
    this._from = from;
  }

  /** Добавить меры/стоимость в бакет; сутки вне окна и нулевые значения пропускаются. */
  add(
    family: RebuildableFamily,
    day: string,
    axes: AnalyticsAxes,
    measures: Record<string, number>,
    costByCurrency?: Record<string, number>,
  ): void {
    if (this._from !== undefined && day < this._from) return;

    const cleanMeasures: Record<string, number> = {};
    for (const [name, value] of Object.entries(measures)) {
      if (isFiniteNumber(value) && value !== 0) cleanMeasures[name] = value;
    }
    const cleanCosts: Record<string, number> = {};
    for (const [currency, value] of Object.entries(costByCurrency ?? {})) {
      if (isFiniteNumber(value) && value !== 0) cleanCosts[currency] = value;
    }
    if (Object.keys(cleanMeasures).length === 0 && Object.keys(cleanCosts).length === 0) return;

    const dimensions = buildDimensions(axes);
    const key = rollupBucketKey({ family, day, dimensions });
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = { family, day, dimensions, measures: {} };
      this._buckets.set(key, bucket);
    }
    for (const [name, value] of Object.entries(cleanMeasures)) {
      bucket.measures[name] = (bucket.measures[name] ?? 0) + value;
    }
    if (Object.keys(cleanCosts).length > 0) {
      const costs = bucket.costByCurrency ?? {};
      for (const [currency, value] of Object.entries(cleanCosts)) {
        costs[currency] = (costs[currency] ?? 0) + value;
      }
      bucket.costByCurrency = costs;
    }
  }

  /** Итоговые бакеты в детерминированном порядке (день → семейство → ключ). */
  buckets(): AnalyticsRollupBucket[] {
    return [...this._buckets.entries()]
      .sort(([keyA, a], [keyB, b]) => {
        if (a.day !== b.day) return a.day < b.day ? -1 : 1;
        if (a.family !== b.family) return a.family < b.family ? -1 : 1;
        return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
      })
      .map(([, bucket]) => bucket);
  }
}

/**
 * Пересобрать роллапы `usage`/`activity` из истории за окно `--from…сегодня`.
 *
 * Идемпотентно: бакеты считаются целиком и пишутся `set`, а не `increment`.
 * `dryRun` — только расчёт и сводка, порт не вызывается.
 *
 * @throws AnalyticsValidationError — `from` не является датой `YYYY-MM-DD` (UTC).
 */
export async function rebuildAnalyticsRollups(
  opts: AnalyticsRebuildOptions,
): Promise<AnalyticsRebuildResult> {
  const from = opts.from;
  if (from !== undefined && !isValidDay(from)) {
    throw new AnalyticsValidationError(
      'period',
      `from: ожидается дата YYYY-MM-DD (UTC), получено "${from}"`,
    );
  }

  const now = opts.now ? opts.now() : new Date();
  const today = utcDay(now);
  const accumulator = new RebuildAccumulator(from);
  const coverage = new Map<string, AuditCoverage>();
  const warnings: string[] = [];
  let statsChecked = 0;
  let statsMismatched = 0;
  let messages = 0;

  const sessions = await opts.sessions.list();
  const getSession = (sessionId: string): Promise<Session | null> => opts.sessions.load(sessionId);

  for (const session of sessions) {
    const axes: AnalyticsAxes = { userId: session.userId, projectId: session.projectId };
    const createdDay = dayOf(session.createdAt);

    // Жизненный цикл сессии (activity).
    if (createdDay) {
      accumulator.add('activity', createdDay, axes, { sessions_created: 1 });
      if (session.sessionOrigin === 'subagent') {
        // `agent_spawned` (ADR-030): ход саб-агента — по дню его сессии.
        accumulator.add('activity', createdDay, axes, { turns: 1 });
      }
    }
    const archivedDay = dayOf(session.archivedAt);
    if (archivedDay) {
      accumulator.add('activity', archivedDay, axes, { sessions_archived: 1 });
    }

    const ownTotals = emptyTotals();

    for (const msg of session.messages) {
      const day = dayOf(msg.createdAt) ?? createdDay;
      const toolChain = msg.metadata?.tool_chain === true;

      // Сверка со stats — по всей сессии, независимо от окна `--from`
      // (computeSessionStats считает историю целиком). User/tool статистика
      // агентов не учитывает.
      if (!toolChain && msg.role !== MessageRole.USER && msg.role !== MessageRole.TOOL) {
        ownTotals.input += msg.usage?.inputTokens ?? 0;
        ownTotals.output += msg.usage?.outputTokens ?? 0;
        ownTotals.cacheRead += msg.usage?.cacheReadTokens ?? 0;
        ownTotals.cacheWrite += msg.usage?.cacheWriteTokens ?? 0;
        ownTotals.reasoning += msg.usage?.reasoningTokens ?? 0;
      }

      if (!day || (from !== undefined && day < from)) continue;
      messages += 1;

      // ── activity ────────────────────────────────────────────────────────
      if (!toolChain) {
        const measure = msg.role === MessageRole.USER
          ? 'messages_user'
          : activityMeasureForMessage(msg.role);
        if (measure) accumulator.add('activity', day, axes, { [measure]: 1 });
      }
      const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls.length : 0;
      if (toolCalls > 0) accumulator.add('activity', day, axes, { tool_calls: toolCalls });
      const status = msg.metadata?.status;
      if (status === 'error' || status === 'limit') {
        accumulator.add('activity', day, axes, { errors: 1 });
      } else if (status === 'cancelled') {
        accumulator.add('activity', day, axes, { aborts: 1 });
      }

      // Скрытые tool-chain сообщения точка записи usage не пишет — не пишем и здесь.
      if (toolChain) continue;

      // ── usage ───────────────────────────────────────────────────────────
      const measures = usageMeasures(msg.usage);
      const hasTokens = Object.keys(measures).length > 0;
      if (hasTokens) measures.requests = 1;
      if (msg.role === MessageRole.ASSISTANT) measures.messages = 1;
      const durationMs = messageDurationMs(msg);
      if (durationMs !== undefined) measures.duration_ms = durationMs;
      const costs = messageCosts(msg.metadata);
      const model = msg.model || undefined;
      const agent = msg.agentRole || undefined;
      accumulator.add('usage', day, { ...axes, model, agent }, measures, costs);

      // Покрытие для аудита — все токены сообщения (независимо от роли).
      if (hasTokens || Object.keys(costs).length > 0) {
        const key = coverageKey(day, session.userId, model);
        const cover = coverage.get(key) ?? { input: 0, output: 0, usd: 0 };
        cover.input += msg.usage?.inputTokens ?? 0;
        cover.output += msg.usage?.outputTokens ?? 0;
        cover.usd += costs.USD ?? 0;
        coverage.set(key, cover);
      }
    }

    // Диагностика: сообщения vs `computeSessionStats` (истина — сообщения).
    statsChecked += 1;
    const stats = await computeSessionStats(session, { getSession });
    const agentTokens = stats.agents.reduce(
      (sum, agent) =>
        sum
        + agent.input_tokens
        + agent.output_tokens
        + agent.cache_read_tokens
        + agent.cache_write_tokens
        + agent.reasoning_tokens,
      0,
    );
    const subagentTokens =
      stats.subagents.input_tokens
      + stats.subagents.output_tokens
      + stats.subagents.cache_read_tokens
      + stats.subagents.cache_write_tokens
      + stats.subagents.reasoning_tokens;
    const ownFromStats = agentTokens - subagentTokens;
    const ownFromMessages = totalsSum(ownTotals);
    if (ownFromStats !== ownFromMessages) {
      statsMismatched += 1;
      warnings.push(
        `сессия ${session.id}: расхождение usage (сообщения ${ownFromMessages} токенов, ` +
          `computeSessionStats ${ownFromStats}) — суммы не правятся, истина: сообщения`,
      );
    }
  }

  // ── Второй источник: журнал LLM Gateway (ADR-036) ───────────────────────
  const auditGroups = new Map<string, AuditGroup>();
  let auditEntries = 0;
  if (opts.auditLogPath) {
    // `readAuditLog` по умолчанию отдаёт последние 100 записей — бэкфиллу нужен
    // весь журнал (лимит — верхняя граница, обрезающая не более чем ничего).
    const { entries } = await readAuditLog(opts.auditLogPath, {
      ...(from !== undefined ? { since: `${from}T00:00:00.000Z` } : {}),
      limit: Number.MAX_SAFE_INTEGER,
    });
    auditEntries = entries.length;

    for (const entry of entries) {
      const day = dayOf(entry.ts);
      if (!day || (from !== undefined && day < from)) continue;
      const input = isFiniteNumber(entry.tokensIn) ? entry.tokensIn : 0;
      const output = isFiniteNumber(entry.tokensOut) ? entry.tokensOut : 0;
      const usd = isFiniteNumber(entry.costUsd) ? entry.costUsd : 0;
      if (input === 0 && output === 0 && usd === 0) continue;

      const key = coverageKey(day, entry.userId, entry.model);
      const group = auditGroups.get(key) ?? {
        key,
        day,
        userId: entry.userId,
        model: entry.model,
        input: 0,
        output: 0,
        usd: 0,
      };
      group.input += input;
      group.output += output;
      group.usd += usd;
      auditGroups.set(key, group);
    }
  }

  let auditGaps = 0;
  for (const group of auditGroups.values()) {
    const cover = coverage.get(group.key) ?? { input: 0, output: 0, usd: 0 };
    // Детерминированное правило: добавляется только положительная разница по
    // каждому полю; отрицательная не вычитается (истина — сообщения).
    const gapInput = Math.max(0, group.input - cover.input);
    const gapOutput = Math.max(0, group.output - cover.output);
    const gapUsd = Math.max(0, group.usd - cover.usd);
    if (gapInput === 0 && gapOutput === 0 && gapUsd === 0) continue;
    auditGaps += 1;
    accumulator.add(
      'usage',
      group.day,
      { userId: group.userId, model: group.model },
      { input_tokens: gapInput, output_tokens: gapOutput },
      gapUsd > 0 ? { USD: gapUsd } : undefined,
    );
  }

  const rows = accumulator.buckets();
  const dryRun = opts.dryRun === true;
  if (!dryRun) {
    for (const bucket of rows) await opts.repo.set(bucket);
  }

  const days = [...new Set(rows.map((bucket) => bucket.day))].sort();
  return {
    from: from ?? days[0] ?? today,
    to: today,
    dryRun,
    days,
    buckets: rows.length,
    rows,
    sessions: sessions.length,
    messages,
    auditEntries,
    auditGaps,
    statsChecked,
    statsMismatched,
    warnings,
  };
}
