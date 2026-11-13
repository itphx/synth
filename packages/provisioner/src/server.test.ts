/**
 * HTTP-контракт provisioner'а (PROP-135, Ф4b-2a).
 *
 * Проверяется то, чем пользуется `HttpExecutionPoolProvider` в core:
 * bearer-гард (401), `ensure` + идемпотентность, `touch` (204), `drain` (202),
 * `DELETE` (202/404), лимит пулов (429), `/health` без токена, `/metrics`
 * с токеном и `no-store`, URL-encoded ключ с `:`, диагностический список без
 * токенов пулов.
 */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { ProvisionerKubernetesConfig } from './config.js';
import type {
  KubernetesClient,
  KubernetesDaemonSet,
  KubernetesManifest,
  KubernetesPod,
  KubernetesSecret,
} from './kubernetes.js';
import { KubernetesPoolProvisioner } from './kubernetes-provider.js';
import { createProvisionerMetrics, type ProvisionerMetrics } from './metrics.js';
import { PoolService } from './pool-service.js';
import { StaticPoolProvisioner } from './provider.js';
import { createProvisionerApp } from './server.js';
import type { EnsurePoolRequest } from './protocol.js';

// Токен собирается из частей (secret-scan).
const TOKEN = ['provisioner-server', 'token', 'test-1234567890'].join('-');

const PROFILES = {
  default: {
    url: 'http://executor-default:5100',
    description: 'Базовый исполнитель',
    // env профиля и запускающая конфигурация MCP в метаданные не попадают.
    env: { EXECUTOR_SECRET_ENV: 'env-secret-value' },
    mcpServers: [
      {
        name: 'playwright',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: { MCP_TOKEN: 'mcp-secret-value' },
      },
    ],
  },
  browser: { url: 'http://browser:4200' },
};

const STATIC_POOLS = {
  'project:p1:exec:default': 'http://executor-p1:5100',
};

interface Harness {
  app: Hono;
  service: PoolService;
  metrics: ProvisionerMetrics;
}

/** Приложение provisioner'а с сервисом в памяти (без сокета). */
function makeHarness(opts: { maxPools?: number } = {}): Harness {
  const maxPools = opts.maxPools ?? 50;
  const provider = new StaticPoolProvisioner(STATIC_POOLS, PROFILES);
  const metrics = createProvisionerMetrics({ profiles: Object.keys(PROFILES) });
  const service = new PoolService({
    provider,
    metrics,
    idleTimeoutMs: 900_000,
    sessionIdleTimeoutMs: 300_000,
    maxLifetimeMs: 43_200_000,
    drainGraceMs: 30_000,
    maxPools,
  });
  metrics.setPoolSource(() => service.list());
  const app = createProvisionerApp({
    token: TOKEN,
    service,
    metrics,
    providerName: 'static',
    limits: {
      maxPools,
      idleTimeoutMs: 900_000,
      sessionIdleTimeoutMs: 300_000,
      maxLifetimeMs: 43_200_000,
      drainGraceMs: 30_000,
    },
  });
  return { app, service, metrics };
}

/** Запрос к приложению; `token: null` — без авторизации. */
function request(
  app: Hono,
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const payload =
    opts.raw !== undefined
      ? opts.raw
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return Promise.resolve(
    app.request(path, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
    }),
  );
}

/** Тело `ensure` для проектного пула. */
function ensureBody(overrides: Partial<EnsurePoolRequest> = {}): EnsurePoolRequest {
  return {
    key: 'project:p1:exec:default',
    scope: 'project',
    id: 'p1',
    class: 'exec',
    profile: 'default',
    ...overrides,
  };
}

/** Ошибка из тела ответа. */
async function readError(res: Response): Promise<{ reason: string; message: string }> {
  const body = (await res.json()) as { error: { reason: string; message: string } };
  return body.error;
}

/* ---------------------------------------------------------------------------
 * Спецификация профиля (`profileSpec`): пул поднимается по спецификации из
 * тела запроса, а не по каталогу provisioner'а (ADR-135).
 * ------------------------------------------------------------------------ */

/** Конфигурация Kubernetes-провайдера для тестов. */
const KUBERNETES: ProvisionerKubernetesConfig = {
  namespace: 'synth',
  workspacePvc: 'synth-workspace',
  workspaceMount: '/var/synth/data/workspaces',
  apiServer: 'https://kubernetes.default.svc',
  tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
  caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
  startTimeoutMs: 1_000,
  pollIntervalMs: 50,
  executorPort: 5100,
  terminationGraceSeconds: 30,
  imagePullSecrets: [],
};

