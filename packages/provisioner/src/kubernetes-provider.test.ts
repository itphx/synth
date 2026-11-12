/**
 * Kubernetes-провайдер пулов: под + секрет на ключ (PROP-135, Ф4b-2b).
 *
 * K8s API подменяется in-memory реализацией `KubernetesClient` (шов): тесты
 * проверяют поведение провайдера — создание/усыновление/таймаут/subPath/
 * drain/release — без кластера и TLS.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVISIONER_ENV,
  PROVISIONER_KUBERNETES_ENV,
  resolveProvisionerConfig,
} from './config.js';
import type {
  ProvisionerExecutorCommandPolicyConfig,
  ProvisionerKubernetesConfig,
  ProvisionerProfiles,
} from './config.js';
import { createProvisionerMetrics } from './metrics.js';
import { PoolProvisionerError } from './errors.js';
import type {
  KubernetesClient,
  KubernetesManifest,
  KubernetesPod,
  KubernetesSecret,
} from './kubernetes.js';
import {
  COMMAND_POLICY_ANNOTATION,
  COMMAND_POLICY_MOUNT_PATH,
  COMMAND_POLICY_TOKEN_FILE,
  COMMAND_POLICY_TOKEN_KEY,
  KUBERNETES_PROVIDER_NAME,
  KubernetesPoolProvisioner,
  POOL_HASH_LABEL,
  POOL_KEY_ANNOTATION,
  POOL_NETWORK_LABEL,
  POOL_PROFILE_LABEL,
  buildPoolPodManifest,
  commandPolicyFingerprint,
  mcpServersFingerprint,
  poolHash,
  poolObjectName,
  sanitizeLabelValue,
} from './kubernetes-provider.js';
import { createPoolProvisioner } from './provider.js';
import type { EnsurePoolRequest } from './protocol.js';

/** Конфигурация провайдера для тестов. */
const KUBERNETES: ProvisionerKubernetesConfig = {
  namespace: 'synth',
  workspacePvc: 'synth-workspace',
  workspaceMount: '/var/synth/data/workspaces',
  serviceAccount: 'synth-executor',
  imagePullSecrets: ['regcred'],
  apiServer: 'https://kubernetes.default.svc',
  tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
  caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
  startTimeoutMs: 1_000,
  pollIntervalMs: 100,
  executorPort: 5100,
  terminationGraceSeconds: 30,
};

/** Профили: полный (для проверки pod spec) и минимальный. */
const PROFILES: ProvisionerProfiles = {
  full: {
    image: 'registry.example/synth-executor:0.13.8',
    network: 'restricted',
    runtimeClass: 'gvisor',
    readOnlyRootFilesystem: false,
    resources: {
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2', memory: '4Gi' },
    },
    env: { SYNTH_EXECUTOR_MAX_CONCURRENCY: '2' },
  },
  default: { image: 'registry.example/synth-executor:0.13.8' },
};

/** Запрос пула. */
function request(overrides: Partial<EnsurePoolRequest> = {}): EnsurePoolRequest {
  return {
    key: 'project:p1:exec:default',
    scope: 'project',
    id: 'p1',
    class: 'exec',
    profile: 'default',
    ...overrides,
  };
}

/** base64-токен из секрета. */
function secretTokenOf(secret: KubernetesSecret | undefined): string {
  const raw = secret?.data?.token ?? '';
  return Buffer.from(raw, 'base64').toString('utf8');
}

/** In-memory Kubernetes API: поды и секреты в одном namespace. */
class FakeKubernetesClient implements KubernetesClient {
  readonly pods = new Map<string, KubernetesPod>();
  readonly secrets = new Map<string, KubernetesSecret>();
  readonly createdPods: KubernetesManifest[] = [];
  readonly createdSecrets: KubernetesManifest[] = [];
  readonly deletedPods: Array<{ name: string; graceSeconds: number }> = [];
  readonly deletedSecrets: string[] = [];
  readonly selectors: string[] = [];
  readonly getPodCalls: string[] = [];

  /** Сколько раз `getPod` вернёт Pending, прежде чем под станет Running. */
  pendingGets = 0;
  /** Принудительный сбой `getPod` (например, 403). */
  failGetPod: Error | undefined;
  /** Принудительный сбой `createPod`. */
  failCreatePod: Error | undefined;
  /** Принудительный сбой `deletePod`. */
  failDeletePod: Error | undefined;

