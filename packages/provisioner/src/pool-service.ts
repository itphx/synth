/**
 * Жизненный цикл пулов provisioner'а (PROP-135, Ф4b-2a).
 *
 * `PoolService` — реестр выданных пулов и единственное место, где меняется
 * их состояние. Провайдер (`PoolProvisioner`) отвечает за **ресурс**, сервис —
 * за **учёт**:
 *
 * ```text
 * ensure ──► ready ──(idle / maxLifetime)──► draining ──(grace)──► release
 *              ▲                                │
 *              └──────── ensure (reuse) ────────┘
 * ```
 *
 * ## Идемпотентность
 *
 * Повторный `ensure` того же ключа возвращает **тот же** url и токен и
 * продлевает `lastUsedAt` (control plane может обращаться к пулу на каждом
 * ходе). Параллельные `ensure` одного ключа схлопываются: второй ждёт первый,
 * а не создаёт второй ресурс.
 *
 * ## Уборка
 *
 * Reaper (`sweep`) снимает пул, если:
 * - он простаивал дольше `idleTimeoutMs` (проектный/инстансный) или
 *   `sessionIdleTimeoutMs` (сессионный);
 * - он живёт дольше `maxLifetimeMs` (предельное время жизни).
 *
 * Снятие — **двухфазное**: сначала `draining` (провайдеру даётся сигнал
 * освободить исполнителей), затем — через `drainGraceMs` — `release`
 * (удаление ресурса). Явный `drain` из control plane попадает в ту же
 * последовательность: `202`, затем удаление по grace. В 4b-2a `release`
 * удаляет сразу (реальный ресурс появляется у Kubernetes-провайдера, 4b-2b).
 *
 * `now()` и таймер инъектируются — тесты не зависят от реальных часов.
 */

import type { ProvisionerMetrics } from './metrics.js';
import type {
  EnsurePoolRequest,
  EnsurePoolResponse,
  PoolInfo,
  PoolScope,
  PoolState,
  ProvisionerProfileInfo,
} from './protocol.js';
import type { PoolProvisioner } from './provider.js';
import { generatePoolToken } from './provider.js';

/** Запись реестра пулов (токен не покидает provisioner кроме ответа `ensure`). */
export interface PoolRecord {
  /** Канонический ключ пула. */
  key: string;
  /** Адрес исполнителя пула. */
  url: string;
  /** Токен доступа к пулу. */
  token: string;
  /** Профиль исполнения. */
  profile: string;
  /** Область пула. */
  scope: PoolScope;
  /** Идентификатор области (у `instance` — нет). */
  id?: string;
  /** Когда пул выдан, мс (инъектируемые часы). */
  createdAt: number;
  /** Когда пул последний раз использовался, мс. */
  lastUsedAt: number;
  /** Состояние пула. */
  state: PoolState;
  /** Когда началось снятие, мс (только `draining`). */
  drainingAt?: number;
  /** Причина снятия (для исхода метрики release). */
  drainReason?: 'manual' | 'idle' | 'lifetime';
}

/** Пул не выдан: превышен лимит живых пулов (`429`). */
export class PoolCapacityError extends Error {
  constructor(maxPools: number) {
    super(`исчерпан лимит пулов provisioner'а (${maxPools}) — пул не выдан`);
    this.name = 'PoolCapacityError';
  }
}

/** Инъектируемый таймер (тесты подменяют `setInterval`). */
export interface ProvisionerTimer {
  setInterval: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

const defaultTimer: ProvisionerTimer = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/** Параметры сервиса пулов. */
export interface PoolServiceOptions {
  /** Провайдер ресурсов пула. */
  provider: PoolProvisioner;
  /** Idle-таймаут проектного/инстансного пула, мс. */
  idleTimeoutMs: number;
  /** Idle-таймаут сессионного пула, мс. */
  sessionIdleTimeoutMs: number;
  /** Предельное время жизни пула, мс. */
  maxLifetimeMs: number;
  /** Пауза между drain и release, мс. */
  drainGraceMs: number;
  /** Лимит живых пулов. */
  maxPools: number;
  /** Период reaper'а, мс (по умолчанию 30 000). */
  reaperIntervalMs?: number;
  /** Метрики (необязательны: сервис работает и без них). */
  metrics?: ProvisionerMetrics;
  /** Инъектируемые часы (тесты). */
  now?: () => number;
  /** Инъектируемый таймер (тесты). */
  timer?: ProvisionerTimer;
}

/** Реестр пулов и их жизненный цикл. */
export class PoolService {
  private readonly _provider: PoolProvisioner;
  private readonly _idleTimeoutMs: number;
  private readonly _sessionIdleTimeoutMs: number;
  private readonly _maxLifetimeMs: number;
  private readonly _drainGraceMs: number;
  private readonly _maxPools: number;
  private readonly _reaperIntervalMs: number;
  private readonly _metrics: ProvisionerMetrics | undefined;
  private readonly _now: () => number;
  private readonly _timer: ProvisionerTimer;

