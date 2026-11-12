/**
 * Конфигурация provisioner'а: env-парсинг и fail-closed.
 *
 * Проверяется контракт PROP-135 §4b-2a/4b-2b:
 * - дефолты (порт 5200, idle 15/5 мин, maxLifetime 12 ч, drain grace 30 с,
 *   лимит 50 пулов, период reaper 30 с);
 * - без токена процесс не стартует; токен не попадает в текст ошибок;
 * - неизвестный provider — ошибка; kubernetes требует PVC и image профиля;
 * - битый JSON, профиль без url/image, нечисловые значения — ошибка;
 * - `scrubProvisionerToken` убирает токен из окружения.
 */
import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_COMMAND_POLICY_DEFAULTS,
  KUBERNETES_DEFAULTS,
  PROVISIONER_COMMAND_POLICY_ENV,
  PROVISIONER_DEFAULTS,
  PROVISIONER_ENV,
  PROVISIONER_KUBERNETES_ENV,
  parseJsonEnv,
  profilesSchema,
  resolveExecutorCommandPolicy,
  resolveProvisionerConfig,
  scrubProvisionerToken,
} from './config.js';

// Токен собирается из частей: в исходнике нет литерала, похожего на кред.
const TOKEN = ['provisioner-config', 'token', 'test-1234567890'].join('-');

/** Валидный env с переопределениями (`undefined` — удалить переменную). */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    [PROVISIONER_ENV.token]: TOKEN,
    [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { url: 'http://executor:5100' } }),
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** Валидный env Kubernetes-провайдера (`undefined` — удалить переменную). */
function KUBERNETES_ENV(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return makeEnv({
    [PROVISIONER_ENV.provider]: 'kubernetes',
    [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { image: 'synth-executor:0.13.8' } }),
    [PROVISIONER_KUBERNETES_ENV.workspacePvc]: 'synth-workspace',
    ...overrides,
  });
}

