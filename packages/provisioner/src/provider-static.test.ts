/**
 * Провайдер `static`: адреса известны заранее.
 *
 * - точный ключ `STATIC_POOLS` важнее профиля;
 * - иначе — `url` профиля запроса;
 * - неизвестный ключ/профиль → `PoolProvisionerError` `pool_not_found`;
 * - `capabilities` отдаёт `static` и список профилей;
 * - `drain`/`release` — no-op (ресурсов нет).
 */
import { describe, expect, it } from 'vitest';
import type { EnsurePoolRequest } from './protocol.js';
import { PoolProvisionerError, StaticPoolProvisioner } from './provider.js';

const PROFILES = {
  default: { url: 'http://executor-default:5100' },
  browser: { url: 'http://browser:4200', network: 'restricted' as const },
};

const STATIC_POOLS = {
  'project:p1:exec:default': 'http://executor-p1:5100',
};

/** Запрос пула с дефолтными полями. */
function request(overrides: Partial<EnsurePoolRequest> = {}): EnsurePoolRequest {
  return {
    key: 'project:p1:exec:default',
    scope: 'project',
    id: 'p1',
    class: 'exec',
    profile: 'default',
    ...overrides,
  };
}

describe('provisioner: static-провайдер', () => {
  const provider = new StaticPoolProvisioner(STATIC_POOLS, PROFILES);

  it('точный ключ важнее профиля', async () => {
    const pool = await provider.ensure(request());
    expect(pool.url).toBe('http://executor-p1:5100');
    expect(pool.token).not.toBe('');
  });

  it('неизвестный ключ → url профиля', async () => {
    const pool = await provider.ensure(request({ key: 'project:p2:exec:default', id: 'p2' }));
    expect(pool.url).toBe('http://executor-default:5100');
  });

  it('профиль browser находит свой url', async () => {
    const pool = await provider.ensure(
      request({
        key: 'session:s1:browser:default',
        scope: 'session',
        id: 's1',
        class: 'browser',
        profile: 'browser',
      }),
    );
    expect(pool.url).toBe('http://browser:4200');
  });

  it('каждый ensure выдаёт новый токен (идемпотентность — у сервиса)', async () => {
    const first = await provider.ensure(request());
    const second = await provider.ensure(request());
    expect(first.token).not.toBe(second.token);
  });

  it('неизвестный профиль → pool_not_found', async () => {
    await expect(
      provider.ensure(request({ key: 'project:p9:exec:missing', id: 'p9', profile: 'missing' })),
    ).rejects.toMatchObject({ name: 'PoolProvisionerError', reason: 'pool_not_found' });
  });

  it('profileSpec игнорируется: адрес пула — из каталога (static)', async () => {
    const pool = await provider.ensure(
      request({
        profileSpec: { image: 'registry.example/synth-executor:from-spec' },
      }),
    );
    expect(pool.url).toBe('http://executor-p1:5100');
  });

  it('ошибка не содержит токенов и описывает причину', async () => {
    try {
      await provider.ensure(request({ key: 'project:p9:exec:missing', id: 'p9', profile: 'missing' }));
      expect.unreachable('ожидалась ошибка');
    } catch (err) {
      expect(err).toBeInstanceOf(PoolProvisionerError);
      const message = (err as Error).message;
      expect(message).toContain('missing');
      expect(message).toContain('SYNTH_PROVISIONER_PROFILES');
    }
  });

  it('capabilities: provider static и профили', async () => {
    const capabilities = await provider.capabilities();
    expect(capabilities.provider).toBe('static');
    expect(capabilities.profiles.sort()).toEqual(['browser', 'default']);
  });

  it('drain/release — no-op и не бросают', async () => {
    await expect(provider.drain('project:p1:exec:default')).resolves.toBeUndefined();
    await expect(provider.release('project:p1:exec:default')).resolves.toBeUndefined();
  });
});