  private readonly _pools = new Map<string, PoolRecord>();
  private readonly _inflight = new Map<string, Promise<PoolRecord>>();
  private _reaper: ReturnType<typeof setInterval> | undefined;
  private _sweeping = false;

  constructor(opts: PoolServiceOptions) {
    this._provider = opts.provider;
    this._idleTimeoutMs = opts.idleTimeoutMs;
    this._sessionIdleTimeoutMs = opts.sessionIdleTimeoutMs;
    this._maxLifetimeMs = opts.maxLifetimeMs;
    this._drainGraceMs = opts.drainGraceMs;
    this._maxPools = opts.maxPools;
    this._reaperIntervalMs = opts.reaperIntervalMs ?? 30_000;
    this._metrics = opts.metrics;
    this._now = opts.now ?? Date.now;
    this._timer = opts.timer ?? defaultTimer;
  }

  /**
   * Обеспечить пул по ключу.
   *
   * @throws PoolCapacityError при превышении лимита (`429`)
   * @throws PoolProvisionerError если провайдер не смог выдать пул
   */
  async ensure(req: EnsurePoolRequest): Promise<EnsurePoolResponse> {
    const existing = this._pools.get(req.key);
    if (existing) return this._reuse(existing);

    // Параллельный запрос того же ключа ждёт первый, а не создаёт второй ресурс.
    const pending = this._inflight.get(req.key);
    if (pending) {
      const record = await pending;
      if (this._pools.get(req.key) === record) return this._reuse(record);
      // Пул успели удалить, пока запрос ждал: обеспечиваем заново отдельным
      // путём (без рекурсии — иначе зациклились бы на этом же `pending`).
    }

    return this._provisionNew(req);
  }

  /**
   * Продлить жизнь пула (idle-таймаут отсчитывается от последнего касания).
   *
   * @returns `false` — пул неизвестен (`404` на HTTP-слое)
   */
  touch(key: string): boolean {
    const record = this._pools.get(key);
    if (!record) return false;
    record.lastUsedAt = this._now();
    return true;
  }

  /**
   * Слить пул: перевести в `draining` (удаление — по grace в reaper'е).
   *
   * Повторный `drain` — идемпотентен (`true`).
   *
   * @returns `false` — пул неизвестен
   */
  async drain(key: string): Promise<boolean> {
    const record = this._pools.get(key);
    if (!record) return false;
    if (record.state === 'draining') return true;
    await this._beginDrain(record, 'manual');
    return true;
  }

  /**
   * Удалить пул немедленно (не дожидаясь grace).
   *
   * @param key ключ пула
   * @param outcome исход для метрики (ручное удаление — `ok`)
   * @returns `false` — пул неизвестен
   */
  async release(key: string, outcome: 'ok' | 'idle' | 'lifetime' = 'ok'): Promise<boolean> {
    const record = this._pools.get(key);
    if (!record) return false;
    await this._releaseRecord(record, outcome);
    return true;
  }

  /** Пул по ключу (без токена) либо `undefined`. */
  get(key: string): PoolInfo | undefined {
    const record = this._pools.get(key);
    return record ? toPoolInfo(record) : undefined;
  }

  /** Список пулов без токенов (диагностика и источник gauge метрик). */
  list(): PoolInfo[] {
    return [...this._pools.values()].map(toPoolInfo);
  }

  /** Число живых пулов. */
  size(): number {
    return this._pools.size;
  }

  /** Диагностика провайдера (имя и профили). */
  capabilities(): Promise<{ provider: string; profiles: string[] }> {
    return this._provider.capabilities();
  }

  /**
   * Метаданные профилей (образ/сеть/ресурсы/runtimeClass, имена MCP-серверов).
   *
   * Провайдер без `profilesInfo` — пустой список (старый/тестовый провайдер):
   * диагностика не должна падать из-за необязательной возможности.
   */
  async profilesInfo(): Promise<ProvisionerProfileInfo[]> {
    if (typeof this._provider.profilesInfo !== 'function') return [];
    return this._provider.profilesInfo();
  }

  /**
   * Один проход уборщика: idle/maxLifetime → drain; истёкший grace → release.
   *
   * Публичный метод (а не только таймер) — тесты вызывают его с
   * инъектированными часами, не дожидаясь реального интервала.
   */
  async sweep(now: number = this._now()): Promise<void> {
    if (this._sweeping) return;
    this._sweeping = true;
    try {
      for (const record of [...this._pools.values()]) {
        if (record.state === 'draining') {
          const since = record.drainingAt ?? record.lastUsedAt;
          if (now - since >= this._drainGraceMs) {
            try {
              await this._releaseRecord(record, releaseOutcome(record));
            } catch {
              // Провайдер не смог удалить ресурс — повторим на следующем проходе:
              // запись остаётся в реестре (иначе ресурс утёк бы без учёта).
            }
          }
          continue;
        }
        if (now - record.createdAt > this._maxLifetimeMs) {
          await this._beginDrain(record, 'lifetime');
          continue;
        }
        const idleTimeout =
          record.scope === 'session' ? this._sessionIdleTimeoutMs : this._idleTimeoutMs;
        if (now - record.lastUsedAt > idleTimeout) {
          await this._beginDrain(record, 'idle');
        }
      }
    } finally {
      this._sweeping = false;
    }
  }

