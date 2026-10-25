/**
 * ADR-101 (Pipeline Engine): движок прогона пайплайна.
 *
 * `PipelineEngine` — второй движок рядом с `ChatOrchestrator`: он **не**
 * знает про HTTP, сессии и очередь — только про порты слоя хранения
 * (ADR-096) и исполнителей шагов (ADR-101 §1). Шаг пайплайна — не сессия:
 * движок ведёт прогон по графу, применяет условия и маппинг входа и пишет
 * журнал.
 *
 * ## Цикл прогона
 *
 * ```text
 * run()  → опубликованная версия спецификации → запись прогона (run.started)
 *        → узел → исполнитель (ретраи, таймаут) → node.started/node.finished
 *        → переход (edge.taken) → … → выходы (run.finished)
 * ```
 *
 * ## Гейт (пауза прогона)
 *
 * Прогон может встать на паузу **на любом узле**: исполнитель возвращает
 * исход-гейт (`StepGateOutcome`) — либо вопрос human-шага (`kind: 'human'`),
 * либо эскалацию `ask`-политики permission-слоя (`kind: 'tool_approval'`,
 * ADR-101 §6). Движок сохраняет текущий узел, пишет в журнал `gate.awaiting`
 * (payload — данные гейта), ставит статус прогона `awaiting_human` и
 * **возвращает управление**.
 *
 * Продолжение — `resume(runId, {approved, output?, comment?})`: узел
 * исполняется заново, с решением оператора в контексте (`ctx.gateDecision`),
 * и цикл продолжается из результата этого вызова.
 *
 * ## Активный таймаут гейта
 *
 * Ожидание оператора ограничено `node.timeoutSec`: таймер живёт **в процессе**
 * ядра (`unref`), по истечении шаг проваливается с `pipeline.gate_timeout`, а
 * прогон продолжается по условиям перехода (или завершается).
 *
 * ## Отмена
 *
 * `AbortSignal` останавливает прогон: статус `cancelled`, в журнал —
 * `run.failed` с кодом `pipeline.cancelled`.
 */
import { generateId, nowISO } from '@itphx/synth-shared';
import { pipelineSpecSchema, validatePipelineSpec } from '@itphx/synth-shared';
import type { EventType, PipelineNode, PipelineRunEventType, PipelineSpec, StepResult } from '@itphx/synth-shared';

import { error as logError, info as logInfo, warning as logWarning } from '../../logger.js';
import type { PipelineRunRecord } from '../../storage/ports/index.js';
import { t } from '../system-messages.js';
import {
  gateDecisionResult,
  gateTimeoutResult,
  humanGate,
  startGateTimeout,
} from './gate.js';
import { resolveSpecVars, resolveStepInput } from './mapping.js';
import { sanitizeRecord, sanitizeTrigger } from './payload.js';
import { MAX_PIPELINE_TRANSITIONS, nextNodeId } from './planner.js';
import { buildPipelineStepContext, type PipelineStepContext } from './step-context.js';
import {
  PipelineEngineError,
  isStepGateOutcome,
  type PipelineEngineDeps,
  type PipelineEngineLogger,
  type PipelineEventPublisher,
  type PipelineExitContext,
  type PipelineExitHandler,
  type PipelineGate,
  type PipelineGateDecision,
  type PipelineRunOptions,
  type PipelineStepLlmRuntime,
  type StepExecutionContext,
  type StepExecutor,
  type StepOutcome,
} from './types.js';

/** Лог-группа движка пайплайнов. */
const LOG_GROUP = 'PIPELINE';

/** Префикс идентификатора прогона. */
const RUN_ID_PREFIX = 'prun_';

/** Состояние прогона внутри движка (не сохраняется целиком — только узлы). */
interface RunState {
  /** Запись прогона (заголовок журнала). */
  record: PipelineRunRecord;
  /** Снимок спецификации прогона. */
  spec: PipelineSpec;
  /** Результат последнего выполненного шага. */
  prev?: StepResult;
  /** Разрешённые переменные спецификации (пересчитываются после каждого шага). */
  vars: Record<string, unknown>;
  /** Счётчик переходов (защита от бесконечного цикла). */
  transitions: number;
}

/**
 * Активный гейт прогона — ожидание решения оператора в процессе.
 *
 * Нужен для двух вещей: активного таймаута (по истечении прогон продолжается
 * с провалом шага) и защиты от гонки «таймер сработал после `resume`» —
 * срабатывает только гейт с тем же токеном.
 */
interface PendingGate {
  /** Токен гейта (уникален в пределах движка). */
  token: string;
  /** Узел, на котором прогон ждёт решения. */
  nodeId: string;
  /** Номер попытки узла. */
  attempt: number;
  /** Состояние прогона на момент паузы (нужно для продолжения по таймауту). */
  state: RunState;
  /** Момент постановки на паузу (мс) — длительность ожидания человека. */
  waitStartedAt: number;
}

/**
 * Коды ошибок шага, по которым повторять шаг **нельзя**.
 *
 * Отказ по правам, отклонение гейта и истечение таймаута гейта — решения
 * человека/политики: повтор не изменит исход.
 */
const NON_RETRYABLE_ERROR_CODES = new Set<string>([
  'pipeline.executor_missing',
  'pipeline.cancelled',
  'pipeline.gate_rejected',
  'pipeline.gate_timeout',
  'permission.denied',
  // Э4.3: agent-шаг без LLM-контура/провайдера и невосполнимая ошибка LLM —
  // повтор не изменит исход.
  'pipeline.agent_unavailable',
  'pipeline.provider_not_found',
  'pipeline.llm_unrecoverable',
  // Э4.3b: исчерпан лимит итераций Tool-Use-цикла — модель зациклилась на
  // вызовах тулов; повтор узла повторит тот же цикл.
  'pipeline.agent_iterations',
]);

