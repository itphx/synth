/**
 * Клиент удалённого порта исполнения (ADR-077, шаг 7a).
 *
 * `createRemoteExecutionPort(opts)` возвращает реализацию **`ExecutionPort` из
 * core** — того же интерфейса, что и `InlineExecutionPort`. Домен (тулы
 * `execute_shell`/`grep_files`, git-тулы, inline-shell, детект зависимостей)
 * не различает физических исполнителей: поведение удалённого режима должно
 * совпадать с inline (тексты ошибок, коды, поля `ExecutionError`).
 *
 * ## Транспорт
 *
 * Исходящие запросы — **только через `egressFetch` из core** (ADR-099):
 * единый источник доверия TLS/CA и прокси. Собственных `Agent`/диспетчеров
 * пакет не создаёт (инвариант 22).
 *
 * ## Адреса и отказоустойчивость
 *
 * - адреса перебираются **по кругу** (round-robin) — нагрузка распределяется;
 * - при **ошибке соединения** (исполнитель недоступен) — следующий адрес;
 * - ответ исполнителя (включая ошибку исполнения) — **не** повод для failover:
 *   команда уже выполнена, повтор изменит её семантику (побочные эффекты);
 * - когда недоступны все адреса — `failMode`:
 *   - `fail` (по умолчанию) — `ExecutionError` (fail-closed);
 *   - `inline-fallback` — делегирование в `InlineExecutionPort` (явная
 *     настройка оператора, не дефолт: тихий возврат к исполнению в процессе
 *     означал бы, что удалённый режим на деле не работает). Оговорка: в
 *     fallback команда выполняется **в процессе control plane**, поэтому
 *     `cwd` — локальный путь (в удалённом режиме пути исполнителя могут
 *     отличаться), а containment исполнителя не действует.
 *
 * ## Отмена
 *
 * `req.signal` («Стоп») → разрыв HTTP-запроса → на стороне исполнителя
 * процесс команды убивается (SIGTERM). Клиент бросает `ExecutionError` с
 * причиной `aborted` — как и в inline-режиме.
 */

import type { ExecRequest, ExecResult, ExecutionPort } from '@itphx/synth-core';
import {
  EXECUTOR_PROTOCOL_VERSION,
  isPortFailureReason,
  type ExecErrorBody,
  type ExecRequestBody,
  type ExecSuccessBody,
} from './protocol.js';

/** Тип функции-транспорта (совместим с `egressFetch` и обычным `fetch`). */
export type ExecutorFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Поведение при недоступности всех исполнителей. */
export type RemoteFailMode = 'fail' | 'inline-fallback';

/** Параметры удалённого порта. */
export interface RemoteExecutionPortOptions {
  /** Адреса исполнителей (`http://host:port`). */
  urls: string[];
  /** Bearer-токен доступа к исполнителям (в логи не пишется). */
  token: string;
  /** Таймаут HTTP-запроса, мс (по умолчанию — 30 c). */
  timeoutMs?: number;
  /** Лимит одновременных вызовов (остальные — в очереди). */
  concurrency?: number;
  /** Поведение при недоступности всех адресов (по умолчанию — `fail`). */
  failMode?: RemoteFailMode;
  /** Транспорт (по умолчанию — `egressFetch` из core; для тестов). */
  fetchImpl?: ExecutorFetch;
}

/** Таймаут HTTP-запроса по умолчанию, мс (как `execution.remote.timeoutMs`). */
export const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

/** Запас к таймауту команды: HTTP-запрос живёт дольше самой команды. */
export const REMOTE_TIMEOUT_GRACE_MS = 5_000;

/** Ошибка соединения — повод переключиться на следующий адрес. */
class ConnectionFailure extends Error {
  constructor(readonly cause: unknown) {
    super('executor connection failed');
    this.name = 'ConnectionFailure';
  }
}

/** Ленивая загрузка рантайм-части core (точечный runtime-импорт). */
let coreModule: typeof import('@itphx/synth-core') | undefined;

async function loadCore(): Promise<typeof import('@itphx/synth-core')> {
  coreModule ??= await import('@itphx/synth-core');
  return coreModule;
}

