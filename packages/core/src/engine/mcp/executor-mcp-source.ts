/**
 * Источник состава MCP-серверов пула исполнителей (ADR-077, шаг B2).
 *
 * В split-режиме MCP-серверы живут в исполнителе (шаг B1). Control plane не
 * знает их заранее: состав приходит из `GET /mcp/servers` по адресам пула
 * (`execution.remote.url`). Здесь — discovery-слой:
 *
 * - **объединение по имени**: сервер считается доступным (`up`), если **хотя бы
 *   один** адрес отдал `up` (лучшее состояние побеждает); `down` пробрасывается
 *   как есть (с причиной);
 * - **`idle` = «ещё не поднят», а не «недоступен»**: у исполнителя ленивый
 *   старт — сервер поднимается при первом обращении к `/mcp/tools`. Увидев
 *   `idle`, источник **активирует** сервер (вызов `/mcp/tools` — тот же
 *   триггер ленивого старта) и перечитывает `/mcp/servers`: после этого сервер
 *   должен быть `up`. Иначе control plane считал бы сервер «недоступным» и
 *   первый ход агента после раскатки исполнителя ушёл бы без браузерных
 *   инструментов (тулы появлялись бы только к следующему ходу, по TTL);
 * - **TTL 120 с** (как инвентарь возможностей в шаге A): ленивое обновление
 *   при обращении (`ensureFresh`) и явное (`refresh`);
 * - пустой/недоступный пул → **пустой список и warning**, без исключения:
 *   отсутствие исполнителя не должно ломать старт control plane (сам режим
 *   уже проверен fail-closed при сборке порта исполнения);
 * - `close()` для остановки источника.
 *
 * Серверы помечаются `origin: 'executor'` — это **runtime-записи**: они не
 * персистятся в реестр `McpRegistryStore`, не редактируются пользователем и
 * видны как system-level (ADR-071). Запись в `McpManager` делает
 * `attachExecutorMcpSource` (см. ниже).
 */

import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import { readExecutorToken } from '../../execution/remote.js';
import { info, warning } from '../../logger.js';
import {
  EXECUTOR_MCP_CONNECT_TIMEOUT_MS,
  ExecutorMcpClient,
  ExecutorMcpPool,
  type ExecutorFetch,
  type ExecutorMcpServerStatus,
  type ExecutorMcpToolInfo,
} from './executor-mcp-client.js';

/** TTL снимка состава серверов (как инвентарь возможностей порта, шаг A). */
export const EXECUTOR_MCP_SOURCE_TTL_MS = 120_000;

/**
 * Пауза перед повтором **неудачного** discovery, мс.
 *
 * Полный TTL на неудачу ставить нельзя: типичная причина пустого снимка —
 * временная недоступность пула (раскатка исполнителя, старт рядом с control
 * plane). С TTL 120 с control plane оставался без MCP-инструментов две минуты
 * после того, как исполнитель уже поднялся (наблюдалось в test: backend
 * стартовал раньше нового пода исполнителя, получил 404 и «запомнил» пустой
 * состав). Короткая пауза гасит шторм запросов, но не блокирует восстановление.
 */
export const EXECUTOR_MCP_SOURCE_RETRY_MS = 15_000;

/** Таймаут одного discovery-запроса `GET /mcp/servers` (5 c). */
export const EXECUTOR_MCP_DISCOVERY_TIMEOUT_MS = 5_000;

/** Сервер исполнителя в снимке источника. */
export interface ExecutorMcpServerInfo {
  name: string;
  status: 'idle' | 'up' | 'down';
  toolCount: number;
  /** Причина последней ошибки (без секретов). */
  error?: string;
  /** Происхождение: сервер поднят исполнителем, не реестром Synth. */
  origin: 'executor';
}

/** Параметры источника. */
export interface ExecutorMcpSourceOptions {
  /** Адреса исполнителей (`execution.remote.url`). */
  urls: string[];
  /** Bearer-токен исполнителя (в логах/ошибках не появляется). */
  token: string;
  /** Транспорт (по умолчанию `egressFetch`, ADR-099). */
  fetchImpl?: ExecutorFetch;
  /** TTL снимка, мс (по умолчанию 120 000). */
  ttlMs?: number;
  /** Пауза перед повтором неудачного discovery, мс (по умолчанию 15 000). */
  retryMs?: number;
  /** Таймаут discovery-запроса, мс (по умолчанию 5 000). */
  requestTimeoutMs?: number;
  /** Таймауты клиента сервера (пробрасываются в `ExecutorMcpClient`). */
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
}

/**
 * Источник состава MCP-серверов исполнителя.
 *
 * Экземпляр — зависимость сборки приложения (не process-глобальный синглтон):
 * создаётся при старте, живёт столько же, сколько процесс (инвариант 24).
 */
