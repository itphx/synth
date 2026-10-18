/**
 * PROP-102 (волна 1): сборщики пред-агрегированных суточных роллапов аналитики.
 *
 * `AnalyticsRecorder` — тонкий слой над портом `AnalyticsRollupRepository`
 * (ADR-096, инвариант 2): инкремент бакета по ключу `(family, day, dimensions)`.
 * Единица роллапа — **сутки UTC** (`YYYY-MM-DD`, `utcDay`). Пишутся только
 * сырые счётчики и разбивка стоимости по валютам — дериваты считает сервис на
 * чтении (PROP-102 §2).
 *
 * Запись **best-effort и никогда не ломает основной поток**: ошибки порта
 * логируются `warn`-ом и не пробрасываются; отсутствие репозитория — no-op
 * (memory-тесты, деградированный режим, инстансы без аналитики).
 *
 * Семейство `prompt` отдельной записи не требует — это проекция `usage` на
 * чтении; отдельный метод есть только у `usage`/`activity`/`decision`.
 */

import type { TokenUsage } from '@itphx/synth-shared';
import { ANALYTICS_MEASURES_BY_FAMILY, MessageRole } from '@itphx/synth-shared';
import type { AnalyticsRollupRepository } from '../storage/ports/index.js';
import { utcDay } from './service.js';

/** Имя меры семейства `usage` (snake_case, как в `sessions/stats.ts`). */
export type UsageMeasure = (typeof ANALYTICS_MEASURES_BY_FAMILY)['usage'][number];
/** Имя меры семейства `activity`. */
export type ActivityMeasure = (typeof ANALYTICS_MEASURES_BY_FAMILY)['activity'][number];
/** Имя меры семейства `decision` (ADR-084). */
export type DecisionMeasure = (typeof ANALYTICS_MEASURES_BY_FAMILY)['decision'][number];

/** Оси атрибуции роллапа (короткие ключи `AnalyticsDimension`). */
export interface AnalyticsAxes {
  /** Ось `user` (владелец/пользователь сессии). */
  userId?: string;
  /** Ось `project`. */
  projectId?: string;
  /** Ось `model` (модель, ответившая в ходе). */
  model?: string;
  /** Ось `agent` (`agentRole`, ответивший в ходе). */
  agent?: string;
  /** Ось `provider`. */
  provider?: string;
}

/** Вход сборщика `usage`: токены/стоимость хода по осям. */
export interface UsageRollupInput extends AnalyticsAxes {
  /** Usage хода/сообщения (провайдерский токен-контракт). */
  usage?: TokenUsage;
  /**
   * Число LLM-запросов хода: собственный ответ (1) + сессии сабагентов,
   * учтённые в `metadata.subagents.sessions`.
   */
  requests?: number;
  /** Число сохранённых assistant-сообщений хода (обычно 1). */
  messages?: number;
  /** Длительность хода, мс (метаданные `duration_ms`). */
  durationMs?: number;
  /** Стоимость хода: валюта → сумма (сливается суммированием). */
  costByCurrency?: Record<string, number>;
}

/** Вход сборщика `activity`: одна мера по осям `user`/`project`. */
export interface ActivityRollupInput extends Pick<AnalyticsAxes, 'userId' | 'projectId'> {
  /** Величина инкремента (по умолчанию 1). */
  value?: number;
  /** Момент события; по умолчанию — текущее время. */
  at?: Date;
}

/** Минимальный срез итога decision-каскада для персистентных метрик. */
export interface DecisionRollupAttempt {
  /** Тир каскада (`primary`/`escalation`). */
  tier: 'primary' | 'escalation';
  /** Провайдер тира (ось `provider`). */
  providerName: string;
  /** Модель тира (ось `model`). */
  modelName: string;
  /** Статус попытки (`ok`/`low_confidence`/`invalid`/`no_answer`/`no_provider`/`error`). */
  status: string;
}

/** Вход сборщика `decision` — итог одного прогона каскада (ADR-084). */
export interface DecisionRollupInput {
  /** Каскад принял решение. */
  accepted: boolean;
  /** Тир, принявший решение (при `accepted`). */
  tier?: 'primary' | 'escalation';
  /** Все опрошенные попытки (в порядке каскада). */
  attempts: DecisionRollupAttempt[];
  /** Момент события; по умолчанию — текущее время. */
  at?: Date;
}