/** Транспорт по умолчанию — `egressFetch` из core (ADR-099). */
async function resolveFetch(override?: ExecutorFetch): Promise<ExecutorFetch> {
  if (override) return override;
  const core = await loadCore();
  return core.egressFetch as unknown as ExecutorFetch;
}

/** Собрать `ExecutionError` из core (класс нужен рантаймом). */
async function buildExecutionError(init: {
  reason: 'timeout' | 'aborted' | 'spawn_failed' | 'nonzero_exit' | 'max_output';
  message: string;
  name?: string;
  code?: string | number | null;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string | null;
  truncated?: boolean;
  durationMs?: number;
}): Promise<import('@itphx/synth-core').ExecutionError> {
  const core = await loadCore();
  return new core.ExecutionError(init);
}

/** Протокольная причина → код ошибки порта (`reason` закрыт типом core). */
const PROTOCOL_REASON_CODE: Record<string, string> = {
  invalid_request: 'EINVAL',
  cwd_outside_workspace: 'EWORKSPACE',
  unauthorized: 'EAUTH',
  too_many_requests: 'ELIMIT',
  internal_error: 'EINTERNAL',
};

/** Нормализация адреса: без завершающих слэшей. */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Реализация `ExecutionPort` поверх удалённых исполнителей.
 *
 * Экземпляр можно создавать на каждый вызов (инстанс без процесс-глобального
 * состояния) — состояние счётчиков относится к одному порту.
 */
export class RemoteExecutionPort implements ExecutionPort {
  private readonly _urls: string[];
  private readonly _token: string;
  private readonly _timeoutMs: number;
  private readonly _concurrency: number;
  private readonly _failMode: RemoteFailMode;
  private readonly _fetchImpl: ExecutorFetch | undefined;
  private _cursor = 0;
  private _active = 0;
  private readonly _waiting: Array<() => void> = [];