/**
 * Движок пайплайнов (ADR-101).
 *
 * Публичный API:
 * - `run(opts)` — запуск прогона по опубликованной версии спецификации;
 * - `resume(runId, decision)` — продолжение прогона после HITL-паузы.
 */
export class PipelineEngine {
  private readonly _pipelines: PipelineEngineDeps['pipelines'];
  private readonly _runs: PipelineEngineDeps['runs'];
  private readonly _executors: Map<PipelineNode['kind'], StepExecutor>;
  private readonly _exitHandlers: PipelineExitHandler[];
  private readonly _sleep: (ms: number) => Promise<void>;
  private readonly _logger: PipelineEngineLogger;
  /** Активные гейты прогонов (ожидание решения оператора). */
  private readonly _pendingGates = new Map<string, PendingGate>();
  /** Счётчик токенов гейтов (уникальность активного таймера). */
  private _gateSeq = 0;
  /** Зависимости сборки контекста шага (ADR-101 §10) — опциональные. */
  private readonly _stepContextDeps: PipelineEngineDeps;
  /** LLM-контур шага (ADR-101 §4) — прокидывается в контекст исполнения. */
  private readonly _llm: PipelineStepLlmRuntime | undefined;
  /** Шина инстансных событий (ADR-101 §2.12) — публикация `pipeline.run.*`. */
  private readonly _eventBus: PipelineEventPublisher | null;
  /** Метрики прогонов (ADR-094, `synth_pipeline_*`). */
  private readonly _metrics: PipelineEngineDeps['metrics'];

  constructor(deps: PipelineEngineDeps) {
    this._pipelines = deps.pipelines;
    this._runs = deps.runs;
    this._executors = new Map();
    for (const executor of deps.executors ?? []) {
      this._executors.set(executor.kind, executor);
    }
    this._exitHandlers = deps.exits ?? [];
    this._sleep = deps.sleep ?? defaultSleep;
    this._stepContextDeps = deps;
    this._eventBus = deps.eventBus ?? null;
    this._metrics = deps.metrics ?? null;
    // ADR-101 §4: LLM-контур шага собирается один раз (движок не знает, откуда
    // берётся провайдер — это забота точки сборки). Без композитора agent-шаги
    // падают с `pipeline.agent_unavailable`.
    this._llm = deps.composer
      ? {
          composer: deps.composer,
          resolveProvider: deps.resolveProvider ?? (() => null),
          ...(deps.resolveLlmDefaults ? { resolveLlmDefaults: deps.resolveLlmDefaults } : {}),
        }
      : undefined;
    this._logger = deps.logger ?? {
      info: (group, message) => logInfo(group, message),
      warning: (group, message) => logWarning(group, message),
      error: (group, message) => logError(group, message),
    };
  }

  /**
   * Контекст шага (ADR-101 §10): проект, рабочий каталог, режим, инструменты,
   * MCP-скоуп, инструкции и скиллы — всё, что нужно исполнителю шага.
   *
   * Исполнители видов шагов (Э4.2/Э4.3) получают контекст отсюда; шага без
   * проекта/рабочего каталога — не ошибка (контекст без проектной части).
   */
  async buildStepContext(ctx: StepExecutionContext): Promise<PipelineStepContext> {
    return buildPipelineStepContext(ctx, this._stepContextDeps);
  }

