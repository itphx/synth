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
 * ## Инвентарь пула и маршрутизация по возможностям (ADR-077)
 *
 * Состав пула известен из `GET /capabilities` каждого адреса: порт собирает
 * **карту «адрес → множество программ»** и обновляет её по TTL
 * (`REMOTE_CAPABILITIES_TTL_MS`). На этой карте решаются две задачи:
 *
 * 1. **Доступность инструмента** — `probe(bin)`: программа доступна, если она
 *    есть хотя бы у одного **ответившего** адреса. Так доступность тула
 *    определяется составом пула, а не одиночной пробой в control plane.
 * 2. **Маршрутизация команды** — `ExecRequest.requires`: команда уходит в
 *    адрес, чей инвентарь покрывает все требуемые бинари. Адрес, который не
 *    ответил на `/capabilities`, в маршрутизации **не участвует** (его состав
 *    неизвестен — fail-closed); если подходящего адреса нет, команда падает с
 *    различимой причиной `dependency_missing`.
 *
 * ## Отмена
 *
 * `req.signal` («Стоп») → разрыв HTTP-запроса → на стороне исполнителя
 * процесс команды убивается (SIGTERM). Клиент бросает `ExecutionError` с
 * причиной `aborted` — как и в inline-режиме.
 *
 * ## Фоновые процессы (ADR-077, шаг 7c)
 *
 * Фоновой процесс **живёт на исполнителе** (там, где есть toolchain и рабочий
 * каталог), а control plane наблюдает его опросом — стриминга на проводе нет:
 *
 * - журнал — `GET /exec/:processId/logs` каждые `REMOTE_BACKGROUND_LOG_POLL_MS`
 *   (300 мс), отрезки приходят по смещениям (`stdoutOffset`/`stderrOffset`);
 * - состояние — `GET /exec/:processId` каждые `REMOTE_BACKGROUND_STATUS_POLL_MS`
 *   (500 мс) до терминального статуса;
 * - остановка — `POST /exec/:processId/stop` (best-effort, без исключений).
 *
 * Выбор адреса — **тем же** механизмом, что у `execute` (по `requires`;
 * адрес без нужного бинаря и не ответивший адрес исключаются), плюс требование
 * `features.background` (протокол v3): старый исполнитель фоновых процессов
 * не знает.
 */

