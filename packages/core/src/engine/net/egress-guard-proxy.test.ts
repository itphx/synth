import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveProxyConfig } from '@itphx/synth-shared';
import type { EgressPolicy } from '@itphx/synth-shared';
import { checkEgressUrl, fetchWithEgressGuard, EgressBlockedError, PRIVATE_EGRESS_POLICY } from './egress-guard.js';
import type { EgressLogEvent, FetchLike } from './egress-guard.js';
import { resetEgressProxyState, setEgressProxyConfig } from '../../security/proxy-state.js';

function enableProxy(noProxy: string[] = []): void {
  setEgressProxyConfig(
    resolveProxyConfig(
      { proxy: { url: 'http://proxy.corp:3128', noProxy, fromEnv: false } },
      {},
    ),
  );
}

afterEach(() => resetEgressProxyState());

const publicResolver = (calls: string[]) => async (host: string): Promise<string[]> => {
  calls.push(host);
  return ['93.184.216.34'];
};

describe('checkEgressUrl({ proxied: true }) — ADR-099 D1', () => {
  it('не выполняет DNS-резолв', async () => {
    const resolver = vi.fn(async () => ['127.0.0.1']);
    const res = await checkEgressUrl('https://public.example/x', PRIVATE_EGRESS_POLICY, {
      proxied: true,
      resolveHost: resolver,
    });
    expect(res.allowed).toBe(true);
    expect(res).toMatchObject({ proxied: true });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('hostname-исключение работает без DNS', async () => {
    const policy: EgressPolicy = { mode: 'deny', list: ['10.0.0.0/8'], exceptions: ['*.corp.example'] };
    const res = await checkEgressUrl('https://api.corp.example/x', policy, { proxied: true });
    expect(res.allowed).toBe(true);
    expect(res).toMatchObject({ matchedRule: '*.corp.example', proxied: true });
  });

  it('hostname из deny-list блокируется без DNS', async () => {
    const policy: EgressPolicy = { mode: 'deny', list: ['evil.example'], exceptions: [] };
    const res = await checkEgressUrl('https://evil.example/x', policy, { proxied: true });
    expect(res.allowed).toBe(false);
    expect(res).toMatchObject({ matchedRule: 'evil.example', proxied: true });
  });

  it('allow-политика без hostname-правила не проверяема через прокси (fail-closed)', async () => {
    const policy: EgressPolicy = { mode: 'allow', list: ['10.0.0.0/8'], exceptions: [] };
    const res = await checkEgressUrl('https://public.example/x', policy, { proxied: true });
    expect(res.allowed).toBe(false);
    expect(res.allowed === false && res.reason).toMatch(/CIDR\/DNS не выполняются/);
  });

  it('proxied:false — прежнее поведение (DNS вызывается)', async () => {
    const resolver = vi.fn(async () => ['93.184.216.34']);
    await checkEgressUrl('https://public.example/x', PRIVATE_EGRESS_POLICY, { resolveHost: resolver });
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

describe('fetchWithEgressGuard — маршрут на каждом хопе (ADR-099 D1)', () => {
  it('proxied → no_proxy-хост: DNS включается только на втором хопе', async () => {
    enableProxy(['direct.example']);
    const calls: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (input === 'https://public.example/start') {
        return new Response(null, { status: 302, headers: { location: 'https://direct.example/final' } });
      }
      return new Response('ok', { status: 200 });
    });

    const res = await fetchWithEgressGuard(
      'https://public.example/start',
      {},
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: publicResolver(calls), fetchImpl },
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual(['direct.example']);
  });

  it('direct → proxied-хост: DNS только на первом хопе', async () => {
    enableProxy(['direct.example']);
    const calls: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (input === 'https://direct.example/start') {
        return new Response(null, { status: 302, headers: { location: 'https://public.example/final' } });
      }
      return new Response('ok', { status: 200 });
    });

    const res = await fetchWithEgressGuard(
      'https://direct.example/start',
      {},
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: publicResolver(calls), fetchImpl },
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual(['direct.example']);
  });

  it('журнал egress: via=proxy для проксируемого хоста и via=direct для no_proxy', async () => {
    enableProxy(['direct.example']);
    const events: EgressLogEvent[] = [];
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('ok', { status: 200 }));
    const log = (event: EgressLogEvent): void => { events.push(event); };

    await fetchWithEgressGuard('https://public.example/x', {}, {
      policy: PRIVATE_EGRESS_POLICY,
      resolveHost: publicResolver([]),
      fetchImpl,
      scope: 'web_fetch',
      log,
    });
    await fetchWithEgressGuard('https://direct.example/x', {}, {
      policy: PRIVATE_EGRESS_POLICY,
      resolveHost: publicResolver([]),
      fetchImpl,
      scope: 'web_fetch',
      log,
    });

    expect(events.map((event) => event.via)).toEqual(['proxy', 'direct']);
  });

  it('запрещённый проксируемый хост (deny-list hostname) не уходит в сеть', async () => {
    enableProxy();
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('nope', { status: 200 }));
    const policy: EgressPolicy = { mode: 'deny', list: ['evil.example'], exceptions: [] };

    await expect(fetchWithEgressGuard('https://evil.example/x', {}, { policy, fetchImpl }))
      .rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