  constructor(opts: RemoteExecutionPortOptions) {
    this._urls = (opts.urls ?? [])
      .map((url) => normalizeUrl(url))
      .filter((url) => url.length > 0);
    this._token = opts.token;
    this._timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS);
    this._concurrency = Math.max(1, opts.concurrency ?? 1);
    this._failMode = opts.failMode ?? 'fail';
    this._fetchImpl = opts.fetchImpl;
  }

  /** Адреса исполнителей (нормализованные). */
  get urls(): string[] {
    return [...this._urls];
  }

  /** Выполнить команду на удалённом исполнителе. */
  async execute(req: ExecRequest): Promise<ExecResult> {
    await this._acquire();
    try {
      return await this._execute(req);
    } finally {
      this._release();
    }
  }

  // --- внутреннее ---------------------------------------------------------

  private async _execute(req: ExecRequest): Promise<ExecResult> {
    if (this._urls.length === 0) {
      return this._unreachable(new Error('не задано ни одного адреса исполнителя'), req);
    }

    const start = this._cursor;
    this._cursor = (this._cursor + 1) % this._urls.length;

    let lastCause: unknown;
    for (let i = 0; i < this._urls.length; i += 1) {
      const url = this._urls[(start + i) % this._urls.length] as string;
      try {
        return await this._call(url, req);
      } catch (err) {
        if (err instanceof ConnectionFailure) {
          // Ошибка соединения — следующий адрес (команда не выполнялась).
          lastCause = err.cause;
          continue;
        }
        throw err;
      }
    }
    return this._unreachable(lastCause, req);
  }

  /** Один вызов исполнителя: HTTP-запрос + разбор ответа. */
  private async _call(url: string, req: ExecRequest): Promise<ExecResult> {
    const fetchImpl = await resolveFetch(this._fetchImpl);
    const timeoutController = new AbortController();
    const timeoutMs = this._effectiveTimeout(req.timeoutMs);
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    timer.unref?.();

    const signals: AbortSignal[] = [timeoutController.signal];
    if (req.signal) signals.push(req.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : timeoutController.signal;

    const body: ExecRequestBody = {
      command: req.command,
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      ...(req.env !== undefined ? { env: req.env } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.maxOutputBytes !== undefined ? { maxOutputBytes: req.maxOutputBytes } : {}),
    };

    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${url}/exec`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this._token}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      text = await response.text();
    } catch (err) {
      if (req.signal?.aborted) {
        throw await buildExecutionError({
          reason: 'aborted',
          name: 'AbortError',
          message: 'выполнение команды отменено',
        });
      }
      if (timeoutController.signal.aborted) {
        throw await buildExecutionError({
          reason: 'timeout',
          code: 'ETIMEDOUT',
          message: `превышен таймаут запроса к исполнителю (${timeoutMs} мс)`,
        });
      }
      throw new ConnectionFailure(err);
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      throw await buildExecutionError({
        reason: 'spawn_failed',
        code: 'EBADRESPONSE',
        message: 'исполнитель вернул невалидный ответ',
      });
    }

    if (response.ok) {
      const ok = parsed as ExecSuccessBody | null;
      return {
        stdout: ok?.stdout ?? '',
        stderr: ok?.stderr ?? '',
        exitCode: ok?.exitCode ?? 0,
        truncated: ok?.truncated ?? false,
        durationMs: ok?.durationMs ?? 0,
      };
    }

    const errorBody = (parsed as { error?: ExecErrorBody } | null)?.error;
    if (!errorBody) {
      throw await buildExecutionError({
        reason: 'spawn_failed',
        code: 'EBADRESPONSE',
        message: `исполнитель вернул ошибку без описания (HTTP ${response.status})`,
      });
    }
    throw await this._toExecutionError(errorBody);
  }

  /** Ошибка провода → `ExecutionError` (те же поля, что у inline). */
  private async _toExecutionError(body: ExecErrorBody): Promise<import('@itphx/synth-core').ExecutionError> {
    const wireReason = typeof body.reason === 'string' ? body.reason : 'internal_error';
    const reason = isPortFailureReason(wireReason) ? wireReason : 'spawn_failed';
    const code =
      body.code !== undefined && body.code !== null
        ? body.code
        : (PROTOCOL_REASON_CODE[wireReason] ?? 'EINTERNAL');
    return buildExecutionError({
      reason,
      message: body.message ?? 'команда завершилась с ошибкой',
      name: reason === 'aborted' ? 'AbortError' : 'Error',
      code,
      stdout: body.stdout ?? '',
      stderr: body.stderr ?? '',
      killed: body.killed === true,
      signal: body.signal ?? null,
      truncated: body.truncated === true,
      durationMs: body.durationMs ?? 0,
    });
  }

  /** Все адреса недоступны — поведение по `failMode`. */
  private async _unreachable(cause: unknown, req: ExecRequest): Promise<ExecResult> {
    if (this._failMode === 'inline-fallback') {
      // Явная настройка оператора: исполнение в процессе (как inline-режим).
      const core = await loadCore();
      return new core.InlineExecutionPort().execute(req);
    }
    const message = `исполнитель недоступен: ${describeCause(cause)}`;
    throw await buildExecutionError({
      reason: 'spawn_failed',
      code: 'EUNREACHABLE',
      message,
    });
  }

  /** Таймаут HTTP-запроса: не меньше заданного и не меньше таймаута команды. */
  private _effectiveTimeout(commandTimeoutMs: number | undefined): number {
    if (commandTimeoutMs === undefined) return this._timeoutMs;
    return Math.max(this._timeoutMs, commandTimeoutMs + REMOTE_TIMEOUT_GRACE_MS);
  }

  /** Занять слот (лимит одновременных вызовов). */
  private async _acquire(): Promise<void> {
    if (this._active < this._concurrency) {
      this._active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this._waiting.push(resolve);
    });
  }

  /** Освободить слот (передав его ожидающему, если есть). */
  private _release(): void {
    const next = this._waiting.shift();
    if (next) {
      next();
      return;
    }
    this._active -= 1;
  }
}

/** Текст причины недоступности (без токена и внутренних деталей). */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code ? `${code} (${cause.message})` : cause.message;
  }
  if (typeof cause === 'string') return cause;
  return 'причина неизвестна';
}

/**
 * Фабрика удалённого порта исполнения.
 *
 * @param opts адреса/токен/лимиты/поведение при недоступности
 * @returns реализация `ExecutionPort` из core
 */
export function createRemoteExecutionPort(opts: RemoteExecutionPortOptions): ExecutionPort {
  return new RemoteExecutionPort(opts);
}

/** Версия wire-протокола, на которую рассчитан клиент. */
export const REMOTE_PROTOCOL_VERSION = EXECUTOR_PROTOCOL_VERSION;