export interface AnalyticsRecorderOptions {
  /**
   * Порт роллапов; `undefined`/`null` — рекордер выключен (no-op). Так
   * отключается запись в деградированном режиме и в тестах без аналитики.
   */
  repo?: AnalyticsRollupRepository | null;
  /** Источник текущего времени (тесты); по умолчанию `new Date()`. */
  now?: () => Date;
}

/** Число конечно и пригодно к инкременту. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Оставить только непустые строковые значения осей. Экспортируется для
 * бэкфилла (`analytics/rebuild.ts`) — та же сборка ключа, что у записи.
 */
export function buildDimensions(axes: AnalyticsAxes): Record<string, string> {
  const dimensions: Record<string, string> = {};
  if (axes.userId) dimensions.user = axes.userId;
  if (axes.projectId) dimensions.project = axes.projectId;
  if (axes.model) dimensions.model = axes.model;
  if (axes.agent) dimensions.agent = axes.agent;
  if (axes.provider) dimensions.provider = axes.provider;
  return dimensions;
}

/** Добавить меру, если она конечна и ненулевая (нулевой инкремент бессмыслен). */
function addMeasure(measures: Record<string, number>, name: string, value: number | undefined): void {
  if (isFiniteNumber(value) && value !== 0) measures[name] = value;
}

/** Добавить разбивку стоимости, если она конечна и ненулевая. */
function addCosts(target: Record<string, number>, cost: Record<string, number> | undefined): void {
  if (!cost) return;
  for (const [currency, value] of Object.entries(cost)) {
    if (isFiniteNumber(value) && value !== 0) target[currency] = (target[currency] ?? 0) + value;
  }
}

/**
 * Нормализовать usage в меры snake_case (только ненулевые). Экспортируется для
 * бэкфилла (`analytics/rebuild.ts`), чтобы не дублировать маппинг контракта.
 */
export function usageMeasures(usage: TokenUsage | undefined): Record<string, number> {
  const measures: Record<string, number> = {};
  if (!usage) return measures;
  addMeasure(measures, 'input_tokens', usage.inputTokens);
  addMeasure(measures, 'output_tokens', usage.outputTokens);
  addMeasure(measures, 'cache_read_tokens', usage.cacheReadTokens);
  addMeasure(measures, 'cache_write_tokens', usage.cacheWriteTokens);
  addMeasure(measures, 'reasoning_tokens', usage.reasoningTokens);
  return measures;
}

/**
 * Сборщик суточных роллапов (PROP-102 §2–3). Все методы идемпотентны по
 * семантике порта (`increment` — upsert с суммированием), безопасны при
 * ошибках хранилища и возвращают `Promise<void>` без reject.
 */
export class AnalyticsRecorder {
  private readonly _repo: AnalyticsRollupRepository | null;
  private readonly _now: () => Date;

  constructor(opts: AnalyticsRecorderOptions = {}) {
    this._repo = opts.repo ?? null;
    this._now = opts.now ?? (() => new Date());
  }

  /** Запись включена (есть порт). */
  get enabled(): boolean {
    return this._repo !== null;
  }

  /** Инкрементировать `usage` за сутки (UTC): токены, запросы, сообщения, стоимость. */
  async recordUsage(input: UsageRollupInput): Promise<void> {
    const measures = usageMeasures(input.usage);
    addMeasure(measures, 'requests', input.requests);
    addMeasure(measures, 'messages', input.messages);
    addMeasure(measures, 'duration_ms', input.durationMs);
    const costByCurrency: Record<string, number> = {};
    addCosts(costByCurrency, input.costByCurrency);
    if (Object.keys(measures).length === 0 && Object.keys(costByCurrency).length === 0) return;
    await this._increment('usage', input, measures, costByCurrency);
  }

  /** Инкрементировать одну меру `activity` по осям `user`/`project`. */
  async recordActivity(measure: ActivityMeasure, input: ActivityRollupInput = {}): Promise<void> {
    const value = input.value ?? 1;
    if (!Number.isFinite(value) || value === 0) return;
    await this._increment(
      'activity',
      { userId: input.userId, projectId: input.projectId },
      { [measure]: value },
      {},
      input.at,
    );
  }