  /** Запустить reaper (таймер `unref`: не держит процесс живым). */
  startReaper(): void {
    if (this._reaper !== undefined) return;
    const handle = this._timer.setInterval(() => {
      void this.sweep();
    }, this._reaperIntervalMs);
    handle.unref?.();
    this._reaper = handle;
  }

  /** Остановить reaper (идемпотентно). */
  stopReaper(): void {
    if (this._reaper === undefined) return;
    this._timer.clearInterval(this._reaper);
    this._reaper = undefined;
  }

  /** Создать новый пул с проверкой лимита и схлопыванием параллельных запросов. */
  private async _provisionNew(req: EnsurePoolRequest): Promise<EnsurePoolResponse> {
    if (this._pools.size >= this._maxPools) {
      this._metrics?.provisioned('capacity');
      throw new PoolCapacityError(this._maxPools);
    }

    const task = this._create(req);
    this._inflight.set(req.key, task);
    try {
      const record = await task;
      this._metrics?.provisioned('ok');
      return { url: record.url, token: record.token };
    } catch (err) {
      this._metrics?.provisioned('error');
      throw err;
    } finally {
      this._inflight.delete(req.key);
    }
  }

  /** Создать ресурс у провайдера и зарегистрировать пул. */
  private async _create(req: EnsurePoolRequest): Promise<PoolRecord> {
    const pool = await this._provider.ensure(req);
    const url = pool.url.trim();
    if (url === '') {
      // Провайдер нарушил контракт — не регистрируем пул с пустым адресом.
      throw new Error(`провайдер вернул пустой адрес пула для ключа "${req.key}"`);
    }
    const now = this._now();
    const record: PoolRecord = {
      key: req.key,
      url,
      token: pool.token.trim() || generatePoolToken(),
      profile: req.profile,
      scope: req.scope,
      ...(req.id !== undefined ? { id: req.id } : {}),
      createdAt: now,
      lastUsedAt: now,
      state: 'ready',
    };
    this._pools.set(req.key, record);
    return record;
  }

  /** Переиспользовать запись: продлить `lastUsedAt`, вернуть из `draining`. */
  private _reuse(record: PoolRecord): EnsurePoolResponse {
    record.lastUsedAt = this._now();
    if (record.state === 'draining') {
      record.state = 'ready';
      record.drainingAt = undefined;
      record.drainReason = undefined;
    }
    this._metrics?.provisioned('ok');
    return { url: record.url, token: record.token };
  }

  /** Начать снятие: `draining` + сигнал провайдеру (best-effort). */
  private async _beginDrain(record: PoolRecord, reason: 'manual' | 'idle' | 'lifetime'): Promise<void> {
    record.state = 'draining';
    record.drainingAt = this._now();
    record.drainReason = reason;
    if (reason === 'idle') this._metrics?.idleTerminated();
    try {
      await this._provider.drain(record.key);
    } catch {
      // Best-effort: сбой сигнала не должен оставлять пул в реестре навсегда —
      // release всё равно произойдёт по grace.
    }
  }

  /** Удалить ресурс и запись из реестра; ошибка провайдера — исход `error`. */
  private async _releaseRecord(
    record: PoolRecord,
    outcome: 'ok' | 'idle' | 'lifetime',
  ): Promise<void> {
    try {
      await this._provider.release(record.key);
    } catch (err) {
      // Запись оставляем: ресурс ещё жив, повторная попытка — в следующем
      // проходе уборщика или по явному DELETE.
      this._metrics?.released('error');
      throw err;
    }
    this._pools.delete(record.key);
    this._metrics?.released(outcome);
  }
}

/** Исход удаления по причине снятия (лейбл `outcome`). */
function releaseOutcome(record: PoolRecord): 'ok' | 'idle' | 'lifetime' {
  if (record.drainReason === 'idle') return 'idle';
  if (record.drainReason === 'lifetime') return 'lifetime';
  return 'ok';
}

/** Проекция записи без токена. */
function toPoolInfo(record: PoolRecord): PoolInfo {
  return {
    key: record.key,
    url: record.url,
    profile: record.profile,
    scope: record.scope,
    ...(record.id !== undefined ? { id: record.id } : {}),
    state: record.state,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    ...(record.drainingAt !== undefined ? { drainingAt: record.drainingAt } : {}),
  };
}
