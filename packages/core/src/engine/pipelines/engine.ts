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
 * ## HITL-гейт
 *
 * Узел вида `human` — пауза: прогон переводится в `awaiting_human`, в журнал
 * пишется `gate.awaiting`, а `run()` возвращает управление. Продолжение —
 * `resume(runId, {approved, output?, comment?})`: результат гейта становится
 * `StepResult` (`ok`/`failed`), дальше — обычный цикл.
 *
 * ## Отмена
 *
 * `AbortSignal` останавливает прогон: статус `cancelled`, в журнал —
 * `run.failed` с кодом `pipeline.cancelled`.
 */
import { generateId, nowISO } from '@itphx/synth-shared';
import { pipelineSpecSchema, validatePipelineSpec } from '@itphx/synth-shared';
import type { PipelineNode, PipelineRunEventType, PipelineSpec, StepResult } from '@itphx/synth-shared';

import { error as logError, info as logInfo, warning as logWarning } from '../../logger.js';
import type { PipelineRunRecord } from '../../storage/ports/index.js';
import { t } from '../system-messages.js';
import { resolveSpecVars, resolveStepInput } from './mapping.js';
import { sanitizeRecord, sanitizeTrigger } from './payload.js';
import { MAX_PIPELINE_TRANSITIONS, nextNodeId } from './planner.js';
import {
  PipelineEngineError,
  type PipelineEngineDeps,
  type PipelineEngineLogger,
  type PipelineExitContext,
  type PipelineExitHandler,
  type PipelineGateDecision,
  type PipelineRunOptions,
  type StepExecutionContext,
  type StepExecutor,
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

  constructor(deps: PipelineEngineDeps) {
    this._pipelines = deps.pipelines;
    this._runs = deps.runs;
    this._executors = new Map();
    for (const executor of deps.executors ?? []) {
      this._executors.set(executor.kind, executor);
    }
    this._exitHandlers = deps.exits ?? [];
    this._sleep = deps.sleep ?? defaultSleep;
    this._logger = deps.logger ?? {
      info: (group, message) => logInfo(group, message),
      warning: (group, message) => logWarning(group, message),
      error: (group, message) => logError(group, message),
    };
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
    await this._appendEvent(runId, 'run.started', {
      pipelineId: opts.pipelineId,
      version: spec.version,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      triggerKind: trigger.kind,
      ...(trigger.source ? { source: trigger.source } : {}),
      ...(trigger.type ? { type: trigger.type } : {}),
    });

    this._logger.info(LOG_GROUP, `прогон ${runId} запущен (пайплайн «${opts.pipelineId}»@${spec.version})`);

    const state: RunState = { record, spec, vars: {}, transitions: 0 };
    const signal = opts.signal ?? new AbortController().signal;
    return this._drive(state, signal, record.currentNode ?? null);
  }

  /**
   * Продолжение прогона после HITL-паузы.
   *
   * Результат гейта становится `StepResult`: одобрение — `ok` (выход гейта —
   * в `output`), отклонение — `failed` с кодом `pipeline.gate_rejected`.
   * Дальше — обычный цикл (переходы считаются от журнала, поэтому лимит
   * переходов сохраняется между паузой и возобновлением).
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

    const result: StepResult = decision.approved
      ? {
          status: 'ok',
          attempt: 1,
          ...(decision.output ? { output: decision.output } : {}),
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
        }
      : {
          status: 'failed',
          attempt: 1,
          error: {
            code: 'pipeline.gate_rejected',
            message: t('pipeline.gate_rejected', { node: node.id }),
          },
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
        };

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

    const state: RunState = {
      record: { ...stored, status: 'running', updatedAt: now },
      spec,
      prev: result,
      vars: {},
      transitions: await this._countTransitions(runId),
    };
    state.vars = resolveSpecVars(spec, { prev: result, trigger });
    // Статус прогона — «идёт» уже до вычисления следующего узла.
    await this._runs.saveRun(state.record);

    const next = nextNodeId(spec, { node, prev: result, trigger, vars: state.vars });
    if (!next) {
      if (result.status === 'failed') {
        return this._finishFailed(
          state,
          'pipeline.gate_rejected',
          result.error?.message ?? t('pipeline.gate_rejected', { node: node.id }),
        );
      }
      return this._finishDone(state);
    }

    state.transitions += 1;
    if (state.transitions > MAX_PIPELINE_TRANSITIONS) {
      return this._finishFailed(
        state,
        'pipeline.loop_limit',
        t('pipeline.loop_limit', { limit: String(MAX_PIPELINE_TRANSITIONS) }),
      );
    }
    await this._appendEvent(runId, 'edge.taken', { from: node.id, to: next });
    state.record.currentNode = next;
    await this._runs.saveRun(state.record);

    return this._drive(state, new AbortController().signal, next);
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
   * завершает прогон (выходы), неуспешный — валит прогон.
   */
  private async _drive(
    state: RunState,
    signal: AbortSignal,
    startNodeId: string | null,
  ): Promise<PipelineRunRecord> {
    const trigger = state.record.trigger ?? { kind: 'manual' };
    let nodeId = startNodeId;

    while (nodeId) {
      if (signal.aborted) return this._finishCancelled(state);

      const node = state.spec.nodes.find((item) => item.id === nodeId);
      if (!node) {
        return this._finishFailed(
          state,
          'pipeline.invalid_spec',
          t('pipeline.invalid_spec', { problems: `node «${nodeId}» is missing in the spec` }),
        );
      }

      // HITL-гейт: прогон встаёт на паузу и ждёт решения человека.
      if (node.kind === 'human') return this._pauseForGate(state, node);

      // Переменные для входа шага — по результату предыдущего шага.
      state.vars = resolveSpecVars(state.spec, { ...(state.prev ? { prev: state.prev } : {}), trigger });

      const result = await this._runStep(state, node, signal);
      state.prev = result;

      // Переменные для условий перехода — по результату текущего шага.
      state.vars = resolveSpecVars(state.spec, { prev: result, trigger });

      if (signal.aborted) return this._finishCancelled(state);

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
      nodeId = next;
    }

    return this._finishDone(state);
  }

  /**
   * Исполнение шага с ретраями.
   *
   * Попыток — `1 + node.retry.max`; между попытками пауза `node.retry.backoffSec`
   * (через инъектированный `sleep` — в тестах мгновенная). Ошибки
   * «нет исполнителя» и «отмена» не повторяются.
   */
  private async _runStep(
    state: RunState,
    node: PipelineNode,
    signal: AbortSignal,
  ): Promise<StepResult> {
    const executor = this._executors.get(node.kind);
    const maxAttempts = 1 + Math.max(0, node.retry?.max ?? 0);
    let attempt = 0;
    let result: StepResult;

    for (;;) {
      attempt += 1;

      await this._appendEvent(state.record.id, 'node.started', {
        node: node.id,
        kind: node.kind,
        attempt,
      });

      if (!executor) {
        result = {
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
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        });
        break;
      }

      result = await this._invoke(state, node, executor, attempt, signal);
      await this._appendEvent(state.record.id, 'node.finished', {
        node: node.id,
        kind: node.kind,
        attempt,
        status: result.status,
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        ...(result.error ? { error: result.error } : {}),
      });

      const retryable =
        result.status === 'failed' &&
        result.error?.code !== 'pipeline.executor_missing' &&
        result.error?.code !== 'pipeline.cancelled';
      if (!retryable || attempt >= maxAttempts) break;

      const backoffSec = node.retry?.backoffSec;
      if (backoffSec) await this._sleep(backoffSec * 1000);
      if (signal.aborted) break;
    }

    return result;
  }

  /**
   * Вызов исполнителя шага: таймаут, отмена, приведение исключения к
   * `StepResult{status:'failed'}` (наружу исключение не выходит).
   */
  private async _invoke(
    state: RunState,
    node: PipelineNode,
    executor: StepExecutor,
    attempt: number,
    signal: AbortSignal,
  ): Promise<StepResult> {
    const startedAt = nowISO();
    const startMs = Date.now();
    const controller = new AbortController();
    const abort = (reason: Error): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onAbort = (): void => abort(new Error('pipeline cancelled'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

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
      signal: controller.signal,
      attempt,
      mode: state.spec.mode,
    };

    const timeoutMs = node.timeoutSec ? node.timeoutSec * 1000 : 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      const execution = executor.execute(ctx);
      // Гонка с таймаутом: результат «проигравшего» промиса не должен стать
      // необработанным отказом.
      execution.catch(() => undefined);

      let result: StepResult;
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

  /** HITL-пауза: прогон ждёт решения человека. */
  private async _pauseForGate(state: RunState, node: PipelineNode): Promise<PipelineRunRecord> {
    state.record.status = 'awaiting_human';
    state.record.currentNode = node.id;
    state.record.updatedAt = nowISO();
    await this._runs.saveRun(state.record);
    await this._appendEvent(state.record.id, 'gate.awaiting', {
      node: node.id,
      kind: node.kind,
      ...(node.timeoutSec !== undefined ? { timeoutSec: node.timeoutSec } : {}),
    });
    this._logger.info(LOG_GROUP, `прогон ${state.record.id}: ожидание человека на узле «${node.id}»`);
    return state.record;
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
      for (const handler of this._exitHandlers) {
        try {
          await handler.handle(ctx);
        } catch (err) {
          // Выход не исполняется «по-жёсткому»: сбой обработчика не роняет прогон.
          this._logger.error(
            LOG_GROUP,
            `обработчик выхода пайплайна завершился ошибкой: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      applied.push(sanitizeRecord(exit as unknown as Record<string, unknown>) ?? { kind: exit.kind });
    }

    const now = nowISO();
    state.record.status = 'done';
    state.record.finishedAt = now;
    state.record.updatedAt = now;
    await this._runs.saveRun(state.record);
    await this._appendEvent(state.record.id, 'run.finished', {
      status: 'done',
      exits: applied,
      ...(sanitizeRecord(output) ? { output: sanitizeRecord(output) } : {}),
    });
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
    await this._runs.saveRun(state.record);
    await this._appendEvent(state.record.id, 'run.failed', {
      code,
      error: message,
      ...(state.record.currentNode ? { node: state.record.currentNode } : {}),
    });
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
    await this._runs.saveRun(state.record);
    await this._appendEvent(state.record.id, 'run.failed', {
      code: 'pipeline.cancelled',
      error: message,
      ...(state.record.currentNode ? { node: state.record.currentNode } : {}),
    });
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

  /** Счётчик переходов прогона (по журналу — переживает паузу и рестарт). */
  private async _countTransitions(runId: string): Promise<number> {
    const events = await this._runs.listEvents(runId);
    return events.filter((event) => event.type === 'edge.taken').length;
  }
}

/**
 * Ошибка уровня прогона по провалу шага.
 *
 * Код шага может быть произвольным (исполнитель сообщает свой код) — на
 * уровне прогона используются только коды движка: «нет исполнителя»,
 * «таймаут шага», «отмена» и общий «шаг провалился».
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
