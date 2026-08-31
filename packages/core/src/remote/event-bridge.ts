// RemoteEventBridge — мост событий удалённого backend в локальный EventBus (гибрид, Часть 7).
// Подписывается на SSE GET /api/v2/events удалённого backend, переписывает id
// в `remote:<...>` и публикует в локальный EventBus → локальный /api/v2/events (SSE/WS) → UI.
//
// Фильтр контента по умолчанию: форвардим ВСЕ события. UI рендерит контент только из
// событий `stream.chunk`, приходящих через transport (WS/SSE /api/v2/events); тело
// prompt-стрима UI не читает (enqueueMessage отбрасывает response.body), а событий
// `message.stream`/`stream.content` в кодовой базе нет. Значит в гибриде мост — ЕДИНСТВЕННЫЙ
// путь контента до UI, исключать stream.chunk нельзя (иначе двойного вывода не будет,
// а контента не будет вовсе).

import type { BusEvent, EventType } from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';
import type { RemoteBackendClient } from './client.js';
import { toRemoteRef } from './aggregate.js';
import type { EventBus } from '../events/bus.js';

export interface RemoteEventBridgeOptions {
  /** Клиент к удалённому backend: для запроса GET /api/v2/events. */
  client: RemoteBackendClient;
  /** Поставщик токена (обычно RemoteSession.getToken) — автообновление в рантайме. */
  getToken: () => Promise<string | null>;
  /** Локальный EventBus, куда публикуем переписанные события. */
  eventBus: EventBus;
  /** URL удалённого backend (для логов/диагностики). */
  backendUrl: string;
  /** Базовая задержка реконнекта (по умолчанию 2000 мс). */
  reconnectDelayMs?: number;
  /** Максимальная задержка реконнекта (по умолчанию 60000 мс). */
  maxReconnectDelayMs?: number;
  /** Селектор: какие события транслировать (по умолчанию все). */
  shouldForward?: (event: BusEvent) => boolean;
}

const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;

/** Ключи data, являющиеся ссылками на сущности удалённого backend → переписываем в remote:<...>. */
const REWRITE_KEYS = ['session_id', 'project_id', 'parent_id', 'child_session_id', 'parent_session_id', 'id'] as const;

export class RemoteEventBridge {
  onStatusChange?: (connected: boolean) => void;

  private readonly _client: RemoteBackendClient;
  private readonly _getToken: () => Promise<string | null>;
  private readonly _eventBus: EventBus;
  private readonly _backendUrl: string;
  private readonly _reconnectDelayMs: number;
  private readonly _maxReconnectDelayMs: number;
  private readonly _shouldForward: (event: BusEvent) => boolean;

  private _controller: AbortController | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _attempt = 0;
  private _stopped = false;
  private _connected = false;

  constructor(options: RemoteEventBridgeOptions) {
    this._client = options.client;
    this._getToken = options.getToken;
    this._eventBus = options.eventBus;
    this._backendUrl = options.backendUrl;
    this._reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this._maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this._shouldForward = options.shouldForward ?? (() => true);
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    this._stopped = false;
    // Уже подключены/подключаемся или реконнект запланирован — не плодим дубли.
    if (this._controller || this._reconnectTimer) return;
    void this._connect();
  }

  stop(): void {
    this._stopped = true;
    this._controller?.abort();
    this._controller = null;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._setConnected(false);
  }

  private _setConnected(value: boolean): void {
    if (this._connected === value) return;
    this._connected = value;
    this.onStatusChange?.(value);
  }

