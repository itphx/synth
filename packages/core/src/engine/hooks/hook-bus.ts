import type { HookContextMap, HookMode, HookName, HookResult } from '@itphx/synth-shared';

/**
 * ADR-030: таймаут fire-and-forget обработчиков хука (`emitAsync`). По истечении
 * обработчик считается зависшим — логируется предупреждение, выполнение не
 * прерывается (обещание просто перестаёт ожидаться).
 */
export const HOOK_ASYNC_TIMEOUT_MS = 5000;

/** ADR-030: обработчик хука — sync (последовательный) или async (fire-and-forget). */
export type HookHandler<N extends HookName> = (
  ctx: HookContextMap[N],
) => HookResult | void | Promise<HookResult | void>;

/** ADR-030: параметры регистрации обработчика в {@link HookBus}. */
export interface HookRegistrationOptions {
  /**
   * Режим выполнения: `sync` (по умолчанию) — вызывается в `emit`,
   * `async` — только в `emitAsync`.
   */
  mode?: HookMode;
  /** Приоритет: больше — раньше. По умолчанию 0. При равенстве — порядок регистрации. */
  priority?: number;
  /**
   * Метаданные: встроенный обработчик ядра. Снятие builtin-обработчиков
   * зарезервировано под будущую политику (внешние плагины не должны снимать
   * обработчики ядра); текущий `off` не отказывает, флаг только хранится.
   */
  builtin?: boolean;
}

/** ADR-030: результат `emit`. */
export interface HookEmitResult<N extends HookName> {
  blocked: boolean;
  reason?: string;
  context: HookContextMap[N];
}

interface HookRegistration {
  handler: HookHandler<HookName>;
  mode: HookMode;
  priority: number;
  builtin: boolean;
  /** Порядковый номер регистрации — тай-брейк для стабильной сортировки. */
  seq: number;
}

/**
 * HookBus — ядровый in-process примитив системы хуков (ADR-030), фундамент для
 * внешних событий (ADR-089). Семантика:
 * - `emit` вызывает только sync-обработчики, последовательно по убыванию priority,
 *   и ожидает каждый; `{ block: true }` немедленно прерывает цепочку;
 * - `emitAsync` запускает только async-обработчики fire-and-forget с таймаутом;
 * - ошибка обработчика изолируется (логируется, не пробрасывается).
 *
 * Не зависит от событий сессии (`events/bus.ts`) и core-сервисов.
 */
export class HookBus {
  private _handlers = new Map<HookName, HookRegistration[]>();
  private _seq = 0;

  /** Зарегистрировать обработчик. Возвращает функцию отписки. */
  on<N extends HookName>(
    name: N,
    handler: HookHandler<N>,
    opts: HookRegistrationOptions = {},
  ): () => void {
    const reg: HookRegistration = {
      // Внутреннее хранилище стирает конкретный N — безопасно, т.к. emit/emitAsync
      // кастят обратно к HookHandler<N> для запрошенного имени.
      handler: handler as HookHandler<HookName>,
      mode: opts.mode ?? 'sync',
      priority: opts.priority ?? 0,
      builtin: opts.builtin ?? false,
      seq: this._seq++,
    };

    const list = this._handlers.get(name);
    if (list) {
      list.push(reg);
    } else {
      this._handlers.set(name, [reg]);
    }

    return () => {
      this._remove(name, (r) => r === reg);
    };
  }

  /** Снять обработчик по ссылке. Builtin-обработчики тоже снимаются (политика — позже). */
  off<N extends HookName>(name: N, handler: HookHandler<N>): void {
    this._remove(name, (r) => r.handler === (handler as HookHandler<HookName>));
  }

  /**
   * Синхронная (блокирующая) эмиссия: только sync-обработчики, последовательно
   * по priority; `block` прерывает, `patch` поверхностно мержится в контекст.
   */
  async emit<N extends HookName>(name: N, ctx: HookContextMap[N]): Promise<HookEmitResult<N>> {
    let context: HookContextMap[N] = ctx;
    const handlers = this._sorted(name);

    for (const reg of handlers) {
      if (reg.mode !== 'sync') continue;

      let result: HookResult | void;
      try {
        result = await (reg.handler as HookHandler<N>)(context);
      } catch (err) {
        console.warn(`[HookBus] handler for "${name}" failed: ${String(err)}`);
        continue;
      }

      if (!result) continue;

      if (result.block) {
        console.debug(`[HookBus] "${name}" blocked${result.reason ? `: ${result.reason}` : ''}`);
        return { blocked: true, reason: result.reason, context };
      }

      if (result.patch) {
        // Patch — произвольный набор полей поверх контекста события.
        context = { ...context, ...result.patch } as HookContextMap[N];
      }
    }

    return { blocked: false, context };
  }

  /**
   * Fire-and-forget эмиссия: только async-обработчики. Ошибка и таймаут
   * логируются, наружу не пробрасываются; метод возвращает управление сразу.
   */
  emitAsync<N extends HookName>(name: N, ctx: HookContextMap[N]): void {
    const handlers = this._sorted(name);

    for (const reg of handlers) {
      if (reg.mode !== 'async') continue;
      void this._dispatchAsync(name, reg.handler as HookHandler<N>, ctx);
    }
  }

  /** Полная очистка (для тестов). */
  removeAll(): void {
    this._handlers.clear();
  }

  /** Число зарегистрированных обработчиков имени (оба режима). */
  count(name: HookName): number {
    return this._handlers.get(name)?.length ?? 0;
  }

  private _sorted(name: HookName): HookRegistration[] {
    const handlers = this._handlers.get(name);
    if (!handlers || handlers.length < 2) return handlers ?? [];
    return [...handlers].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  private _remove(name: HookName, predicate: (reg: HookRegistration) => boolean): void {
    const handlers = this._handlers.get(name);
    if (!handlers) return;
    const kept = handlers.filter((r) => !predicate(r));
    if (kept.length === 0) {
      this._handlers.delete(name);
    } else {
      this._handlers.set(name, kept);
    }
  }

  private async _dispatchAsync<N extends HookName>(
    name: N,
    handler: HookHandler<N>,
    ctx: HookContextMap[N],
  ): Promise<void> {
    const run = Promise.resolve()
      .then(() => handler(ctx))
      .then(() => undefined)
      .catch((err) => {
        console.warn(`[HookBus] async handler for "${name}" failed: ${String(err)}`);
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(
          `[HookBus] async handler for "${name}" timed out after ${HOOK_ASYNC_TIMEOUT_MS}ms`,
        );
        resolve();
      }, HOOK_ASYNC_TIMEOUT_MS);
      // Не держим event loop открытым из-за таймаута (Node-специфичный API).
      const maybeUnref = (timer as { unref?: () => void }).unref;
      if (typeof maybeUnref === 'function') maybeUnref.call(timer);
    });

    try {
      await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
