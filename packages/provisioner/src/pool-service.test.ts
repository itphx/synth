/**
 * Сервис пулов: шов «запрос → провайдер» для спецификации профиля
 * (`profileSpec`, ADR-135).
 *
 * Сервис **не решает**, какой профиль применить: он передаёт провайдеру
 * разобранный запрос без изменений. Приоритет «спецификация из тела важнее
 * каталога provisioner'а» решает провайдер (`kubernetes-provider.ts`), а
 * сервис отвечает за учёт пула (идемпотентность, лимиты, уборка).
 *
 * Проверяется именно этот шов: спецификация доезжает до провайдера, а запрос
 * без спецификации остаётся запросом без спецификации (поведение прежнее).
 */
import { describe, expect, it } from 'vitest';
import { PoolService } from './pool-service.js';
import type { EnsurePoolRequest } from './protocol.js';
import type { PoolProvisioner } from './provider.js';

/** Провайдер-наблюдатель: запоминает запросы `ensure`. */
class RecordingProvider implements PoolProvisioner {
  readonly requests: EnsurePoolRequest[] = [];

  async ensure(req: EnsurePoolRequest): Promise<{ url: string; token: string }> {
    this.requests.push(req);
    return { url: 'http://exec:5100', token: 'pool-token' };
  }

  async drain(_key: string): Promise<void> {
    // no-op
  }

  async release(_key: string): Promise<void> {
    // no-op
  }

  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    return { provider: 'fake', profiles: ['default'] };
  }
}

/** Сервис пулов с наблюдателем-провайдером. */
function makeService(): { service: PoolService; provider: RecordingProvider } {
  const provider = new RecordingProvider();
  const service = new PoolService({
    provider,
    idleTimeoutMs: 900_000,
    sessionIdleTimeoutMs: 300_000,
    maxLifetimeMs: 43_200_000,
    drainGraceMs: 30_000,
    maxPools: 50,
  });
  return { service, provider };
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

describe('provisioner: спецификация профиля в запросе', () => {
  it('спецификация профиля доезжает до провайдера без изменений', async () => {
    const { service, provider } = makeService();
    const profileSpec = {
      image: 'registry.example/synth-executor:dev',
      network: 'restricted' as const,
      resources: { limits: { cpu: '2', memory: '4Gi' } },
    };

    await service.ensure(poolRequest({ profileSpec }));

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.profileSpec).toEqual(profileSpec);
  });

  it('запрос без спецификации уходит без неё (поведение прежнее)', async () => {
    const { service, provider } = makeService();

    await service.ensure(poolRequest());

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.profileSpec).toBeUndefined();
  });

  it('повторный ensure того же ключа спецификацию провайдеру не пересылает', async () => {
    const { service, provider } = makeService();

    const first = await service.ensure(
      poolRequest({ profileSpec: { image: 'registry.example/synth-executor:dev' } }),
    );
    const second = await service.ensure(
      poolRequest({ profileSpec: { image: 'registry.example/synth-executor:dev' } }),
    );

    // Пул тот же (идемпотентность сервиса) — провайдер зовётся один раз.
    expect(second).toEqual(first);
    expect(provider.requests).toHaveLength(1);
  });

  it('профиль и ключ пула в запросе не меняются (spec — только дополнение)', async () => {
    const { service, provider } = makeService();

    await service.ensure(
      poolRequest({
        key: 'session:s1:browser:browser',
        scope: 'session',
        id: 's1',
        class: 'browser',
        profile: 'browser',
        profileSpec: { image: 'registry.example/synth-executor:browser' },
      }),
    );

    expect(provider.requests[0]).toMatchObject({
      key: 'session:s1:browser:browser',
      scope: 'session',
      id: 's1',
      class: 'browser',
      profile: 'browser',
    });
  });
});