export class ExecutorMcpSource {
  private readonly _pool: ExecutorMcpPool;
  private readonly _ttlMs: number;
  private readonly _retryMs: number;
  private readonly _requestTimeoutMs: number;
  private readonly _connectTimeoutMs: number | undefined;
  private readonly _toolTimeoutMs: number | undefined;
  private _servers = new Map<string, ExecutorMcpServerInfo>();
  private _snapshotAt = 0;
  /** Момент, до которого повтор после неудачи не нужен (0 — неудачи не было). */
  private _retryAt = 0;
  private _closed = false;
  private _warnedEmpty = false;

  constructor(opts: ExecutorMcpSourceOptions) {
    this._pool = new ExecutorMcpPool({
      urls: opts.urls,
      token: opts.token,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this._ttlMs = opts.ttlMs ?? EXECUTOR_MCP_SOURCE_TTL_MS;
    this._retryMs = opts.retryMs ?? EXECUTOR_MCP_SOURCE_RETRY_MS;
    this._requestTimeoutMs = opts.requestTimeoutMs ?? EXECUTOR_MCP_DISCOVERY_TIMEOUT_MS;
    this._connectTimeoutMs = opts.connectTimeoutMs;
    this._toolTimeoutMs = opts.toolTimeoutMs;
  }

  /** Адреса пула (без токена). */
  get urls(): string[] {
    return this._pool.urls;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Снимок состава (без I/O): что известно на момент последнего refresh. */
  listServers(): ExecutorMcpServerInfo[] {
    return [...this._servers.values()]
      .map((server) => ({ ...server }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Сервер по имени из снимка. */
  getServer(name: string): ExecutorMcpServerInfo | undefined {
    const server = this._servers.get(name);
    return server ? { ...server } : undefined;
  }

  /** Снимок просрочен (или его ещё нет)? */
  isStale(now: number = Date.now()): boolean {
    // Неудача discovery: короткая пауза вместо полного TTL — иначе временная
    // недоступность пула (раскатка) прячет MCP-инструменты на весь TTL.
    if (this._retryAt !== 0) return now >= this._retryAt;
    return this._snapshotAt === 0 || now - this._snapshotAt >= this._ttlMs;
  }

  /** Обновить снимок, если он просрочен (ленивое обновление). */
  async ensureFresh(): Promise<ExecutorMcpServerInfo[]> {
    if (this.isStale()) return this.refresh();
    return this.listServers();
  }

  /**
   * Перечитать состав серверов по всем адресам пула.
   *
   * Ошибки отдельных адресов не пробрасываются: снимок собирается из
   * ответивших. Не ответил никто → пустой список + warning (тулов нет).
   *
   * **Ленивый старт исполнителя.** `GET /mcp/servers` только показывает
   * состояние (`idle` — сервер настроен, но ещё не поднимался), а поднимает
   * серверы `GET /mcp/tools`. Поэтому увидев `idle`, источник активирует
   * серверы и перечитывает состояние: после активации сервер должен быть `up`.
   * Без этого control plane считал бы сервер «недоступным», и первый ход
   * агента после раскатки исполнителя ушёл бы без браузерных инструментов.
   */
  async refresh(): Promise<ExecutorMcpServerInfo[]> {
    if (this._closed) {
      this._servers.clear();
      this._retryAt = 0;
      return [];
    }

    const urls = this._pool.urls;
    if (urls.length === 0) {
      if (!this._warnedEmpty) {
        warning('MCP', 'Пул исполнителей пуст: MCP-инструменты исполнителя недоступны (execution.remote.url)');
        this._warnedEmpty = true;
      }
      this._servers.clear();
      this._snapshotAt = Date.now();
      this._retryAt = 0;
      return [];
    }

    const first = await this._readServers(urls);

    if (first.lists.length === 0) {
      warning(
        'MCP',
        `MCP-серверы исполнителя недоступны: не ответил ни один адрес из ${urls.length}` +
          (first.failures.length > 0 ? ` (${first.failures.join('; ')})` : ''),
      );
      this._servers.clear();
      // Короткая пауза: пул может подняться через секунды (раскатка), полный
      // TTL на неудачу скрывал бы инструменты две минуты.
      this._retryAt = Date.now() + this._retryMs;
      return [];
    }

    let merged = mergeServerStatuses(
      first.lists.flat(),
      (text) => this._pool.redact(text),
    );

    // `idle` — «ещё не поднят» (ленивый старт исполнителя), а не «недоступен»:
    // активируем серверы через `/mcp/tools` и перечитываем состояние.
    let retryAt = 0;
    const idle = [...merged.values()].filter((server) => server.status === 'idle');
    if (idle.length > 0) {
      const activation = await this._activateIdleServers();
      if (activation.ok) {
        const second = await this._readServers(urls);
        if (second.lists.length > 0) {
          merged = mergeServerStatuses(
            second.lists.flat(),
            (text) => this._pool.redact(text),
          );
        }
        // Сервер, который не поднялся даже после активации, — `down` с
        // причиной: иначе он «залипает» в `idle` до конца TTL и выглядит как
        // «ещё не поднят», хотя исполнитель его не отдаёт.
        for (const server of [...merged.values()]) {
          if (server.status !== 'idle') continue;
          merged.set(server.name, {
            ...server,
            status: 'down',
            error: 'сервер не поднялся после активации (/mcp/tools)',
          });
        }
      } else {
        // Ошибка активации не ломает снимок: остальные серверы сохраняются,
        // неактивированный помечается `down` с причиной.
        for (const server of idle) {
          merged.set(server.name, { ...server, status: 'down', error: activation.error });
        }
        // Повтор — через короткую паузу, а не через TTL: исполнитель мог
        // перезапускаться (раскатка) и поднять сервер с минуту.
        retryAt = Date.now() + this._retryMs;
      }
    }

    this._servers = merged;
    this._snapshotAt = Date.now();
    this._retryAt = retryAt;
    this._warnedEmpty = false;
    if (merged.size > 0) {
      const up = [...merged.values()].filter((server) => server.status === 'up').length;
      info(
        'MCP',
        `Серверы исполнителя: ${merged.size} (up: ${up}, адресов ответило: ${first.lists.length} из ${urls.length})`,
      );
    }
    return this.listServers();
  }

  /**
   * Прочитать `/mcp/servers` со всех адресов пула.
   *
   * Ошибка отдельного адреса не пробрасывается: снимок собирается из
   * ответивших. `lists` — ответы (возможно пустые массивы), `failures` —
   * тексты ошибок не ответивших адресов (для warning'а).
   */
  private async _readServers(urls: string[]): Promise<{
    lists: ExecutorMcpServerStatus[][];
    failures: string[];
  }> {
    const responses = await Promise.allSettled(
      urls.map((url) =>
        this._pool.requestAt<ExecutorMcpServerStatus[]>(
          url,
          '/mcp/servers',
          { method: 'GET' },
          this._requestTimeoutMs,
        ),
      ),
    );

    const lists: ExecutorMcpServerStatus[][] = [];
    const failures: string[] = [];
    for (const result of responses) {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        lists.push(result.value);
        continue;
      }
      if (result.status === 'rejected') {
        failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }
    return { lists, failures };
  }

  /**
   * Активировать серверы в статусе `idle` — вызов `/mcp/tools` (триггер
   * ленивого старта исполнителя) с обычным failover пула.
   *
   * Ошибка не пробрасывается: активация — best effort, снимок собирается
   * дальше (серверы без активации помечаются `down` с причиной).
   */
  private async _activateIdleServers(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this._pool.request<ExecutorMcpToolInfo[]>(
        '/mcp/tools',
        { method: 'GET' },
        this._connectTimeoutMs ?? EXECUTOR_MCP_CONNECT_TIMEOUT_MS,
      );
      return { ok: true };
    } catch (err) {
      const reason = this._pool.redact(err instanceof Error ? err.message : String(err));
      warning('MCP', `Не удалось активировать MCP-серверы исполнителя (/mcp/tools): ${reason}`);
      return { ok: false, error: `активация не удалась: ${reason}` };
    }
  }

  /** Клиент одного сервера исполнителя (поверхность `McpClientLike`). */
  createClient(name: string): ExecutorMcpClient {
    return new ExecutorMcpClient(name, this._pool, {
      ...(this._connectTimeoutMs !== undefined ? { connectTimeoutMs: this._connectTimeoutMs } : {}),
      ...(this._toolTimeoutMs !== undefined ? { toolTimeoutMs: this._toolTimeoutMs } : {}),
    });
  }

  /** Остановить источник (снимок сбрасывается; соединений не держим). */
  close(): void {
    this._closed = true;
    this._servers.clear();
    this._snapshotAt = 0;
    this._retryAt = 0;
  }
}

/**
 * Объединение статусов по имени сервера.
 *
 * `up`, если **хотя бы один** адрес отдал `up`; иначе `down`, если есть `down`;
 * иначе `idle`. `toolCount` — максимум по наблюдениям (у `up`-адреса актуален).
 */
function mergeServerStatuses(
  statuses: ExecutorMcpServerStatus[],
  redact: (text: string) => string,
): Map<string, ExecutorMcpServerInfo> {
  const merged = new Map<string, ExecutorMcpServerInfo>();
  for (const item of statuses) {
    if (!item || typeof item.name !== 'string' || item.name.length === 0) continue;
    const status = item.status === 'up' || item.status === 'down' ? item.status : 'idle';
    const toolCount = Number.isFinite(item.toolCount) && item.toolCount > 0 ? item.toolCount : 0;
    const error = typeof item.error === 'string' && item.error.length > 0 ? redact(item.error) : undefined;
    const existing = merged.get(item.name);
    if (!existing) {
      merged.set(item.name, {
        name: item.name,
        status,
        toolCount,
        origin: 'executor',
        ...(error ? { error } : {}),
      });
      continue;
    }
    const nextStatus: ExecutorMcpServerInfo['status'] =
      existing.status === 'up' || status === 'up'
        ? 'up'
        : existing.status === 'down' || status === 'down'
          ? 'down'
          : 'idle';
    merged.set(item.name, {
      name: item.name,
      status: nextStatus,
      toolCount: Math.max(existing.toolCount, toolCount),
      origin: 'executor',
      ...(nextStatus === 'up' ? {} : error ? { error } : existing.error ? { error: existing.error } : {}),
    });
  }
  return merged;
}

/** Минимальная поверхность `McpManager`, нужная для подключения источника. */
export interface ExecutorMcpManagerLike {
  setExecutorMcpSource(source: ExecutorMcpSource | null): void;
  refreshExecutorServers(): Promise<void>;
  /** Источник уже подключён? (идемпотентность проводки). */
  hasExecutorMcpSource?(): boolean;
}

/** Дескриптор MCP-пула на порту исполнения (ADR-077 шаг B2). */
export interface ExecutorMcpDescriptorLike {
  readonly urls: readonly string[];
  readonly token: string;
}

/**
 * Подключить источник по дескриптору порта исполнения (идемпотентно).
 *
 * Нужен managed-backend'у: оркестратор получает удалённый порт из общей
 * фабрики core и сам поднимает MCP-источник — отдельная проводка в каждой
 * сборке `McpManager` не требуется. `inline`-порт дескриптора не несёт, поэтому
 * там ничего не происходит.
 */
export function attachExecutorMcpFromDescriptor(
  manager: ExecutorMcpManagerLike,
  descriptor: ExecutorMcpDescriptorLike | undefined,
): ExecutorMcpSource | null {
  if (!descriptor) return null;
  const urls = descriptor.urls.map((url) => url.trim()).filter((url) => url.length > 0);
  if (urls.length === 0) return null;
  if (manager.hasExecutorMcpSource?.() === true) return null;
  const source = new ExecutorMcpSource({ urls, token: descriptor.token });
  manager.setExecutorMcpSource(source);
  // Discovery — фоном: первый ход не должен ждать исполнителя (сам старт режима
  // уже проверен fail-closed сборкой порта). Ошибки — warning внутри refresh.
  void manager.refreshExecutorServers().catch(() => {});
  return source;
}

/**
 * Собрать источник по `execution`-конфигу (только `mode=remote`).
 *
 * `inline` → `null` (поведение прежнее). Токен читается тем же
 * fail-closed-путём, что и порт исполнения (`readExecutorToken`), и в текст
 * ошибок не попадает.
 */
export async function createExecutorMcpSourceFromConfig(
  config?: ResolvedExecutionConfig | null,
  opts: {
    fetchImpl?: ExecutorFetch;
    ttlMs?: number;
    retryMs?: number;
    requestTimeoutMs?: number;
    connectTimeoutMs?: number;
    toolTimeoutMs?: number;
  } = {},
): Promise<ExecutorMcpSource | null> {
  if (!config || config.mode !== 'remote') return null;
  const urls = (config.remote.url ?? []).map((url) => url.trim()).filter((url) => url.length > 0);
  if (urls.length === 0) return null;
  const token = await readExecutorToken(config.remote.tokenSecret);
  return new ExecutorMcpSource({ urls, token, ...opts });
}

/**
 * Подключить источник серверов исполнителя к менеджеру MCP.
 *
 * Только `execution.mode=remote`: в `inline` ничего не происходит (регрессия
 * существующих установок недопустима). Ошибки discovery не пробрасываются —
 * старт control plane не должен падать из-за временно недоступного
 * исполнителя (fail-closed режима уже проверен сборкой порта исполнения).
 *
 * @returns источник (для остановки на shutdown) либо `null`
 */
export async function attachExecutorMcpSource(
  manager: ExecutorMcpManagerLike,
  config?: ResolvedExecutionConfig | null,
  opts: {
    fetchImpl?: ExecutorFetch;
    ttlMs?: number;
    retryMs?: number;
    requestTimeoutMs?: number;
    connectTimeoutMs?: number;
    toolTimeoutMs?: number;
  } = {},
): Promise<ExecutorMcpSource | null> {
  const source = await createExecutorMcpSourceFromConfig(config, opts);
  if (!source) return null;
  manager.setExecutorMcpSource(source);
  try {
    await manager.refreshExecutorServers();
  } catch (err) {
    warning(
      'MCP',
      `Не удалось получить MCP-серверы исполнителя при старте: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return source;
}