import type {
  ExecBackgroundChunk,
  ExecBackgroundExit,
  ExecBackgroundProcess,
  ExecRequest,
  ExecResult,
  ExecutionCapabilitySummary,
  ExecutionPort,
} from '@itphx/synth-core';
import {
  EXECUTOR_PROTOCOL_VERSION,
  isPortFailureReason,
  type BackgroundLogsResponse,
  type BackgroundProcessStatus,
  type BackgroundStatusResponse,
  type ExecErrorBody,
  type ExecRequestBody,
  type ExecSuccessBody,
  type SpawnExecRequest,
  type SpawnExecResponse,
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

/**
 * TTL инвентаря пула, мс (ADR-077).
 *
 * Состав пула меняется редко (образ исполнителя фиксирован), но узнать его
 * заново перед каждой командой — лишний round-trip. Инвентарь обновляется
 * лениво: перед `probe`/маршрутизацией, если он просрочен.
 */
export const REMOTE_CAPABILITIES_TTL_MS = 120_000;

/** Таймаут запроса `/capabilities`, мс — запрос лёгкий, ждать долго незачем. */
export const REMOTE_CAPABILITIES_TIMEOUT_MS = 5_000;

/**
 * Интервал опроса журнала фонового процесса, мс (ADR-077, шаг 7c).
 *
 * Журнал приходит отрезками (стриминга на проводе нет) — чаще 300 мс ждать
 * незачем: тик добавляет трафик пулу без заметного выигрыша в задержке.
 */
export const REMOTE_BACKGROUND_LOG_POLL_MS = 300;

/**
 * Интервал опроса состояния фонового процесса, мс.
 *
 * Состояние нужно нечасто (терминальный статус — редкое событие), а журнал
 * читается чаще: отсюда разные интервалы.
 */
export const REMOTE_BACKGROUND_STATUS_POLL_MS = 500;

/** Таймаут запроса остановки фонового процесса, мс (best-effort). */
export const REMOTE_BACKGROUND_STOP_TIMEOUT_MS = 5_000;

/**
 * Снимок состава одного адреса пула (ADR-077).
 *
 * `reachable: false` — адрес не ответил на `/capabilities`: его состав
 * неизвестен, поэтому в маршрутизации он не участвует.
 */
interface PoolEntry {
  reachable: boolean;
  binaries: Set<string>;
  /** Версия wire-протокола исполнителя (`0` — неизвестна). */
  protocol: number;
  /** Умеет ли исполнитель фоновые процессы (`features.background`, протокол v3). */
  background: boolean;
}

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
  reason:
    | 'timeout'
    | 'aborted'
    | 'spawn_failed'
    | 'nonzero_exit'
    | 'max_output'
    | 'dependency_missing';
  message: string;
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

/**
 * Сигнал остановки, который принимает исполнитель.
 *
 * Протокол берёт белый список (`SIGTERM`/`SIGKILL`), прочие сигналы
 * отклоняются (`400 invalid_request`) — а значит, запрос с таким сигналом
 * молча ничего не остановил бы. Поэтому unsupported-сигнал приводится к
 * `SIGTERM` (мягкое завершение): процесс останавливается в любом случае.
 */
function executorStopSignal(signal: NodeJS.Signals): 'SIGTERM' | 'SIGKILL' {
  return signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
}

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
  /** Инвентарь пула: адрес → состав (ADR-077). */
  private _inventory: Map<string, PoolEntry> | undefined;
  /** Момент последнего обновления инвентаря, мс. */
  private _inventoryAt = 0;
  /** Промис текущего обновления инвентаря (дедупликация параллельных запросов). */
  private _inventoryPromise: Promise<Map<string, PoolEntry>> | undefined;

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

  /**
   * ADR-077: доступность программы в окружении порта.
   *
   * Ответ — по **инвентарю пула**: программа доступна, если она есть хотя бы
   * у одного ответившего адреса. Если ни один адрес не ответил, состав пула
   * неизвестен — fail-open (ADR-078): неоднозначная ошибка не должна блокировать
   * инструмент (команда упадёт с `EUNREACHABLE` — ошибка видна модели).
   */
  async probe(bin: string): Promise<boolean> {
    const inventory = await this._ensureInventory();
    const reachable = [...inventory.values()].filter((entry) => entry.reachable);
    if (reachable.length === 0) return true;
    return reachable.some((entry) => entry.binaries.has(bin));
  }

  /**
   * ADR-077: сводка о составе пула по программе — для объяснения модели, где
   * программы нет («в пуле: 2 из 3 адресов»).
   */
  async capabilitySummary(bin: string): Promise<ExecutionCapabilitySummary> {
    const inventory = await this._ensureInventory();
    const entries = [...inventory.values()];
    const reachable = entries.filter((entry) => entry.reachable);
    const missing = reachable.filter((entry) => !entry.binaries.has(bin)).length;
    return {
      available: reachable.some((entry) => entry.binaries.has(bin)),
      missing,
      total: entries.length,
      unreachable: entries.length - reachable.length,
    };
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

  /**
   * ADR-077 (шаг 7c): фоновый запуск на удалённом исполнителе.
   *
   * Процесс живёт **на исполнителе**; control plane получает хэндл и
   * наблюдает процесс опросом (журнал — каждые 300 мс, состояние — каждые
   * 500 мс). Поток вывода собирается из отрезков журнала.
   *
   * Отличия от `execute` (портовый контракт):
   *
   * - `ExecRequest.signal` **не поддерживается** — отмена фонового процесса
   *   делается только через `stop()` хэндла;
   * - `ExecRequest.maxOutputBytes` **не применяется** — вывод не буферизуется
   *   портом, а приходит кусками в `output`;
   * - `ExecRequest.timeoutMs` уходит исполнителю (таймер процесса), а не
   *   клиенту.
   *
   * Слот одновременных вызовов **не занимается**: фоновой процесс переживает
   * запрос, а держать слот до его конца — значит заблокировать пул.
   */
  async spawnBackground(req: ExecRequest): Promise<ExecBackgroundProcess> {
    if (this._urls.length === 0) {
      return this._unreachableBackground(new Error('не задано ни одного адреса исполнителя'), req);
    }
    const requires = req.requires ?? [];
    const candidates = await this._backgroundCandidates(requires);
    if (candidates.length === 0) {
      throw await this._backgroundSelectionError(requires);
    }

    let lastCause: unknown;
    for (const url of candidates) {
      try {
        return await this._spawnBackground(url, req);
      } catch (err) {
        if (err instanceof ConnectionFailure) {
          // Ошибка соединения — процесс не запустился, пробуем следующего.
          lastCause = err.cause;
          continue;
        }
        throw err;
      }
    }
    return this._unreachableBackground(lastCause, req);
  }

  // --- внутреннее ---------------------------------------------------------

  private async _execute(req: ExecRequest): Promise<ExecResult> {
    if (this._urls.length === 0) {
      return this._unreachable(new Error('не задано ни одного адреса исполнителя'), req);
    }

    const requires = req.requires ?? [];
    if (requires.length > 0) {
      return this._executeWithRequirements(req, requires);
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

  /**
   * ADR-077: маршрутизация команды по бинарным требованиям.
   *
   * Команда уходит в адрес, чей инвентарь покрывает **все** требуемые
   * бинари. Адреса, не ответившие на `/capabilities`, не участвуют (состав
   * неизвестен — fail-closed). Если подходящего адреса нет:
   *
   * - ни один адрес не ответил — поведение по `failMode` (пул недоступен);
   * - пул ответил, но нужной программы нет ни у кого — ошибка
   *   `dependency_missing` (различимая причина: слой доступности превращает
   *   её в `unavailable(dependency)`).
   */
  private async _executeWithRequirements(
    req: ExecRequest,
    requires: string[],
  ): Promise<ExecResult> {
    const inventory = await this._ensureInventory();
    const start = this._cursor;
    this._cursor = (this._cursor + 1) % this._urls.length;

    const candidates: string[] = [];
    for (let i = 0; i < this._urls.length; i += 1) {
      const url = this._urls[(start + i) % this._urls.length] as string;
      const entry = inventory.get(url);
      if (!entry || !entry.reachable) continue;
      if (!requires.every((bin) => entry.binaries.has(bin))) continue;
      candidates.push(url);
    }

    if (candidates.length === 0) {
      const reachable = [...inventory.values()].filter((entry) => entry.reachable);
      if (reachable.length === 0) {
        // Пул целиком недоступен — как при обычной недоступности адресов.
        return this._unreachable(
          new Error('исполнители не ответили на /capabilities'),
          req,
        );
      }
      throw await buildExecutionError({
        reason: 'dependency_missing',
        code: 'EDEPENDENCY',
        message: `необходимый бинарь недоступен в пуле: ${describeMissing(requires, inventory)}`,
      });
    }

    let lastCause: unknown;
    for (const url of candidates) {
      try {
        return await this._call(url, req);
      } catch (err) {
        if (err instanceof ConnectionFailure) {
          // Адрес не отвечает — пробуем следующего кандидата (команда не выполнялась).
          lastCause = err.cause;
          continue;
        }
        throw err;
      }
    }
    return this._unreachable(lastCause, req);
  }

  /**
   * Адреса-кандидаты для фонового запуска (ADR-077, шаг 7c).
   *
   * Механизм — **тот же**, что у `execute`: по `requires` выбирается адрес,
   * чей инвентарь покрывает требуемые бинари; адрес без нужного бинаря и адрес,
   * не ответивший на `/capabilities`, в кандидаты не попадают (fail-closed).
   * Дополнительное условие — адрес должен уметь фоновые процессы
   * (`features.background` / протокол v3): старый исполнитель `/exec/spawn`
   * не знает.
   */
  private async _backgroundCandidates(requires: string[]): Promise<string[]> {
    const inventory = await this._ensureInventory();
    const start = this._cursor;
    this._cursor = (this._cursor + 1) % this._urls.length;

    const candidates: string[] = [];
    for (let i = 0; i < this._urls.length; i += 1) {
      const url = this._urls[(start + i) % this._urls.length] as string;
      const entry = inventory.get(url);
      if (!entry || !entry.reachable) continue;
      if (!entry.background) continue;
      if (!requires.every((bin) => entry.binaries.has(bin))) continue;
      candidates.push(url);
    }
    return candidates;
  }

  /**
   * Отказать в фоновом запуске: различаем три причины.
   *
   * - пул целиком недоступен → `EUNREACHABLE` (сеть недоступна);
   * - исполнитель не умеет фоновые процессы (протокол < 3) → `EBACKGROUND`
   *   (core превращает это в `background_unsupported`);
   * - нужной программы нет ни у кого → `dependency_missing`/`EDEPENDENCY`.
   */
  private async _backgroundSelectionError(
    requires: string[],
  ): Promise<import('@itphx/synth-core').ExecutionError> {
    const inventory = await this._ensureInventory();
    const reachable = [...inventory.values()].filter((entry) => entry.reachable);
    if (reachable.length === 0) {
      return buildExecutionError({
        reason: 'spawn_failed',
        code: 'EUNREACHABLE',
        message: 'исполнитель недоступен: исполнители не ответили на /capabilities',
      });
    }
    if (reachable.every((entry) => !entry.background)) {
      // Код отказа — из core (источник истины для обеих сторон): core превращает
      // его в `background_unsupported`.
      const core = await loadCore();
      return buildExecutionError({
        reason: 'spawn_failed',
        code: core.EXECUTION_BACKGROUND_UNSUPPORTED_CODE,
        message:
          `исполнитель не поддерживает фоновые процессы ` +
          `(нужен протокол ${EXECUTOR_PROTOCOL_VERSION} / features.background)`,
      });
    }
    return buildExecutionError({
      reason: 'dependency_missing',
      code: 'EDEPENDENCY',
      message: `необходимый бинарь недоступен в пуле: ${describeMissing(requires, inventory)}`,
    });
  }

  /** Запуск фонового процесса на конкретном адресе (`POST /exec/spawn`). */
  private async _spawnBackground(
    url: string,
    req: ExecRequest,
  ): Promise<ExecBackgroundProcess> {
    const fetchImpl = await resolveFetch(this._fetchImpl);
    const timeoutController = new AbortController();
    const timeoutMs = this._effectiveTimeout(req.timeoutMs);
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    timer.unref?.();

    const body: SpawnExecRequest = {
      command: req.command,
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      ...(req.env !== undefined ? { env: req.env } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.requires !== undefined && req.requires.length > 0
        ? { requires: [...req.requires] }
        : {}),
    };

    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${url}/exec/spawn`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this._token}`,
        },
        body: JSON.stringify(body),
        signal: timeoutController.signal,
      });
      text = await response.text();
    } catch (err) {
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

    if (!response.ok) {
      const errorBody = (parsed as { error?: ExecErrorBody } | null)?.error;
      if (!errorBody) {
        throw await buildExecutionError({
          reason: 'spawn_failed',
          code: 'EBADRESPONSE',
          message: `исполнитель вернул ошибку без описания (HTTP ${response.status})`,
        });
      }
      // Текст исполнителя сохраняется дословно (его видит модель).
      throw await this._toExecutionError(errorBody);
    }

    const ok = parsed as SpawnExecResponse | null;
    const processId = ok?.processId;
    if (typeof processId !== 'string' || processId.length === 0) {
      throw await buildExecutionError({
        reason: 'spawn_failed',
        code: 'EBADRESPONSE',
        message: 'исполнитель не вернул идентификатор фонового процесса',
      });
    }
    return new RemoteBackgroundProcess({
      url,
      token: this._token,
      fetchImpl,
      processId,
      ...(typeof ok?.pid === 'number' ? { pid: ok.pid } : {}),
    });
  }

  /** Все адреса недоступны — поведение по `failMode` (фоновый запуск). */
  private async _unreachableBackground(
    cause: unknown,
    req: ExecRequest,
  ): Promise<ExecBackgroundProcess> {
    if (this._failMode === 'inline-fallback') {
      // Явная настройка оператора: процесс выполняется в процессе control plane
      // (та же оговорка, что у `execute` — про `cwd` и containment).
      const core = await loadCore();
      return new core.InlineExecutionPort().spawnBackground(req);
    }
    const message = `исполнитель недоступен: ${describeCause(cause)}`;
    throw await buildExecutionError({
      reason: 'spawn_failed',
      code: 'EUNREACHABLE',
      message,
    });
  }

  /**
   * Инвентарь пула — карта «адрес → состав» (ADR-077).
   *
   * Обновление **ленивое**: перед `probe`/маршрутизацией, если инвентарь
   * просрочен (TTL). Не ответивший адрес помечается недоступным — это не
   * фатально, пока есть другие.
   */
  private async _ensureInventory(): Promise<Map<string, PoolEntry>> {
    const now = Date.now();
    if (this._inventory && now - this._inventoryAt < REMOTE_CAPABILITIES_TTL_MS) {
      return this._inventory;
    }
    this._inventoryPromise ??= this._refreshInventory();
    try {
      return await this._inventoryPromise;
    } finally {
      this._inventoryPromise = undefined;
    }
  }

  /** Опросить `GET /capabilities` у всех адресов и собрать инвентарь. */
  private async _refreshInventory(): Promise<Map<string, PoolEntry>> {
    const entries = await Promise.all(
      this._urls.map((url) => this._fetchCapabilities(url)),
    );
    const inventory = new Map<string, PoolEntry>();
    this._urls.forEach((url, index) => {
      inventory.set(url, entries[index] ?? unreachableEntry());
    });
    this._inventory = inventory;
    this._inventoryAt = Date.now();
    return inventory;
  }

  /** Состав одного адреса (`GET /capabilities`); ошибка — адрес недоступен. */
  private async _fetchCapabilities(url: string): Promise<PoolEntry> {
    const fetchImpl = await resolveFetch(this._fetchImpl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_CAPABILITIES_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${url}/capabilities`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this._token}` },
        signal: controller.signal,
      });
      if (!response.ok) return unreachableEntry();
      const body = (await response.json()) as {
        toolchain?: Record<string, unknown>;
        protocol?: number;
        features?: { background?: boolean };
      } | null;
      const toolchain = body?.toolchain;
      const binaries = new Set<string>();
      if (toolchain && typeof toolchain === 'object') {
        for (const key of Object.keys(toolchain)) binaries.add(key);
      }
      const protocol = typeof body?.protocol === 'number' ? body.protocol : 0;
      // Фоновые процессы — протокол v3 (`/exec/spawn` и далее). Признак
      // `features.background` — аддитивный: исполнитель может объявить его
      // явно, но и версия протокола ≥ 3 уже означает поддержку.
      const background = body?.features?.background === true || protocol >= EXECUTOR_PROTOCOL_VERSION;
      return { reachable: true, binaries, protocol, background };
    } catch {
      // Адрес не ответил — состав неизвестен (в маршрутизации не участвует).
      return unreachableEntry();
    } finally {
      clearTimeout(timer);
    }
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

