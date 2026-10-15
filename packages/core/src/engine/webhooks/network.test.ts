import { describe, it, expect } from 'vitest';
import { evaluateWebhookTarget } from './network.js';

/** Детерминированный резолвер: hostname → адреса. */
const resolve = (map: Record<string, string[]>) =>
  async (host: string): Promise<string[]> => map[host] ?? [];

describe('webhooks: SSRF-политика (ADR-052, этап II)', () => {
  it('приватный/loopback адрес блокируется по умолчанию', async () => {
    const res = await evaluateWebhookTarget('https://internal.example/hook', {
      resolveHost: resolve({ 'internal.example': ['10.0.0.5'] }),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBeTruthy();

    const loopback = await evaluateWebhookTarget('https://localhost:9000/hook', {
      resolveHost: resolve({ localhost: ['127.0.0.1'] }),
    });
    expect(loopback.allowed).toBe(false);
  });

  it('публичный https-адрес разрешён', async () => {
    const res = await evaluateWebhookTarget('https://hooks.example/hook', {
      resolveHost: resolve({ 'hooks.example': ['93.184.216.34'] }),
    });
    expect(res.allowed).toBe(true);
    expect(res.addresses).toEqual(['93.184.216.34']);
  });

  it('http блокируется без allowPrivateTargets; при флаге — разрешается', async () => {
    const http = await evaluateWebhookTarget('http://hooks.example/hook', {
      resolveHost: resolve({ 'hooks.example': ['93.184.216.34'] }),
    });
    expect(http.allowed).toBe(false);

    const dev = await evaluateWebhookTarget('http://localhost:8080/hook', {
      allowPrivateTargets: true,
    });
    expect(dev.allowed).toBe(true);
  });

  it('некорректная схема/URL отклоняется', async () => {
    expect((await evaluateWebhookTarget('ftp://x/y')).allowed).toBe(false);
    expect((await evaluateWebhookTarget('not-a-url')).allowed).toBe(false);
  });
});
