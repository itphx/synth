import { describe, it, expect, afterEach } from 'vitest';
import { checkProxyConnectivity } from './proxy-check.js';
import { startFakeSocks5Proxy } from '../test-helpers/fake-socks5-proxy.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('checkProxyConnectivity — SOCKS5 (D2b)', () => {
  it('no-auth: greeting/methods → CONNECT probe.invalid', async () => {
    const socks = await startFakeSocks5Proxy();
    cleanups.push(() => socks.close());

    const result = await checkProxyConnectivity({ url: socks.url, timeoutMs: 3000 });
    expect(result.reachable).toBe(true);
    expect(result.authChallenge).toBe('none');
    expect(socks.connections).toBe(1);
    expect(socks.methods).toEqual([0x00]);
    expect(socks.targets).toContain('probe.invalid:443');
  });

  it('user/pass из userinfo URL → успешная аутентификация', async () => {
    const socks = await startFakeSocks5Proxy({ auth: { username: 'user', password: 'pass' } });
    cleanups.push(() => socks.close());

    const url = socks.url.replace('socks5://', 'socks5://user:pass@');
    const result = await checkProxyConnectivity({ url, timeoutMs: 3000 });
    expect(result.reachable).toBe(true);
    expect(result.authChallenge).toBe('none');
    expect(socks.authAttempts).toBe(1);
  });

  it('прокси требует auth, кред нет → authChallenge Basic', async () => {
    const socks = await startFakeSocks5Proxy({ auth: { username: 'user', password: 'pass' } });
    cleanups.push(() => socks.close());

    const result = await checkProxyConnectivity({ url: socks.url, timeoutMs: 3000 });
    expect(result.reachable).toBe(true);
    expect(result.authChallenge).toBe('Basic');
    expect(socks.authAttempts).toBe(0);
  });

  it('неверный пароль → reachable, authChallenge Basic (секрет не раскрыт)', async () => {
    const socks = await startFakeSocks5Proxy({ auth: { username: 'user', password: 'right' } });
    cleanups.push(() => socks.close());

    const url = socks.url.replace('socks5://', 'socks5://user:wrong@');
    const result = await checkProxyConnectivity({ url, timeoutMs: 3000 });
    expect(result.reachable).toBe(true);
    expect(result.authChallenge).toBe('Basic');
    expect(socks.authAttempts).toBe(1);
    expect(JSON.stringify(result)).not.toContain('wrong');
  });
});