/** Запись инвентаря для адреса, не ответившего на `/capabilities`. */
function unreachableEntry(): PoolEntry {
  return { reachable: false, binaries: new Set(), protocol: 0, background: false };
}

/** Терминальный статус фонового процесса (процесс завершился). */
function isTerminalBackgroundStatus(status: BackgroundProcessStatus): boolean {
  return status === 'exited' || status === 'failed' || status === 'killed';
}

/**
 * Ожидание с прерыванием (ADR-077, шаг 7c).
 *
 * `interrupt()` завершает **текущие** ожидания немедленно: `stop()` должен
 * разбудить опрос состояния, чтобы терминальный статус увидели сразу, а не
 * через полный интервал. После прерывания следующие ожидания снова полные
 * (иначе опрос «пел бы» вхолостую).
 *
 * Таймер ожидания **не** `unref`-ится: класс используется только
 * `RemoteBackgroundProcess` (опрос состояния и журнала фонового процесса), и
 * пока наблюдение активно, ожидание обязано держать event loop. Иначе в
 * потребителе без другой ref'нутой работы (CLI-скрипт, короткий smoke-тест)
 * Node завершает процесс с «unsettled top-level await» — поток вывода
 * `bg.output` не доходит до конца, и контракт порта работает только внутри
 * долгоживущего HTTP-сервера.
 */
