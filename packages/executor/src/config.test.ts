import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXECUTOR_DEFAULTS,
  EXECUTOR_ENV,
  parseMcpServerSpecs,
  resolveExecutorConfig,
  scrubExecutorMcpServers,
  scrubExecutorToken,
} from './config.js';

describe('конфигурация исполнителя (env)', () => {
  it('без токена — ошибка (fail-closed)', () => {
    expect(() =>
      resolveExecutorConfig({ [EXECUTOR_ENV.workspace]: '/workspace' } as NodeJS.ProcessEnv),
    ).toThrow(/SYNTH_EXECUTOR_TOKEN/);
  });

  it('без корня workspace — ошибка (fail-closed)', () => {
    expect(() =>
      resolveExecutorConfig({ [EXECUTOR_ENV.token]: 'secret' } as NodeJS.ProcessEnv),
    ).toThrow(/SYNTH_EXECUTOR_WORKSPACE/);
  });

  it('дефолты и явные значения', () => {
    const config = resolveExecutorConfig({
      [EXECUTOR_ENV.token]: 'secret',
      [EXECUTOR_ENV.workspace]: '/workspace',
    } as NodeJS.ProcessEnv);
    expect(config.host).toBe(EXECUTOR_DEFAULTS.host);
    expect(config.port).toBe(EXECUTOR_DEFAULTS.port);
    expect(config.maxConcurrency).toBe(EXECUTOR_DEFAULTS.maxConcurrency);
    expect(config.maxTimeoutMs).toBe(EXECUTOR_DEFAULTS.maxTimeoutMs);
    expect(config.maxOutputBytes).toBe(EXECUTOR_DEFAULTS.maxOutputBytes);
    expect(config.token).toBe('secret');
    expect(config.workspaceRoot).toBe('/workspace');
  });

  it('дефолт потолка таймаута — 600000 мс (10 мин)', () => {
    expect(EXECUTOR_DEFAULTS.maxTimeoutMs).toBe(600_000);
    const config = resolveExecutorConfig({
      [EXECUTOR_ENV.token]: 'secret',
      [EXECUTOR_ENV.workspace]: '/workspace',
    } as NodeJS.ProcessEnv);
    expect(config.maxTimeoutMs).toBe(600_000);
  });

  it('явный потолок таймаута — как задано (дефолт не перекрывается)', () => {
    const config = resolveExecutorConfig({
      [EXECUTOR_ENV.token]: 'secret',
      [EXECUTOR_ENV.workspace]: '/workspace',
      [EXECUTOR_ENV.maxTimeoutMs]: '1800000',
    } as NodeJS.ProcessEnv);
    expect(config.maxTimeoutMs).toBe(1_800_000);
  });

  it('невалидные значения — ошибка (не молчаливый дефолт)', () => {
    const base = {
      [EXECUTOR_ENV.token]: 'secret',
      [EXECUTOR_ENV.workspace]: '/workspace',
    } as NodeJS.ProcessEnv;
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.port]: 'abc' })).toThrow(
      /SYNTH_EXECUTOR_PORT/,
    );
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.maxConcurrency]: '0' })).toThrow(
      /SYNTH_EXECUTOR_MAX_CONCURRENCY/,
    );
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.port]: '70000' })).toThrow(
      /SYNTH_EXECUTOR_PORT/,
    );
  });

  it('scrubExecutorToken убирает токен из окружения процесса', () => {
    const env = { [EXECUTOR_ENV.token]: 'secret' } as NodeJS.ProcessEnv;
    scrubExecutorToken(env);
    expect(env[EXECUTOR_ENV.token]).toBeUndefined();
  });
});