/** Каталог профилей provisioner'а (fallback, когда спецификация не пришла). */
const K8S_PROFILES = {
  default: { image: 'registry.example/synth-executor:catalog' },
};

/** In-memory Kubernetes API: поды, секреты и DaemonSet'ы в одном namespace. */
class FakeKubernetesClient implements KubernetesClient {
  readonly createdPods: KubernetesManifest[] = [];
  readonly createdDaemonSets: KubernetesManifest[] = [];
  readonly deletedDaemonSets: string[] = [];
  private readonly pods = new Map<string, KubernetesPod>();
  private readonly secrets = new Map<string, KubernetesSecret>();
  private readonly daemonSets = new Map<string, KubernetesDaemonSet>();

  async listPods(): Promise<KubernetesPod[]> {
    return [];
  }

  async getPod(name: string): Promise<KubernetesPod | null> {
    const pod = this.pods.get(name);
    if (pod === undefined) return null;
    pod.status = {
      phase: 'Running',
      podIP: '10.0.0.5',
      conditions: [{ type: 'Ready', status: 'True' }],
    };
    return pod;
  }

  async createPod(manifest: KubernetesManifest): Promise<boolean> {
    this.createdPods.push(manifest);
    const name = String((manifest.metadata as { name?: string } | undefined)?.name ?? '');
    if (this.pods.has(name)) return false;
    this.pods.set(name, {
      metadata: manifest.metadata as KubernetesPod['metadata'],
      status: { phase: 'Pending' },
    });
    return true;
  }

  async deletePod(name: string): Promise<void> {
    this.pods.delete(name);
  }

  async createSecret(manifest: KubernetesManifest): Promise<boolean> {
    const name = String((manifest.metadata as { name?: string } | undefined)?.name ?? '');
    if (this.secrets.has(name)) return false;
    this.secrets.set(name, manifest as unknown as KubernetesSecret);
    return true;
  }

  async getSecret(name: string): Promise<KubernetesSecret | null> {
    return this.secrets.get(name) ?? null;
  }

  async deleteSecret(name: string): Promise<void> {
    this.secrets.delete(name);
  }

  async createDaemonSet(manifest: KubernetesManifest): Promise<boolean> {
    this.createdDaemonSets.push(manifest);
    const name = String((manifest.metadata as { name?: string } | undefined)?.name ?? '');
    if (this.daemonSets.has(name)) return false;
    this.daemonSets.set(name, {
      metadata: manifest.metadata as KubernetesDaemonSet['metadata'],
      status: { numberReady: 2, desiredNumberScheduled: 2 },
    });
    return true;
  }

  async getDaemonSet(name: string): Promise<KubernetesDaemonSet | null> {
    return this.daemonSets.get(name) ?? null;
  }

  async deleteDaemonSet(name: string): Promise<void> {
    this.deletedDaemonSets.push(name);
    this.daemonSets.delete(name);
  }
}

/** Приложение provisioner'а с Kubernetes-провайдером (без кластера и TLS). */
function makeKubernetesHarness(): { app: Hono; client: FakeKubernetesClient } {
  const client = new FakeKubernetesClient();
  const provider = new KubernetesPoolProvisioner({
    client,
    kubernetes: KUBERNETES,
    profiles: K8S_PROFILES,
  });
  const metrics = createProvisionerMetrics({ profiles: Object.keys(K8S_PROFILES) });
  const service = new PoolService({
    provider,
    metrics,
    idleTimeoutMs: 900_000,
    sessionIdleTimeoutMs: 300_000,
    maxLifetimeMs: 43_200_000,
    drainGraceMs: 30_000,
    maxPools: 50,
  });
  metrics.setPoolSource(() => service.list());
  const app = createProvisionerApp({
    token: TOKEN,
    service,
    metrics,
    providerName: 'kubernetes',
    limits: {
      maxPools: 50,
      idleTimeoutMs: 900_000,
      sessionIdleTimeoutMs: 300_000,
      maxLifetimeMs: 43_200_000,
      drainGraceMs: 30_000,
    },
  });
  return { app, client };
}

/** Созданный под в разбираемом виде (манифест — `Record<string, unknown>`). */
interface PodView {
  metadata?: { labels?: Record<string, string> };
  spec?: {
    containers?: Array<{
      image?: string;
      env?: Array<{ name: string; value?: string }>;
      resources?: unknown;
    }>;
  };
}

