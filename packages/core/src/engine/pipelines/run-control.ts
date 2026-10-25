/**
 * ADR-101: управление активными прогонами пайплайна.
 *
 * Реестр активных прогонов **этого процесса** — по `runId` хранится
 * контроллер отмены и промис движка. Он нужен для двух вещей:
 *
 * - **отмена** идущего прогона (ADR-101 §2.9): отмена идёт через
 *   `AbortController`, переданный движку;
 * - **soft-lock** (анти-«запусти 50 прогонов»): второй прогон того же
 *   пайплайна не запускается, пока предыдущий **исполняется**. Прогон,
 *   вставший на паузу HITL (`awaiting_human`), считается неисполняемым —
 *   он ждёт человека и ресурсов движка не потребляет.
 *
 * ## Почему это отдельный модуль
 *
 * Управление прогонами нужно **двум** контурам: HTTP-роуту пайплайнов
 * (`server/routes/pipeline-project-routes.ts`) и встроенным тулам агента
 * (`engine/tools/pipeline-run.ts`). Дублировать карту в двух местах — значит
 * завести два «реестра активности» и разъехаться по soft-lock'у; поэтому
 * карта живёт здесь, а оба контура получают **один и тот же экземпляр**
 * (точка сборки — `server/app/deps.ts` / `backend/app/deps.ts`).
 *
 * Модуль не знает про HTTP, сессии и очередь — только про движок и порт
 * прогонов (ADR-096), как и сам движок.
 */

import type { PipelineRunTrigger } from '@itphx/synth-shared';
import type { PipelineRunRecord, PipelineRunRepository } from '../../storage/ports/index.js';
import { t } from '../system-messages.js';
import { PipelineEngineError } from './types.js';
import type { PipelineEngine } from './engine.js';

/** Потолок ожидания заголовка прогона в порту (мс). */
const RUN_RECORD_WAIT_MS = 5000;
/** Шаг опроса порта прогонов при поиске заголовка (мс). */
const RUN_RECORD_POLL_MS = 5;

/** Активный прогон текущего процесса. */
interface ActiveRun {
  /** Идентификатор прогона. */
  runId: string;
  /** Идентификатор пайплайна (для soft-lock'а). */
  pipelineId: string;
  /** Контроллер отмены (передан движку). */
  controller: AbortController;
  /** Промис движка (резолвится, когда прогон встал на паузу или завершился). */
  promise: Promise<PipelineRunRecord>;
}

/** Опции запуска прогона (`startRun`). */
export interface PipelineRunStartOptions {
  /** Движок пайплайнов (ADR-101). */
  engine: PipelineEngine;
  /** Порт прогонов и журнала (ADR-096) — по нему ищется заголовок прогона. */
  runs: PipelineRunRepository;
  /** Идентификатор пайплайна. */
  pipelineId: string;
  /** Версия спецификации (по умолчанию — последняя опубликованная). */
  version?: number;
  /** Проект-владелец прогона. */
  projectId?: string;
  /** Триггер прогона. */
  trigger: PipelineRunTrigger;
  /**
   * Дополнительные данные прогона (вход).
   *
   * Складываются **под** `trigger.payload`: явный payload триггера —
   * канонические данные триггера и имеют приоритет.
   */
  input?: Record<string, unknown>;
}

/** Результат запуска прогона. */
export interface PipelineRunStartResult {
  /** Заголовок прогона (прогон идёт в фоне). */
  run: PipelineRunRecord;
}

/**
 * Реестр активных прогонов + операции запуска/отмены.
 *
 * Экземпляр — **один на процесс**: он живёт в точке сборки и передаётся
 * и HTTP-роуту, и тулам агента.
 */
export class PipelineRunControl {
  /** Активные прогоны по `runId`. */
  private readonly _active = new Map<string, ActiveRun>();
  /** Пайплайны, для которых уже **идёт** запуск (защита от гонки). */
  private readonly _reserved = new Set<string>();