  /**
   * Персистентные decision-метрики (ADR-084): зеркало счётчиков in-memory
   * `decisionMetrics` по осям `provider`/`model`. На каждую попытку —
   * `attempts` и `rejected` (для неуспешных статусов); `calls` — на первую
   * попытку каскада; `handled`/`escalated` — на принявшую попытку;
   * `fallback` — на последнюю попытку отказавшего каскада.
   */
  async recordDecision(input: DecisionRollupInput): Promise<void> {
    const attempts = input.attempts ?? [];
    if (attempts.length === 0) {
      // Каскад без попыток (напр. нет тиров) — вызов всё равно был.
      await this._increment(
        'decision',
        {},
        { calls: 1, ...(input.accepted ? { handled: 1 } : { fallback: 1 }) },
        {},
        input.at,
      );
      return;
    }

    const groups = new Map<
      string,
      { provider: string; model: string; measures: Record<string, number> }
    >();
    const group = (provider: string, model: string) => {
      const key = `${provider}\u0000${model}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { provider, model, measures: {} };
        groups.set(key, entry);
      }
      return entry;
    };

    attempts.forEach((attempt, index) => {
      const entry = group(attempt.providerName, attempt.modelName);
      entry.measures.attempts = (entry.measures.attempts ?? 0) + 1;
      if (attempt.status !== 'ok') {
        entry.measures.rejected = (entry.measures.rejected ?? 0) + 1;
      }
      if (index === 0) entry.measures.calls = (entry.measures.calls ?? 0) + 1;
    });

    const last = attempts[attempts.length - 1]!;
    const lastEntry = group(last.providerName, last.modelName);
    if (input.accepted) {
      lastEntry.measures.handled = (lastEntry.measures.handled ?? 0) + 1;
      if (input.tier === 'escalation' || (input.tier === undefined && last.tier === 'escalation')) {
        lastEntry.measures.escalated = (lastEntry.measures.escalated ?? 0) + 1;
      }
    } else {
      lastEntry.measures.fallback = (lastEntry.measures.fallback ?? 0) + 1;
    }

    await Promise.all(
      [...groups.values()].map((entry) =>
        this._increment(
          'decision',
          { provider: entry.provider, model: entry.model },
          entry.measures,
          {},
          input.at,
        ),
      ),
    );
  }

  /** Один best-effort инкремент бакета: ошибки порта не пробрасываются. */
  private async _increment(
    family: 'usage' | 'activity' | 'decision',
    axes: AnalyticsAxes,
    measures: Record<string, number>,
    costByCurrency: Record<string, number>,
    at?: Date,
  ): Promise<void> {
    const repo = this._repo;
    if (!repo) return;
    if (Object.keys(measures).length === 0 && Object.keys(costByCurrency).length === 0) return;

    const day = utcDay(at ?? this._now());
    try {
      await repo.increment({
        family,
        day,
        dimensions: buildDimensions(axes),
        measures,
        ...(Object.keys(costByCurrency).length > 0 ? { costByCurrency } : {}),
      });
    } catch (err) {
      console.warn(
        `[AnalyticsRecorder] не удалось записать роллап ${family}/${day}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Мера `activity` по роли персистируемого сообщения (`null` — не считаем). */
export function activityMeasureForMessage(role: MessageRole | string): ActivityMeasure | null {
  switch (role) {
    case MessageRole.ASSISTANT:
      return 'messages_assistant';
    case MessageRole.TOOL:
      return 'messages_tool';
    default:
      // Пользовательские сообщения персистятся очередью (`QueueProcessor`) —
      // отдельная точка записи, чтобы не зависеть от пути (API/внешнее событие).
      return null;
  }
}

/** Оси `user`/`project` из сессии (`undefined` вместо пустых строк). */
export function sessionAxes(session: { userId?: string; projectId?: string } | null): {
  userId?: string;
  projectId?: string;
} {
  if (!session) return {};
  return {
    ...(session.userId ? { userId: session.userId } : {}),
    ...(session.projectId ? { projectId: session.projectId } : {}),
  };
}
