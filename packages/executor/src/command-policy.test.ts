/**
 * PROP-136b: клиент внешнего чекера команд.
 *
 * Проверяются оба контракта (`http-json`, `opa`), авторизация токеном из
 * файла, таймаут и fail mode (`closed`/`open`), кэш вердиктов (включая `deny`
 * и истечение TTL) и метрики.
 *
 * Сеть — фиктивный транспорт: реальный чекер в тестах не поднимается.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMAND_POLICY_UNAVAILABLE_OPEN_REASON,
  COMMAND_POLICY_UNAVAILABLE_REASON,
  commandPolicyCommandText,
  createCommandPolicyGuard,
} from './command-policy.js';
import type { CommandPolicyConfig } from './config.js';
import { ExecutorMetrics } from './metrics.js';

/** Записи о вызовах фиктивного транспорта. */
interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Фиктивный транспорт: ответ — по URL/init, вызовы запоминаются. */
function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return await handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** JSON-ответ чекера. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Конфигурация чекера с дефолтами. */
function policy(overrides: Partial<CommandPolicyConfig> = {}): CommandPolicyConfig {
  return {
    provider: 'http',
    url: 'http://policy.local',
    failMode: 'closed',
    timeoutMs: 2_000,
    cacheTtlMs: 60_000,
    opaPath: '/v1/data/synth/exec/decision',
    ...overrides,
  };
}

/** Тело запроса чекера (разобранный JSON). */
function requestBody(call: FetchCall): Record<string, unknown> {
  const body = call.init?.body;
  expect(typeof body).toBe('string');
  return JSON.parse(body as string) as Record<string, unknown>;
}

/** Заголовок запроса (в нижнем регистре). */
function header(call: FetchCall, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

const TOKEN_VALUE = ['policy-checker', 'token', '1234567890'].join('-');

let tokenDir: string | undefined;

afterEach(async () => {
  if (tokenDir !== undefined) {
    await rm(tokenDir, { recursive: true, force: true });
    tokenDir = undefined;
  }
});

describe('чекер команд: провайдер off', () => {
  it('off — guard не создаётся', () => {
    expect(createCommandPolicyGuard({ commandPolicy: policy({ provider: 'off' }) })).toBeNull();
  });
});

describe('чекер команд: http-json', () => {
  it('allow — расчётный адрес, тело запроса и вердикт', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ action: 'allow' }));
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy() },
      { fetchImpl },
    );
    expect(guard).not.toBeNull();
    const verdict = await guard!.check({
      command: 'ls -la',
      cwd: '/workspace/project',
      timeoutMs: 5_000,
    });
    expect(verdict).toEqual({ action: 'allow' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://policy.local/v1/check');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(requestBody(calls[0] as FetchCall)).toEqual({
      command: 'ls -la',
      cwd: '/workspace/project',
      timeout_ms: 5_000,
      background: false,
    });
    // Без токена заголовка авторизации нет.
    expect(header(calls[0] as FetchCall, 'authorization')).toBeUndefined();
  });

  it('bearer-токен читается из файла и уходит заголовком', async () => {
    tokenDir = await mkdtemp(join(tmpdir(), 'synth-exec-policy-token-'));
    const tokenFile = join(tokenDir, 'token');
    await writeFile(tokenFile, `${TOKEN_VALUE}\n`, 'utf8');
    const { fetchImpl, calls } = fakeFetch(() => json({ action: 'allow' }));
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy({ tokenFile }) },
      { fetchImpl },
    );
    await guard!.check({ command: 'ls', cwd: '/workspace' });
    expect(header(calls[0] as FetchCall, 'authorization')).toBe(`Bearer ${TOKEN_VALUE}`);
  });

  it('deny — reason и rule_id пробрасываются', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ action: 'deny', reason: 'rm запрещён', rule_id: 'no-rm-root' }),
    );
    const guard = createCommandPolicyGuard({ commandPolicy: policy() }, { fetchImpl });
    await expect(guard!.check({ command: 'rm -rf /', cwd: '/' })).resolves.toEqual({
      action: 'deny',
      reason: 'rm запрещён',
      ruleId: 'no-rm-root',
    });
  });

  it('таймаут при failMode closed — deny «command policy unavailable»', async () => {
    const { fetchImpl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy({ timeoutMs: 5 }) },
      { fetchImpl },
    );
    await expect(guard!.check({ command: 'sleep 1', cwd: '/workspace' })).resolves.toEqual({
      action: 'deny',
      reason: COMMAND_POLICY_UNAVAILABLE_REASON,
    });
  });

  it('таймаут при failMode open — allow с причиной fail-open', async () => {
    const { fetchImpl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy({ timeoutMs: 5, failMode: 'open' }) },
      { fetchImpl },
    );
    await expect(guard!.check({ command: 'sleep 1', cwd: '/workspace' })).resolves.toEqual({
      action: 'allow',
      reason: COMMAND_POLICY_UNAVAILABLE_OPEN_REASON,
    });
  });

  it('не-2xx и невалидный ответ — недоступность (closed → deny)', async () => {
    const notOk = fakeFetch(() => json({ action: 'allow' }, 500));
    const guardNotOk = createCommandPolicyGuard(
      { commandPolicy: policy() },
      { fetchImpl: notOk.fetchImpl },
    );
    await expect(guardNotOk!.check({ command: 'ls', cwd: '/workspace' })).resolves.toEqual({
      action: 'deny',
      reason: COMMAND_POLICY_UNAVAILABLE_REASON,
    });

    const invalid = fakeFetch(() => json({ action: 'ask' }));
    const guardInvalid = createCommandPolicyGuard(
      { commandPolicy: policy() },
      { fetchImpl: invalid.fetchImpl },
    );
    await expect(guardInvalid!.check({ command: 'ls', cwd: '/workspace' })).resolves.toEqual({
      action: 'deny',
      reason: COMMAND_POLICY_UNAVAILABLE_REASON,
    });
  });

  it('фон помечается в запросе (background: true)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ action: 'allow' }));
    const guard = createCommandPolicyGuard({ commandPolicy: policy() }, { fetchImpl });
    await guard!.check({ command: 'npm run dev', cwd: '/workspace', background: true });
    expect(requestBody(calls[0] as FetchCall)).toMatchObject({ background: true });
  });
});

