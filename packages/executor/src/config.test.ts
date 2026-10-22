import { describe, expect, it } from 'vitest';
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
