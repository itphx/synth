/**
 * PROP-136b (слайс 136b-2a): зеркальный внешний чекер команд в control plane.
 *
 * Проверяется контракт `createCommandPolicyProvider`:
 * - `http` — `POST {url}/v1/check`, allow/deny, bearer из файла токена;
 * - `opa` — `POST {url}{opaPath}`, `result.allow`/`rule_id`;
 * - таймаут/сбой/не-2xx — по `failMode` (`closed` → deny, `open` → allow);
 * - кэш по `sha256(command\0cwd\0background)` (TTL инъекцией `now`);
 * - `enabled: false` → `null`; `enabled` без `url` → ошибка (fail-closed);
 * - метрики (`synth_command_policy_total` / `_seconds`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandPolicyConfig } from '@itphx/synth-shared';
import { MetricsRegistry } from '../../metrics/registry.js';
import {
  createCommandPolicyMetrics,
  type CommandPolicyMetricsSink,
} from '../../metrics/collectors/command-policy.js';
import {
  COMMAND_POLICY_DEFAULT_TTL_MS,
  COMMAND_POLICY_UNAVAILABLE_OPEN_REASON,
  COMMAND_POLICY_UNAVAILABLE_REASON,
  createCommandPolicyProvider,
} from './command-policy.js';

function makeConfig(overrides: Partial<CommandPolicyConfig> = {}): CommandPolicyConfig {
  return {
    enabled: true,
    provider: 'http',
    url: 'http://policy.local',
    tokenSecret: '',
    failMode: 'closed',
    timeoutMs: 2_000,
    opaPath: '/v1/data/synth/exec/decision',
    ...overrides,
  };
}

/** Ответ-заглушка с JSON-телом. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createCommandPolicyProvider', () => {
  it('enabled: false → null (проверки нет, поведение прежнее)', () => {
    expect(createCommandPolicyProvider(makeConfig({ enabled: false }))).toBeNull();
  });

  it('enabled без url → ошибка (fail-closed старта)', () => {
    expect(() => createCommandPolicyProvider(makeConfig({ url: '  ' }))).toThrow(/без адреса/);
  });

  it('http: allow + rule_id, запрос на {url}/v1/check', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const provider = createCommandPolicyProvider(makeConfig(), {
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          headers: (init.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({ action: 'allow', reason: 'ok', rule_id: 'rule-1', ttl_ms: 5_000 });
      }) as unknown as typeof fetch,
    });

    const verdict = await provider!.check({ command: 'ls -la', cwd: '/work', background: false });
    expect(verdict).toMatchObject({ action: 'allow', reason: 'ok', ruleId: 'rule-1', kind: 'http' });
    expect(verdict.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://policy.local/v1/check');
    expect(calls[0]!.body).toEqual({ command: 'ls -la', cwd: '/work', background: false });
    // Токен не задан — заголовка авторизации нет.
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('http: deny с причиной', async () => {
    const provider = createCommandPolicyProvider(makeConfig(), {
      fetchImpl: (async () =>
        jsonResponse({ action: 'deny', reason: 'rm -rf запрещён', rule_id: 'no-rm' })) as unknown as typeof fetch,
    });
    const verdict = await provider!.check({ command: 'rm -rf /', cwd: '/work' });
    expect(verdict.action).toBe('deny');
    expect(verdict.reason).toBe('rm -rf запрещён');
    expect(verdict.ruleId).toBe('no-rm');
  });

  describe('bearer из файла токена', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'synth-cmd-policy-token-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('значение токена уходит в Authorization, в лог не пишется', async () => {
      const tokenFile = join(dir, 'policy.token');
      await writeFile(tokenFile, '  secret-token-value \n', 'utf8');
      let authHeader: string | undefined;
      const provider = createCommandPolicyProvider(
        makeConfig({ tokenSecret: tokenFile }),
        {
          fetchImpl: (async (_url: string, init: RequestInit) => {
            authHeader = (init.headers as Record<string, string>).authorization;
            return jsonResponse({ action: 'allow' });
          }) as unknown as typeof fetch,
        },
      );
      const verdict = await provider!.check({ command: 'pwd', cwd: '/work' });
      expect(verdict.action).toBe('allow');
      expect(authHeader).toBe('Bearer secret-token-value');
      expect(JSON.stringify(verdict)).not.toContain('secret-token-value');
    });

    it('нечитаемый файл токена → недоступность по failMode (не проверка без авторизации)', async () => {
      const warn = vi.fn();
      const provider = createCommandPolicyProvider(
        makeConfig({ tokenSecret: join(dir, 'missing.token'), failMode: 'open' }),
        {
          fetchImpl: (async () => {
            throw new Error('fetch не должен вызываться');
          }) as unknown as typeof fetch,
          warn,
        },
      );
      const verdict = await provider!.check({ command: 'pwd', cwd: '/work' });
      expect(verdict.action).toBe('allow');
      expect(verdict.reason).toBe(COMMAND_POLICY_UNAVAILABLE_OPEN_REASON);
      expect(warn).toHaveBeenCalledTimes(1);
      // Путь в предупреждении есть, значения токена — нет.
      expect(String(warn.mock.calls[0]![0])).not.toContain('Bearer');
    });
  });

  it('opa: allow/deny из result.allow + rule_id, тело {input}', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = createCommandPolicyProvider(makeConfig({ provider: 'opa' }), {
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return jsonResponse({ result: { allow: false, reason: 'blocked', rule_id: 'opa-1' } });
      }) as unknown as typeof fetch,
    });
    const verdict = await provider!.check({ command: 'cat /etc/passwd', cwd: '/work', timeoutMs: 500 });
    expect(verdict).toMatchObject({ action: 'deny', reason: 'blocked', ruleId: 'opa-1', kind: 'opa' });
    expect(calls[0]!.url).toBe('http://policy.local/v1/data/synth/exec/decision');
    expect(calls[0]!.body).toEqual({
      input: { command: 'cat /etc/passwd', cwd: '/work', timeout_ms: 500, background: false },
    });
  });

  it('opa: allow', async () => {
    const provider = createCommandPolicyProvider(makeConfig({ provider: 'opa' }), {
      fetchImpl: (async () => jsonResponse({ result: { allow: true } })) as unknown as typeof fetch,
    });
    const verdict = await provider!.check({ command: 'ls', cwd: '/work' });
    expect(verdict.action).toBe('allow');
    expect(verdict.kind).toBe('opa');
  });

  it('таймаут/сбой при failMode closed → deny "command policy unavailable"', async () => {
    const provider = createCommandPolicyProvider(makeConfig({ failMode: 'closed', timeoutMs: 20 }), {
      fetchImpl: (async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }) as unknown as typeof fetch,
    });
    const verdict = await provider!.check({ command: 'ls', cwd: '/work' });
    expect(verdict.action).toBe('deny');
    expect(verdict.reason).toBe(COMMAND_POLICY_UNAVAILABLE_REASON);
  });

  it('не-2xx и невалидный ответ — недоступность (failMode open → allow + warning)', async () => {
    const warn = vi.fn();
    const provider = createCommandPolicyProvider(makeConfig({ failMode: 'open' }), {
      fetchImpl: (async () => jsonResponse({ oops: true }, 500)) as unknown as typeof fetch,
      warn,
    });
    const verdict = await provider!.check({ command: 'ls', cwd: '/work' });
    expect(verdict.action).toBe('allow');
    expect(verdict.reason).toBe(COMMAND_POLICY_UNAVAILABLE_OPEN_REASON);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('кэш: повторный вызов не ходит в сеть, latencyMs 0, TTL по ttl_ms', async () => {
    let clock = 1_000;
    let calls = 0;
    const provider = createCommandPolicyProvider(makeConfig(), {
      now: () => clock,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({ action: 'deny', rule_id: 'r', ttl_ms: 100 });
      }) as unknown as typeof fetch,
    });

    const first = await provider!.check({ command: 'rm x', cwd: '/work', background: true });
    expect(first.action).toBe('deny');
    expect(calls).toBe(1);

    // Другая команда — другой ключ кэша.
    await provider!.check({ command: 'rm y', cwd: '/work', background: true });
    expect(calls).toBe(2);

    clock += 50;
    const second = await provider!.check({ command: 'rm x', cwd: '/work', background: true });
    expect(second.action).toBe('deny');
    expect(second.latencyMs).toBe(0);
    expect(calls).toBe(2);

    // TTL истёк — снова сеть.
    clock += 100;
    await provider!.check({ command: 'rm x', cwd: '/work', background: true });
    expect(calls).toBe(3);
  });

  it('кэш: TTL по умолчанию — 60 с', async () => {
    let clock = 0;
    let calls = 0;
    const provider = createCommandPolicyProvider(makeConfig(), {
      now: () => clock,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({ action: 'allow' });
      }) as unknown as typeof fetch,
    });

    await provider!.check({ command: 'ls', cwd: '/work' });
    clock = COMMAND_POLICY_DEFAULT_TTL_MS - 1;
    await provider!.check({ command: 'ls', cwd: '/work' });
    expect(calls).toBe(1);
    clock = COMMAND_POLICY_DEFAULT_TTL_MS;
    await provider!.check({ command: 'ls', cwd: '/work' });
    expect(calls).toBe(2);
  });

  it('недоступность не кэшируется: после сбоя следующий вызов идёт в сеть', async () => {
    let calls = 0;
    const provider = createCommandPolicyProvider(makeConfig({ failMode: 'open' }), {
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) throw new Error('network down');
        return jsonResponse({ action: 'deny', rule_id: 'r' });
      }) as unknown as typeof fetch,
      warn: () => {},
    });

    const first = await provider!.check({ command: 'ls', cwd: '/work' });
    expect(first.action).toBe('allow');
    const second = await provider!.check({ command: 'ls', cwd: '/work' });
    expect(second.action).toBe('deny');
    expect(calls).toBe(2);
  });

  it('метрики: allow/deny/unavailable считаются, длительность — в секундах', async () => {
    let clock = 0;
    const registry = new MetricsRegistry();
    const sink: CommandPolicyMetricsSink = createCommandPolicyMetrics(registry);
    let mode: 'allow' | 'deny' | 'fail' = 'allow';
    const provider = createCommandPolicyProvider(makeConfig({ failMode: 'open' }), {
      metrics: sink,
      now: () => {
        clock += 250;
        return clock;
      },
      fetchImpl: (async () => {
        if (mode === 'fail') throw new Error('down');
        return jsonResponse({ action: mode });
      }) as unknown as typeof fetch,
      warn: () => {},
    });

    await provider!.check({ command: 'a', cwd: '/w' });
    mode = 'deny';
    await provider!.check({ command: 'b', cwd: '/w' });
    mode = 'fail';
    await provider!.check({ command: 'c', cwd: '/w' });

    const snapshot = registry.snapshot();
    const total = snapshot.find((m) => m.name === 'synth_command_policy_total');
    expect(total).toBeDefined();
    const byOutcome = Object.fromEntries(
      total!.series.map((s) => [s.labels.outcome, s.value]),
    );
    expect(byOutcome.allow).toBe(1);
    expect(byOutcome.deny).toBe(1);
    expect(byOutcome.unavailable).toBe(1);
    for (const series of total!.series) expect(series.labels.provider).toBe('http');

    const duration = snapshot.find((m) => m.name === 'synth_command_policy_seconds');
    expect(duration).toBeDefined();
    expect(duration!.type).toBe('histogram');
    expect(duration!.series[0]!.count).toBe(3);
    // 250 мс × 3 = 0.75 c (секунды, не миллисекунды).
    expect(duration!.series[0]!.sum).toBeCloseTo(0.75, 5);
  });
});
