/**
 * Жизненный цикл пулов (PROP-135, Ф4b-2a).
 *
 * - idle-таймаут: проектный (`idleTimeoutMs`) и сессионный
 *   (`sessionIdleTimeoutMs`);
 * - `touch` продлевает жизнь;
 * - `maxLifetime` снимает пул независимо от активности;
 * - снятие двухфазное: `draining` → (grace) → `release`;
 * - явные `drain`/`release`, лимит пулов, схлопывание параллельных `ensure`;
 * - reaper: инъекция таймера, `unref`, остановка.
 *
 * Часы и таймер инъектируются — тесты не ждут реального времени.
 */
import { describe, expect, it } from 'vitest';
import { createProvisionerMetrics, type ProvisionerMetrics } from './metrics.js';
import {
  PoolCapacityError,
  PoolService,
  type PoolServiceOptions,
  type ProvisionerTimer,
} from './pool-service.js';
import type { EnsurePoolRequest } from './protocol.js';
import type { PoolProvisioner } from './provider.js';

/** Провайдер-наблюдатель: фиксирует drain/release и умеет падать на release. */
class FakeProvider implements PoolProvisioner {
  ensureCalls = 0;
  drains: string[] = [];
  releases: string[] = [];
  failRelease = false;

  async ensure(_req: EnsurePoolRequest): Promise<{ url: string; token: string }> {
    this.ensureCalls += 1;
    return { url: `http://exec-${this.ensureCalls}:5100`, token: `tok-${this.ensureCalls}` };
  }

  async drain(key: string): Promise<void> {
    this.drains.push(key);
  }

  async release(key: string): Promise<void> {
    if (this.failRelease) throw new Error('release failed');
    this.releases.push(key);
  }

  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    return { provider: 'fake', profiles: ['default'] };
  }
}

interface Harness {
  provider: FakeProvider;
  metrics: ProvisionerMetrics;
  service: PoolService;
  advance: (ms: number) => void;
}