describe('provisioner: аутентификация', () => {
  it('без токена — 401', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', { body: ensureBody(), token: null });
    expect(res.status).toBe(401);
    expect((await readError(res)).reason).toBe('unauthorized');
  });

  it('с неверным токеном — 401', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody(),
      token: 'wrong-token',
    });
    expect(res.status).toBe(401);
  });

  it('текст ошибки не содержит ожидаемый токен', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/v1/pools', { token: 'wrong-token' });
    expect(await res.text()).not.toContain(TOKEN);
  });

  it('/health — без токена, 200', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/health', { token: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: 'static' });
  });

  it('неизвестный маршрут с токеном — 404 JSON', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/v1/unknown');
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });
});

describe('provisioner: ensure', () => {
  it('выдаёт url и токен', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; token: string };
    expect(body.url).toBe('http://executor-p1:5100');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
  });

  it('идемпотентен: тот же url и токен на повторный ключ', async () => {
    const { app } = makeHarness();
    const first = (await (await request(app, 'POST', '/v1/pools', { body: ensureBody() })).json()) as {
      url: string;
      token: string;
    };
    const second = (await (await request(app, 'POST', '/v1/pools', { body: ensureBody() })).json()) as {
      url: string;
      token: string;
    };
    expect(second).toEqual(first);
  });

  it('по профилю, когда точного ключа нет', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({
        key: 'session:s1:browser:default',
        scope: 'session',
        id: 's1',
        class: 'browser',
        profile: 'browser',
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe('http://browser:4200');
  });

  // PROP-135 слайс 5a: класс `sandbox` — аддитивное значение (протокол не
  // повышен). Пул песочницы адресуется профилем; `exec`/`browser` не сломаны.
  it('класс sandbox принимается, пул — по профилю', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({
        key: 'session:s1:sandbox:default',
        scope: 'session',
        id: 's1',
        class: 'sandbox',
        profile: 'default',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; token: string };
    expect(body.url).toBe('http://executor-default:5100');
    expect(body.token.length).toBeGreaterThan(0);
  });

  it('неизвестный класс пула — 400 invalid_request (fail-closed)', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: { ...ensureBody(), class: 'shell' },
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('неизвестный профиль — 404 pool_not_found', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ key: 'project:p9:exec:missing', id: 'p9', profile: 'missing' }),
    });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('pool_not_found');
  });

  it('невалидное тело — 400 invalid_request', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', { body: { scope: 'project' } });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('project без id — 400 (изоляция пулов)', async () => {
    const { app } = makeHarness();
    const body = ensureBody();
    delete (body as { id?: string }).id;
    const res = await request(app, 'POST', '/v1/pools', { body });
    expect(res.status).toBe(400);
    expect((await readError(res)).message).toContain('id');
  });

  it('workspaceSubPath: относительный путь принимается, небезопасный — 400', async () => {
    const { app } = makeHarness();
    const ok = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ workspaceSubPath: 'proj-slug/.worktrees/x' }),
    });
    expect(ok.status).toBe(200);
    for (const workspaceSubPath of ['../x', '/abs', 'a//b']) {
      const res = await request(app, 'POST', '/v1/pools', {
        body: ensureBody({ key: 'project:p2:exec:default', id: 'p2', workspaceSubPath }),
      });
      expect(res.status).toBe(400);
      expect((await readError(res)).reason).toBe('invalid_request');
    }
  });

  it('невалидный JSON — 400', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', { raw: '__not_json__' });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('превышение MAX_POOLS — 429 capacity', async () => {
    const { app } = makeHarness({ maxPools: 1 });
    expect((await request(app, 'POST', '/v1/pools', { body: ensureBody() })).status).toBe(200);
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ key: 'project:p2:exec:default', id: 'p2' }),
    });
    expect(res.status).toBe(429);
    expect((await readError(res)).reason).toBe('capacity');
  });
});

