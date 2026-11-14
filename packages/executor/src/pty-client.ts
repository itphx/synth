/**
 * Клиент PTY-сессий удалённого исполнителя (протокол 8, план терминалов Ф2b).
 *
 * ## Что делает
 *
 * - **открывает** сессию (`POST /pty/open`) — **без** клиентского `id`:
 *   идентификатор выдаёт исполнитель (`pty_<uuid>`), а в `PtyOpenRequest` его
 *   нет (клиентский `id` — ключ идемпотентности, его задаёт сервис терминалов);
 * - **читает** вывод терминала как **NDJSON** (`GET /pty/:id/stream?since=0`):
 *   кадр `{"seq":n,"data":"…"}` → `onData(data)`;
 * - **пишет** ввод (`POST /pty/:id/input`), **меняет** размер
 *   (`POST /pty/:id/resize`), **закрывает** (`POST /pty/:id/close`).
 *
 * ## Обрыв потока
 *
 * Конец потока или сетевая ошибка → `onExit({ signal: 'stream_lost' })`
 * **один раз**, сессия считается мёртвой (ввод и размер — no-op). Реконнекта
 * нет: пересоздаст сервис терминалов (иначе вывод терминала потерял бы рамку
 * ответа, а терминал без рамки — не терминал).
 *
 * ## Транспорт
 *
 * Исходящие запросы — **только** через `egressFetch` из core (ADR-099,
 * инвариант 22): транспорт в клиент передаётся снаружи (`fetchImpl`), своих
 * агентов/диспетчеров пакет не создаёт.
 */

import type { PtyHandle, PtyOpenRequest } from '@itphx/synth-core';
import type { PtyOpenResponse, PtyStreamFrame } from './protocol.js';

/**
 * Тип функции-транспорта (совместим с `egressFetch` и обычным `fetch`).
 *
 * Отдельное объявление (а не импорт из `client.ts`): модуль клиента PTY не
 * зависит от модуля порта — иначе получился бы цикл импортов.
 */
export type PtyFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Потолок буфера ожидания: кадры, пришедшие **до** первой подписки на вывод.
 *
 * Сколько-то вывода терминала не должно потеряться между `openPty` и
 * подпиской (`onData`) — но и копить его без предела нельзя.
 */
const PTY_PENDING_MAX_BYTES = 256 * 1024;

/**
 * Причины PTY на проводе → код ошибки порта (`ExecutionError.code`).
 *
 * Коды — как в спецификации протокола (`docs/EXECUTION.md` §4.2.3):
 * `EPTY`/`ENOPTY`/`ELIMIT`/`EWORKSPACE`.
 */
const PTY_REASON_CODE: Record<string, string> = {
  pty_unsupported: 'EPTY',
  pty_not_found: 'ENOPTY',
  pty_limit: 'ELIMIT',
  cwd_outside_workspace: 'EWORKSPACE',
  invalid_request: 'EINVAL',
  payload_too_large: 'EPTOOLARGE',
};

/**
 * Причины PTY на проводе → причина порта (`ExecutionError.reason`).
 *
 * Только `pty_unsupported` — **недоступность зависимости** (`dependency_missing`):
 * слой доступности превращает её в `unavailable(dependency)` — «программы нет»,
 * а не «команда упала». Прочие причины — обычный `spawn_failed`.
 */
const PTY_REASON_PORT: Record<string, 'dependency_missing' | 'spawn_failed'> = {
  pty_unsupported: 'dependency_missing',
};

/** Ошибка соединения — повод взять следующий адрес пула. */
export class PtyConnectionError extends Error {
  constructor(readonly cause: unknown) {
    super('executor connection failed');
    this.name = 'PtyConnectionError';
  }
}

/** Собрать `ExecutionError` из core (класс нужен рантаймом). */
async function buildPtyError(init: {
  reason: 'timeout' | 'spawn_failed' | 'dependency_missing';
  message: string;
  code?: string | number | null;
}): Promise<import('@itphx/synth-core').ExecutionError> {
  const core = await import('@itphx/synth-core');
  return new core.ExecutionError(init);
}

