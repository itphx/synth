import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncProvidersFromEnv } from './sync-from-env.js';
import { JsonStore } from '../storage/json-store.js';
import type { ProviderConfig, ModelConfig } from '@itphx/synth-shared';

describe('syncProvidersFromEnv — NUM_CTX', () => {
  let tmpDir: string;
  let providerStore: JsonStore<ProviderConfig>;
  let modelStore: JsonStore<ModelConfig>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-sync-env-'));
    providerStore = new JsonStore<ProviderConfig>({ dataDir: tmpDir, subdir: 'providers' });
    modelStore = new JsonStore<ModelConfig>({ dataDir: tmpDir, subdir: 'models' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('SYNTH_PROVIDER_<NAME>_NUM_CTX → provider.numCtx (целое > 0)', async () => {
    vi.stubEnv('SYNTH_PROVIDER_OLLAMA_URL', 'http://localhost:11434');
    vi.stubEnv('SYNTH_PROVIDER_OLLAMA_MODEL', 'qwen3:8b');
    vi.stubEnv('SYNTH_PROVIDER_OLLAMA_NUM_CTX', '8192');

    await syncProvidersFromEnv(providerStore, modelStore);

    const p = await providerStore.load('ollama');
    expect(p?.numCtx).toBe(8192);
    expect(p?.baseUrl).toBe('http://localhost:11434');
  });

  it('имя с подчёркиваниями → lowercase с дефисом', async () => {
    vi.stubEnv('SYNTH_PROVIDER_MY_LOCAL_URL', 'http://localhost:11434');
    vi.stubEnv('SYNTH_PROVIDER_MY_LOCAL_NUM_CTX', '4096');

    await syncProvidersFromEnv(providerStore, modelStore);

    expect((await providerStore.load('my-local'))?.numCtx).toBe(4096);
  });

  it('невалидное NUM_CTX (не целое / ≤ 0) игнорируется', async () => {
    vi.stubEnv('SYNTH_PROVIDER_BAD_URL', 'http://localhost:11434');
    vi.stubEnv('SYNTH_PROVIDER_BAD_NUM_CTX', '0');
    vi.stubEnv('SYNTH_PROVIDER_BAD2_URL', 'http://localhost:11434');
    vi.stubEnv('SYNTH_PROVIDER_BAD2_NUM_CTX', 'abc');

    await syncProvidersFromEnv(providerStore, modelStore);

    expect((await providerStore.load('bad'))?.numCtx).toBeUndefined();
    expect((await providerStore.load('bad2'))?.numCtx).toBeUndefined();
  });
});