describe('provisioner: спецификация профиля (profileSpec)', () => {
  it('spec принят: под создан по спецификации (image/network/resources/mcp)', async () => {
    const { app, client } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({
        profileSpec: {
          image: 'registry.example/synth-executor:ui',
          network: 'restricted',
          resources: { limits: { cpu: '2', memory: '4Gi' } },
          mcpServers: [
            { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);

    const pod = client.createdPods[0] as PodView;
    const container = pod.spec?.containers?.[0];
    // Образ — из спецификации, а не из каталога provisioner'а.
    expect(container?.image).toBe('registry.example/synth-executor:ui');
    expect(pod.metadata?.labels?.['synth.io/network']).toBe('restricted');
    expect(container?.resources).toEqual({ limits: { cpu: '2', memory: '4Gi' } });
    // MCP-серверы спецификации — в env пода (JSON, как ждёт исполнитель).
    const mcp = container?.env?.find((entry) => entry.name === 'SYNTH_EXECUTOR_MCP_SERVERS');
    expect(JSON.parse(mcp?.value ?? '[]')).toEqual([
      { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} },
    ]);
  });

  it("без spec под создаётся по каталогу provisioner'а (прежнее поведение)", async () => {
    const { app, client } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    expect(res.status).toBe(200);

    const pod = client.createdPods[0] as PodView;
    expect(pod.spec?.containers?.[0]?.image).toBe('registry.example/synth-executor:catalog');
  });

  it('невалидный spec — 400 invalid_request (строгая схема)', async () => {
    const { app } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      // Лишнее поле внутри spec — ошибка **разбора тела** (не типизации).
      body: {
        ...ensureBody(),
        profileSpec: { image: 'registry.example/synth-executor:ui', unknownField: 1 },
      } as unknown as EnsurePoolRequest,
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('spec без image — 400 invalid_request (fail-closed: под не из чего поднять)', async () => {
    const { app } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ profileSpec: { network: 'restricted' } }),
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('spec важнее каталога: неизвестный в каталоге профиль создаётся по spec', async () => {
    const { app, client } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({
        key: 'project:p1:exec:ui-profile',
        profile: 'ui-profile',
        profileSpec: { image: 'registry.example/synth-executor:ui' },
      }),
    });
    expect(res.status).toBe(200);
    const pod = client.createdPods[0] as PodView;
    expect(pod.spec?.containers?.[0]?.image).toBe('registry.example/synth-executor:ui');
  });

  it('static: spec игнорируется — адрес пула из каталога', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({
        profileSpec: { image: 'registry.example/synth-executor:ui' },
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe('http://executor-p1:5100');
  });
});

describe('provisioner: touch / drain / delete', () => {
  it('touch известного пула — 204, неизвестного — 404', async () => {
    const { app } = makeHarness();
    await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    const touch = await request(app, 'POST', '/v1/pools/project%3Ap1%3Aexec%3Adefault/touch');
    expect(touch.status).toBe(204);
    const missing = await request(app, 'POST', '/v1/pools/project%3Ap9%3Aexec%3Adefault/touch');
    expect(missing.status).toBe(404);
    expect((await readError(missing)).reason).toBe('not_found');
  });

  it('drain — 202, повторно 202, состояние draining', async () => {
    const { app, service } = makeHarness();
    await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    const first = await request(app, 'POST', '/v1/pools/project%3Ap1%3Aexec%3Adefault/drain');
    expect(first.status).toBe(202);
    expect(service.get('project:p1:exec:default')?.state).toBe('draining');
    const second = await request(app, 'POST', '/v1/pools/project%3Ap1%3Aexec%3Adefault/drain');
    expect(second.status).toBe(202);
  });

  it('delete — 202 и удаляет пул; повторно — 404', async () => {
    const { app, service } = makeHarness();
    await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    const first = await request(app, 'DELETE', '/v1/pools/project%3Ap1%3Aexec%3Adefault');
    expect(first.status).toBe(202);
    expect(service.size()).toBe(0);
    const second = await request(app, 'DELETE', '/v1/pools/project%3Ap1%3Aexec%3Adefault');
    expect(second.status).toBe(404);
  });

  it('ключ с «:» в URL-кодировке работает во всех путях', async () => {
    const { app } = makeHarness();
    const key = 'session:s-1:exec:default';
    await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ key, scope: 'session', id: 's-1' }),
    });
    const encoded = encodeURIComponent(key);
    expect((await request(app, 'POST', `/v1/pools/${encoded}/touch`)).status).toBe(204);
    expect((await request(app, 'POST', `/v1/pools/${encoded}/drain`)).status).toBe(202);
    expect((await request(app, 'DELETE', `/v1/pools/${encoded}`)).status).toBe(202);
  });
});

