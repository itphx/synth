/**
 * Detach идущего прогона саб-агента — ADR-111 §«Перевод идущего прогона в фон».
 *
 * Тул `task` по умолчанию **блокирует** родительский ход: модель ждёт
 * результата ребёнка. Этот модуль даёт альтернативу — прогон регистрируется в
 * реестре активных прогонов сессии (`extra.activeRuns`), и
 * `POST /api/v2/sessions/:id/background` может **перевести его в фон**:
 * блокирующее ожидание просыпается и возвращает модели `tool_result`
 * «переведено в фон», а сам прогон продолжается уже по правилам фонового —
 * собственный `AbortController`, собственный `streamId`, публикация в
 * родительский стрим отключена, по завершении — обычное уведомление родителя.
 *
 * Инварианты:
 * 1. **Односторонний переход.** Возврата в foreground нет.
 * 2. **До detach — прежнее поведение.** Родительский «Стоп» убивает ребёнка
 *    (подписка на `ctx.abortSignal`), ошибки пробрасываются как раньше,
 *    публикация в стрим родителя идёт как обычно.
 * 3. **После detach прогон независим:** отмена родителя его не трогает;
 *    останавливает только свой «Стоп» — `POST /processes/:id/stop`
 *    (хэндл реестра) либо `POST /sessions/<child>/abort` (cancel-токен по
 *    новому `streamId`).
 * 4. **Нет реестра/сервиса — нет detach:** без `extra.activeRuns`,
 *    `extra.backgroundService`, дочерней сессии или сессии-владельца тул
 *    работает как раньше (блокирующий прогон).
 */
import { generateStreamId, nowISO } from '@itphx/synth-shared';
import type { BackgroundRunRecord, ToolContext, ToolResult } from '@itphx/synth-shared';
import type { CancellationToken } from '../../../providers/base.js';
import type { BackgroundFinishPatch } from '../../background/types.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { runSubagent, type SubagentRunConfig } from './run-cycle.js';
import type { TaskParams } from './args.js';
import type { TaskExtra } from './types.js';

/** Итог прогона: результат или ошибка (не бросаем наружу из ожидания). */
type RunOutcome = { ok: true; result: ToolResult } | { ok: false; error: unknown };

export interface DetachableSubagentOptions {
  /** Аргументы тула `task`. */
  params: TaskParams;
  /** Конфигурация прогона саб-агента (та же, что у блокирующего пути). */
  runConfig: SubagentRunConfig;
  /** Зависимости тула (реестр активных прогонов, сервис фоновых прогонов, …). */
  extra: TaskExtra;
  /** Контекст инструмента (родительский сигнал отмены, рабочий каталог). */
  ctx: ToolContext;
  /** Инъекция цикла прогона (тесты); по умолчанию — `runSubagent`. */
  run?: (config: SubagentRunConfig) => Promise<ToolResult>;
}

/**
 * Запустить саб-агента с возможностью перевода в фон.
 *
 * Прогон стартует сразу (блокирующее ожидание — как у прежнего `runSubagent`);
 * разница только в том, что до завершения он зарегистрирован в
 * `extra.activeRuns` и умеет «отцепиться».
 */