  async listPods(labelSelector: string): Promise<KubernetesPod[]> {
    this.selectors.push(labelSelector);
    const [pair] = labelSelector.split(',');
    const [label, value] = (pair ?? '').split('=');
    return [...this.pods.values()].filter(
      (pod) => pod.metadata?.labels?.[label ?? ''] === value,
    );
  }

  async getPod(name: string): Promise<KubernetesPod | null> {
    this.getPodCalls.push(name);
    if (this.failGetPod !== undefined) throw this.failGetPod;
    const pod = this.pods.get(name);
    if (pod === undefined) return null;
    if (this.pendingGets > 0) {
      this.pendingGets -= 1;
      return pod;
    }
    if (pod.status?.phase !== 'Running') {
      pod.status = { phase: 'Running', podIP: '10.0.0.5', conditions: [{ type: 'Ready', status: 'True' }] };
    }
    return pod;
  }

  async createPod(manifest: KubernetesManifest): Promise<boolean> {
    this.createdPods.push(manifest);
    if (this.failCreatePod !== undefined) throw this.failCreatePod;
    const name = String((manifest.metadata as { name?: string } | undefined)?.name ?? '');
    if (this.pods.has(name)) return false;
    this.pods.set(name, {
      metadata: manifest.metadata as KubernetesPod['metadata'],
      status: { phase: 'Pending' },
    });
    return true;
  }

  async deletePod(name: string, graceSeconds: number): Promise<void> {
    this.deletedPods.push({ name, graceSeconds });
    if (this.failDeletePod !== undefined) throw this.failDeletePod;
    // 404 — no-op: удаление идемпотентно.
    this.pods.delete(name);
  }

  async createSecret(manifest: KubernetesManifest): Promise<boolean> {
    this.createdSecrets.push(manifest);
    const name = String((manifest.metadata as { name?: string } | undefined)?.name ?? '');
    if (this.secrets.has(name)) return false;
    this.secrets.set(name, manifest as unknown as KubernetesSecret);
    return true;
  }

  async getSecret(name: string): Promise<KubernetesSecret | null> {
    return this.secrets.get(name) ?? null;
  }

  async deleteSecret(name: string): Promise<void> {
    this.deletedSecrets.push(name);
    this.secrets.delete(name);
  }
}

/** Провайдер с фейковым клиентом и управляемыми часами/паузой. */
function makeProvider(
  client: FakeKubernetesClient,
  overrides: {
    now?: () => number;
    profiles?: ProvisionerProfiles;
    metrics?: ReturnType<typeof createProvisionerMetrics>;
    commandPolicy?: ProvisionerExecutorCommandPolicyConfig;
  } = {},
): { provider: KubernetesPoolProvisioner; clock: { value: number } } {
  const clock = { value: 1_000 };
  const provider = new KubernetesPoolProvisioner({
    client,
    kubernetes: KUBERNETES,
    profiles: overrides.profiles ?? PROFILES,
    now: overrides.now ?? (() => clock.value),
    sleep: async (ms) => {
      clock.value += ms;
    },
    ...(overrides.metrics !== undefined ? { metrics: overrides.metrics } : {}),
    ...(overrides.commandPolicy !== undefined ? { commandPolicy: overrides.commandPolicy } : {}),
  });
  return { provider, clock };
}

/** Конфигурация чекера команд для тестов (policy-token — не секрет теста). */
function policy(
  overrides: Partial<ProvisionerExecutorCommandPolicyConfig> = {},
): ProvisionerExecutorCommandPolicyConfig {
  return {
    enabled: true,
    provider: 'http',
    url: 'http://policy:8080',
    failMode: 'closed',
    timeoutMs: 2000,
    cacheTtlMs: 60000,
    opaPath: '/v1/data/synth/exec/decision',
    ...overrides,
  };
}

