// Лимит загрузки файла `/api/v2/fs/upload`: значение из `StandaloneConfig.maxUploadBytes`
// (заполняется `resolveMaxUploadBytes` — config/env) должно дойти до core-фабрики
// `createFsRoutes` в standalone-точке монтирования (standalone `mount-routes.ts`).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneApp } from './app.js';

const API_KEY = 'fs-upload-limit-test-key';

type StandaloneApp = Awaited<ReturnType<typeof createStandaloneApp>>;

describe('standalone /api/v2/fs/upload: лимит из StandaloneConfig.maxUploadBytes', () => {
  let dir: string;
  let wsRoot: string;

  async function upload(app: StandaloneApp, name: string, content: string): Promise<Response> {
    const fd = new FormData();
    fd.set('file', new File([content], name, { type: 'application/octet-stream' }));
    return app.app.request('/api/v2/fs/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: fd,
    });
  }

  function stop(handle: StandaloneApp): void {
    handle.stopScheduler();
    handle.stopEphemeralSweeper();
    handle.stopEventJournalPruner();
    handle.stopWebhookService();
    handle.stopWebhookDeliveryPruner();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-fs-upload-lim-'));
    wsRoot = join(dir, 'workspaces');
    await mkdir(wsRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('значение пробрасывается: в пределах лимита → 201, превышение → 413', async () => {
    const handle = await createStandaloneApp({
      port: 0,
      dataDir: dir,
      apiKey: API_KEY,
      workspacesRoot: wsRoot,
      maxUploadBytes: 16,
    });
    try {
      const ok = await upload(handle, 'ok.txt', 'ok');
      expect(ok.status).toBe(201);

      const big = await upload(handle, 'big.bin', 'x'.repeat(64));
      expect(big.status).toBe(413);
      expect(((await big.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
      await expect(stat(join(wsRoot, 'big.bin'))).rejects.toThrow();
    } finally {
      stop(handle);
    }
  });

  it('без maxUploadBytes применяется дефолт (100 МиБ): небольшой файл → 201', async () => {
    const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: API_KEY, workspacesRoot: wsRoot });
    try {
      const res = await upload(handle, 'default.txt', 'within-default-limit');
      expect(res.status).toBe(201);
    } finally {
      stop(handle);
    }
  });
});