/** Сервис пулов с инъектированными часами. */
function makeService(opts: Partial<PoolServiceOptions> = {}): Harness {
  const provider = new FakeProvider();
  const metrics = createProvisionerMetrics({ profiles: ['default'] });
  let clock = 1_000_000;
  const service = new PoolService({
    provider,
    metrics,
    idleTimeoutMs: 900_000,
    sessionIdleTimeoutMs: 300_000,
    maxLifetimeMs: 43_200_000,
    drainGraceMs: 30_000,
    maxPools: 50,
    now: () => clock,
    ...opts,
  });
  metrics.setPoolSource(() => service.list());
  return {
    provider,
    metrics,
    service,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Запрос проектного пула. */
function poolRequest(overrides: Partial<EnsurePoolRequest> = {}): EnsurePoolRequest {
  return {
    key: 'project:p1:exec:default',
    scope: 'project',
    id: 'p1',
    class: 'exec',
    profile: 'default',
    ...overrides,
  };
}

/** Дождаться микрозадач reaper'а, запущенного из таймера. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('provisioner: idle-таймауты', () => {
  it('проектный пул снимается после idleTimeout, затем release по grace', async () => {
    const { service, provider, metrics, advance } = makeService();
    const key = 'project:p1:exec:default';
    await service.ensure(poolRequest());

    advance(900_001);
    await service.sweep();
    expect(service.get(key)?.state).toBe('draining');
    expect(provider.drains).toEqual([key]);
    expect(metrics.render().text).toContain('synth_provisioner_idle_terminations_total 1');

    // До истечения grace ресурс ещё жив.
    advance(29_999);
    await service.sweep();
    expect(service.get(key)).toBeDefined();

    advance(1);
    await service.sweep();
    expect(service.get(key)).toBeUndefined();
    expect(provider.releases).toEqual([key]);
    const text = metrics.render().text;
    expect(text).toContain('synth_provisioner_release_total{outcome="idle"} 1');
    expect(text).toContain('synth_provisioner_pools{profile="default",state="ready"} 0');
    expect(text).toContain('synth_provisioner_pools{profile="default",state="draining"} 0');
  });

  it('на границе idle-таймаута пул ещё жив (строгое >)', async () => {
    const { service, advance } = makeService();
    const key = 'project:p1:exec:default';
    await service.ensure(poolRequest());
    advance(900_000);
    await service.sweep();
    expect(service.get(key)?.state).toBe('ready');
  });

  it('сессионный пул использует отдельный (короткий) idleTimeout', async () => {
    const { service, advance } = makeService();
    const key = 'session:s1:exec:default';
    await service.ensure(poolRequest({ key, scope: 'session', id: 's1' }));

    // 300 001 < 900 000: проектный порог ещё не наступил, сессионный — уже.
    advance(300_001);
    await service.sweep();
    expect(service.get(key)?.state).toBe('draining');
  });

  it('touch продлевает жизнь пула', async () => {
    const { service, advance } = makeService();
    const key = 'project:p1:exec:default';
    await service.ensure(poolRequest());

    advance(800_000);
    expect(service.touch(key)).toBe(true);

    // С момента касания прошло 500 000 < 900 000 — пул жив.
    advance(500_000);
    await service.sweep();
    expect(service.get(key)?.state).toBe('ready');

    // С момента касания прошло 900 001 — снимается.
    advance(400_001);
    await service.sweep();
    expect(service.get(key)?.state).toBe('draining');
  });

  it('touch неизвестного пула — false', () => {
    const { service } = makeService();
    expect(service.touch('project:nope:exec:default')).toBe(false);
  });
});

describe('provisioner: maxLifetime', () => {
  it('пул снимается по предельному времени жизни независимо от активности', async () => {
    const { service, provider, metrics, advance } = makeService({
      idleTimeoutMs: 10_000_000,
      maxLifetimeMs: 5_000,
    });
    const key = 'project:p1:exec:default';
    await service.ensure(poolRequest());

    advance(4_000);
    service.touch(key);
    advance(1_001); // 5 001 от создания, активность не спасает
    await service.sweep();
    expect(service.get(key)?.state).toBe('draining');

    advance(30_000);
    await service.sweep();
    expect(service.get(key)).toBeUndefined();
    expect(provider.releases).toEqual([key]);
    expect(metrics.render().text).toContain('synth_provisioner_release_total{outcome="lifetime"} 1');
  });
});

describe('provisioner: явные drain/release', () => {
  it('drain переводит в draining, release — по grace', async () => {
    const { service, provider, advance } = makeService();
    const key = 'project:p1:exec:default';
    await service.ensure(poolRequest());

    expect(await service.drain(key)).toBe(true);
    expect(service.get(key)?.state).toBe('draining');
    expect(provider.drains).toEqual([key]);

    // Повторный drain идемпотентен: провайдер не дёргается второй раз.
    expect(await service.drain(key)).toBe(true);
    expect(provider.drains).toEqual([key]);

    advance(30_000);
    await service.sweep();
    expect(service.get(key)).toBeUndefined();
    expect(provider.releases).toEqual([key]);
  });

  it('release удаляет немедленно; повторный release — false', async () => {
    const { service, provider } = makeService();
    const key = 'project:p1:exec:default';
    await service.ensure(poolRequest());

    expect(await service.release(key)).toBe(true);
    expect(service.size()).toBe(0);
    expect(provider.releases).toEqual([key]);
    expect(await service.release(key)).toBe(false);
  });

  it('ensure возвращает пул из draining в ready (повторное использование)', async () => {
    const { service } = makeService();
    const key = 'project:p1:exec:default';
    const first = await service.ensure(poolRequest());
    await service.drain(key);
    const second = await service.ensure(poolRequest());
    expect(second).toEqual(first);
    expect(service.get(key)?.state).toBe('ready');
  });

  it('сбой release не теряет запись: повтор на следующем проходе', async () => {
    const { service, provider, metrics, advance } = makeService();
    const key = 'project:p1:exec:default';
    await service.ensure(poolRequest());
    await service.drain(key);

    provider.failRelease = true;
    advance(30_001);
    await service.sweep();
    expect(service.get(key)).toBeDefined();
    expect(metrics.render().text).toContain('synth_provisioner_release_total{outcome="error"} 1');

    provider.failRelease = false;
    await service.sweep();
    expect(service.get(key)).toBeUndefined();
  });
});

describe('provisioner: лимиты и параллельность', () => {
  it('сверх maxPools — PoolCapacityError и метрика capacity', async () => {
    const { service, metrics } = makeService({ maxPools: 1 });
    await service.ensure(poolRequest());
    await expect(
      service.ensure(poolRequest({ key: 'project:p2:exec:default', id: 'p2' })),
    ).rejects.toBeInstanceOf(PoolCapacityError);
    expect(metrics.render().text).toContain('synth_provisioner_provision_total{outcome="capacity"} 1');
  });

  it('параллельные ensure одного ключа создают один пул', async () => {
    const { service, provider } = makeService();
    const [first, second] = await Promise.all([
      service.ensure(poolRequest()),
      service.ensure(poolRequest()),
    ]);
    expect(second).toEqual(first);
    expect(provider.ensureCalls).toBe(1);
    expect(service.size()).toBe(1);
  });

  it('неудача провайдера — ошибка и метрика error', async () => {
    const metrics = createProvisionerMetrics({ profiles: ['default'] });
    const failing = new PoolService({
      provider: {
        ensure: async () => {
          throw new Error('boom');
        },
        drain: async () => undefined,
        release: async () => undefined,
        capabilities: async () => ({ provider: 'fake', profiles: [] }),
      },
      idleTimeoutMs: 1000,
      sessionIdleTimeoutMs: 1000,
      maxLifetimeMs: 1000,
      drainGraceMs: 1000,
      maxPools: 1,
      metrics,
      now: () => 0,
    });
    await expect(failing.ensure(poolRequest())).rejects.toThrow('boom');
    expect(metrics.render().text).toContain('synth_provisioner_provision_total{outcome="error"} 1');
  });
});

describe('provisioner: reaper', () => {
  it('запускается с интервалом, unref и останавливается идемпотентно', async () => {
    let handler: (() => void) | undefined;
    let intervalMs = 0;
    let unrefCalled = false;
    let clearCount = 0;
    const timer: ProvisionerTimer = {
      setInterval: (fn, ms) => {
        handler = fn;
        intervalMs = ms;
        return {
          unref: () => {
            unrefCalled = true;
          },
        } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (_handle) => {
        clearCount += 1;
      },
    };

    const { service, advance } = makeService({ timer, reaperIntervalMs: 12_345 });
    const key = 'project:p1:exec:default';
    await service.ensure(poolRequest());

    service.startReaper();
    expect(intervalMs).toBe(12_345);
    expect(unrefCalled).toBe(true);
    expect(handler).toBeDefined();

    advance(900_001);
    handler?.();
    await flush();
    expect(service.get(key)?.state).toBe('draining');

    service.stopReaper();
    expect(clearCount).toBe(1);
    service.stopReaper();
    expect(clearCount).toBe(1);
  });
});