/** Параметры клиента PTY-сессий. */
export interface RemotePtyClientOptions {
  /** Адрес исполнителя (`http://host:port`). */
  url: string;
  /** Bearer-токен доступа к исполнителю (в логи не пишется). */
  token: string;
  /** Транспорт (уже разрешённый — `egressFetch` из core). */
  fetchImpl: PtyFetch;
  /** Таймаут HTTP-запросов **управления** сессией, мс (поток вывода — без него). */
  timeoutMs: number;
}

/**
 * Клиент PTY-сессий одного адреса исполнителя.
 *
 * Экземпляр — на одну сессию: адрес, токен и транспорт задаются при сборке.
 */
export class RemotePtyClient {
  private readonly _opts: RemotePtyClientOptions;

  constructor(opts: RemotePtyClientOptions) {
    this._opts = opts;
  }

  /**
   * Открыть PTY-сессию и вернуть хэндл.
   *
   * Поток вывода открывается **до** возврата хэндла: ошибка открытия (сессии
   * нет, контур выключен) — это ошибка `openPty`, а не «тихий» хэндл без
   * вывода.
   *
   * @param req запрос открытия (тот же контракт, что у inline-порта)
   * @returns хэндл сессии (поток вывода уже читается)
   */
  async open(req: PtyOpenRequest): Promise<PtyHandle> {
    const opened = await this._openSession(req);
    const id = typeof opened.id === 'string' ? opened.id : '';
    if (id.length === 0) {
      throw await buildPtyError({
        reason: 'spawn_failed',
        code: 'EBADRESPONSE',
        message: 'исполнитель не вернул идентификатор PTY-сессии',
      });
    }
    const handle = new RemotePtyHandle({
      client: this,
      id,
      ...(typeof opened.pid === 'number' ? { pid: opened.pid } : {}),
    });
    await handle.start();
    return handle;
  }

  /** Запись во вход терминала (`POST /pty/:id/input`). */
  async sendInput(id: string, data: string): Promise<void> {
    await this._postJson(`/pty/${encodeURIComponent(id)}/input`, { data });
  }

  /** Изменение размера терминала (`POST /pty/:id/resize`). */
  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this._postJson(`/pty/${encodeURIComponent(id)}/resize`, { cols, rows });
  }

  /** Закрытие сессии (`POST /pty/:id/close`). */
  async closeSession(id: string): Promise<void> {
    await this._postJson(`/pty/${encodeURIComponent(id)}/close`, {});
  }

  /**
   * Открыть поток вывода терминала (`GET /pty/:id/stream?since=0`).
   *
   * Таймаута у потока **нет**: он живёт вместе с терминалом (минуты-часы).
   * Отмена — только через `signal` (закрытие сессии).
   *
   * @internal
   */
  async openStream(id: string, signal: AbortSignal): Promise<Response> {
    try {
      return await this._opts.fetchImpl(
        `${this._opts.url}/pty/${encodeURIComponent(id)}/stream?since=0`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${this._opts.token}` },
          signal,
        },
      );
    } catch (err) {
      throw new PtyConnectionError(err);
    }
  }

  /**
   * Ошибочный ответ исполнителя → `ExecutionError`.
   *
   * Причина и код берутся из тела ответа (`{ error: { reason, code, message } }`),
   * как у прочих вызовов протокола; неизвестная причина → `spawn_failed`.
   *
   * @internal
   */
  async toPtyError(response: Response): Promise<import('@itphx/synth-core').ExecutionError> {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // Тело не-JSON — причина неизвестна, код ответа скажет о классе отказа.
    }
    const error = (parsed as { error?: { reason?: unknown; code?: unknown; message?: unknown } } | null)
      ?.error;
    const wireReason = typeof error?.reason === 'string' ? error.reason : 'internal_error';
    const code =
      error?.code !== undefined && error?.code !== null
        ? (error.code as string | number)
        : (PTY_REASON_CODE[wireReason] ?? 'EINTERNAL');
    const reason = PTY_REASON_PORT[wireReason] ?? 'spawn_failed';
    return buildPtyError({
      reason,
      code,
      message:
        typeof error?.message === 'string' && error.message.length > 0
          ? error.message
          : `исполнитель ответил статусом ${response.status}`,
    });
  }

  /** Открыть сессию (`POST /pty/open`). */
  private async _openSession(req: PtyOpenRequest): Promise<PtyOpenResponse> {
    const body: Record<string, unknown> = {
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
    };
    if (req.shell !== undefined) body.shell = req.shell;
    if (req.args !== undefined) body.args = req.args;
    if (req.env !== undefined) body.env = req.env;

    const response = await this._postJson('/pty/open', body);
    return (await response.json()) as PtyOpenResponse;
  }

  /** POST с JSON-телом: вернуть ответ (ошибку разбирает вызывающий). */
  private async _postJson(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._opts.timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this._opts.fetchImpl(`${this._opts.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this._opts.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw await buildPtyError({
          reason: 'timeout',
          code: 'ETIMEDOUT',
          message: `превышен таймаут запроса к исполнителю (${this._opts.timeoutMs} мс)`,
        });
      }
      throw new PtyConnectionError(err);
    } finally {
      clearTimeout(timer);
    }
    // Отказ исполнителя — **не** ошибка соединения: повтор на другом адресе
    // не помог бы (контур выключен / сессии нет / лимит сессий).
    if (!response.ok) throw await this.toPtyError(response);
    return response;
  }
}