describe('конфигурация исполнителя: MCP-серверы', () => {
  it('не заданы — пустой список', () => {
    expect(parseMcpServerSpecs(undefined, EXECUTOR_ENV.mcpServers)).toEqual([]);
    expect(parseMcpServerSpecs('  ', EXECUTOR_ENV.mcpServers)).toEqual([]);
  });

  it('пустая строка — «серверов нет» (способ отключить дефолт образа)', () => {
    // В образе flavor'ов с браузером задан дефолт SYNTH_EXECUTOR_MCP_SERVERS;
    // оператор отключает его пустой строкой, а не ошибкой разбора (fail-closed
    // остаётся только для невалидного JSON/описания).
    expect(parseMcpServerSpecs('', EXECUTOR_ENV.mcpServers)).toEqual([]);
    const config = resolveExecutorConfig({
      [EXECUTOR_ENV.token]: 'secret',
      [EXECUTOR_ENV.workspace]: '/workspace',
      [EXECUTOR_ENV.mcpServers]: '',
    } as NodeJS.ProcessEnv);
    expect(config.mcpServers).toEqual([]);
  });

  it('валидный список разбирается', () => {
    const specs = parseMcpServerSpecs(
      JSON.stringify([
        { name: 'playwright-mcp', command: 'playwright-mcp', args: ['--no-sandbox'], env: {} },
        { name: 'gitea', command: 'gitea-mcp', env: { GITEA_TOKEN: 'secret-token' } },
      ]),
      EXECUTOR_ENV.mcpServers,
    );
    expect(specs).toHaveLength(2);
    expect(specs[0]).toEqual({
      name: 'playwright-mcp',
      command: 'playwright-mcp',
      args: ['--no-sandbox'],
      env: {},
    });
    expect(specs[1]?.args).toEqual([]);
    expect(specs[1]?.env.GITEA_TOKEN).toBe('secret-token');
  });

  it('невалидный JSON — ошибка (fail-closed)', () => {
    expect(() => parseMcpServerSpecs('{not json', EXECUTOR_ENV.mcpServers)).toThrow(
      /SYNTH_EXECUTOR_MCP_SERVERS/,
    );
  });

  it('не-массив — ошибка', () => {
    expect(() => parseMcpServerSpecs('{"name":"x"}', EXECUTOR_ENV.mcpServers)).toThrow(
      /JSON-массивом/,
    );
  });

  it('без name или command — ошибка', () => {
    expect(() => parseMcpServerSpecs('[{"command":"x"}]', EXECUTOR_ENV.mcpServers)).toThrow(
      /name/,
    );
    expect(() => parseMcpServerSpecs('[{"name":"x"}]', EXECUTOR_ENV.mcpServers)).toThrow(
      /command/,
    );
  });

  it('невалидные args/env — ошибка', () => {
    expect(() =>
      parseMcpServerSpecs('[{"name":"x","command":"y","args":[1]}]', EXECUTOR_ENV.mcpServers),
    ).toThrow(/args/);
    expect(() =>
      parseMcpServerSpecs('[{"name":"x","command":"y","env":{"A":1}}]', EXECUTOR_ENV.mcpServers),
    ).toThrow(/env/);
  });

  it('повторяющиеся имена — ошибка', () => {
    expect(() =>
      parseMcpServerSpecs(
        '[{"name":"x","command":"y"},{"name":"x","command":"z"}]',
        EXECUTOR_ENV.mcpServers,
      ),
    ).toThrow(/уже используется/);
  });

  it('конфигурация исполнителя читает список MCP-серверов', () => {
    const config = resolveExecutorConfig({
      [EXECUTOR_ENV.token]: 'secret',
      [EXECUTOR_ENV.workspace]: '/workspace',
      [EXECUTOR_ENV.mcpServers]: '[{"name":"playwright-mcp","command":"playwright-mcp"}]',
    } as NodeJS.ProcessEnv);
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0]?.name).toBe('playwright-mcp');
  });

  it('невалидный список MCP-серверов — ошибка старта (fail-closed)', () => {
    expect(() =>
      resolveExecutorConfig({
        [EXECUTOR_ENV.token]: 'secret',
        [EXECUTOR_ENV.workspace]: '/workspace',
        [EXECUTOR_ENV.mcpServers]: '{bad',
      } as NodeJS.ProcessEnv),
    ).toThrow(/SYNTH_EXECUTOR_MCP_SERVERS/);
  });

  it('scrubExecutorMcpServers убирает описание серверов из окружения', () => {
    const env = { [EXECUTOR_ENV.mcpServers]: '[{"name":"x","command":"y"}]' } as NodeJS.ProcessEnv;
    scrubExecutorMcpServers(env);
    expect(env[EXECUTOR_ENV.mcpServers]).toBeUndefined();
  });
});