describe('provisioner: конфигурация из env', () => {
  it('минимальный env даёт дефолты', () => {
    const config = resolveProvisionerConfig(makeEnv());
    expect(config.token).toBe(TOKEN);
    expect(config.host).toBe(PROVISIONER_DEFAULTS.host);
    expect(config.port).toBe(5200);
    expect(config.provider).toBe('static');
    expect(config.idleTimeoutMs).toBe(900_000);
    expect(config.sessionIdleTimeoutMs).toBe(300_000);
    expect(config.maxLifetimeMs).toBe(43_200_000);
    expect(config.drainGraceMs).toBe(30_000);
    expect(config.maxPools).toBe(50);
    expect(config.reaperIntervalMs).toBe(30_000);
    expect(config.profiles.default?.url).toBe('http://executor:5100');
    expect(config.staticPools).toEqual({});
  });

  it('переопределения env применяются', () => {
    const config = resolveProvisionerConfig(
      makeEnv({
        [PROVISIONER_ENV.host]: '127.0.0.1',
        [PROVISIONER_ENV.port]: '5201',
        [PROVISIONER_ENV.idleTimeoutMs]: '1000',
        [PROVISIONER_ENV.sessionIdleTimeoutMs]: '500',
        [PROVISIONER_ENV.maxLifetimeMs]: '2000',
        [PROVISIONER_ENV.drainGraceMs]: '10',
        [PROVISIONER_ENV.maxPools]: '2',
        [PROVISIONER_ENV.reaperIntervalMs]: '50',
        [PROVISIONER_ENV.staticPools]: JSON.stringify({
          'project:p1:exec:default': 'http://executor-p1:5100',
        }),
      }),
    );
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(5201);
    expect(config.idleTimeoutMs).toBe(1000);
    expect(config.sessionIdleTimeoutMs).toBe(500);
    expect(config.maxLifetimeMs).toBe(2000);
    expect(config.drainGraceMs).toBe(10);
    expect(config.maxPools).toBe(2);
    expect(config.reaperIntervalMs).toBe(50);
    expect(config.staticPools['project:p1:exec:default']).toBe('http://executor-p1:5100');
  });

  it('без токена — ошибка fail-closed с именем переменной', () => {
    expect(() => resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.token]: undefined }))).toThrow(
      /SYNTH_PROVISIONER_TOKEN.*fail-closed/s,
    );
  });

  it('пустой токен — ошибка', () => {
    expect(() => resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.token]: '   ' }))).toThrow(
      /SYNTH_PROVISIONER_TOKEN/,
    );
  });

  it('kubernetes без WORKSPACE_PVC — ошибка fail-closed', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({
          [PROVISIONER_ENV.provider]: 'kubernetes',
          [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { image: 'synth-executor:1' } }),
        }),
        { readFile: () => '' },
      ),
    ).toThrow(/SYNTH_PROVISIONER_KUBERNETES_WORKSPACE_PVC.*fail-closed/s);
  });

  it('kubernetes: профиль без image — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({
          [PROVISIONER_ENV.provider]: 'kubernetes',
          [PROVISIONER_KUBERNETES_ENV.workspacePvc]: 'synth-workspace',
        }),
        { readFile: () => '' },
      ),
    ).toThrow(/профиль "default" без image/);
  });

  it('kubernetes: без профилей — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({
          [PROVISIONER_ENV.provider]: 'kubernetes',
          [PROVISIONER_ENV.profiles]: '{}',
          [PROVISIONER_KUBERNETES_ENV.workspacePvc]: 'synth-workspace',
        }),
        { readFile: () => '' },
      ),
    ).toThrow(/хотя бы один профиль с образом/);
  });

  it('kubernetes: статические пулы несовместимы с провайдером', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({
          [PROVISIONER_ENV.provider]: 'kubernetes',
          [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { image: 'synth-executor:1' } }),
          [PROVISIONER_ENV.staticPools]: JSON.stringify({
            'project:p1:exec:default': 'http://executor-p1:5100',
          }),
          [PROVISIONER_KUBERNETES_ENV.workspacePvc]: 'synth-workspace',
        }),
        { readFile: () => '' },
      ),
    ).toThrow(/SYNTH_PROVISIONER_STATIC_POOLS.*kubernetes/s);
  });

  it('kubernetes: минимальный env даёт дефолты и namespace из файла ServiceAccount', () => {
    const config = resolveProvisionerConfig(KUBERNETES_ENV(), {
      readFile: (path) => (path === KUBERNETES_DEFAULTS.namespaceFile ? 'synth-test\n' : ''),
    });
    expect(config.provider).toBe('kubernetes');
    const kubernetes = config.kubernetes;
    expect(kubernetes).toBeDefined();
    expect(kubernetes?.namespace).toBe('synth-test');
    expect(kubernetes?.workspacePvc).toBe('synth-workspace');
    expect(kubernetes?.workspaceMount).toBe(KUBERNETES_DEFAULTS.workspaceMount);
    expect(kubernetes?.apiServer).toBe(KUBERNETES_DEFAULTS.apiServer);
    expect(kubernetes?.tokenFile).toBe(KUBERNETES_DEFAULTS.tokenFile);
    expect(kubernetes?.caFile).toBe(KUBERNETES_DEFAULTS.caFile);
    expect(kubernetes?.startTimeoutMs).toBe(120_000);
    expect(kubernetes?.pollIntervalMs).toBe(1_000);
    expect(kubernetes?.executorPort).toBe(5100);
    expect(kubernetes?.terminationGraceSeconds).toBe(30);
    expect(kubernetes?.serviceAccount).toBeUndefined();
    expect(kubernetes?.imagePullSecrets).toEqual([]);
    expect(config.staticPools).toEqual({});
  });

  it('kubernetes: namespace — файл ServiceAccount, иначе synth', () => {
    const fromFallback = resolveProvisionerConfig(KUBERNETES_ENV(), {
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(fromFallback.kubernetes?.namespace).toBe(KUBERNETES_DEFAULTS.namespace);
    expect(KUBERNETES_DEFAULTS.namespace).toBe('synth');
  });

  it('kubernetes: env важнее файла namespace', () => {
    const config = resolveProvisionerConfig(
      KUBERNETES_ENV({ [PROVISIONER_KUBERNETES_ENV.namespace]: 'synth-prod' }),
      { readFile: () => 'from-file' },
    );
    expect(config.kubernetes?.namespace).toBe('synth-prod');
  });

  it('kubernetes: переопределения env применяются', () => {
    const config = resolveProvisionerConfig(
      KUBERNETES_ENV({
        [PROVISIONER_KUBERNETES_ENV.workspaceMount]: '/workspaces',
        [PROVISIONER_KUBERNETES_ENV.serviceAccount]: 'synth-executor',
        [PROVISIONER_KUBERNETES_ENV.imagePullSecrets]: 'regcred, mirror-cred',
        [PROVISIONER_KUBERNETES_ENV.apiServer]: 'https://k8s.example:6443',
        [PROVISIONER_KUBERNETES_ENV.tokenFile]: '/var/run/token',
        [PROVISIONER_KUBERNETES_ENV.caFile]: '/var/run/ca.crt',
        [PROVISIONER_KUBERNETES_ENV.startTimeoutMs]: '5000',
        [PROVISIONER_KUBERNETES_ENV.pollIntervalMs]: '250',
        [PROVISIONER_KUBERNETES_ENV.executorPort]: '5200',
        [PROVISIONER_KUBERNETES_ENV.terminationGraceSeconds]: '5',
      }),
      { readFile: () => '' },
    );
    expect(config.kubernetes).toMatchObject({
      workspaceMount: '/workspaces',
      serviceAccount: 'synth-executor',
      imagePullSecrets: ['regcred', 'mirror-cred'],
      apiServer: 'https://k8s.example:6443',
      tokenFile: '/var/run/token',
      caFile: '/var/run/ca.crt',
      startTimeoutMs: 5000,
      pollIntervalMs: 250,
      executorPort: 5200,
      terminationGraceSeconds: 5,
    });
  });

  it('kubernetes: невалидное имя PVC — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        KUBERNETES_ENV({ [PROVISIONER_KUBERNETES_ENV.workspacePvc]: 'Synth Workspace' }),
        { readFile: () => '' },
      ),
    ).toThrow(/SYNTH_PROVISIONER_KUBERNETES_WORKSPACE_PVC/);
  });

  it('kubernetes: относительный workspaceMount — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        KUBERNETES_ENV({ [PROVISIONER_KUBERNETES_ENV.workspaceMount]: 'workspaces' }),
        { readFile: () => '' },
      ),
    ).toThrow(/WORKSPACE_MOUNT.*абсолютным/s);
  });

  it('kubernetes: нечисловой таймаут — ошибка, а не дефолт', () => {
    expect(() =>
      resolveProvisionerConfig(
        KUBERNETES_ENV({ [PROVISIONER_KUBERNETES_ENV.startTimeoutMs]: 'soon' }),
        { readFile: () => '' },
      ),
    ).toThrow(/SYNTH_PROVISIONER_KUBERNETES_START_TIMEOUT_MS="soon"/);
  });

  it('kubernetes: профиль с ресурсами, runtimeClass и env разбирается', () => {
    const config = resolveProvisionerConfig(
      KUBERNETES_ENV({
        [PROVISIONER_ENV.profiles]: JSON.stringify({
          default: {
            image: 'synth-executor:1',
            network: 'restricted',
            runtimeClass: 'gvisor',
            readOnlyRootFilesystem: false,
            resources: {
              requests: { cpu: '250m', memory: '512Mi' },
              limits: { cpu: '2', memory: '4Gi' },
            },
            env: { SYNTH_EXECUTOR_MAX_CONCURRENCY: '2' },
          },
        }),
      }),
      { readFile: () => '' },
    );
    expect(config.profiles.default).toMatchObject({
      image: 'synth-executor:1',
      network: 'restricted',
      runtimeClass: 'gvisor',
      readOnlyRootFilesystem: false,
      resources: {
        requests: { cpu: '250m', memory: '512Mi' },
        limits: { cpu: '2', memory: '4Gi' },
      },
      env: { SYNTH_EXECUTOR_MAX_CONCURRENCY: '2' },
    });
  });

  it('kubernetes: неизвестное поле resources — ошибка (fail-closed)', () => {
    expect(() =>
      resolveProvisionerConfig(
        KUBERNETES_ENV({
          [PROVISIONER_ENV.profiles]: JSON.stringify({
            default: { image: 'synth-executor:1', resources: { cpu: '1' } },
          }),
        }),
        { readFile: () => '' },
      ),
    ).toThrow(/SYNTH_PROVISIONER_PROFILES/);
  });

  it('неизвестный provider — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.provider]: 'nomad' })),
    ).toThrow(/неизвестный provider "nomad"/);
  });

  it('битый JSON профилей — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.profiles]: '{not json' })),
    ).toThrow(/невалидный JSON в SYNTH_PROVISIONER_PROFILES/);
  });

  it('профиль без url в static-режиме — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { image: 'executor:1' } }) }),
      ),
    ).toThrow(/профиль "default" без url/);
  });

  it('невалидный url профиля — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { url: 'not-a-url' } }) }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_PROFILES/);
  });

  it('невалидный url статического пула — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ [PROVISIONER_ENV.staticPools]: JSON.stringify({ 'project:p1:exec:default': 'ftp://x' }) }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_STATIC_POOLS/);
  });

  it('неизвестное поле профиля — ошибка (fail-closed)', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({
          [PROVISIONER_ENV.profiles]: JSON.stringify({
            default: { url: 'http://executor:5100', unknown: true },
          }),
        }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_PROFILES/);
  });

  it('пустой каталог профилей и пулов — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.profiles]: '{}' })),
    ).toThrow(/ни одного профиля и ни одного статического пула/);
  });

  it('только статические пулы без профилей допустимы', () => {
    const config = resolveProvisionerConfig(
      makeEnv({
        [PROVISIONER_ENV.profiles]: '{}',
        [PROVISIONER_ENV.staticPools]: JSON.stringify({
          'session:s1:exec:default': 'http://executor-s1:5100',
        }),
      }),
    );
    expect(config.profiles).toEqual({});
    expect(config.staticPools['session:s1:exec:default']).toBe('http://executor-s1:5100');
  });

  it('нечисловое значение — ошибка, а не молчаливый дефолт', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.maxPools]: 'many' })),
    ).toThrow(/SYNTH_PROVISIONER_MAX_POOLS="many"/);
  });

  it('ноль/отрицательное значение — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.idleTimeoutMs]: '0' })),
    ).toThrow(/SYNTH_PROVISIONER_IDLE_TIMEOUT_MS="0"/);
  });

  it('порт вне 1..65535 — ошибка', () => {
    expect(() => resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.port]: '70000' }))).toThrow(
      /SYNTH_PROVISIONER_PORT="70000"/,
    );
  });

  it('текст ошибки не содержит токен', () => {
    try {
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.profiles]: '{oops' }));
      expect.unreachable('ожидалась ошибка');
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it('scrubProvisionerToken удаляет токен из окружения', () => {
    const env = makeEnv();
    scrubProvisionerToken(env);
    expect(env[PROVISIONER_ENV.token]).toBeUndefined();
  });

  it('parseJsonEnv: пустое значение — fallback', () => {
    expect(parseJsonEnv(undefined, 'X', profilesSchema, {})).toEqual({});
    expect(parseJsonEnv('   ', 'X', profilesSchema, {})).toEqual({});
  });

  it('чекер команд: по умолчанию выключен с дефолтами', () => {
    const config = resolveProvisionerConfig(makeEnv());
    expect(config.executorCommandPolicy).toEqual({
      enabled: EXECUTOR_COMMAND_POLICY_DEFAULTS.enabled,
      provider: EXECUTOR_COMMAND_POLICY_DEFAULTS.provider,
      failMode: EXECUTOR_COMMAND_POLICY_DEFAULTS.failMode,
      timeoutMs: EXECUTOR_COMMAND_POLICY_DEFAULTS.timeoutMs,
      cacheTtlMs: EXECUTOR_COMMAND_POLICY_DEFAULTS.cacheTtlMs,
      opaPath: EXECUTOR_COMMAND_POLICY_DEFAULTS.opaPath,
    });
    expect(config.executorCommandPolicy.token).toBeUndefined();
    expect(config.executorCommandPolicy.url).toBeUndefined();
  });

  it('чекер команд: enabled без url — ошибка fail-closed', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ [PROVISIONER_COMMAND_POLICY_ENV.enabled]: 'true' }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_URL.*fail-closed/s);
  });

  it('чекер команд: env применяются, адрес нормализуется, токен — значением', () => {
    const config = resolveProvisionerConfig(
      makeEnv({
        [PROVISIONER_COMMAND_POLICY_ENV.enabled]: 'true',
        [PROVISIONER_COMMAND_POLICY_ENV.provider]: 'opa',
        [PROVISIONER_COMMAND_POLICY_ENV.url]: 'https://policy:8181/',
        [PROVISIONER_COMMAND_POLICY_ENV.token]: 'policy-token',
        [PROVISIONER_COMMAND_POLICY_ENV.failMode]: 'open',
        [PROVISIONER_COMMAND_POLICY_ENV.timeoutMs]: '1500',
        [PROVISIONER_COMMAND_POLICY_ENV.cacheTtlMs]: '0',
        [PROVISIONER_COMMAND_POLICY_ENV.opaPath]: '/v1/data/x/decision',
      }),
    );
    expect(config.executorCommandPolicy).toEqual({
      enabled: true,
      provider: 'opa',
      url: 'https://policy:8181',
      token: 'policy-token',
      failMode: 'open',
      timeoutMs: 1500,
      cacheTtlMs: 0,
      opaPath: '/v1/data/x/decision',
    });
  });

  it('чекер команд: токен читается из файла provisioner\'а', () => {
    const config = resolveProvisionerConfig(
      makeEnv({
        [PROVISIONER_COMMAND_POLICY_ENV.enabled]: 'true',
        [PROVISIONER_COMMAND_POLICY_ENV.url]: 'http://policy:8080',
        [PROVISIONER_COMMAND_POLICY_ENV.tokenFile]: '/run/secrets/policy-token',
      }),
      { readFile: (path) => (path === '/run/secrets/policy-token' ? 'file-token\n' : '') },
    );
    expect(config.executorCommandPolicy.token).toBe('file-token');
  });

  it('чекер команд: нечитаемый/пустой файл токена — ошибка', () => {
    const base = {
      [PROVISIONER_COMMAND_POLICY_ENV.enabled]: 'true',
      [PROVISIONER_COMMAND_POLICY_ENV.url]: 'http://policy:8080',
      [PROVISIONER_COMMAND_POLICY_ENV.tokenFile]: '/run/secrets/policy-token',
    };
    expect(() =>
      resolveProvisionerConfig(makeEnv(base), {
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_TOKEN_FILE.*недоступен/s);
    expect(() =>
      resolveProvisionerConfig(makeEnv(base), { readFile: () => '   ' }),
    ).toThrow(/файл токена чекера пуст/);
  });

  it('чекер команд: невалидные provider/failMode/enabled/timeout/opaPath — ошибка', () => {
    const enabled = {
      [PROVISIONER_COMMAND_POLICY_ENV.enabled]: 'true',
      [PROVISIONER_COMMAND_POLICY_ENV.url]: 'http://policy:8080',
    };
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ ...enabled, [PROVISIONER_COMMAND_POLICY_ENV.provider]: 'plugin' }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_PROVIDER="plugin"/);
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ ...enabled, [PROVISIONER_COMMAND_POLICY_ENV.failMode]: 'maybe' }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_FAIL_MODE="maybe"/);
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_COMMAND_POLICY_ENV.enabled]: 'on' })),
    ).toThrow(/SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_ENABLED="on"/);
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ ...enabled, [PROVISIONER_COMMAND_POLICY_ENV.timeoutMs]: '0' }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_TIMEOUT_MS="0"/);
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ ...enabled, [PROVISIONER_COMMAND_POLICY_ENV.opaPath]: 'v1/data' }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_EXECUTOR_COMMAND_POLICY_OPA_PATH/);
  });

  it('чекер команд: не-http(s) url — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({
          [PROVISIONER_COMMAND_POLICY_ENV.enabled]: 'true',
          [PROVISIONER_COMMAND_POLICY_ENV.url]: 'ftp://policy:21',
        }),
      ),
    ).toThrow(/только http\/https/);
  });

  it('чекер команд: выключенный чекер игнорирует прочие ключи', () => {
    const policy = resolveExecutorCommandPolicy(
      {
        [PROVISIONER_COMMAND_POLICY_ENV.provider]: 'opa',
        [PROVISIONER_COMMAND_POLICY_ENV.token]: 'ignored',
      },
      () => '',
    );
    expect(policy.enabled).toBe(false);
    expect(policy.token).toBeUndefined();
  });
});