describe('чекер команд: opa', () => {
  it('allow/deny — форма result.allow, путь решения и тела input', async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.endsWith('/v1/data/synth/exec/decision')
        ? json({ result: { allow: false, reason: 'policy: deny', rule_id: 'opa-rule' } })
        : json({ result: { allow: true } }),
    );
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy({ provider: 'opa', url: 'http://opa.local:8181' }) },
      { fetchImpl },
    );
    expect(guard?.provider).toBe('opa');
    const verdict = await guard!.check({ command: 'cat /etc/shadow', cwd: '/workspace' });
    expect(verdict).toEqual({ action: 'deny', reason: 'policy: deny', ruleId: 'opa-rule' });
    expect(calls[0]?.url).toBe('http://opa.local:8181/v1/data/synth/exec/decision');
    expect(requestBody(calls[0] as FetchCall)).toEqual({
      input: { command: 'cat /etc/shadow', cwd: '/workspace', background: false },
    });
  });

  it('невалидный ответ OPA (нет result.allow) — недоступность', async () => {
    const { fetchImpl } = fakeFetch(() => json({ result: { action: 'allow' } }));
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy({ provider: 'opa' }) },
      { fetchImpl },
    );
    await expect(guard!.check({ command: 'ls', cwd: '/workspace' })).resolves.toEqual({
      action: 'deny',
      reason: COMMAND_POLICY_UNAVAILABLE_REASON,
    });
  });
});

describe('чекер команд: кэш вердиктов', () => {
  it('второй вызов не ходит в сеть и помечен cached', async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch(() => json({ action: 'allow', ttl_ms: 1_000 }));
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy() },
      { fetchImpl, now: () => now },
    );
    const input = { command: 'ls -la', cwd: '/workspace' };
    expect(await guard!.check(input)).toEqual({ action: 'allow' });
    now = 500;
    expect(await guard!.check(input)).toEqual({ action: 'allow', cached: true });
    expect(calls).toHaveLength(1);
  });

  it('deny тоже кэшируется', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ action: 'deny', reason: 'blocked' }));
    const guard = createCommandPolicyGuard({ commandPolicy: policy() }, { fetchImpl });
    const input = { command: 'sudo rm -rf /', cwd: '/workspace' };
    await guard!.check(input);
    const second = await guard!.check(input);
    expect(second).toEqual({ action: 'deny', reason: 'blocked', cached: true });
    expect(calls).toHaveLength(1);
  });

  it('TTL истекает — снова запрос к чекеру', async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch(() => json({ action: 'allow', ttl_ms: 1_000 }));
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy() },
      { fetchImpl, now: () => now },
    );
    const input = { command: 'ls', cwd: '/workspace' };
    await guard!.check(input);
    now = 1_500;
    const verdict = await guard!.check(input);
    expect(verdict.cached).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('ключ учитывает cwd и background', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ action: 'allow' }));
    const guard = createCommandPolicyGuard({ commandPolicy: policy() }, { fetchImpl });
    await guard!.check({ command: 'ls', cwd: '/workspace/a' });
    await guard!.check({ command: 'ls', cwd: '/workspace/b' });
    await guard!.check({ command: 'ls', cwd: '/workspace/a', background: true });
    expect(calls).toHaveLength(3);
  });

  it('cacheTtlMs = 0 — кэш выключен', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ action: 'allow' }));
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy({ cacheTtlMs: 0 }) },
      { fetchImpl },
    );
    const input = { command: 'ls', cwd: '/workspace' };
    await guard!.check(input);
    await guard!.check(input);
    expect(calls).toHaveLength(2);
  });
});

describe('чекер команд: метрики и текст команды', () => {
  it('счётчик решений и гистограмма длительности', async () => {
    const metrics = new ExecutorMetrics();
    const { fetchImpl } = fakeFetch(() => json({ action: 'deny', reason: 'blocked' }));
    const guard = createCommandPolicyGuard(
      { commandPolicy: policy() },
      { fetchImpl, metrics },
    );
    await guard!.check({ command: 'rm -rf /', cwd: '/workspace' });
    const text = metrics.render().text;
    expect(text).toContain('synth_executor_command_policy_total');
    expect(text).toContain('outcome="deny"');
    expect(text).toContain('provider="http"');
    expect(text).toContain('synth_executor_command_policy_seconds');
  });

  it('argv-форма команды — через пробел', () => {
    expect(commandPolicyCommandText({ kind: 'shell', command: 'ls -la' })).toBe('ls -la');
    expect(
      commandPolicyCommandText({ kind: 'argv', file: 'git', args: ['status', '--short'] }),
    ).toBe('git status --short');
  });
});