class InterruptibleWait {
  private _waiters: Array<() => void> = [];

  /** Ожидание не дольше `ms` (или до прерывания). */
  wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const state: { timer?: NodeJS.Timeout } = {};
      const wake = (): void => {
        if (state.timer) clearTimeout(state.timer);
        this._waiters = this._waiters.filter((item) => item !== wake);
        resolve();
      };
      state.timer = setTimeout(wake, ms);
      this._waiters.push(wake);
    });
  }

  /** Завершить все текущие ожидания. */
  interrupt(): void {
    const waiters = this._waiters;
    this._waiters = [];
    for (const wake of waiters) wake();
  }
}

/**
 * Хэндл фонового процесса на удалённом исполнителе (ADR-077, шаг 7c).
 *
 * Процесс живёт **на исполнителе**; control plane наблюдает его опросом:
 * журнал — `GET /exec/:processId/logs` (каждые 300 мс, отрезки по смещениям),
 * состояние — `GET /exec/:processId` (каждые 500 мс) до терминального статуса.
 * Стриминга на проводе нет, поэтому поток вывода собирается из отрезков.
 *
 * Оговорка: журнал дублируется — он лежит на исполнителе (до `prune`) и
 * одновременно пишется в control plane через `BlobStore` (реестр фоновых
 * прогонов, ADR-111).
 */