  /**
   * Запуск прогона пайплайна.
   *
   * Берётся **опубликованная** версия спецификации: указанная `version` или
   * последняя опубликованная. Опубликованной версии нет — ошибка
   * `pipeline.not_published`; спецификация невалидна — `pipeline.invalid_spec`.
   *
   * Возвращает запись прогона. Если прогон встал на HITL-паузу, запись имеет
   * статус `awaiting_human` (продолжение — `resume`).
   */
  async run(opts: PipelineRunOptions): Promise<PipelineRunRecord> {
    const spec = await this._loadPublishedSpec(opts.pipelineId, opts.version);
    const trigger = sanitizeTrigger(opts.trigger);
    const now = nowISO();
    const runId = `${RUN_ID_PREFIX}${generateId()}`;

    const record: PipelineRunRecord = {
      id: runId,
      pipelineId: opts.pipelineId,
      version: spec.version,
      // Снимок спецификации — прогон самодостаточен (ADR-101 §7).
      spec,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      status: 'running',
      currentNode: spec.nodes[0]?.id,
      trigger,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this._runs.saveRun(record);
    // ADR-101: «прогон стартовал» — сразу после сохранения записи и **до**
    // исполнения узлов. Вызывающий узнаёт id прогона, не дожидаясь конца.
    // Ошибка колбэка не должна ронять прогон — она логируется.
    if (opts.onStarted) {
      try {
        opts.onStarted(record);
      } catch (err) {
        this._logger.warning(
          LOG_GROUP,
          `прогон ${runId}: колбэк onStarted не удался: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this._appendEvent(runId, 'run.started', {
      pipelineId: opts.pipelineId,
      version: spec.version,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      triggerKind: trigger.kind,
      ...(trigger.source ? { source: trigger.source } : {}),
      ...(trigger.type ? { type: trigger.type } : {}),
    });

    // ADR-101 §2.12: прогон виден в шине (инстансный канал) — UI/наблюдаемость.
    this._publish('pipeline.run.started', {
      ...this._eventBase(record),
      triggerKind: trigger.kind,
    });
    try {
      this._metrics?.onRunStarted({ source: trigger.kind });
    } catch {
      // метрики не влияют на прогон
    }

    this._logger.info(LOG_GROUP, `прогон ${runId} запущен (пайплайн «${opts.pipelineId}»@${spec.version})`);

    const state: RunState = { record, spec, vars: {}, transitions: 0 };
    const signal = opts.signal ?? new AbortController().signal;
    return this._drive(state, signal, record.currentNode ?? null);
  }

  /**
   * Продолжение прогона после HITL-паузы.
   *
   * Прогон продолжается **с того узла, на котором он встал на паузу**:
   *
   * - одобрение гейта `tool_approval` — узел исполняется **заново**, но право
   *   на инструмент считается выданным (`ctx.gateDecision.approved`), поэтому
   *   permission-проверка не повторяется; цикл продолжается из результата
   *   вызова инструмента;
   * - одобрение гейта `human` — результат шага = выход гейта (`output`) и
   *   комментарий оператора;
   * - отклонение — результат шага `failed` с кодом `pipeline.gate_rejected`,
   *   дальше — обычный цикл (переход по условиям или завершение прогона).
   *
   * Таймаут ожидания проверяется по времени ожидания: детерминированно и
   * переживает рестарт процесса (активный таймер в процессе — дополнительно).
   */
  async resume(runId: string, decision: PipelineGateDecision): Promise<PipelineRunRecord> {
    const stored = await this._runs.getRun(runId);
    if (!stored) {
      throw new PipelineEngineError(
        'pipeline.run_not_found',
        t('pipeline.run_not_found', { id: runId }),
      );
    }
    if (stored.status !== 'awaiting_human') {
      throw new PipelineEngineError(
        'pipeline.invalid_state',
        t('pipeline.invalid_state', { id: runId, status: stored.status }),
      );
    }

    const spec = stored.spec;
    const nodeId = stored.currentNode;
    const node = spec.nodes.find((item) => item.id === nodeId);
    if (!node) {
      throw new PipelineEngineError(
        'pipeline.invalid_spec',
        t('pipeline.invalid_spec', { problems: `node «${nodeId ?? '?'}» is missing in the spec` }),
      );
    }

    const trigger = stored.trigger ?? { kind: 'manual' };
    const now = nowISO();

    // Таймаут ожидания человека проверяется по времени ожидания: детерминированно
    // и переживает рестарт процесса (активного таймера в движке нет).
    if (node.timeoutSec !== undefined) {
      const since = Date.parse(stored.updatedAt ?? stored.startedAt ?? '');
      if (!Number.isNaN(since) && Date.now() - since > node.timeoutSec * 1000) {
        const state: RunState = { record: { ...stored }, spec, vars: {}, transitions: 0 };
        this._logger.warning(
          LOG_GROUP,
          `прогон ${runId}: истекло время ожидания гейта «${node.id}» (${node.timeoutSec}c)`,
        );
        return this._finishFailed(
          state,
          'pipeline.gate_timeout',
          t('pipeline.gate_timeout', { node: node.id, timeoutSec: String(node.timeoutSec) }),
        );
      }
    }

    // Гейт закрыт решением оператора — активное ожидание снимается.
    const pending = this._pendingGates.get(runId);
    this._pendingGates.delete(runId);
    // ADR-094: длительность ожидания человека (от паузы до решения оператора).
    const waitStartedAt = pending?.waitStartedAt ?? Date.parse(stored.updatedAt ?? stored.startedAt ?? '');
    try {
      if (!Number.isNaN(waitStartedAt)) {
        this._metrics?.onHumanWaitFinished({ durationMs: Math.max(0, Date.now() - waitStartedAt) });
      }
    } catch {
      // метрики не влияют на прогон
    }

    const state: RunState = {
      record: { ...stored, status: 'running', updatedAt: now },
      spec,
      vars: {},
      transitions: await this._countTransitions(runId),
    };
    state.vars = resolveSpecVars(spec, { trigger });

    const executor = this._executors.get(node.kind);
    const signal = new AbortController().signal;

    if (!executor) {
      // Исполнителя нет — решение применяет сам движок (human-узел без
      // зарегистрированного исполнителя).
      const result = gateDecisionResult(decision, node, 1);
      await this._appendEvent(runId, 'node.started', { node: node.id, kind: node.kind, attempt: 1 });
      await this._appendEvent(runId, 'node.finished', {
        node: node.id,
        kind: node.kind,
        attempt: 1,
        status: result.status,
        durationMs: 0,
        ...(result.error ? { error: result.error } : {}),
        ...(decision.comment ? { comment: decision.comment } : {}),
      });
      this._publish('pipeline.run.node_started', {
        ...this._eventBase(state.record),
        node: node.id,
        nodeKind: node.kind,
        attempt: 1,
      });
      this._publish('pipeline.run.node_finished', {
        ...this._eventBase(state.record),
        node: node.id,
        nodeKind: node.kind,
        attempt: 1,
        status: result.status,
        durationMs: 0,
        ...(result.error?.code ? { errorCode: result.error.code } : {}),
      });
      try {
        this._metrics?.onStepFinished({ kind: node.kind, outcome: result.status, durationMs: 0 });
      } catch {
        // метрики не влияют на прогон
      }
      return this._continueAfterStep(state, node, result, signal);
    }

    // Узел исполняется заново — с решением оператора в контексте шага.
    const attempt = (await this._countNodeAttempts(runId, node.id)) + 1;
    const gateToken = this._nextGateToken();
    const outcome = await this._runStep(state, node, signal, {
      gateDecision: decision,
      startAttempt: attempt,
      gateToken,
      // Данные гейта (инструмент/аргументы) — из журнала прогона: решение
      // оператора применяется к тому же вызову (ADR-101 §6).
      gate: await this._lastGate(runId, node.id),
    });
    if (isStepGateOutcome(outcome)) {
      // Исполнитель запросил гейт снова — пауза продлевается.
      return this._pauseForGate(state, node, outcome.gate, gateToken);
    }
    return this._continueAfterStep(state, node, outcome, signal);
  }

  /**
   * Опубликованная версия спецификации (проверенная).
   *
   * `version` не задан — берётся последняя опубликованная версия пайплайна.
   * Публикации нет — `pipeline.not_published`; спецификация не проходит
   * структурную (`pipelineSpecSchema`) или семантическую (`validatePipelineSpec`)
   * проверку — `pipeline.invalid_spec`.
   */
  private async _loadPublishedSpec(pipelineId: string, version?: number): Promise<PipelineSpec> {
    const pipeline = await this._pipelines.getPipeline(pipelineId);
    if (!pipeline) {
      throw new PipelineEngineError('pipeline.not_found', t('pipeline.not_found', { id: pipelineId }));
    }
    const target = version ?? pipeline.publishedVersion;
    if (target === undefined) {
      throw new PipelineEngineError(
        'pipeline.not_published',
        t('pipeline.not_published', { id: pipelineId }),
      );
    }
    const record = await this._pipelines.getVersion(pipelineId, target);
    if (!record) {
      throw new PipelineEngineError(
        'pipeline.not_published',
        t('pipeline.not_published', { id: pipelineId }),
      );
    }

    const parsed = pipelineSpecSchema.safeParse(record.spec);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`)
        .join('; ');
      throw new PipelineEngineError(
        'pipeline.invalid_spec',
        t('pipeline.invalid_spec', { problems }),
      );
    }
    const validation = validatePipelineSpec(parsed.data);
    if (!validation.ok) {
      throw new PipelineEngineError(
        'pipeline.invalid_spec',
        t('pipeline.invalid_spec', { problems: validation.problems.join('; ') }),
      );
    }
    return parsed.data;
  }

  /**
   * Основной цикл прогона: узел → шаг → переход → … → выходы.
   *
   * Правила переходов — в `planner.ts`; при отсутствии перехода успешный шаг
   * завершает прогон (выходы), неуспешный — валит прогон. Исполнитель может
   * в любой момент **попросить паузу** (исход-гейт): прогон встаёт на
   * `awaiting_human`, а `resume()` продолжает его с того же узла.
   *
   * Переход к следующему узлу — в `_continueAfterStep` (он же продолжает цикл
   * рекурсивным вызовом `_drive`); глубина рекурсии ограничена лимитом
   * переходов прогона (`MAX_PIPELINE_TRANSITIONS`).
   */
  private async _drive(
    state: RunState,
    signal: AbortSignal,
    startNodeId: string | null,
  ): Promise<PipelineRunRecord> {
    const trigger = state.record.trigger ?? { kind: 'manual' };
    if (!startNodeId) return this._finishDone(state);
    if (signal.aborted) return this._finishCancelled(state);

    const node = state.spec.nodes.find((item) => item.id === startNodeId);
    if (!node) {
      return this._finishFailed(
        state,
        'pipeline.invalid_spec',
        t('pipeline.invalid_spec', { problems: `node «${startNodeId}» is missing in the spec` }),
      );
    }

    // HITL-гейт без зарегистрированного исполнителя: движок сам останавливает
    // прогон (обратная совместимость с Э3).
    if (node.kind === 'human' && !this._executors.has('human')) {
      return this._pauseForGate(state, node, humanGate(node), this._nextGateToken());
    }

    // Переменные для входа шага — по результату предыдущего шага.
    state.vars = resolveSpecVars(state.spec, { ...(state.prev ? { prev: state.prev } : {}), trigger });

    // Токен гейта узла: один на попытку — им же защищается активный таймер
    // (таймер закрытого гейта не должен провалить уже завершённый прогон).
    const gateToken = this._nextGateToken();
    const outcome = await this._runStep(state, node, signal, { gateToken });

    // Исполнитель запросил решение человека — прогон встаёт на паузу.
    if (isStepGateOutcome(outcome)) {
      return this._pauseForGate(state, node, outcome.gate, gateToken);
    }

    if (signal.aborted) return this._finishCancelled(state);

    return this._continueAfterStep(state, node, outcome, signal);
  }

  /**
   * Продолжение прогона после шага: результат → переменные → переход → узел.
   *
   * Переход и его ограничения — как в `planner.ts`; перехода нет при успешном
   * шаге — прогон завершается штатно (выходы), при провале — прогон падает.
   */
  private async _continueAfterStep(
    state: RunState,
    node: PipelineNode,
    result: StepResult,
    signal: AbortSignal,
  ): Promise<PipelineRunRecord> {
    const trigger = state.record.trigger ?? { kind: 'manual' };
    state.prev = result;
    state.record.status = 'running';
    state.record.currentNode = node.id;
    state.record.updatedAt = nowISO();

    // Переменные для условий перехода — по результату текущего шага.
    state.vars = resolveSpecVars(state.spec, { prev: result, trigger });
    await this._runs.saveRun(state.record);

    const next = nextNodeId(state.spec, {
      node,
      prev: result,
      trigger,
      vars: state.vars,
    });

    if (!next) {
      if (result.error?.code === 'pipeline.cancelled') return this._finishCancelled(state);
      if (result.status === 'failed') {
        const failure = runFailure(node, result);
        return this._finishFailed(state, failure.code, failure.message);
      }
      return this._finishDone(state);
    }

    state.transitions += 1;
    if (state.transitions > MAX_PIPELINE_TRANSITIONS) {
      this._logger.warning(
        LOG_GROUP,
        `прогон ${state.record.id}: превышен лимит переходов (${MAX_PIPELINE_TRANSITIONS})`,
      );
      return this._finishFailed(
        state,
        'pipeline.loop_limit',
        t('pipeline.loop_limit', { limit: String(MAX_PIPELINE_TRANSITIONS) }),
      );
    }

    await this._appendEvent(state.record.id, 'edge.taken', { from: node.id, to: next });
    state.record.currentNode = next;
    state.record.updatedAt = nowISO();
    await this._runs.saveRun(state.record);

    return this._drive(state, signal, next);
  }

  /**
   * Исполнение шага с ретраями.
   *
   * Попыток — `1 + node.retry.max`; между попытками пауза `node.retry.backoffSec`
   * (через инъектированный `sleep` — в тестах мгновенная). Ошибки
   * «нет исполнителя», «отмена», «отказ по правам» и «решение человека» не
   * повторяются. Исход-пауза (гейт) шаг не завершает — прогон встаёт на
   * ожидание решения оператора.
   */
  private async _runStep(
    state: RunState,
    node: PipelineNode,
    signal: AbortSignal,
    opts?: {
      gateDecision?: PipelineGateDecision;
      startAttempt?: number;
      gateToken?: string;
      gate?: PipelineGate;
    },
  ): Promise<StepOutcome> {
    const executor = this._executors.get(node.kind);
    const maxAttempts = 1 + Math.max(0, node.retry?.max ?? 0);
    let attempt = opts?.startAttempt !== undefined ? opts.startAttempt - 1 : 0;
    let outcome: StepOutcome | undefined;

    const baseCtx = await this._buildStepContext(state, node, opts?.gateDecision, opts?.gate);
    const gateToken = opts?.gateToken ?? this._nextGateToken();

    for (;;) {
      attempt += 1;

      await this._appendEvent(state.record.id, 'node.started', {
        node: node.id,
        kind: node.kind,
        attempt,
      });
      this._publish('pipeline.run.node_started', {
        ...this._eventBase(state.record),
        node: node.id,
        nodeKind: node.kind,
        attempt,
      });

      if (!executor) {
        const missing: StepResult = {
          status: 'failed',
          attempt,
          error: {
            code: 'pipeline.executor_missing',
            message: t('pipeline.executor_missing', { kind: node.kind }),
          },
        };
        await this._appendEvent(state.record.id, 'node.finished', {
          node: node.id,
          kind: node.kind,
          attempt,
          status: missing.status,
          ...(missing.error ? { error: missing.error } : {}),
        });
        this._publish('pipeline.run.node_finished', {
          ...this._eventBase(state.record),
          node: node.id,
          nodeKind: node.kind,
          attempt,
          status: missing.status,
          errorCode: missing.error?.code,
        });
        try {
          this._metrics?.onStepFinished({ kind: node.kind, outcome: missing.status, durationMs: 0 });
        } catch {
          // метрики не влияют на прогон
        }
        return missing;
      }

      outcome = await this._invoke(baseCtx, node, executor, attempt, signal, gateToken);

      // Пауза: шаг не завершён, журналить `node.finished` нечего.
      if (isStepGateOutcome(outcome)) return outcome;

      await this._appendEvent(state.record.id, 'node.finished', {
        node: node.id,
        kind: node.kind,
        attempt,
        status: outcome.status,
        ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      this._publish('pipeline.run.node_finished', {
        ...this._eventBase(state.record),
        node: node.id,
        nodeKind: node.kind,
        attempt,
        status: outcome.status,
        ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
        // Только машинночитаемый код ошибки — текст ошибки живёт в журнале.
        ...(outcome.error?.code ? { errorCode: outcome.error.code } : {}),
      });
      try {
        this._metrics?.onStepFinished({
          kind: node.kind,
          outcome: outcome.status,
          durationMs: outcome.durationMs ?? 0,
        });
      } catch {
        // метрики не влияют на прогон
      }

      const retryable =
        outcome.status === 'failed' &&
        !NON_RETRYABLE_ERROR_CODES.has(outcome.error?.code ?? '');
      if (!retryable || attempt >= maxAttempts) return outcome;

      const backoffSec = node.retry?.backoffSec;
      if (backoffSec) await this._sleep(backoffSec * 1000);
      if (signal.aborted) break;
    }

    return outcome as StepOutcome;
  }

  /**
   * Базовый контекст шага: прогон, узел, маппинг входа, режим — плюс
   * **контекст шага** (ADR-101 §10): проект, рабочий каталог, тулы, MCP-скоуп.
   *
   * Собирается один раз на узел (не на попытку): исполнителям нужен один и тот
   * же набор инструментов и окружение.
   */
  private async _buildStepContext(
    state: RunState,
    node: PipelineNode,
    gateDecision?: PipelineGateDecision,
    gate?: PipelineGate,
  ): Promise<StepExecutionContext> {
    const trigger = state.record.trigger ?? { kind: 'manual' };
    const ctx: StepExecutionContext = {
      runId: state.record.id,
      pipelineId: state.record.pipelineId,
      version: state.record.version,
      node,
      spec: state.spec,
      ...(state.record.projectId ? { projectId: state.record.projectId } : {}),
      trigger,
      input: resolveStepInput(node, {
        ...(state.prev ? { prev: state.prev } : {}),
        trigger,
        vars: state.vars,
      }),
      vars: state.vars,
      ...(state.prev ? { prev: state.prev } : {}),
      signal: new AbortController().signal,
      attempt: 1,
      mode: state.spec.mode,
      ...(gateDecision ? { gateDecision } : {}),
      ...(gate ? { gate } : {}),
    };

    const withLlm = this._llm ? { llm: this._llm } : {};
    try {
      const step = await buildPipelineStepContext(ctx, this._stepContextDeps);
      return { ...ctx, step, ...withLlm };
    } catch {
      // Контекст шага — вспомогательный: его отсутствие не роняет шаг.
      return { ...ctx, ...withLlm };
    }
  }

  /**
   * Вызов исполнителя шага: таймаут, отмена, приведение исключения к
   * `StepResult{status:'failed'}` (наружу исключение не выходит).
   *
   * Исход может быть гейтом (`StepGateOutcome`) — тогда шаг не завершён, а
   * прогон встаёт на ожидание решения оператора.
   */
  private async _invoke(
    baseCtx: StepExecutionContext,
    node: PipelineNode,
    executor: StepExecutor,
    attempt: number,
    signal: AbortSignal,
    gateToken: string,
  ): Promise<StepOutcome> {
    const startedAt = nowISO();
    const startMs = Date.now();
    const controller = new AbortController();
    const abort = (reason: Error): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onAbort = (): void => abort(new Error('pipeline cancelled'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const ctx: StepExecutionContext = {
      ...baseCtx,
      signal: controller.signal,
      attempt,
      // Активный таймаут гейта: исполнитель сообщает движку о готовом провале
      // шага, движок продолжает прогон по условиям перехода.
      onGateTimeout: (_gate, result) => {
        void this._onGateTimeout(baseCtx.runId, gateToken, result);
      },
    };

    const timeoutMs = node.timeoutSec ? node.timeoutSec * 1000 : 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      const execution = executor.execute(ctx);
      // Гонка с таймаутом: результат «проигравшего» промиса не должен стать
      // необработанным отказом.
      execution.catch(() => undefined);

      let result: StepOutcome;
      if (timeoutMs > 0) {
        const guard = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            abort(new Error('pipeline step timeout'));
            reject(
              new PipelineEngineError(
                'pipeline.step_timeout',
                t('pipeline.step_timeout', {
                  node: node.id,
                  timeoutSec: String(node.timeoutSec),
                }),
              ),
            );
          }, timeoutMs);
        });
        result = await Promise.race([execution, guard]);
      } else {
        result = await execution;
      }
      if (isStepGateOutcome(result)) return result;
      return normalizeResult(result, node.id, attempt, startedAt, startMs);
    } catch (err) {
      if (timedOut) {
        return {
          status: 'failed',
          attempt,
          error: {
            code: 'pipeline.step_timeout',
            message: t('pipeline.step_timeout', {
              node: node.id,
              timeoutSec: String(node.timeoutSec),
            }),
          },
          startedAt,
          finishedAt: nowISO(),
          durationMs: Date.now() - startMs,
        };
      }
      if (signal.aborted) {
        return {
          status: 'failed',
          attempt,
          error: { code: 'pipeline.cancelled', message: t('pipeline.cancelled') },
          startedAt,
          finishedAt: nowISO(),
          durationMs: Date.now() - startMs,
        };
      }
      const detail = err instanceof Error ? err.message : String(err);
      this._logger.warning(LOG_GROUP, `шаг «${node.id}» провалился: ${detail}`);
      return {
        status: 'failed',
        attempt,
        error: {
          code: 'pipeline.step_failed',
          message: t('pipeline.step_failed', { node: node.id, error: detail }),
        },
        startedAt,
        finishedAt: nowISO(),
        durationMs: Date.now() - startMs,
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Пауза прогона на гейте: узел сохраняется в записи прогона, в журнал
   * пишется `gate.awaiting` (payload — данные гейта), статус прогона —
   * `awaiting_human`, управление возвращается вызывающему.
   *
   * Данные гейта живут **в журнале** (append-only) — контракт записи прогона
   * не меняется и миграция схемы не нужна: при `resume` движок читает
   * последнее событие `gate.awaiting`.
   */
  private async _pauseForGate(
    state: RunState,
    node: PipelineNode,
    gate: PipelineGate,
    gateToken: string,
  ): Promise<PipelineRunRecord> {
    state.record.status = 'awaiting_human';
    state.record.currentNode = node.id;
    state.record.updatedAt = nowISO();
    await this._runs.saveRun(state.record);
    await this._appendEvent(state.record.id, 'gate.awaiting', {
      node: node.id,
      kind: gate.kind,
      ...(gate.toolName ? { toolName: gate.toolName } : {}),
      ...(gate.args ? { args: gate.args } : {}),
      ...(gate.question ? { question: gate.question } : {}),
      ...(gate.title ? { title: gate.title } : {}),
      ...(gate.timeoutSec !== undefined ? { timeoutSec: gate.timeoutSec } : {}),
      ...(gate.reason ? { reason: gate.reason } : {}),
    });

    this._pendingGates.set(state.record.id, {
      token: gateToken,
      nodeId: node.id,
      attempt: 1,
      state,
      waitStartedAt: Date.now(),
    });

    // ADR-101 §2.12: прогон встал на ожидание решения человека — событие шины
    // и счётчик ожиданий (без вопроса и аргументов инструмента: они живут в
    // журнале прогона).
    this._publish('pipeline.run.awaiting_human', {
      ...this._eventBase(state.record),
      node: node.id,
      gateKind: gate.kind,
      ...(gate.timeoutSec !== undefined ? { timeoutSec: gate.timeoutSec } : {}),
    });
    try {
      this._metrics?.onHumanWaitStarted({ kind: gate.kind });
    } catch {
      // метрики не влияют на прогон
    }

    // Активный таймаут гейта: таймер в процессе (`unref`). Исполнитель human-шага
    // заводит свой таймер (шаг сам знает про таймаут) — первым сработавший
    // продолжает прогон, второй игнорируется (проверка по токену гейта).
    if (gate.timeoutSec !== undefined && gate.timeoutSec > 0) {
      startGateTimeout(gate.timeoutSec, () => {
        void this._onGateTimeout(state.record.id, gateToken, gateTimeoutResult(node, 1));
      });
    }

    this._logger.info(
      LOG_GROUP,
      `прогон ${state.record.id}: ожидание человека на узле «${node.id}» (гейт «${gate.kind}»)`,
    );
    return state.record;
  }

  /**
   * Истечение активного таймаута гейта: шаг проваливается с
   * `pipeline.gate_timeout`, прогон продолжается по условиям перехода (или
   * завершается, если перехода нет).
   *
   * Срабатывает только для того гейта, который активен сейчас: таймер,
   * оставшийся от закрытого гейта, игнорируется (по токену).
   */
  private async _onGateTimeout(
    runId: string,
    token: string,
    result: StepResult,
  ): Promise<void> {
    const pending = this._pendingGates.get(runId);
    if (!pending || pending.token !== token) return;
    this._pendingGates.delete(runId);

    const node = pending.state.spec.nodes.find((item) => item.id === pending.nodeId);
    if (!node) return;

    this._logger.warning(
      LOG_GROUP,
      `прогон ${runId}: истекло время ожидания гейта «${node.id}»`,
    );
    await this._continueAfterStep(pending.state, node, result, new AbortController().signal);
  }

  /** Токен активного гейта (уникален в пределах движка). */
  private _nextGateToken(): string {
    this._gateSeq += 1;
    return `gate_${this._gateSeq}`;
  }

  /** Штатное завершение прогона: выходы пайплайна фиксируются в журнале. */
  private async _finishDone(state: RunState): Promise<PipelineRunRecord> {
    const trigger = state.record.trigger ?? { kind: 'manual' };
    const output = state.prev?.output ?? {};
    const applied: Record<string, unknown>[] = [];

    for (const exit of state.spec.exits ?? []) {
      const ctx: PipelineExitContext = {
        runId: state.record.id,
        pipelineId: state.record.pipelineId,
        version: state.record.version,
        ...(state.record.projectId ? { projectId: state.record.projectId } : {}),
        exit,
        spec: state.spec,
        trigger,
        output,
        vars: state.vars,
      };
      // Сбой обработчика выхода не роняет прогон, но **фиксируется в результате
      // выхода** (журнал прогона, `run.finished.exits[i].error`) — иначе отказ
      // выхода (например, containment файла) был бы виден только в логе.
      let failure: { code: string; message: string } | undefined;
      for (const handler of this._exitHandlers) {
        try {
          await handler.handle(ctx);
        } catch (err) {
          failure = {
            code: 'pipeline.exit_failed',
            message: err instanceof Error ? err.message : String(err),
          };
          this._logger.error(
            LOG_GROUP,
            `обработчик выхода пайплайна завершился ошибкой: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const record = sanitizeRecord(exit as unknown as Record<string, unknown>) ?? { kind: exit.kind };
      applied.push(
        sanitizeRecord(failure ? { ...record, error: failure } : record) ?? { kind: exit.kind },
      );
    }

    const now = nowISO();
    state.record.status = 'done';
    state.record.finishedAt = now;
    state.record.updatedAt = now;
    const durationMs = this._runDurationMs(state.record);
    await this._runs.saveRun(state.record);
    await this._appendEvent(state.record.id, 'run.finished', {
      status: 'done',
      exits: applied,
      ...(sanitizeRecord(output) ? { output: sanitizeRecord(output) } : {}),
    });
    this._publish('pipeline.run.finished', {
      ...this._eventBase(state.record),
      status: 'done',
      exits: applied.length,
      durationMs,
    });
    try {
      this._metrics?.onRunFinished({ status: 'done', durationMs });
    } catch {
      // метрики не влияют на прогон
    }
    this._logger.info(LOG_GROUP, `прогон ${state.record.id} завершён (выходов: ${applied.length})`);
    return state.record;
  }

  /** Провал прогона: статус `failed` + событие `run.failed`. */
  private async _finishFailed(
    state: RunState,
    code: PipelineEngineError['code'],
    message: string,
  ): Promise<PipelineRunRecord> {
    const now = nowISO();
    state.record.status = 'failed';
    state.record.error = message;
    state.record.finishedAt = now;
    state.record.updatedAt = now;
    const durationMs = this._runDurationMs(state.record);
    await this._runs.saveRun(state.record);
    await this._appendEvent(state.record.id, 'run.failed', {
      code,
      error: message,
      ...(state.record.currentNode ? { node: state.record.currentNode } : {}),
    });
    this._publish('pipeline.run.failed', {
      ...this._eventBase(state.record),
      status: 'failed',
      code,
      durationMs,
      ...(state.record.currentNode ? { node: state.record.currentNode } : {}),
    });
    try {
      this._metrics?.onRunFinished({ status: 'failed', durationMs });
    } catch {
      // метрики не влияют на прогон
    }
    this._logger.warning(LOG_GROUP, `прогон ${state.record.id} провалился (${code})`);
    return state.record;
  }

  /** Отмена прогона: статус `cancelled` + событие `run.failed` с причиной. */
  private async _finishCancelled(state: RunState): Promise<PipelineRunRecord> {
    const message = t('pipeline.cancelled');
    const now = nowISO();
    state.record.status = 'cancelled';
    state.record.error = message;
    state.record.finishedAt = now;
    state.record.updatedAt = now;
    const durationMs = this._runDurationMs(state.record);
    await this._runs.saveRun(state.record);
    await this._appendEvent(state.record.id, 'run.failed', {
      code: 'pipeline.cancelled',
      error: message,
      ...(state.record.currentNode ? { node: state.record.currentNode } : {}),
    });
    this._publish('pipeline.run.failed', {
      ...this._eventBase(state.record),
      status: 'cancelled',
      code: 'pipeline.cancelled',
      durationMs,
      ...(state.record.currentNode ? { node: state.record.currentNode } : {}),
    });
    try {
      this._metrics?.onRunFinished({ status: 'cancelled', durationMs });
    } catch {
      // метрики не влияют на прогон
    }
    this._logger.warning(LOG_GROUP, `прогон ${state.record.id} отменён`);
    return state.record;
  }

  /** Запись события в журнал прогона (append-only, payload — санитизированный). */
  private async _appendEvent(
    runId: string,
    type: PipelineRunEventType,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const sanitized = payload ? sanitizeRecord(payload) : undefined;
    await this._runs.appendEvent({
      runId,
      ts: nowISO(),
      type,
      ...(sanitized ? { payload: sanitized } : {}),
    });
  }

  /**
   * Публикация инстансного события прогона в существующую шину
   * (ADR-101 §2.12, ADR-024/ADR-089) — **новых каналов нет**.
   *
   * Полезная нагрузка: id прогона, id пайплайна, версия, id узла, статус и
   * вид триггера. Секреты, payload прогонов и сырые пути сюда не попадают.
   * Ошибка публикации не влияет на прогон.
   */
  private _publish(type: EventType, data: Record<string, unknown>): void {
    if (!this._eventBus) return;
    try {
      this._eventBus.publishInstance(type, data);
    } catch (err) {
      this._logger.warning(
        LOG_GROUP,
        `не удалось опубликовать событие «${type}»: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Базовая часть полезной нагрузки события прогона (без секретов). */
  private _eventBase(record: PipelineRunRecord): Record<string, unknown> {
    return {
      runId: record.id,
      pipelineId: record.pipelineId,
      version: record.version,
      ...(record.projectId ? { projectId: record.projectId } : {}),
    };
  }

  /** Длительность прогона в миллисекундах (по времени старта записи прогона). */
  private _runDurationMs(record: PipelineRunRecord): number {
    const started = Date.parse(record.startedAt ?? record.createdAt ?? '');
    if (Number.isNaN(started)) return 0;
    return Math.max(0, Date.now() - started);
  }

  /** Счётчик переходов прогона (по журналу — переживает паузу и рестарт). */
  private async _countTransitions(runId: string): Promise<number> {
    const events = await this._runs.listEvents(runId);
    return events.filter((event) => event.type === 'edge.taken').length;
  }

  /**
   * Число попыток узла (по журналу) — нумерация попыток продолжается после
   * паузы и переживает рестарт процесса.
   */
  private async _countNodeAttempts(runId: string, nodeId: string): Promise<number> {
    const events = await this._runs.listEvents(runId);
    return events.filter(
      (event) => event.type === 'node.started' && event.payload?.node === nodeId,
    ).length;
  }

  /**
   * Данные последнего гейта узла (по журналу) — что именно прогон ждал.
   *
   * Читаются из события `gate.awaiting`: переживают перезапуск процесса и
   * дают исполнителю понять, к какому вызову относится решение оператора
   * (инструмент + аргументы). Данные журнала **санитизированы** (ADR-101
   * §2.9) — секреты в них вырезаны.
   */
  private async _lastGate(runId: string, nodeId: string): Promise<PipelineGate | undefined> {
    const events = await this._runs.listEvents(runId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.type !== 'gate.awaiting') continue;
      const payload = event.payload ?? {};
      if (payload.node !== nodeId) continue;
      const kind = payload.kind === 'human' ? 'human' : 'tool_approval';
      return {
        kind,
        nodeId,
        ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {}),
        ...(isPlainRecord(payload.args) ? { args: payload.args } : {}),
        ...(typeof payload.question === 'string' ? { question: payload.question } : {}),
        ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
        ...(typeof payload.timeoutSec === 'number' ? { timeoutSec: payload.timeoutSec } : {}),
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      };
    }
    return undefined;
  }
}

/** Обычный объект (не массив и не `null`). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Ошибка уровня прогона по провалу шага.
 *
 * Код шага может быть произвольным (исполнитель сообщает свой код) — на
 * уровне прогона используются только коды движка: «нет исполнителя»,
 * «таймаут шага», «отмена» и общий «шаг провалился». Решения человека и
 * политики прав сохраняют свой код: отказ по правам (`permission.denied`),
 * отклонение гейта (`pipeline.gate_rejected`) и истечение таймаута гейта
 * (`pipeline.gate_timeout`) — по ним понятно, **почему** прогон встал.
 */
function runFailure(
  node: PipelineNode,
  result: StepResult,
): { code: PipelineEngineError['code']; message: string } {
  const code = result.error?.code;
  const detail = result.error?.message ?? '';
  if (code === 'pipeline.executor_missing') {
    return { code, message: detail || t('pipeline.executor_missing', { kind: node.kind }) };
  }
  if (code === 'pipeline.step_timeout') {
    return {
      code,
      message:
        detail ||
        t('pipeline.step_timeout', { node: node.id, timeoutSec: String(node.timeoutSec ?? '') }),
    };
  }
  if (
    code === 'pipeline.gate_timeout' ||
    code === 'pipeline.gate_rejected' ||
    code === 'permission.denied'
  ) {
    return { code, message: detail || t('pipeline.step_failed', { node: node.id, error: code }) };
  }
  return {
    code: 'pipeline.step_failed',
    message: t('pipeline.step_failed', { node: node.id, error: detail }),
  };
}

/**
 * Приведение результата исполнителя к `StepResult`: попытка, тайминги и
 * допустимый статус. Неизвестный статус трактуется как провал шага.
 */
function normalizeResult(
  result: StepResult | undefined,
  nodeId: string,
  attempt: number,
  startedAt: string,
  startMs: number,
): StepResult {
  const finishedAt = nowISO();
  const durationMs = Date.now() - startMs;
  const status = result?.status;
  if (
    !result ||
    (status !== 'ok' && status !== 'failed' && status !== 'skipped' && status !== 'awaiting_human')
  ) {
    return {
      status: 'failed',
      attempt,
      error: {
        code: 'pipeline.step_failed',
        message: t('pipeline.step_failed', {
          node: nodeId,
          error: `unexpected step status: ${String(status)}`,
        }),
      },
      startedAt,
      finishedAt,
      durationMs,
    };
  }
  return {
    ...result,
    status,
    attempt,
    startedAt: result.startedAt ?? startedAt,
    finishedAt: result.finishedAt ?? finishedAt,
    durationMs: result.durationMs ?? durationMs,
  };
}

/** Пауза по умолчанию (в тестах инъектируется мгновенная). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