describe('provisioner: kubernetes-провайдер', () => {
  it('ensure создаёт секрет и под, затем возвращает podIP и токен', async () => {
    const client = new FakeKubernetesClient();
    client.pendingGets = 1;
    const { provider } = makeProvider(client);

    const pool = await provider.ensure(request());
    const hash = poolHash('project:p1:exec:default');
    const name = poolObjectName(hash);

    expect(pool.url).toBe('http://10.0.0.5:5100');
    expect(pool.token).not.toBe('');
    expect(client.createdSecrets).toHaveLength(1);
    expect(client.createdPods).toHaveLength(1);
    expect(secretTokenOf(client.secrets.get(name))).toBe(pool.token);
    expect(client.selectors[0]).toBe(`${POOL_HASH_LABEL}=${hash}`);
    expect(name).toBe(`synth-pool-${hash}`);
    expect(hash).toHaveLength(16);
  });

  it('adopt: готовый под не пересоздаётся, токен читается из секрета', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    // Первый пул создан «прошлым процессом» provisioner'а.
    const first = await provider.ensure(request());
    const createdPods = client.createdPods.length;
    const createdSecrets = client.createdSecrets.length;

    const adopted = await provider.ensure(request());
    expect(adopted).toEqual(first);
    expect(client.createdPods).toHaveLength(createdPods);
    expect(client.createdSecrets).toHaveLength(createdSecrets);
  });

  it('таймаут: под и секрет удаляются, ошибка provider_error', async () => {
    const client = new FakeKubernetesClient();
    // Под остаётся Pending навсегда.
    client.pendingGets = Number.MAX_SAFE_INTEGER;
    const metrics = createProvisionerMetrics({ profiles: ['default'] });
    const { provider } = makeProvider(client, { metrics });

    await expect(provider.ensure(request())).rejects.toMatchObject({
      name: 'PoolProvisionerError',
      reason: 'provider_error',
    });
    const hash = poolHash('project:p1:exec:default');
    expect(client.pods.size).toBe(0);
    expect(client.secrets.size).toBe(0);
    expect(client.deletedPods.map((item) => item.name)).toContain(poolObjectName(hash));
    expect(client.deletedSecrets).toContain(poolObjectName(hash));
    const text = metrics.render().text;
    expect(text).toContain('synth_provisioner_provider_errors_total{reason="wait"} 1');
    expect(text).toContain('synth_provisioner_ensure_seconds_count{provider="kubernetes"} 1');
  });

  it('некорректный workspaceSubPath — invalid_request без обращения к API', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    for (const subPath of ['../x', '/abs', 'a//b', 'a/', '.', 'a/./b', '']) {
      await expect(provider.ensure(request({ workspaceSubPath: subPath }))).rejects.toMatchObject({
        reason: 'invalid_request',
      });
    }
    expect(client.createdPods).toHaveLength(0);
    expect(client.createdSecrets).toHaveLength(0);
    expect(client.selectors).toHaveLength(0);
  });

  it('workspaceSubPath попадает в subPath тома workspace', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    await provider.ensure(request({ workspaceSubPath: 'proj/.worktrees/x' }));
    const spec = client.createdPods[0]?.spec as {
      containers: Array<{ volumeMounts: Array<Record<string, unknown>> }>;
    };
    const workspace = spec.containers[0]?.volumeMounts.find((mount) => mount.name === 'workspace');
    expect(workspace).toMatchObject({
      name: 'workspace',
      mountPath: KUBERNETES.workspaceMount,
      subPath: 'proj/.worktrees/x',
    });
  });

  it('pod spec: labels, annotations, securityContext, ресурсы, сеть, runtimeClass, pull secrets', () => {
    const manifest = buildPoolPodManifest({
      key: 'project:p1:exec:full',
      hash: poolHash('project:p1:exec:full'),
      profileName: 'full',
      profile: PROFILES.full!,
      kubernetes: KUBERNETES,
      secretName: 'synth-pool-abc',
      workspaceSubPath: 'proj-slug',
    });
    const metadata = manifest.metadata as {
      name: string;
      namespace: string;
      labels: Record<string, string>;
      annotations: Record<string, string>;
    };
    expect(metadata.name).toBe(`synth-pool-${poolHash('project:p1:exec:full')}`);
    expect(metadata.namespace).toBe('synth');
    expect(metadata.labels).toMatchObject({
      'app.kubernetes.io/name': 'synth-executor',
      'app.kubernetes.io/managed-by': 'synth-provisioner',
      [POOL_HASH_LABEL]: poolHash('project:p1:exec:full'),
      [POOL_PROFILE_LABEL]: 'full',
      [POOL_NETWORK_LABEL]: 'restricted',
    });
    expect(metadata.annotations[POOL_KEY_ANNOTATION]).toBe('project:p1:exec:full');

    const spec = manifest.spec as {
      restartPolicy: string;
      terminationGracePeriodSeconds: number;
      serviceAccountName: string;
      imagePullSecrets: Array<{ name: string }>;
      runtimeClassName: string;
      securityContext: Record<string, unknown>;
      containers: Array<{
        name: string;
        image: string;
        ports: Array<{ containerPort: number }>;
        env: Array<{ name: string; value?: string; valueFrom?: unknown }>;
        resources: Record<string, unknown>;
        securityContext: Record<string, unknown>;
        volumeMounts: Array<Record<string, unknown>>;
      }>;
      volumes: Array<Record<string, unknown>>;
    };
    expect(spec.restartPolicy).toBe('Never');
    expect(spec.terminationGracePeriodSeconds).toBe(30);
    expect(spec.serviceAccountName).toBe('synth-executor');
    expect(spec.imagePullSecrets).toEqual([{ name: 'regcred' }]);
    expect(spec.runtimeClassName).toBe('gvisor');
    expect(spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });

    const container = spec.containers[0]!;
    expect(container.name).toBe('executor');
    expect(container.image).toBe('registry.example/synth-executor:0.13.8');
    expect(container.ports[0]?.containerPort).toBe(5100);
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(container.resources).toEqual({
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2', memory: '4Gi' },
    });
    expect(container.env).toEqual(
      expect.arrayContaining([
        { name: 'SYNTH_EXECUTOR_HOST', value: '0.0.0.0' },
        { name: 'SYNTH_EXECUTOR_PORT', value: '5100' },
        { name: 'SYNTH_EXECUTOR_WORKSPACE', value: '/var/synth/data/workspaces' },
        { name: 'SYNTH_EXECUTOR_MAX_CONCURRENCY', value: '2' },
      ]),
    );
    expect(container.env.find((item) => item.name === 'SYNTH_EXECUTOR_TOKEN')).toEqual({
      name: 'SYNTH_EXECUTOR_TOKEN',
      valueFrom: { secretKeyRef: { name: 'synth-pool-abc', key: 'token' } },
    });
    expect(container.volumeMounts[0]).toMatchObject({
      name: 'workspace',
      subPath: 'proj-slug',
    });
    expect(spec.volumes[0]).toEqual({
      name: 'workspace',
      persistentVolumeClaim: { claimName: 'synth-workspace' },
    });
  });

  /**
   * PROP-135 слайз 5b-1: MCP-серверы профиля → env `SYNTH_EXECUTOR_MCP_SERVERS`
   * (JSON, формат исполнителя). Пустой состав — переменной нет (дефолт образа
   * остаётся в силе).
   */
  it('pod spec: mcpServers профиля → env SYNTH_EXECUTOR_MCP_SERVERS (JSON)', () => {
    const manifest = buildPoolPodManifest({
      key: 'project:p1:browser:browser',
      hash: poolHash('project:p1:browser:browser'),
      profileName: 'browser',
      profile: {
        image: 'registry.example/synth-executor:0.13.8-browser',
        mcpServers: [
          {
            name: 'playwright',
            command: 'playwright-mcp',
            args: ['--headless', '--no-sandbox'],
            env: { MCP_HOSTING_TOKEN: 'placeholder' },
          },
        ],
      },
      kubernetes: KUBERNETES,
      secretName: 'synth-pool-abc',
    });
    const spec = manifest.spec as {
      containers: Array<{ env: Array<{ name: string; value?: string }> }>;
    };
    const item = spec.containers[0]!.env.find((e) => e.name === 'SYNTH_EXECUTOR_MCP_SERVERS');
    expect(item).toBeDefined();
    expect(JSON.parse(item!.value ?? '[]')).toEqual([
      {
        name: 'playwright',
        command: 'playwright-mcp',
        args: ['--headless', '--no-sandbox'],
        env: { MCP_HOSTING_TOKEN: 'placeholder' },
      },
    ]);
  });

  it('pod spec: без mcpServers переменной нет (дефолт образа остаётся)', () => {
    const manifest = buildPoolPodManifest({
      key: 'project:p1:exec:default',
      hash: poolHash('project:p1:exec:default'),
      profileName: 'default',
      profile: PROFILES.default!,
      kubernetes: KUBERNETES,
      secretName: 'synth-pool-abc',
    });
    const spec = manifest.spec as {
      containers: Array<{ env: Array<{ name: string }> }>;
    };
    expect(
      spec.containers[0]!.env.find((e) => e.name === 'SYNTH_EXECUTOR_MCP_SERVERS'),
    ).toBeUndefined();
  });

  it('отпечаток состава MCP-серверов: пусто → off, состав → хеш', () => {
    expect(mcpServersFingerprint(PROFILES.default!)).toBe('off');
    const withServers = mcpServersFingerprint({
      image: 'x',
      mcpServers: [{ name: 'playwright', command: 'playwright-mcp' }],
    });
    expect(withServers).toMatch(/^v1:[0-9a-f]{16}$/);
    // Смена состава — смена отпечатка (под пересоздаётся: env пода неизменяем).
    expect(
      mcpServersFingerprint({
        image: 'x',
        mcpServers: [{ name: 'playwright', command: 'playwright-mcp', args: ['--headless'] }],
      }),
    ).not.toBe(withServers);
  });

  it('read-only корневая ФС по умолчанию даёт emptyDir на /tmp и HOME', () => {    const manifest = buildPoolPodManifest({
      key: 'project:p1:exec:default',
      hash: poolHash('project:p1:exec:default'),
      profileName: 'default',
      profile: PROFILES.default!,
      kubernetes: KUBERNETES,
      secretName: 'synth-pool-abc',
    });
    const spec = manifest.spec as {
      containers: Array<{ securityContext: Record<string, unknown>; volumeMounts: Array<Record<string, unknown>> }>;
      volumes: Array<Record<string, unknown>>;
    };
    expect(spec.containers[0]?.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(spec.containers[0]?.volumeMounts).toContainEqual({ name: 'tmp', mountPath: '/tmp' });
    expect(spec.containers[0]?.volumeMounts).toContainEqual({
      name: 'home',
      mountPath: '/home/synth',
    });
    expect(spec.volumes).toContainEqual({ name: 'tmp', emptyDir: {} });
    expect(spec.volumes).toContainEqual({ name: 'home', emptyDir: {} });
  });

  it('terminating-под не усыновляется: ждём удаления и создаём заново', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    const hash = poolHash('project:p1:exec:default');
    const name = poolObjectName(hash);
    // Под «на выход»: Ready, но с deletionTimestamp; getPod вернёт его дважды.
    client.pods.set(name, {
      metadata: { name, labels: { [POOL_HASH_LABEL]: hash }, deletionTimestamp: '2026-11-12T00:00:00Z' },
      status: { phase: 'Running', podIP: '10.0.0.9', conditions: [{ type: 'Ready', status: 'True' }] },
    });
    let seen = 0;
    const getPod = client.getPod.bind(client);
    client.getPod = async (podName: string): Promise<KubernetesPod | null> => {
      seen += 1;
      if (seen === 3) client.pods.delete(name);
      return getPod(podName);
    };

    const pool = await provider.ensure(request());
    expect(pool.url).toBe('http://10.0.0.5:5100');
    expect(client.createdPods).toHaveLength(1);
    expect(client.createdSecrets).toHaveLength(1);
  });

  it('под с другим профилем не усыновляется: пара снимается и создаётся заново', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    const hash = poolHash('project:p1:exec:default');
    const name = poolObjectName(hash);
    client.pods.set(name, {
      metadata: {
        name,
        labels: { [POOL_HASH_LABEL]: hash, [POOL_PROFILE_LABEL]: 'old-profile' },
      },
      status: { phase: 'Running', podIP: '10.0.0.9' },
    });
    client.secrets.set(name, {
      metadata: { name },
      data: { token: Buffer.from('stale-token', 'utf8').toString('base64') },
    });

    const pool = await provider.ensure(request());
    expect(pool.url).toBe('http://10.0.0.5:5100');
    expect(pool.token).not.toBe('stale-token');
    expect(client.deletedPods[0]).toEqual({ name, graceSeconds: 0 });
    expect(client.deletedSecrets).toContain(name);
    expect(client.createdPods).toHaveLength(1);
  });

  it('под без секрета удаляется немедленно (grace 0) и пересоздаётся', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    const hash = poolHash('project:p1:exec:default');
    const name = poolObjectName(hash);
    client.pods.set(name, {
      metadata: { name, labels: { [POOL_HASH_LABEL]: hash } },
      status: { phase: 'Running', podIP: '10.0.0.9' },
    });

    const pool = await provider.ensure(request());
    expect(pool.url).toBe('http://10.0.0.5:5100');
    expect(client.deletedPods[0]).toEqual({ name, graceSeconds: 0 });
    expect(client.createdPods).toHaveLength(1);
  });

  it('drain удаляет под, секрет остаётся (adopt после слива)', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    await provider.ensure(request());
    const hash = poolHash('project:p1:exec:default');

    await provider.drain('project:p1:exec:default');
    expect(client.pods.has(poolObjectName(hash))).toBe(false);
    expect(client.secrets.has(poolObjectName(hash))).toBe(true);
    expect(client.deletedPods.at(-1)).toEqual({
      name: poolObjectName(hash),
      graceSeconds: KUBERNETES.terminationGraceSeconds,
    });
  });

  it('release удаляет под и секрет; повторный release — no-op', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    await provider.ensure(request());
    const hash = poolHash('project:p1:exec:default');

    await provider.release('project:p1:exec:default');
    expect(client.pods.size).toBe(0);
    expect(client.secrets.size).toBe(0);
    expect(client.deletedPods.at(-1)).toEqual({ name: poolObjectName(hash), graceSeconds: 0 });

    await expect(provider.release('project:p1:exec:default')).resolves.toBeUndefined();
    expect(client.deletedSecrets.filter((name) => name === poolObjectName(hash))).toHaveLength(2);
  });

  it('403 от API — provider_error без токена в тексте', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    client.failCreatePod = new PoolProvisionerError(
      'provider_error',
      'Kubernetes API POST /api/v1/namespaces/synth/pods: 403 Forbidden',
    );

    try {
      await provider.ensure(request());
      expect.unreachable('ожидалась ошибка');
    } catch (err) {
      expect(err).toBeInstanceOf(PoolProvisionerError);
      const message = (err as Error).message;
      expect(message).toContain('403');
      const token = secretTokenOf(client.secrets.get(poolObjectName(poolHash('project:p1:exec:default'))));
      expect(token).not.toBe('');
      expect(message).not.toContain(token);
    }
  });

  it('неизвестный профиль — pool_not_found, ресурсы не создаются', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    await expect(
      provider.ensure(request({ key: 'project:p9:exec:missing', id: 'p9', profile: 'missing' })),
    ).rejects.toMatchObject({ reason: 'pool_not_found' });
    expect(client.createdPods).toHaveLength(0);
  });

  it('capabilities отдаёт провайдера и профили', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    await expect(provider.capabilities()).resolves.toEqual({
      provider: KUBERNETES_PROVIDER_NAME,
      profiles: ['full', 'default'],
    });
  });

  it('sanitizeLabelValue: длина ≤ 63 и допустимые символы', () => {
    expect(sanitizeLabelValue('default')).toBe('default');
    expect(sanitizeLabelValue('  Browser GPU ')).toBe('Browser-GPU');
    expect(sanitizeLabelValue('a'.repeat(100))).toHaveLength(63);
    expect(sanitizeLabelValue('***')).toBe('unknown');
  });

  it('существующий секрет без токена — понятная ошибка, под не создаётся', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client);
    const secretName = poolObjectName(poolHash('project:p1:exec:default'));
    client.secrets.set(secretName, { metadata: { name: secretName }, data: {} });

    await expect(provider.ensure(request())).rejects.toThrow(/не содержит токена/);
    expect(client.createdPods).toHaveLength(0);
  });

  it('фабрика собирает kubernetes-провайдера из конфигурации (инъекция клиента)', async () => {
    const token = ['provisioner-factory', 'token'].join('-');
    const config = resolveProvisionerConfig(
      {
        [PROVISIONER_ENV.token]: token,
        [PROVISIONER_ENV.provider]: 'kubernetes',
        [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { image: 'synth-executor:1' } }),
        [PROVISIONER_KUBERNETES_ENV.workspacePvc]: 'synth-workspace',
      },
      { readFile: () => '' },
    );
    const client = new FakeKubernetesClient();
    const provider = createPoolProvisioner(config, { client });
    await expect(provider.capabilities()).resolves.toEqual({
      provider: KUBERNETES_PROVIDER_NAME,
      profiles: ['default'],
    });
    const pool = await provider.ensure(request());
    expect(pool.url).toBe('http://10.0.0.5:5100');
  });

  it('pod spec без чекера: env политики не рендерится, аннотация off', () => {
    const manifest = buildPoolPodManifest({
      key: 'project:p1:exec:default',
      hash: poolHash('project:p1:exec:default'),
      profileName: 'default',
      profile: PROFILES.default!,
      kubernetes: KUBERNETES,
      secretName: 'synth-pool-abc',
    });
    const spec = manifest.spec as {
      containers: Array<{
        env: Array<{ name: string }>;
        volumeMounts: Array<{ name: string }>;
      }>;
      volumes: Array<{ name: string }>;
    };
    expect(spec.containers[0]?.env.some((item) => item.name.startsWith('SYNTH_EXECUTOR_COMMAND_POLICY'))).toBe(false);
    expect(spec.containers[0]?.volumeMounts.map((item) => item.name)).not.toContain('command-policy');
    expect(spec.volumes.map((item) => item.name)).not.toContain('command-policy');
    expect((manifest.metadata as { annotations: Record<string, string> }).annotations[
      COMMAND_POLICY_ANNOTATION
    ]).toBe('off');
  });

  it('pod spec с чекером: env политики без токена', () => {
    const manifest = buildPoolPodManifest({
      key: 'project:p1:exec:default',
      hash: poolHash('project:p1:exec:default'),
      profileName: 'default',
      profile: PROFILES.default!,
      kubernetes: KUBERNETES,
      secretName: 'synth-pool-abc',
      commandPolicy: policy({ provider: 'opa', failMode: 'open', timeoutMs: 900 }),
    });
    const spec = manifest.spec as {
      containers: Array<{
        env: Array<{ name: string; value?: string }>;
        volumeMounts: Array<{ name: string }>;
      }>;
    };
    const env = Object.fromEntries(
      spec.containers[0]!.env.map((item) => [item.name, item.value]),
    );
    expect(env.SYNTH_EXECUTOR_COMMAND_POLICY_PROVIDER).toBe('opa');
    expect(env.SYNTH_EXECUTOR_COMMAND_POLICY_URL).toBe('http://policy:8080');
    expect(env.SYNTH_EXECUTOR_COMMAND_POLICY_FAIL_MODE).toBe('open');
    expect(env.SYNTH_EXECUTOR_COMMAND_POLICY_TIMEOUT_MS).toBe('900');
    expect(env.SYNTH_EXECUTOR_COMMAND_POLICY_CACHE_TTL_MS).toBe('60000');
    expect(env.SYNTH_EXECUTOR_COMMAND_POLICY_OPA_PATH).toBe('/v1/data/synth/exec/decision');
    expect(env.SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE).toBeUndefined();
    expect(spec.containers[0]?.volumeMounts.map((item) => item.name)).not.toContain('command-policy');
  });

  it('pod spec с чекером и токеном: файл из Secret пула, режим 0440', () => {
    const manifest = buildPoolPodManifest({
      key: 'project:p1:exec:default',
      hash: poolHash('project:p1:exec:default'),
      profileName: 'default',
      profile: PROFILES.default!,
      kubernetes: KUBERNETES,
      secretName: 'synth-pool-abc',
      commandPolicy: policy({ token: 'policy-token' }),
    });
    const spec = manifest.spec as {
      containers: Array<{
        env: Array<{ name: string; value?: string }>;
        volumeMounts: Array<Record<string, unknown>>;
      }>;
      volumes: Array<Record<string, unknown>>;
    };
    const env = Object.fromEntries(
      spec.containers[0]!.env.map((item) => [item.name, item.value]),
    );
    expect(env.SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE).toBe(
      `${COMMAND_POLICY_MOUNT_PATH}/${COMMAND_POLICY_TOKEN_FILE}`,
    );
    expect(
      spec.containers[0]?.volumeMounts.find((mount) => mount.name === 'command-policy'),
    ).toMatchObject({
      name: 'command-policy',
      mountPath: COMMAND_POLICY_MOUNT_PATH,
      readOnly: true,
    });
    expect(spec.volumes.find((volume) => volume.name === 'command-policy')).toMatchObject({
      name: 'command-policy',
      secret: {
        secretName: 'synth-pool-abc',
        defaultMode: 0o440,
        items: [{ key: COMMAND_POLICY_TOKEN_KEY, path: COMMAND_POLICY_TOKEN_FILE }],
      },
    });
    expect(
      (manifest.metadata as { annotations: Record<string, string> }).annotations[
        COMMAND_POLICY_ANNOTATION
      ],
    ).toBe(commandPolicyFingerprint(policy({ token: 'policy-token' })));
  });

  it('ensure с чекером: токен чекера попадает в Secret пула (не в env)', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client, { commandPolicy: policy({ token: 'policy-token' }) });

    const pool = await provider.ensure(request());
    const name = poolObjectName(poolHash('project:p1:exec:default'));
    expect(pool.token).not.toBe('');
    const secret = client.secrets.get(name);
    expect(secret?.data?.[COMMAND_POLICY_TOKEN_KEY]).toBe(
      Buffer.from('policy-token', 'utf8').toString('base64'),
    );
    const pod = client.createdPods[0]?.spec as {
      containers: Array<{ env: Array<{ name: string; value?: string; valueFrom?: unknown }> }>;
    };
    const env = pod.containers[0]!.env;
    expect(env.some((item) => item.value === 'policy-token')).toBe(false);
    expect(env.find((item) => item.name === 'SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE')?.value).toBe(
      `${COMMAND_POLICY_MOUNT_PATH}/${COMMAND_POLICY_TOKEN_FILE}`,
    );
  });

  it('adopt с чекером: повторный ensure не пересоздаёт пару', async () => {
    const client = new FakeKubernetesClient();
    const { provider } = makeProvider(client, { commandPolicy: policy({ token: 'policy-token' }) });
    const first = await provider.ensure(request());
    const adopted = await provider.ensure(request());
    expect(adopted).toEqual(first);
    expect(client.createdPods).toHaveLength(1);
    expect(client.createdSecrets).toHaveLength(1);
  });

  it('adopt: включение чекера пересоздаёт под, созданный с прежней конфигурацией', async () => {
    const client = new FakeKubernetesClient();
    const { provider: before } = makeProvider(client);
    await before.ensure(request());

    const { provider: after } = makeProvider(client, {
      commandPolicy: policy({ token: 'policy-token' }),
    });
    const pool = await after.ensure(request());
    expect(pool.token).not.toBe('');
    expect(client.createdPods).toHaveLength(2);
    expect(client.deletedPods.map((item) => item.name)).toContain(
      poolObjectName(poolHash('project:p1:exec:default')),
    );
    const secret = client.secrets.get(poolObjectName(poolHash('project:p1:exec:default')));
    expect(secret?.data?.[COMMAND_POLICY_TOKEN_KEY]).toBeDefined();
  });

  /**
   * PROP-135 слайз 5b-1: env пода неизменяем — смена состава MCP-серверов
   * профиля требует пересоздания пода (иначе под остался бы со старым
   * `SYNTH_EXECUTOR_MCP_SERVERS`).
   */
  it('adopt: смена состава MCP-серверов пересоздаёт под', async () => {
    const client = new FakeKubernetesClient();
    const { provider: before } = makeProvider(client);
    await before.ensure(request());

    const { provider: after } = makeProvider(client, {
      profiles: {
        ...PROFILES,
        default: {
          image: PROFILES.default!.image,
          mcpServers: [{ name: 'playwright', command: 'playwright-mcp' }],
        },
      },
    });
    const pool = await after.ensure(request());
    expect(pool.token).not.toBe('');
    expect(client.createdPods).toHaveLength(2);
    expect(client.deletedPods.map((item) => item.name)).toContain(
      poolObjectName(poolHash('project:p1:exec:default')),
    );
  });

  it('adopt: старый Secret без ключа чекера пересоздаётся (update прав нет)', async () => {    const client = new FakeKubernetesClient();
    const secretName = poolObjectName(poolHash('project:p1:exec:default'));
    const { provider } = makeProvider(client, { commandPolicy: policy({ token: 'policy-token' }) });
    // Секрет прошлого пула: токен есть, ключа чекера нет.
    client.secrets.set(secretName, {
      metadata: { name: secretName },
      data: { token: Buffer.from('old-pool-token', 'utf8').toString('base64') },
    });

    const pool = await provider.ensure(request());
    expect(client.deletedSecrets).toContain(secretName);
    expect(client.secrets.get(secretName)?.data?.[COMMAND_POLICY_TOKEN_KEY]).toBeDefined();
    expect(secretTokenOf(client.secrets.get(secretName))).toBe(pool.token);
  });
});
