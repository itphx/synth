import { describe, it, expect } from 'vitest';
import { fetchWithEgressGuard, EgressBlockedError } from './egress-guard.js';
import { createEgressLogSink } from './egress-log.js';
import { PRIVATE_EGRESS_POLICY } from './egress-guard.js';
import { MemoryEgressRequestLogRepository } from '../../storage/memory/index.js';

const policy = { ...PRIVATE_EGRESS_POLICY, exceptions: [] };

function makeRepo() {
  return new MemoryEgressRequestLogRepository();
}

describe('egress-log: журнал внешних запросов', () => {
  it('allowed: пишет запись, url без query/userinfo, без тел/заголовков', async () => {
    const repo = makeRepo();
    const log = createEgressLogSink(repo, { enabled: true });
    const fetchImpl = async () => new Response('secret-body', {
      status: 200,
      headers: { 'content-length': '11', authorization: 'Bearer secret' },
    });

    const res = await fetchWithEgressGuard(
      'https://user:pass@93.184.216.34/path?token=secret#frag',
      { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: 'payload' },
      { policy, fetchImpl, scope: 'web_fetch', log },
    );
    expect(res.status).toBe(200);

    const entries = await repo.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.status).toBe('allowed');
    expect(entry.scope).toBe('web_fetch');
    expect(entry.host).toBe('93.184.216.34');
    expect(entry.url).toBe('https://93.184.216.34/path');
    expect(entry.method).toBe('POST');
    expect(entry.httpStatus).toBe(200);
    expect(entry.bytes).toBe(11);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    // Тела/заголовки не сохраняются.
    expect(JSON.stringify(entry)).not.toContain('secret');
    expect(entry).not.toHaveProperty('body');
    expect(entry).not.toHaveProperty('headers');
  });

  it('blocked: пишет reason/matchedRule', async () => {
    const repo = makeRepo();
    const log = createEgressLogSink(repo, { enabled: true });
    const fetchImpl = async () => { throw new Error('не должен вызываться'); };

    await expect(fetchWithEgressGuard(
      'http://127.0.0.1/private?token=secret',
      {},
      { policy, fetchImpl, scope: 'web_fetch', log },
    )).rejects.toBeInstanceOf(EgressBlockedError);

    const entries = await repo.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('blocked');
    expect(entries[0]!.reason).toBeTruthy();
    expect(entries[0]!.matchedRule).toBe('127.0.0.0/8');
    expect(entries[0]!.url).toBe('http://127.0.0.1/private');
  });

  it('egress.log.enabled=false — записей нет', async () => {
    const repo = makeRepo();
    const log = createEgressLogSink(repo, { enabled: false });
    const fetchImpl = async () => new Response('ok', { status: 200 });

    await fetchWithEgressGuard(
      'https://93.184.216.34/',
      {},
      { policy, fetchImpl, scope: 'web_fetch', log },
    );
    expect(await repo.list()).toEqual([]);
  });
});