/**
 * PROP-136b: внешний чекер команд — конфигурация из env.
 *
 * Проверяется fail-closed разбор: провайдер без адреса, невалидный `failMode`
 * и нечитаемый файл токена — ошибка старта. Значение токена в конфиг **не**
 * попадает: хранится только путь к файлу.
 */
describe('конфигурация исполнителя: внешний чекер команд (PROP-136b)', () => {
  const base = {
    [EXECUTOR_ENV.token]: 'secret',
    [EXECUTOR_ENV.workspace]: '/workspace',
  } as NodeJS.ProcessEnv;

  it('дефолты — off / closed / 2000 мс / 60000 мс / путь OPA', () => {
    const config = resolveExecutorConfig(base);
    expect(config.commandPolicy.provider).toBe('off');
    expect(config.commandPolicy.failMode).toBe('closed');
    expect(config.commandPolicy.timeoutMs).toBe(2_000);
    expect(config.commandPolicy.cacheTtlMs).toBe(60_000);
    expect(config.commandPolicy.opaPath).toBe('/v1/data/synth/exec/decision');
    expect(config.commandPolicy.url).toBeUndefined();
    expect(EXECUTOR_DEFAULTS.commandPolicyProvider).toBe('off');
  });

  it('http/opa без URL — ошибка старта (fail-closed)', () => {
    for (const provider of ['http', 'opa']) {
      expect(() =>
        resolveExecutorConfig({ ...base, [EXECUTOR_ENV.commandPolicyProvider]: provider }),
      ).toThrow(/SYNTH_EXECUTOR_COMMAND_POLICY_URL/);
    }
  });

  it('невалидный провайдер или failMode — ошибка старта', () => {
    expect(() =>
      resolveExecutorConfig({ ...base, [EXECUTOR_ENV.commandPolicyProvider]: 'cel' }),
    ).toThrow(/SYNTH_EXECUTOR_COMMAND_POLICY_PROVIDER/);
    expect(() =>
      resolveExecutorConfig({
        ...base,
        [EXECUTOR_ENV.commandPolicyProvider]: 'http',
        [EXECUTOR_ENV.commandPolicyUrl]: 'http://policy.local',
        [EXECUTOR_ENV.commandPolicyFailMode]: 'silent',
      }),
    ).toThrow(/SYNTH_EXECUTOR_COMMAND_POLICY_FAIL_MODE/);
  });

  it('явные значения и нормализация адреса', () => {
    const config = resolveExecutorConfig({
      ...base,
      [EXECUTOR_ENV.commandPolicyProvider]: 'opa',
      [EXECUTOR_ENV.commandPolicyUrl]: 'http://policy.local:8181/',
      [EXECUTOR_ENV.commandPolicyFailMode]: 'open',
      [EXECUTOR_ENV.commandPolicyTimeoutMs]: '500',
      [EXECUTOR_ENV.commandPolicyCacheTtlMs]: '0',
      [EXECUTOR_ENV.commandPolicyOpaPath]: '/v1/data/custom/decision',
    });
    expect(config.commandPolicy).toMatchObject({
      provider: 'opa',
      url: 'http://policy.local:8181',
      failMode: 'open',
      timeoutMs: 500,
      cacheTtlMs: 0,
      opaPath: '/v1/data/custom/decision',
    });
  });

  it('невалидный адрес чекера — ошибка старта', () => {
    expect(() =>
      resolveExecutorConfig({
        ...base,
        [EXECUTOR_ENV.commandPolicyProvider]: 'http',
        [EXECUTOR_ENV.commandPolicyUrl]: 'ftp://policy.local',
      }),
    ).toThrow(/SYNTH_EXECUTOR_COMMAND_POLICY_URL/);
  });

  it('токен из файла: в конфиге только путь, значения нет', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-policy-cfg-'));
    try {
      const tokenFile = join(dir, 'token');
      const tokenValue = 'policy-token-value-1234567890';
      await writeFile(tokenFile, `${tokenValue}\n`, 'utf8');
      const config = resolveExecutorConfig({
        ...base,
        [EXECUTOR_ENV.commandPolicyProvider]: 'http',
        [EXECUTOR_ENV.commandPolicyUrl]: 'http://policy.local',
        [EXECUTOR_ENV.commandPolicyTokenFile]: tokenFile,
      });
      expect(config.commandPolicy.tokenFile).toBe(tokenFile);
      // Значение токена не хранится в конфиге (и не попадает в его сериализацию).
      expect(JSON.stringify(config)).not.toContain(tokenValue);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('нечитаемый файл токена — ошибка старта (fail-closed)', () => {
    expect(() =>
      resolveExecutorConfig({
        ...base,
        [EXECUTOR_ENV.commandPolicyProvider]: 'http',
        [EXECUTOR_ENV.commandPolicyUrl]: 'http://policy.local',
        [EXECUTOR_ENV.commandPolicyTokenFile]: '/nonexistent/synth-policy-token',
      }),
    ).toThrow(/SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE/);
  });
});

/**
 * Контур PTY-сессий (протокол 8): env-разбор — строгий, как у прочих
 * параметров исполнителя (невалидное значение — ошибка старта, а не тихий
 * дефолт).
 */
describe('конфигурация контура PTY (протокол 8)', () => {
  const base = {
    [EXECUTOR_ENV.token]: 'secret',
    [EXECUTOR_ENV.workspace]: '/workspace',
  } as NodeJS.ProcessEnv;

  it('дефолты: контур включён, 4 сессии, простой 2 дня, ввод 16 КиБ', () => {
    const config = resolveExecutorConfig(base);
    expect(config.pty.enabled).toBe(true);
    expect(config.pty.maxSessions).toBe(4);
    expect(config.pty.idleTimeoutMs).toBe(172_800_000);
    expect(config.pty.inputMaxBytes).toBe(16 * 1024);
  });

  it('явные значения — как задано', () => {
    const config = resolveExecutorConfig({
      ...base,
      [EXECUTOR_ENV.pty]: '0',
      [EXECUTOR_ENV.ptyMax]: '8',
      [EXECUTOR_ENV.ptyIdleMs]: '60000',
      [EXECUTOR_ENV.ptyInputMaxBytes]: '1024',
    });
    expect(config.pty.enabled).toBe(false);
    expect(config.pty.maxSessions).toBe(8);
    expect(config.pty.idleTimeoutMs).toBe(60_000);
    expect(config.pty.inputMaxBytes).toBe(1024);
  });

  it('невалидные значения — ошибка (fail-closed)', () => {
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.pty]: 'yes' })).toThrow(
      /SYNTH_EXECUTOR_PTY/,
    );
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.ptyMax]: '0' })).toThrow(
      /SYNTH_EXECUTOR_PTY_MAX/,
    );
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.ptyIdleMs]: '-1' })).toThrow(
      /SYNTH_EXECUTOR_PTY_IDLE_MS/,
    );
    expect(() =>
      resolveExecutorConfig({ ...base, [EXECUTOR_ENV.ptyInputMaxBytes]: 'x' }),
    ).toThrow(/SYNTH_EXECUTOR_PTY_INPUT_MAX_BYTES/);
  });
});