  /**
   * Запуск прогона пайплайна.
   *
   * Прогон идёт **в фоне**: возвращается заголовок (id, статус, версия).
   * Ошибка прогона не вешает процесс — она попадёт в ответ/журнал.
   *
   * Soft-lock: если по этому пайплайну уже исполняется прогон — ошибка
   * `pipeline.already_running`.
   */
  async startRun(opts: PipelineRunStartOptions): Promise<PipelineRunStartResult> {
    const { engine, runs, pipelineId } = opts;
    if (this._reserved.has(pipelineId) || this._activePipelineIds().has(pipelineId)) {
      throw new PipelineEngineError(
        'pipeline.already_running',
        t('pipeline.tool.already_running', { id: pipelineId }),
      );
    }
    // Резервируем пайплайн на время старта: без этого два параллельных
    // вызова прошли бы проверку до регистрации первого прогона.
    this._reserved.add(pipelineId);
    try {
      const trigger = mergeTriggerPayload(opts.trigger, opts.input);
      const before = new Set(
        (await runs.listRuns({ pipelineId, limit: 1000 })).map((run) => run.id),
      );
      const controller = new AbortController();
      const promise = engine.run({
        pipelineId,
        ...(opts.version !== undefined ? { version: opts.version } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        trigger,
        signal: controller.signal,
      });
      // Ошибка прогона не должна вешать процесс: она попадёт в ответ/журнал.
      promise.catch(() => undefined);

      const run = await this._awaitRunRecord(runs, before, pipelineId, promise);
      this._active.set(run.id, { runId: run.id, pipelineId, controller, promise });
      const forget = (): void => {
        this._active.delete(run.id);
      };
      promise.then(forget, forget);
      return { run };
    } finally {
      this._reserved.delete(pipelineId);
    }
  }

  /**
   * Отмена активного прогона.
   *
   * `true` — прогон был активен в этом процессе и отменён (через
   * `AbortController`); `false` — такого прогона здесь нет (прогон идёт в
   * другом процессе или уже завершён).
   */
  cancelRun(runId: string): boolean {
    const active = this._active.get(runId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  /**
   * Отмена активного прогона с ожиданием финальной записи.
   *
   * `null` — прогон не был активен в этом процессе.
   */
  async cancelAndWait(runId: string): Promise<PipelineRunRecord | null> {
    const active = this._active.get(runId);
    if (!active) return null;
    active.controller.abort();
    return active.promise.catch(() => null);
  }

  /** Идёт ли прогон в этом процессе. */
  isRunning(runId: string): boolean {
    return this._active.has(runId);
  }

  /** Идёт ли прогон по пайплайну (soft-lock). */
  isPipelineRunning(pipelineId: string): boolean {
    return this._activePipelineIds().has(pipelineId);
  }

  /** Идентификаторы активных прогонов (для диагностики). */
  activeRunIds(): string[] {
    return [...this._active.keys()];
  }

  /** Пайплайны с активными прогонами. */
  private _activePipelineIds(): Set<string> {
    const ids = new Set<string>();
    for (const active of this._active.values()) ids.add(active.pipelineId);
    return ids;
  }

  /**
   * Дождаться заголовка прогона в порту.
   *
   * Движок сохраняет заголовок **до** первого шага, поэтому он появляется
   * сразу, а сам прогон идёт в фоне. Промис движка резолвится, когда прогон
   * встал на паузу или завершился, — поэтому заголовок ищем опросом порта.
   */
  private async _awaitRunRecord(
    runs: PipelineRunRepository,
    before: Set<string>,
    pipelineId: string,
    promise: Promise<PipelineRunRecord>,
  ): Promise<PipelineRunRecord> {
    let settled: PipelineRunRecord | undefined;
    let failure: unknown;
    promise.then(
      (record) => {
        settled = record;
      },
      (err) => {
        failure = err;
      },
    );

    const deadline = Date.now() + RUN_RECORD_WAIT_MS;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (settled) return settled;
      let list: PipelineRunRecord[] = [];
      try {
        list = await runs.listRuns({ pipelineId, limit: 100 });
      } catch {
        list = [];
      }
      const fresh = list.find((run) => !before.has(run.id));
      if (fresh) return fresh;
      await delay(RUN_RECORD_POLL_MS);
    }
    if (failure) throw failure;
    if (settled) return settled;
    throw new PipelineEngineError(
      'pipeline.step_failed',
      t('pipeline.step_failed', { node: pipelineId, error: 'run record was not created' }),
    );
  }
}

/**
 * Склейка payload'а триггера и входа прогона.
 *
 * Явный `trigger.payload` имеет приоритет: это канонические данные триггера
 * (ADR-101 §2.3), а `input` — дополнительный вход вызывающего.
 */
function mergeTriggerPayload(
  trigger: PipelineRunTrigger,
  input?: Record<string, unknown>,
): PipelineRunTrigger {
  if (!input || Object.keys(input).length === 0) return trigger;
  const payload = { ...input, ...(trigger.payload ?? {}) };
  return { ...trigger, payload };
}

/** Пауза (мс) — вспомогательная для опроса порта прогонов. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
