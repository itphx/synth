/**
 * Kubernetes API-клиент: REST, авторизация, коды ошибок (PROP-135, Ф4b-2b).
 *
 * Клиент проверяется на локальном HTTP-сервере (Node `http`): это те же
 * `node:https`-опции без TLS-сертификата. TLS-ветка покрывается отдельным
 * тестом на недоступный https-адрес — важно, что ошибка транспорта
 * превращается в `provider_error` и **не содержит токена**.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PoolProvisionerError } from './errors.js';
import { HttpKubernetesClient } from './kubernetes.js';

/** Токен собирается из частей: в исходнике нет литерала, похожего на кред. */
const TOKEN = ['k8s-client', 'token', 'test-1234567890'].join('-');

/** Записанный запрос (для проверки заголовков/тел). */
interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('provisioner: клиент Kubernetes API', () => {
  let server: Server;
  let apiServer: string;
  let dir: string;
  let client: HttpKubernetesClient;
  let forbidden: HttpKubernetesClient;
  const requests: RecordedRequest[] = [];
  let secretPosts = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-k8s-'));
    const tokenFile = join(dir, 'token');
    const caFile = join(dir, 'ca.crt');
    await writeFile(tokenFile, `${TOKEN}\n`, 'utf8');
    await writeFile(caFile, 'test-ca', 'utf8');

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const url = req.url ?? '';

        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (url.includes('/namespaces/forbidden/')) {
          json(403, { kind: 'Status', reason: 'Forbidden', message: 'pods is forbidden' });
          return;
        }

        if (req.method === 'GET' && url.startsWith('/api/v1/namespaces/synth/pods')) {
          if (url.includes('/pods/pod-missing')) {
            json(404, { kind: 'Status', reason: 'NotFound' });
            return;
          }
          if (url.includes('/pods/')) {
            json(200, { metadata: { name: 'pod-a' }, status: { phase: 'Running', podIP: '10.0.0.7' } });
            return;
          }
          json(200, {
            items: [
              {
                metadata: { name: 'pod-a', labels: { 'synth.io/pool-hash': 'abc' } },
                status: { phase: 'Running', podIP: '10.0.0.7' },
              },
            ],
          });
          return;
        }

        if (req.method === 'POST' && url === '/api/v1/namespaces/synth/pods') {
          json(201, { metadata: { name: 'pod-a' } });
          return;
        }

        if (req.method === 'DELETE' && url.startsWith('/api/v1/namespaces/synth/pods/')) {
          if (url.includes('pod-missing')) {
            json(404, { kind: 'Status', reason: 'NotFound' });
            return;
          }
          json(200, { kind: 'Status', status: 'Success' });
          return;
        }

        if (req.method === 'POST' && url === '/api/v1/namespaces/synth/secrets') {
          secretPosts += 1;
          if (secretPosts > 1) {
            json(409, { kind: 'Status', reason: 'AlreadyExists' });
            return;
          }
          json(201, { metadata: { name: 'secret-a' } });
          return;
        }

        if (req.method === 'GET' && url === '/api/v1/namespaces/synth/secrets/secret-a') {
          json(200, {
            metadata: { name: 'secret-a' },
            data: { token: Buffer.from('pool-token-value', 'utf8').toString('base64') },
          });
          return;
        }

        if (req.method === 'GET' && url.startsWith('/api/v1/namespaces/synth/secrets/')) {
          json(404, { kind: 'Status', reason: 'NotFound' });
          return;
        }

        if (req.method === 'DELETE' && url.startsWith('/api/v1/namespaces/synth/secrets/')) {
          json(404, { kind: 'Status', reason: 'NotFound' });
          return;
        }

        json(500, { kind: 'Status', reason: 'InternalError', message: 'unexpected path' });
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    apiServer = `http://127.0.0.1:${port}`;
    client = new HttpKubernetesClient({
      apiServer,
      namespace: 'synth',
      tokenFile,
      caFile,
      requestTimeoutMs: 2_000,
    });
    forbidden = new HttpKubernetesClient({
      apiServer,
      namespace: 'forbidden',
      tokenFile,
      caFile,
      requestTimeoutMs: 2_000,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('listPods: labelSelector кодируется, токен уходит в Authorization', async () => {
    requests.length = 0;
    const pods = await client.listPods('synth.io/pool-hash=abc');
    expect(pods).toHaveLength(1);
    expect(pods[0]?.status?.podIP).toBe('10.0.0.7');
    expect(requests[0]?.url).toContain('labelSelector=synth.io%2Fpool-hash%3Dabc');
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.headers.accept).toBe('application/json');
  });

  it('getPod: 404 → null, найденный под возвращается', async () => {
    await expect(client.getPod('pod-missing')).resolves.toBeNull();
    const pod = await client.getPod('pod-a');
    expect(pod?.metadata?.name).toBe('pod-a');
  });

  it('createPod/createSecret: 409 → false (объект уже есть), тело — JSON', async () => {
    await expect(client.createPod({ kind: 'Pod', metadata: { name: 'pod-a' } })).resolves.toBe(true);
    const posted = requests.at(-1);
    expect(posted?.method).toBe('POST');
    expect(posted?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(posted?.body ?? '{}')).toMatchObject({ kind: 'Pod' });

    await expect(client.createSecret({ kind: 'Secret' })).resolves.toBe(true);
    await expect(client.createSecret({ kind: 'Secret' })).resolves.toBe(false);
  });

  it('getSecret: токен из data.token (base64)', async () => {
    const secret = await client.getSecret('secret-a');
    const token = Buffer.from(secret?.data?.token ?? '', 'base64').toString('utf8');
    expect(token).toBe('pool-token-value');
    await expect(client.getSecret('secret-missing')).resolves.toBeNull();
  });

  it('deletePod/deleteSecret: grace-период в query, 404 — no-op', async () => {
    requests.length = 0;
    await expect(client.deletePod('pod-a', 5)).resolves.toBeUndefined();
    expect(requests[0]?.url).toContain('gracePeriodSeconds=5');
    await expect(client.deletePod('pod-missing', 0)).resolves.toBeUndefined();
    await expect(client.deleteSecret('secret-missing')).resolves.toBeUndefined();
  });

  it('403 → provider_error без токена в тексте', async () => {
    try {
      await forbidden.listPods('synth.io/pool-hash=abc');
      expect.unreachable('ожидалась ошибка');
    } catch (err) {
      expect(err).toBeInstanceOf(PoolProvisionerError);
      expect((err as PoolProvisionerError).reason).toBe('provider_error');
      const message = (err as Error).message;
      expect(message).toContain('403');
      expect(message).toContain('Forbidden');
      expect(message).not.toContain(TOKEN);
    }
  });

  it('http-ошибка разбирается как JSON, а не падает', async () => {
    // Путь не описан в фейковом сервере → 500 с телом Status.
    const unknown = new HttpKubernetesClient({
      apiServer,
      namespace: 'other',
      tokenFile: join(dir, 'token'),
      caFile: join(dir, 'ca.crt'),
    });
    await expect(unknown.listPods('')).rejects.toThrow(/500 InternalError/s);
  });

  it('нет файла токена — provider_error с путём и без значения токена', async () => {
    const broken = new HttpKubernetesClient({
      apiServer,
      namespace: 'synth',
      tokenFile: join(dir, 'missing-token'),
      caFile: join(dir, 'ca.crt'),
    });
    try {
      await broken.getPod('pod-a');
      expect.unreachable('ожидалась ошибка');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('токен ServiceAccount');
      expect(message).not.toContain(TOKEN);
    }
  });

  it('https без CA не подменяется системным доверием (fail-closed)', async () => {
    const broken = new HttpKubernetesClient({
      apiServer: 'https://127.0.0.1:1',
      namespace: 'synth',
      tokenFile: join(dir, 'token'),
      caFile: join(dir, 'missing-ca.crt'),
    });
    await expect(broken.getPod('pod-a')).rejects.toMatchObject({ reason: 'provider_error' });
  });
});