/** Исход выхода PTY-сессии (совпадает с контрактом `PtyHandle`). */
interface PtyExitInfo {
  exitCode?: number;
  signal?: string;
}

/**
 * Хэндл PTY-сессии удалённого исполнителя.
 *
 * Гарантии — те же, что у inline-хэндла (`execution/pty/handle.ts`):
 *
 * - `onExit` срабатывает **один раз** (событие выхода одно);
 * - `close()` **идемпотентен** (тот же промис, второй сигнал не уходит);
 * - `write`/`resize` после выхода — no-op (терминала уже нет).
 */
class RemotePtyHandle implements PtyHandle {
  readonly id: string;
  readonly pid?: number;

  private readonly _client: RemotePtyClient;
  private readonly _dataListeners = new Set<(chunk: string) => void>();
  private readonly _exitListeners = new Set<(e: PtyExitInfo) => void>();
  /** Кадры, пришедшие до первой подписки (буфер ожидания). */
  private _pending: string[] = [];
  private _pendingBytes = 0;
  private _exited = false;
  private _exitInfo: PtyExitInfo = {};
  /** Сессия мёртва (поток оборвался или сессию закрыли) — ввод/размер no-op. */
  private _dead = false;
  private _closePromise: Promise<void> | undefined;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private _abort: AbortController | undefined;

  constructor(opts: { client: RemotePtyClient; id: string; pid?: number }) {
    this._client = opts.client;
    this.id = opts.id;
    if (opts.pid !== undefined) this.pid = opts.pid;
  }

  /**
   * Открыть поток вывода и запустить чтение.
   *
   * @internal
   */
  async start(): Promise<void> {
    const abort = new AbortController();
    this._abort = abort;
    let response: Response;
    try {
      response = await this._client.openStream(this.id, abort.signal);
    } catch (err) {
      this._dead = true;
      throw err;
    }
    if (!response.ok) {
      this._dead = true;
      throw await this._client.toPtyError(response);
    }
    if (!response.body) {
      this._dead = true;
      throw await buildPtyError({
        reason: 'spawn_failed',
        code: 'EBADRESPONSE',
        message: 'исполнитель не вернул поток вывода терминала',
      });
    }
    const reader = response.body.getReader();
    this._reader = reader;
    void this._readLoop(reader);
  }