class RemoteBackgroundProcess implements ExecBackgroundProcess {
  readonly processId: string;
  readonly pid: number | undefined;
  readonly output: AsyncIterable<ExecBackgroundChunk>;
  readonly exited: Promise<ExecBackgroundExit>;

  private readonly _url: string;
  private readonly _token: string;
  private readonly _fetchImpl: ExecutorFetch;
  private readonly _wait = new InterruptibleWait();
  /** Промис остановки (best-effort) — перед первым опросом ждём его. */
  private _stopPromise: Promise<void> | undefined;
  private _stopped = false;

  constructor(opts: {
    url: string;
    token: string;
    fetchImpl: ExecutorFetch;
    processId: string;
    pid?: number;
  }) {
    this._url = opts.url;
    this._token = opts.token;
    this._fetchImpl = opts.fetchImpl;
    this.processId = opts.processId;
    this.pid = opts.pid;
    this.output = { [Symbol.asyncIterator]: () => this._pollLogs() };
    this.exited = this._pollStatus();
  }

  /**
   * Остановить процесс (по умолчанию — SIGTERM).
   *
   * Best-effort: сетевая ошибка, неизвестный процесс или уже завершённый
   * процесс — не бросаем (контракт порта: `stop()` не бросает). Повторный
   * вызов — no-op.
   */
  stop(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this._stopped) return;
    this._stopped = true;
    // Опрос состояния просыпается сразу — терминальный статус увидим раньше.
    this._wait.interrupt();
    this._stopPromise = this._stop(signal);
  }

  /** Запрос остановки на исполнителе (`POST /exec/:processId/stop`). */
  private async _stop(signal: NodeJS.Signals): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_BACKGROUND_STOP_TIMEOUT_MS);
    timer.unref?.();
    try {
      await this._fetchImpl(`${this._url}/exec/${encodeURIComponent(this.processId)}/stop`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this._token}`,
        },
        body: JSON.stringify({ signal: executorStopSignal(signal) }),
        signal: controller.signal,
      });
    } catch {
      // Процесс уже завершён или исполнитель недоступен — останавливать нечем.
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Опрос состояния до терминального статуса.
   *
   * Сеть/404 — состояние недоступно: промис резолвится с `exitCode: -1`, чтобы
   * хэндл **не висел** (иначе реестр ждал бы завершения процесса навсегда).
   */
  private async _pollStatus(): Promise<ExecBackgroundExit> {
    // Если процесс уже остановлен через `stop()`, сначала дожидаемся отправки
    // сигнала — иначе опрос увидел бы «running» раньше, чем сигнал доедет.
    if (this._stopPromise) await this._stopPromise;
    for (;;) {
      try {
        const body = await this._fetchStatus();
        if (isTerminalBackgroundStatus(body.status)) {
          return {
            exitCode: body.exitCode ?? null,
            signal: body.signal ?? null,
            durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0,
          };
        }
      } catch {
        return { exitCode: -1, signal: null, durationMs: 0 };
      }
      await this._wait.wait(REMOTE_BACKGROUND_STATUS_POLL_MS);
    }
  }

  /** Снимок состояния фонового процесса. */
  private async _fetchStatus(): Promise<BackgroundStatusResponse> {
    const response = await this._fetchImpl(
      `${this._url}/exec/${encodeURIComponent(this.processId)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${this._token}` },
      },
    );
    if (!response.ok) {
      throw new Error(`исполнитель ответил статусом ${response.status}`);
    }
    return (await response.json()) as BackgroundStatusResponse;
  }

  /**
   * Опрос журнала: отрезки stdout/stderr по смещениям.
   *
   * Порядок внутри тика — сначала stdout, затем stderr. Поток завершается,
   * когда статус терминальный **и** оба потока дочитаны до конца (за тик не
   * пришло ни байта — файлы журнала уже финальны).
   */
  private async *_pollLogs(): AsyncGenerator<ExecBackgroundChunk> {
    let stdoutOffset = 0;
    let stderrOffset = 0;
    for (;;) {
      let body: BackgroundLogsResponse;
      try {
        body = await this._fetchLogs(stdoutOffset, stderrOffset);
      } catch {
        // Журнал недоступен — поток вывода заканчивается (процесс не «висит»).
        return;
      }
      const stdout = body.stdout;
      const stderr = body.stderr;
      if (stdout.nextOffset > stdout.offset) {
        stdoutOffset = stdout.nextOffset;
        yield { stream: 'stdout', data: stdout.content };
      }
      if (stderr.nextOffset > stderr.offset) {
        stderrOffset = stderr.nextOffset;
        yield { stream: 'stderr', data: stderr.content };
      }
      const drained = stdout.nextOffset <= stdout.offset && stderr.nextOffset <= stderr.offset;
      if (isTerminalBackgroundStatus(body.status) && drained) return;
      await this._wait.wait(REMOTE_BACKGROUND_LOG_POLL_MS);
    }
  }

  /** Отрезки журнала фонового процесса. */
  private async _fetchLogs(
    stdoutOffset: number,
    stderrOffset: number,
  ): Promise<BackgroundLogsResponse> {
    const query = `stdoutOffset=${stdoutOffset}&stderrOffset=${stderrOffset}`;
    const response = await this._fetchImpl(
      `${this._url}/exec/${encodeURIComponent(this.processId)}/logs?${query}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${this._token}` },
      },
    );
    if (!response.ok) {
      throw new Error(`исполнитель ответил статусом ${response.status}`);
    }
    return (await response.json()) as BackgroundLogsResponse;
  }
}

/**
 * Описание отсутствующих требований по составу пула (ADR-077).
 *
 * Модель видит, **какой** бинарь отсутствует и **в скольких** адресах его
 * нет, — иначе ошибка «программа недоступна» неотличима от «исполнитель
 * упал».
 */
function describeMissing(
  requires: string[],
  inventory: Map<string, PoolEntry>,
): string {
  const entries = [...inventory.values()];
  const reachable = entries.filter((entry) => entry.reachable);
  const unreachable = entries.length - reachable.length;
  const parts = requires.map((bin) => {
    const missing = reachable.filter((entry) => !entry.binaries.has(bin)).length;
    return `${bin} отсутствует в ${missing} из ${reachable.length} доступных адресов`;
  });
  if (unreachable > 0) parts.push(`${unreachable} адресов не ответили`);
  return parts.join('; ');
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