  private async _connect(): Promise<void> {
    if (this._stopped) return;

    const controller = new AbortController();
    this._controller = controller;

    let res: Response;
    try {
      res = await this._client.request('GET', '/api/v2/events', undefined, {
        raw: true,
        timeoutMs: 0,
        signal: controller.signal,
      });
    } catch {
      // Сеть недоступна / 401 / 5xx — откат и реконнект с backoff.
      this._controller = null;
      if (!this._stopped && !controller.signal.aborted) {
        this._setConnected(false);
        this._scheduleReconnect();
      }
      return;
    }

    if (!res.ok || !res.body) {
      this._controller = null;
      if (!this._stopped && !controller.signal.aborted) {
        this._setConnected(false);
        this._scheduleReconnect();
      }
      return;
    }

    // Стрим открыт.
    this._setConnected(true);
    console.debug(`[RemoteEventBridge] подключено к событиям ${this._backendUrl}`);

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break; // backend закрыл стрим → реконнект
        buffer += decoder.decode(value, { stream: true });

        // SSE-блоки разделяются пустой строкой; keepalive-комментарии (строки с ':')
        // отсекаются в _processBlock.
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          this._processBlock(block);
        }
      }

      // Остаточный буфер без завершающего \n\n (обрыв посреди события) — обрабатываем.
      // Флаш декодера: многобайтовый символ, разорванный на границе чанка, мог
      // остаться в декодере, а не в буфере.
      buffer += decoder.decode();
      if (buffer.trim()) {
        this._processBlock(buffer);
      }

      if (!controller.signal.aborted) {
        try { await reader.cancel(); } catch { /* ignore */ }
      }
    } catch {
      // Ошибка чтения (обрыв сети) → реконнект.
    } finally {
      this._controller = null;
      if (!this._stopped && !controller.signal.aborted) {
        this._setConnected(false);
        this._scheduleReconnect();
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this._stopped || this._reconnectTimer) return;
    const delay = Math.min(this._reconnectDelayMs * 2 ** this._attempt, this._maxReconnectDelayMs);
    this._attempt += 1;
    console.debug(`[RemoteEventBridge] реконнект через ${delay} мс (попытка ${this._attempt})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this._connect();
    }, delay);
  }

  private _processBlock(block: string): void {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice('data: '.length));
      }
      // `event:` и `:keepalive` игнорируем — тип события внутри JSON (data).
    }
    if (dataLines.length === 0) return;

    const raw = dataLines.join('\n');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.debug('[RemoteEventBridge] невалидный JSON в SSE-событии, пропускаю');
      return;
    }
    this._forward(parsed);
  }

  private _forward(raw: Record<string, unknown>): void {
    if (typeof raw.sessionId !== 'string') return;
    const type = raw.type;
    if (typeof type !== 'string') return;

    // Получили валидное событие — стрим живой: backoff начинается заново
    // (иначе стрим, открывающийся и сразу падающий без событий, давал бы
    // бесконечные быстрые реконнекты на базовой задержке).
    this._attempt = 0;

    const data = (typeof raw.data === 'object' && raw.data !== null ? raw.data : {}) as Record<string, unknown>;
    const rewrittenSessionId = toRemoteRef(raw.sessionId);
    const rewrittenData = this._rewriteData(data);

    const event: BusEvent = {
      type: type as EventType,
      sessionId: rewrittenSessionId,
      data: rewrittenData,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : nowISO(),
    };

    if (!this._shouldForward(event)) return;
    this._eventBus.publish(rewrittenSessionId, event.type, event.data);
  }

  /** Переписать вложенные ссылки на сущности backend в `remote:<...>` (best-effort, только строки). */
  private _rewriteData(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...data };
    for (const key of REWRITE_KEYS) {
      const value = out[key];
      if (typeof value === 'string') {
        out[key] = toRemoteRef(value);
      }
    }
    if (Array.isArray(out.references)) {
      out.references = out.references.map((ref) => {
        if (ref && typeof ref === 'object' && typeof (ref as Record<string, unknown>).session_id === 'string') {
          const r = { ...(ref as Record<string, unknown>) };
          r.session_id = toRemoteRef(r.session_id as string);
          return r;
        }
        return ref;
      });
    }
    return out;
  }
}
