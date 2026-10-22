/**
 * Источник состава MCP-серверов пула исполнителей (ADR-077, шаг B2).
 *
 * В split-режиме MCP-серверы живут в исполнителе (шаг B1). Control plane не
 * знает их заранее: состав приходит из `GET /mcp/servers` по адресам пула
 * (`execution.remote.url`). Здесь — discovery-слой:
 *
 * - **объединение по имени**: сервер считается доступным (`up`), если **хотя бы
 *   один** адрес отдал `up`; `down`/`idle` пробрасываются как есть;
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
  ExecutorMcpClient,
  ExecutorMcpPool,
  type ExecutorFetch,
  type ExecutorMcpServerStatus,
} from './executor-mcp-client.js';

/** TTL снимка состава серверов (как инвентарь возможностей порта, шаг A). */
export const EXECUTOR_MCP_SOURCE_TTL_MS = 120_000;

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
  private readonly _requestTimeoutMs: number;
  private readonly _connectTimeoutMs: number | undefined;
  private readonly _toolTimeoutMs: number | undefined;
  private _servers = new Map<string, ExecutorMcpServerInfo>();
  private _snapshotAt = 0;
  private _closed = false;
  private _warnedEmpty = false;

  constructor(opts: ExecutorMcpSourceOptions) {
    this._pool = new ExecutorMcpPool({
      urls: opts.urls,
      token: opts.token,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this._ttlMs = opts.ttlMs ?? EXECUTOR_MCP_SOURCE_TTL_MS;
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
   */
  async refresh(): Promise<ExecutorMcpServerInfo[]> {
    if (this._closed) {
      this._servers.clear();
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
      return [];
    }

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

    const reachable = responses.filter(
      (result): result is PromiseFulfilledResult<ExecutorMcpServerStatus[]> =>
        result.status === 'fulfilled' && Array.isArray(result.value),
    );

    if (reachable.length === 0) {
      const reasons = responses
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
      warning(
        'MCP',
        `MCP-серверы исполнителя недоступны: не ответил ни один адрес из ${urls.length}` +
          (reasons.length > 0 ? ` (${reasons.join('; ')})` : ''),
      );
      this._servers.clear();
      this._snapshotAt = Date.now();
      return [];
    }

    const merged = mergeServerStatuses(
      reachable.flatMap((result) => result.value),
      (text) => this._pool.redact(text),
    );
    this._servers = merged;
    this._snapshotAt = Date.now();
    this._warnedEmpty = false;
    if (merged.size > 0) {
      const up = [...merged.values()].filter((server) => server.status === 'up').length;
      info(
        'MCP',
        `Серверы исполнителя: ${merged.size} (up: ${up}, адресов ответило: ${reachable.length} из ${urls.length})`,
      );
    }
    return this.listServers();
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
  opts: { fetchImpl?: ExecutorFetch; ttlMs?: number; requestTimeoutMs?: number; connectTimeoutMs?: number; toolTimeoutMs?: number } = {},
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
