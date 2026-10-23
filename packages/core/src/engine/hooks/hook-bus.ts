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
   * Метаданные: встроенный обработчик ядра (ADR-090 — «плагин не может
   * снять/подменить builtin-обработчики»).
   *
   * Защита fail-closed: такой обработчик **нельзя** снять через `off(name,
   * handler)` и через возвращённую функцию отписки — попытка отклоняется
   * (без исключения) и пишется в лог. Явный путь снятия — `offBuiltin()`
   * (см. метод): его зовёт владелец регистрации (ядро), а не внешний код.
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

  /**
   * Зарегистрировать обработчик. Возвращает функцию отписки.
   *
   * Для builtin-регистрации (ADR-090) функция отписки **не снимает**
   * обработчик: попытка отклоняется (fail-closed, без исключения) и
   * пишется в лог. Явный путь снятия — {@link HookBus.offBuiltin}.
   */
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
      if (reg.builtin) {
        console.warn(
          `[HookBus] builtin handler for "${name}" cannot be unsubscribed (builtin policy) — use offBuiltin()`,
        );
        return;
      }
      this._remove(name, (r) => r === reg);
    };
  }

  /**
   * Снять обработчик по ссылке.
   *
   * Builtin-обработчики **не снимаются** (ADR-090: внешний код не должен
   * отключать обработчики ядра): попытка отклоняется fail-closed (без
   * исключения) и пишется в лог. Явный путь — {@link HookBus.offBuiltin}.
   */
  off<N extends HookName>(name: N, handler: HookHandler<N>): void {
    const target = handler as HookHandler<HookName>;
    const handlers = this._handlers.get(name);
    if (!handlers) return;
    if (handlers.some((r) => r.handler === target && r.builtin)) {
      console.warn(
        `[HookBus] builtin handler for "${name}" cannot be removed via off() (builtin policy) — use offBuiltin()`,
      );
      return;
    }
    this._remove(name, (r) => r.handler === target);
  }

  /**
   * Явный путь снятия builtin-обработчика — зовёт **владелец регистрации**
   * (ядро: деактивация подсистемы, graceful shutdown), а не внешний код.
   *
   * Публичный `off` и функция отписки из `on` для builtin-регистраций
   * отказывают (fail-closed). Метод не входит в фасад плагинов (Ф1): плагины
   * работают через `SynthPlugin`, а не через сырую шину.
   */
  offBuiltin<N extends HookName>(name: N, handler: HookHandler<N>): void {
    const target = handler as HookHandler<HookName>;
    this._remove(name, (r) => r.handler === target);
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

  /**
   * Полная очистка (для тестов): снимает **все** обработчики, включая
   * builtin. Служебный метод — в фасад плагинов (Ф1) не попадает.
   */
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
