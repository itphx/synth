/**
 * Опциональная интеграция ADR-099 (D1) с живым прокси.
 *
 * Гейтится env `SYNTH_TEST_PROXY_URL` (по умолчанию `http://top.itphx.loc:3128`);
 * в CI без прокси — skip. Проверяет реальный маршрут через ProxyAgent и
 * no_proxy-исключение.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as undici from 'undici';
import { egressFetch, initTlsTrust, _resetTlsTrustForTests } from './tls.js';

const PROXY_URL = process.env.SYNTH_TEST_PROXY_URL ?? 'http://top.itphx.loc:3128';
const TARGET = 'https://registry.npmjs.org/undici/latest';

afterEach(() => {
  _resetTlsTrustForTests();
  undici.setGlobalDispatcher(new undici.Agent());
});

describe.skipIf(!process.env.SYNTH_TEST_PROXY_URL)('egress proxy (opt-in)', () => {
  it('egressFetch идёт через ProxyAgent', async () => {
    await initTlsTrust({ proxy: { url: PROXY_URL, fromEnv: false } }, {});
    const via: string[] = [];
    const res = await egressFetch(TARGET, {}, { onVia: (value) => via.push(value) });
    expect(res.status).toBe(200);
    expect(via).toEqual(['proxy']);
  });

  it('no_proxy-хост → direct', async () => {
    await initTlsTrust(
      { proxy: { url: PROXY_URL, fromEnv: false, noProxy: ['registry.npmjs.org'] } },
      {},
    );
    const via: string[] = [];
    const res = await egressFetch(TARGET, {}, { onVia: (value) => via.push(value) });
    expect(res.status).toBe(200);
    expect(via).toEqual(['direct']);
  });
});