describe('provisioner: диагностика и метрики', () => {
  it('GET /v1/pools — список без токенов пулов', async () => {
    const { app } = makeHarness();
    const ensured = (await (await request(app, 'POST', '/v1/pools', { body: ensureBody() })).json()) as {
      token: string;
    };
    const res = await request(app, 'GET', '/v1/pools');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(ensured.token);
    const body = JSON.parse(text) as { pools: Array<{ key: string; state: string }> };
    expect(body.pools).toHaveLength(1);
    expect(body.pools[0]?.key).toBe('project:p1:exec:default');
    expect(body.pools[0]?.state).toBe('ready');
  });

  it('GET /v1/capabilities — провайдер, профили, протокол, лимиты', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/v1/capabilities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      profiles: string[];
      protocol: number;
      limits: { maxPools: number };
    };
    expect(body.provider).toBe('static');
    expect(body.profiles.sort()).toEqual(['browser', 'default']);
    expect(body.protocol).toBe(1);
    expect(body.limits.maxPools).toBe(50);
  });

  it('GET /v1/profiles — имена, описание и метаданные без секретов', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/v1/profiles');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profiles: Array<{ name: string; description?: string }>;
    };
    expect(body.profiles).toEqual([
      { name: 'default', description: 'Базовый исполнитель' },
      { name: 'browser' },
    ]);

    const text = JSON.stringify(body);
    // Env профиля, команды/аргументы/env MCP-серверов, адреса и токены — не
    // отдаются (инвариант 13).
    expect(text).not.toContain('env-secret-value');
    expect(text).not.toContain('mcp-secret-value');
    expect(text).not.toContain('npx');
    expect(text).not.toContain('@playwright/mcp');
    expect(text).not.toContain('http://executor-default');
    expect(text).not.toContain(TOKEN);
  });

  it('GET /v1/profiles без токена — 401', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/v1/profiles', { token: null });
    expect(res.status).toBe(401);
  });

  it('/metrics без токена — 401', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/metrics', { token: null });
    expect(res.status).toBe(401);
  });

  it('/metrics с токеном — exposition 0.0.4 и no-store', async () => {
    const { app } = makeHarness();
    await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    const res = await request(app, 'GET', '/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain('# TYPE synth_provisioner_pools gauge');
    expect(text).toContain('synth_provisioner_pools{profile="default",state="ready"} 1');
    expect(text).toContain('synth_provisioner_provision_total{outcome="ok"} 1');
  });
});

/* ---------------------------------------------------------------------------
 * Прогрев образов (`POST /v1/images/warm`): DaemonSet на образ → ожидание
 * готовности → удаление. Ошибка одного образа не валит остальные.
 * ------------------------------------------------------------------------ */
describe('provisioner: прогрев образов', () => {
  it('200: итог по каждому образу, DaemonSet создан и удалён', async () => {
    const { app, client } = makeKubernetesHarness();
    const image = 'registry.example/synth-executor:0.13.8';
    const res = await request(app, 'POST', '/v1/images/warm', {
      body: { images: [image] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ image: string; ok: boolean; nodes: number; error?: string }>;
    };
    expect(body.results).toEqual([{ image, ok: true, nodes: 2 }]);
    expect(client.createdDaemonSets).toHaveLength(1);
    expect(client.deletedDaemonSets).toHaveLength(1);
  });

  it('401: без токена прогрев недоступен', async () => {
    const { app } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/images/warm', {
      body: { images: ['registry.example/synth-executor:0.13.8'] },
      token: null,
    });
    expect(res.status).toBe(401);
  });

  it('400: пустой список образов', async () => {
    const { app } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/images/warm', { body: { images: [] } });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('400: невалидная ссылка на образ', async () => {
    const { app } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/images/warm', {
      body: { images: ['не образ!'] },
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('400: больше 20 образов', async () => {
    const { app } = makeKubernetesHarness();
    const images = Array.from({ length: 21 }, (_, index) => `registry.example/img:${index}`);
    const res = await request(app, 'POST', '/v1/images/warm', { body: { images } });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('400: неизвестное поле в теле — strict-схема', async () => {
    const { app } = makeKubernetesHarness();
    const res = await request(app, 'POST', '/v1/images/warm', {
      body: { images: ['registry.example/synth-executor:0.13.8'], unknownField: 1 },
    });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('static: прогрев не поддерживается — invalid_request', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/images/warm', {
      body: { images: ['registry.example/synth-executor:0.13.8'] },
    });
    expect(res.status).toBe(400);
    const error = await readError(res);
    expect(error.reason).toBe('invalid_request');
    expect(error.message).toContain('kubernetes');
  });
});