export async function runDetachableSubagent(opts: DetachableSubagentOptions): Promise<ToolResult> {
  const { params, runConfig, extra, ctx } = opts;
  const run = opts.run ?? runSubagent;
  const parentSessionId = extra.sessionId;
  const childSessionId = runConfig.childSessionId;
  const service = extra.backgroundService;
  const registry = extra.activeRuns;

  // Нечего переводить: нет реестра, сервиса фоновых прогонов или дочерней
  // сессии (без неё фоновый прогон неотличим от обычного), либо фон выключен
  // инстансом (`background.enabled=false` — мастер-выключатель действует и на
  // detach: он создаёт ровно такую же фоновую работу).
  if (!registry || !service || !parentSessionId || !childSessionId || extra.backgroundEnabled === false) {
    return run(runConfig);
  }

  const title = params.description || params.subagent_type;

  // ─── Свой сигнал отмены с начала прогона ─────────────────────────────
  // До detach ребёнок умирает от родительского «Стопа» (подписка ниже), после
  // detach подписка снимается — прогон живёт по своим правилам.
  const childAbort = new AbortController();
  const ctxChild: ToolContext = { ...ctx, abortSignal: childAbort.signal };
  const parentSignal = ctx.abortSignal;
  const onParentAbort = () => childAbort.abort();
  if (parentSignal) {
    if (parentSignal.aborted) childAbort.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const unsubscribeParent = () => parentSignal?.removeEventListener('abort', onParentAbort);

  /**
   * Переведён ли прогон в фон. Читается обёрткой `publish` на каждое событие:
   * цикл захватывает саму функцию один раз при старте, поэтому «выключить»
   * публикацию можно только флагом внутри неё.
   */
  let detached = false;

  const extraChild: TaskExtra = {
    ...extra,
    publish: (type: string, data: Record<string, unknown>) => {
      if (detached) return;
      extra.publish?.(type, data);
    },
    // `streamId` — изменяемое поле: после detach цикл читает его на каждое
    // событие (run-cycle.ts), поэтому новый id подхватывается без перезапуска.
    streamId: extra.streamId,
  };

  // ─── Состояние перевода в фон ────────────────────────────────────────
  /** Запись реестра фоновых прогонов (появляется при detach). */
  let record: BackgroundRunRecord | null = null;
  /** `streamId` фоновой части прогона (для снятия cancel-токена). */
  let childStreamId: string | undefined;
  let detachPromise: Promise<void> | undefined;
  let finishPromise: Promise<unknown> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  /** Прогон уже завершился (гонка «завершение ↔ detach»). */
  let runSettled = false;
  let settledOutcome: RunOutcome | undefined;

  let wakeDetach!: () => void;
  const detachReached = new Promise<void>((resolve) => { wakeDetach = resolve; });

  /**
   * Терминальный переход записи реестра — **ровно один раз** на прогон.
   * Маппинг статуса/итога — как у `startBackgroundSubagent` (фоновый запуск).
   */
  const finishRecord = (outcome: RunOutcome): Promise<unknown> => {
    if (!record) return Promise.resolve(null);
    if (finishPromise) return finishPromise;
    const patch: BackgroundFinishPatch = (!outcome.ok)
      ? { status: 'failed', summary: String(outcome.error) }
      : (() => {
        const result = outcome.result;
        const stoppedByUser = result.metadata?.stopped_by === 'user';
        const status: 'completed' | 'failed' | 'cancelled' = result.isError
          ? 'failed'
          : stoppedByUser ? 'cancelled' : 'completed';
        const finalContent = typeof result.metadata?.final_content === 'string'
          ? result.metadata.final_content
          : '';
        const summary = status === 'completed'
          ? (finalContent || result.content)
          : status === 'cancelled'
            ? (typeof result.metadata?.partial_output === 'string' ? result.metadata.partial_output : '')
            : result.content;
        return { status, summary };
      })();
    finishPromise = service.finish(record.id, patch).catch(() => null);
    return finishPromise;
  };

  /** Снять cancel-токен фоновой части и маркер активности дочерней сессии. */
  const cleanupChild = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (childStreamId) extra.unregisterCancelToken?.(childStreamId);
      childStreamId = undefined;
      const sessionManager = extra.sessionManager;
      if (!sessionManager) return;
      try {
        await sessionManager.withLock(childSessionId, async (s) => {
          s.currentStream = undefined;
          await sessionManager.saveSession(s);
        });
      } catch {
        // сессия могла быть удалена — маркер всё равно не нужен
      }
    })();
    return cleanupPromise;
  };

  /**
   * Перевод в фон (идемпотентно — повторный вызов возвращает тот же промис).
   *
   * Порядок: запись в реестре фоновых прогонов (там же лимиты) → хэндл отмены
   * прогона → независимость от родителя + свой `streamId`/cancel-токен →
   * маркер активности дочерней сессии → событие `process.detached` → будим
   * ожидание. `BackgroundLimitExceededError` пробрасывается: реестр активных
   * прогонов соберёт его в `failed`, прогон останется foreground.
   */
  const detach = (): Promise<void> => {
    if (detachPromise) return detachPromise;
    const attempt = (async () => {
      // Прогон уже завершился (запрос пришёл в самом конце хода) — переводить
      // нечего: блокирующее ожидание уже вернуло модели настоящий результат.
      if (runSettled) return;

      // 1. Регистрация фонового прогона (лимиты проверяются здесь).
      const started = await service.startSubagent({
        sessionId: parentSessionId,
        childSessionId,
        agentRole: params.subagent_type,
        ...(params.description ? { description: params.description } : {}),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      });
      record = started;
      // Прогон уже в фоне — в родительский стрим больше ничего не публикуем.
      detached = true;

      // 2. Хэндл отмены записи реестра: POST /processes/:id/stop.
      service.registerAbort(started.id, () => childAbort.abort());

      // 3. Независимость от отмены родителя + собственный streamId/токен,
      //    чтобы работал «Стоп» дочерней сессии (POST /sessions/<child>/abort).
      unsubscribeParent();
      const streamId = generateStreamId();
      childStreamId = streamId;
      extraChild.streamId = streamId;
      const token: CancellationToken = {
        cancelled: false,
        cancel: () => {
          token.cancelled = true;
          childAbort.abort();
        },
      };
      extra.registerCancelToken?.(streamId, token);

      // 4. Маркер активности дочерней сессии (best-effort: не записался —
      //    прогон всё равно идёт, отмена остаётся доступна через реестр).
      const sessionManager = extra.sessionManager;
      if (sessionManager) {
        try {
          await sessionManager.withLock(childSessionId, async (s) => {
            s.currentStream = {
              streamId,
              message: params.description,
              agentRole: params.subagent_type,
              startedAt: nowISO(),
              cancelled: false,
            };
            await sessionManager.saveSession(s);
          });
        } catch {
          // не фатально
        }
      }

      // 5. Событие в канал родительской сессии: парт в ленте перерисовывается
      //    («в фоне»), работа дальше видна во вкладке «Процессы».
      extra.eventBus?.publish(parentSessionId, 'process.detached', {
        session_id: parentSessionId,
        kind: 'subagent',
        id: childSessionId,
        child_session_id: childSessionId,
        background_run_id: started.id,
        title,
      });

      // 6. Будим блокирующее ожидание — ход модели продолжается с этого места.
      wakeDetach();

      // Гонка: прогон завершился, пока регистрировали запись. Закрываем её
      // сами, иначе она навсегда осталась бы `running` (`finish` идемпотентен,
      // повтор из финализации — no-op).
      if (runSettled && settledOutcome) await finishRecord(settledOutcome);
    })();
    // Отказ (лимит и т.п.) — не окончательный: снимаем промис, чтобы повтор
    // запроса мог сработать (реестр активных прогонов тоже снимает метку).
    detachPromise = attempt.catch((err: unknown) => {
      detachPromise = undefined;
      throw err;
    });
    return detachPromise;
  };

  // Регистрация до старта прогона: иначе detach не увидел бы только что
  // запущенный вызов (окно между стартом и первым событием).
  const unregister = registry.register(parentSessionId, {
    id: childSessionId,
    kind: 'subagent',
    title,
    detach,
  });

  /** Завершение прогона (любое): снять регистрацию, при detach — закрыть запись. */
  const finalize = async (outcome: RunOutcome): Promise<void> => {
    runSettled = true;
    settledOutcome = outcome;
    unregister();
    if (!detached) {
      unsubscribeParent();
      return;
    }
    await finishRecord(outcome);
    await cleanupChild();
  };

  // Прогон стартует сразу и не блокирует регистрацию: ошибку приводим к
  // `RunOutcome`, чтобы финализация выполнилась всегда.
  const runPromise = (async () => run({ ...runConfig, extra: extraChild, ctx: ctxChild }))();
  const settled = runPromise.then<RunOutcome, RunOutcome>(
    (result): RunOutcome => ({ ok: true, result }),
    (error: unknown): RunOutcome => ({ ok: false, error }),
  );

  const first = await Promise.race([
    settled.then(async (outcome) => {
      try {
        await finalize(outcome);
      } catch {
        // финализация не должна ронять ход — результат прогона важнее
      }
      return { kind: 'run' as const, outcome };
    }),
    detachReached.then(() => ({ kind: 'detach' as const })),
  ]);

  if (first.kind === 'run') {
    // Прогон завершился первым — поведение прежнее (включая проброс ошибки).
    if (!first.outcome.ok) throw first.outcome.error;
    return first.outcome.result;
  }

  // Detach первым: немедленный `tool_result` «переведено в фон». Дальнейшая
  // судьба прогона — фоновая (уведомление родителю придёт по завершении).
  // `record` заполняется в `detach()` до `wakeDetach()`, поэтому здесь он уже
  // есть (геттер — чтобы TS видел присваивание из замыкания).
  const detachedRunId = (): string | undefined => record?.id;
  return {
    content: sm('task.background_started', { id: childSessionId }),
    metadata: {
      child_session_id: childSessionId,
      status: 'running',
      background_run_id: detachedRunId(),
      detached: true,
      i18n: i18nMeta('task.background_started', { id: childSessionId }),
    },
  };
}