  write(data: string): void {
    if (this._dead || this._exited) return;
    // Ошибка записи — best-effort: метод синхронный, а сеть асинхронна.
    // Сессия, которая умерла, отвечает пустым потоком (`stream_lost`).
    void this._client.sendInput(this.id, data).catch(() => {});
  }

  resize(cols: number, rows: number): void {
    if (this._dead || this._exited) return;
    void this._client.resize(this.id, cols, rows).catch(() => {});
  }

  onData(cb: (chunk: string) => void): () => void {
    const first = this._dataListeners.size === 0;
    if (first && this._pending.length > 0) {
      // Вывод, пришедший до подписки, не теряется: в том числе когда сессия
      // уже завершилась (кадры пришли, поток закрылся — а подписка пришла
      // после). Дальше данных не будет — подписчик получит только их.
      const pending = this._pending;
      this._pending = [];
      this._pendingBytes = 0;
      for (const chunk of pending) {
        try {
          cb(chunk);
        } catch {
          // Подписчик не должен рвать поток вывода терминала.
        }
      }
    }
    if (this._exited) return () => {};
    this._dataListeners.add(cb);
    return () => {
      this._dataListeners.delete(cb);
    };
  }

  onExit(cb: (e: PtyExitInfo) => void): () => void {
    if (this._exited) {
      // Выход уже был — отдаём результат немедленно (событие одно).
      cb(this._exitInfo);
      return () => {};
    }
    this._exitListeners.add(cb);
    return () => {
      this._exitListeners.delete(cb);
    };
  }

  close(opts?: { signal?: string }): Promise<void> {
    this._closePromise ??= (async () => {
      try {
        await this._client.closeSession(this.id);
      } catch {
        // Закрытие — best-effort: сессия могла умереть сама (тогда 404).
      }
      this._dead = true;
      // Поток закрываем: иначе чтение продолжалось бы впустую.
      try {
        await this._reader?.cancel();
      } catch {
        // Поток уже закрыт — не ошибка.
      }
      this._abort?.abort();
      this._fireExit({ signal: opts?.signal ?? 'SIGTERM' });
    })();
    return this._closePromise;
  }

  /** Цикл чтения NDJSON-потока: кадр → `onData`, конец → `onExit`. */
  private async _readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          this._handleLine(line);
          index = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) this._handleLine(buffer);
    } catch {
      // Обрыв потока (сеть/отмена) — трактуется так же, как конец потока.
    } finally {
      this._dead = true;
      this._fireExit({ signal: 'stream_lost' });
    }
  }

  /** Разбор одной строки NDJSON (`{"seq":n,"data":"…"}`). */
  private _handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let frame: PtyStreamFrame;
    try {
      frame = JSON.parse(trimmed) as PtyStreamFrame;
    } catch {
      // Битый кадр — пропускаем: поток не рвём (терминал продолжает жить).
      return;
    }
    if (!frame || typeof frame.data !== 'string') return;
    this._deliver(frame.data);
  }

  /** Доставить кадр подписчикам (или отложить — до первой подписки). */
  private _deliver(chunk: string): void {
    if (chunk.length === 0) return;
    if (this._dataListeners.size === 0) {
      this._pending.push(chunk);
      this._pendingBytes += chunk.length;
      while (this._pendingBytes > PTY_PENDING_MAX_BYTES && this._pending.length > 1) {
        const dropped = this._pending.shift();
        this._pendingBytes -= dropped?.length ?? 0;
      }
      return;
    }
    for (const listener of [...this._dataListeners]) {
      try {
        listener(chunk);
      } catch {
        // Подписчик не должен рвать поток вывода терминала.
      }
    }
  }

  /** Событие выхода — **один раз** за сессию. */
  private _fireExit(info: PtyExitInfo): void {
    if (this._exited) return;
    this._exited = true;
    this._exitInfo = info;
    for (const listener of [...this._exitListeners]) {
      try {
        listener(info);
      } catch {
        // Подписчик не должен рвать обработку выхода.
      }
    }
    this._exitListeners.clear();
    this._dataListeners.clear();
  }
}
