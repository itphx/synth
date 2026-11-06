/**
 * PROP-124 §3: матрица доступа к SSH-ключам (единый гейт).
 *
 * Проверяем обе стороны: каждый отказ имеет **машинный код** и происходит
 * **до** `reveal()` (секрет при отказе не раскрывается никогда), а каждый
 * разрешённый случай действительно отдаёт материал ключа.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SSHKeyMeta, SSHKeyUsage } from '@itphx/synth-shared';
import { normalizeSshKeyAllowHosts, normalizeSshKeyAllowPorts, normalizeSshKeyUsages } from '@itphx/synth-shared';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import {
  createSshSecretsResolver,
  MAX_SSH_EXEC_SECRETS,
  resolveSshSecretsForExec,
  resolveSshAccess,
  SshAccessError,
} from './access.js';

/** Запись ключа в фейковом сторе (секрет хранится рядом с метаданными). */
interface FakeKey {
  id: string;
  name: string;
  agentIds: string[];
  usages?: SSHKeyUsage[];
  allowHosts?: string[];
  allowPorts?: number[];
  passphrase?: string;
}

const PRIVATE_KEY = 'private-key-material';

/** Метаданные ключа — как у настоящего стора (нормализация при чтении). */
function toMeta(key: FakeKey): SSHKeyMeta {
  return {
    id: key.id,
    name: key.name,
    type: 'user',
    agentIds: [...key.agentIds],
    usages: normalizeSshKeyUsages(key.usages),
    allowHosts: normalizeSshKeyAllowHosts(key.allowHosts),
    allowPorts: normalizeSshKeyAllowPorts(key.allowPorts),
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

/**
 * Фейковый стор SSH-ключей.
 *
 * `revealCalls` — «шпион» на раскрытие: гейт обязан отказать **до**
 * `reveal()`, поэтому при отказе список вызовов пуст.
 */
class FakeSshKeyStore implements SSHKeyRepository {
  /** id'ы ключей, для которых вызывали `reveal()`. */
  readonly revealCalls: string[] = [];

  constructor(private readonly keys: FakeKey[]) {}

  async list(): Promise<SSHKeyMeta[]> {
    return this.keys.map(toMeta);
  }

  async get(id: string): Promise<SSHKeyMeta | null> {
    const found = this.keys.find((key) => key.id === id);
    return found ? toMeta(found) : null;
  }

  async reveal(id: string): Promise<{ privateKey: string; passphrase?: string } | null> {
    this.revealCalls.push(id);
    const found = this.keys.find((key) => key.id === id);
    if (!found) return null;
    return found.passphrase === undefined
      ? { privateKey: PRIVATE_KEY }
      : { privateKey: PRIVATE_KEY, passphrase: found.passphrase };
  }

  // Остальные методы порта гейтом не используются.
  async listRaw(): Promise<never[]> {
    throw new Error('не используется');
  }
  async rotateMasterKey(): Promise<never> {
    throw new Error('не используется');
  }
  async listForAgent(): Promise<never[]> {
    throw new Error('не используется');
  }
  async create(): Promise<never> {
    throw new Error('не используется');
  }
  async update(): Promise<never> {
    throw new Error('не используется');
  }
  async delete(): Promise<never> {
    throw new Error('не используется');
  }
  async linkAgent(): Promise<never> {
    throw new Error('не используется');
  }
  async unlinkAgent(): Promise<never> {
    throw new Error('не используется');
  }
}

/** Ожидаемый отказ гейта с конкретным машинным кодом. */
async function expectAccessError(
  promise: Promise<unknown>,
  code: string,
): Promise<SshAccessError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SshAccessError);
  expect((err as SshAccessError).code).toBe(code);
  return err as SshAccessError;
}

describe('resolveSshAccess — типы использования (usages)', () => {
  it('ключ только для git → ssh-доступ запрещён (usage_denied)', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'git-only', agentIds: ['fixer'], usages: ['git'] },
    ]);

    await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', keyId: 'k1', agentRole: 'fixer' }),
      'usage_denied',
    );
    // Отказ — до раскрытия: секрет не запрашивался.
    expect(store.revealCalls).toEqual([]);
  });

  it('ключ только для ssh → git-доступ запрещён (usage_denied)', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'ssh-only', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    await expectAccessError(
      resolveSshAccess({ store, purpose: 'git', keyId: 'k1' }),
      'usage_denied',
    );
    expect(store.revealCalls).toEqual([]);
  });

  it('ключ без usages (создан до Ф1) читается как git-only', async () => {
    const store = new FakeSshKeyStore([{ id: 'k1', name: 'legacy', agentIds: ['fixer'] }]);

    const access = await resolveSshAccess({ store, purpose: 'git', keyId: 'k1' });
    expect(access.key.privateKey).toBe(PRIVATE_KEY);

    await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', keyId: 'k1', agentRole: 'fixer' }),
      'usage_denied',
    );
  });

  it('git-запрос без поля mode проходит гейт (union по назначению)', async () => {
    // PROP-124 §3: для git режим инстанса не применяется — в запросе гейта
    // поля mode нет вовсе (дискриминируемое объединение SshAccessRequest).
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'git-only', agentIds: ['fixer'], usages: ['git'] },
    ]);

    const access = await resolveSshAccess({ store, purpose: 'git', keyId: 'k1' });
    expect(access.key.privateKey).toBe(PRIVATE_KEY);
    expect(access.meta.usages).toEqual(['git']);
    // Раскрытие состоялось (режим инстанса к git-пути отношения не имеет).
    expect(store.revealCalls).toEqual(['k1']);
  });

  it('ключ с обоими usage подходит и для git, и для ssh', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'both', agentIds: ['fixer'], usages: ['git', 'ssh'] },
    ]);

    const git = await resolveSshAccess({ store, purpose: 'git', keyId: 'k1' });
    expect(git.key.privateKey).toBe(PRIVATE_KEY);

    const ssh = await resolveSshAccess({
      store,
      mode: 'agent',
      purpose: 'ssh',
      keyId: 'k1',
      agentRole: 'fixer',
    });
    expect(ssh.key.privateKey).toBe(PRIVATE_KEY);
    expect(ssh.meta.name).toBe('both');
  });
});

describe('resolveSshAccess — привязка к агенту (agentIds)', () => {
  const sshKey = { id: 'k1', name: 'deploy', agentIds: [] as string[], usages: ['ssh'] as SSHKeyUsage[] };

  it('пустой agentIds → agent_not_linked', async () => {
    const store = new FakeSshKeyStore([{ ...sshKey }]);

    await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', keyId: 'k1', agentRole: 'fixer' }),
      'agent_not_linked',
    );
    expect(store.revealCalls).toEqual([]);
  });

  it('роль агента не в списке → agent_not_linked', async () => {
    const store = new FakeSshKeyStore([{ ...sshKey, agentIds: ['tester'] }]);

    await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', keyId: 'k1', agentRole: 'fixer' }),
      'agent_not_linked',
    );
    expect(store.revealCalls).toEqual([]);
  });

  it('роль агента в списке → ключ раскрыт', async () => {
    const store = new FakeSshKeyStore([{ ...sshKey, agentIds: ['fixer', 'tester'] }]);

    const access = await resolveSshAccess({
      store,
      mode: 'agent',
      purpose: 'ssh',
      keyId: 'k1',
      agentRole: 'fixer',
    });
    expect(access.key.privateKey).toBe(PRIVATE_KEY);
    expect(store.revealCalls).toEqual(['k1']);
  });

  it('роль агента не задана → agent_not_linked (fail-closed)', async () => {
    const store = new FakeSshKeyStore([{ ...sshKey, agentIds: ['fixer'] }]);

    await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', keyId: 'k1' }),
      'agent_not_linked',
    );
  });

  it('для git привязка к агенту не проверяется', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'git-only', agentIds: [], usages: ['git'] },
    ]);

    const access = await resolveSshAccess({ store, purpose: 'git', keyId: 'k1' });
    expect(access.key.privateKey).toBe(PRIVATE_KEY);
  });
});

describe('resolveSshAccess — политика хостов и портов (режим tools)', () => {
  const base = {
    id: 'k1',
    name: 'deploy',
    agentIds: ['fixer'],
    usages: ['ssh'] as SSHKeyUsage[],
  };

  it('хост не из списка → host_denied', async () => {
    const store = new FakeSshKeyStore([{ ...base, allowHosts: ['git.example.com'] }]);

    await expectAccessError(
      resolveSshAccess({
        store,
        mode: 'tools',
        purpose: 'ssh',
        keyId: 'k1',
        agentRole: 'fixer',
        host: 'evil.example.com',
      }),
      'host_denied',
    );
    expect(store.revealCalls).toEqual([]);
  });

  it('пустой allowHosts → host_denied (не «разрешено всё»)', async () => {
    const store = new FakeSshKeyStore([{ ...base, allowHosts: [] }]);

    await expectAccessError(
      resolveSshAccess({
        store,
        mode: 'tools',
        purpose: 'ssh',
        keyId: 'k1',
        agentRole: 'fixer',
        host: 'git.example.com',
      }),
      'host_denied',
    );
    expect(store.revealCalls).toEqual([]);
  });

  it('хост не передан → policy_required (политика хостов обязательна)', async () => {
    const store = new FakeSshKeyStore([{ ...base, allowHosts: ['git.example.com'] }]);

    await expectAccessError(
      resolveSshAccess({ store, mode: 'tools', purpose: 'ssh', keyId: 'k1', agentRole: 'fixer' }),
      'policy_required',
    );
    expect(store.revealCalls).toEqual([]);
  });

  it('*.suffix матчит поддомен, но не сам домен', async () => {
    const store = new FakeSshKeyStore([{ ...base, allowHosts: ['*.corp.example'] }]);

    const ok = await resolveSshAccess({
      store,
      mode: 'tools',
      purpose: 'ssh',
      keyId: 'k1',
      agentRole: 'fixer',
      host: 'build.corp.example',
    });
    expect(ok.key.privateKey).toBe(PRIVATE_KEY);

    await expectAccessError(
      resolveSshAccess({
        store,
        mode: 'tools',
        purpose: 'ssh',
        keyId: 'k1',
        agentRole: 'fixer',
        host: 'corp.example',
      }),
      'host_denied',
    );
  });

  it('CIDR работает только по IP-литералу', async () => {
    const store = new FakeSshKeyStore([{ ...base, allowHosts: ['10.0.0.0/8'] }]);

    const ok = await resolveSshAccess({
      store,
      mode: 'tools',
      purpose: 'ssh',
      keyId: 'k1',
      agentRole: 'fixer',
      host: '10.1.2.3',
    });
    expect(ok.key.privateKey).toBe(PRIVATE_KEY);

    // Тот же адрес по имени хоста — не разрешён (CIDR не резолвит имена).
    await expectAccessError(
      resolveSshAccess({
        store,
        mode: 'tools',
        purpose: 'ssh',
        keyId: 'k1',
        agentRole: 'fixer',
        host: 'build.internal',
      }),
      'host_denied',
    );
  });

  it('порт вне allowPorts → port_denied', async () => {
    const store = new FakeSshKeyStore([
      { ...base, allowHosts: ['git.example.com'], allowPorts: [22] },
    ]);

    await expectAccessError(
      resolveSshAccess({
        store,
        mode: 'tools',
        purpose: 'ssh',
        keyId: 'k1',
        agentRole: 'fixer',
        host: 'git.example.com',
        port: 2222,
      }),
      'port_denied',
    );
    expect(store.revealCalls).toEqual([]);
  });

  it('пустой allowPorts → разрешён только порт 22', async () => {
    const store = new FakeSshKeyStore([{ ...base, allowHosts: ['git.example.com'], allowPorts: [] }]);

    const ok = await resolveSshAccess({
      store,
      mode: 'tools',
      purpose: 'ssh',
      keyId: 'k1',
      agentRole: 'fixer',
      host: 'git.example.com',
    });
    expect(ok.key.privateKey).toBe(PRIVATE_KEY);

    await expectAccessError(
      resolveSshAccess({
        store,
        mode: 'tools',
        purpose: 'ssh',
        keyId: 'k1',
        agentRole: 'fixer',
        host: 'git.example.com',
        port: 2222,
      }),
      'port_denied',
    );
  });

  it('порт из allowPorts → ключ раскрыт', async () => {
    const store = new FakeSshKeyStore([
      { ...base, allowHosts: ['git.example.com'], allowPorts: [22, 2222] },
    ]);

    const ok = await resolveSshAccess({
      store,
      mode: 'tools',
      purpose: 'ssh',
      keyId: 'k1',
      agentRole: 'fixer',
      host: 'git.example.com',
      port: 2222,
    });
    expect(ok.key.privateKey).toBe(PRIVATE_KEY);
    expect(store.revealCalls).toEqual(['k1']);
  });
});

describe('resolveSshAccess — режим agent (хост/порт не проверяются)', () => {
  it('запрос без хоста и порта проходит', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'deploy', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    const access = await resolveSshAccess({
      store,
      mode: 'agent',
      purpose: 'ssh',
      keyId: 'k1',
      agentRole: 'fixer',
    });
    expect(access.key.privateKey).toBe(PRIVATE_KEY);
  });

  it('в режиме agent хост вне allowHosts не проверяется (фильтрации нет)', async () => {
    const store = new FakeSshKeyStore([
      {
        id: 'k1',
        name: 'deploy',
        agentIds: ['fixer'],
        usages: ['ssh'],
        allowHosts: ['git.example.com'],
        allowPorts: [22],
      },
    ]);

    const access = await resolveSshAccess({
      store,
      mode: 'agent',
      purpose: 'ssh',
      keyId: 'k1',
      agentRole: 'fixer',
      host: 'anywhere.example',
      port: 2200,
    });
    expect(access.key.privateKey).toBe(PRIVATE_KEY);
  });
});

describe('resolveSshAccess — выбор ключа без keyId', () => {
  it('единственный подходящий ключ → раскрыт', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'git-a', agentIds: ['fixer'], usages: ['git'] },
      { id: 'k2', name: 'ssh-a', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    const access = await resolveSshAccess({
      store,
      mode: 'agent',
      purpose: 'ssh',
      agentRole: 'fixer',
    });
    expect(access.meta.id).toBe('k2');
    expect(access.key.privateKey).toBe(PRIVATE_KEY);
  });

  it('несколько подходящих → ambiguous (в тексте — имена ключей)', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'ssh-a', agentIds: ['fixer'], usages: ['ssh'] },
      { id: 'k2', name: 'ssh-b', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    const err = await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', agentRole: 'fixer' }),
      'ambiguous',
    );
    expect(err.message).toContain('ssh-a');
    expect(err.message).toContain('ssh-b');
    expect(store.revealCalls).toEqual([]);
  });

  it('подходящих ключей нет → key_not_found', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'git-a', agentIds: ['fixer'], usages: ['git'] },
    ]);

    await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', agentRole: 'fixer' }),
      'key_not_found',
    );
    expect(store.revealCalls).toEqual([]);
  });

  it('для git подходят все git-ключи: несколько → ambiguous', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'git-a', agentIds: ['fixer'], usages: ['git'] },
      { id: 'k2', name: 'git-b', agentIds: ['fixer'], usages: ['git'] },
    ]);

    await expectAccessError(
      resolveSshAccess({ store, purpose: 'git' }),
      'ambiguous',
    );
  });

  it('явный keyId, которого нет → key_not_found (без раскрытия)', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'git-a', agentIds: ['fixer'], usages: ['git'] },
    ]);

    await expectAccessError(
      resolveSshAccess({ store, purpose: 'git', keyId: 'missing' }),
      'key_not_found',
    );
    expect(store.revealCalls).toEqual([]);
  });
});

describe('resolveSshAccess — секреты в ошибках не светятся', () => {
  it('в тексте отказа — имя ключа, но не материал', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'deploy-key', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    const err = await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', keyId: 'k1', agentRole: 'other' }),
      'agent_not_linked',
    );
    expect(err.message).toContain('deploy-key');
    expect(err.message).not.toContain(PRIVATE_KEY);
  });

  it('passphrase ключа не попадает в результат отказа', async () => {
    const store = new FakeSshKeyStore([
      {
        id: 'k1',
        name: 'deploy-key',
        agentIds: [],
        usages: ['ssh'],
        passphrase: 'super-secret-passphrase',
      },
    ]);

    const err = await expectAccessError(
      resolveSshAccess({ store, mode: 'agent', purpose: 'ssh', keyId: 'k1', agentRole: 'fixer' }),
      'agent_not_linked',
    );
    expect(err.message).not.toContain('super-secret-passphrase');
  });
});

/**
 * PROP-124 §2: секреты вызова для режима `ssh-агента`.
 *
 * Проверяем: режим `tools` не выдаёт ничего; в режиме `agent` выдаются только
 * ключи роли (привязка — единственный ACL), лимит протокола соблюдается, а
 * ключи без привязки/с чужим usage не попадают.
 */
describe('resolveSshSecretsForExec — режим agent', () => {
  /** Стор с тремя ключами: привязан к роли, привязан к чужой роли, без привязки. */
  function makeStore(): FakeSshKeyStore {
    return new FakeSshKeyStore([
      { id: 'k1', name: 'deploy', agentIds: ['fixer'], usages: ['ssh'] },
      { id: 'k2', name: 'git-only', agentIds: ['fixer'], usages: ['git'] },
      { id: 'k3', name: 'other-role', agentIds: ['tester'], usages: ['ssh'] },
      { id: 'k4', name: 'unbound', agentIds: [], usages: ['ssh'] },
    ]);
  }

  it('режим tools — секретов нет (ключ в shell не попадает никогда)', async () => {
    const store = makeStore();

    const secrets = await resolveSshSecretsForExec({
      store,
      mode: 'tools',
      agentRole: 'fixer',
    });

    expect(secrets).toEqual([]);
    expect(store.revealCalls).toEqual([]);
  });

  it('режим agent — ключ роли выдан в режиме доставки agent', async () => {
    const store = makeStore();

    const secrets = await resolveSshSecretsForExec({
      store,
      mode: 'agent',
      agentRole: 'fixer',
    });

    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({
      kind: 'ssh-key',
      privateKey: PRIVATE_KEY,
      mode: 'agent',
    });
    expect(store.revealCalls).toEqual(['k1']);
  });

  it('ключ без привязки и ключ чужой роли не выдаются', async () => {
    const store = makeStore();

    const secrets = await resolveSshSecretsForExec({
      store,
      mode: 'agent',
      agentRole: 'fixer',
    });

    const names = secrets.map((secret) => secret.privateKey);
    expect(names).toEqual([PRIVATE_KEY]);
    // Раскрыт только ключ роли — остальные не трогали вовсе.
    expect(store.revealCalls).toEqual(['k1']);
  });

  it('роль не задана — секретов нет (fail-closed)', async () => {
    const store = makeStore();

    const secrets = await resolveSshSecretsForExec({ store, mode: 'agent' });

    expect(secrets).toEqual([]);
    expect(store.revealCalls).toEqual([]);
  });

  it('подходящих ключей нет — пустой массив, ошибок нет', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'git-only', agentIds: ['fixer'], usages: ['git'] },
    ]);

    const secrets = await resolveSshSecretsForExec({
      store,
      mode: 'agent',
      agentRole: 'fixer',
    });

    expect(secrets).toEqual([]);
  });

  it('больше лимита протокола — усечение по стабильному порядку + предупреждение', async () => {
    const keys = Array.from({ length: 6 }, (_, index) => ({
      id: `k${index}`,
      name: `key-${index}`,
      agentIds: ['fixer'],
      usages: ['ssh'] as SSHKeyUsage[],
    }));
    const store = new FakeSshKeyStore(keys);
    const warn = vi.fn();

    const secrets = await resolveSshSecretsForExec({
      store,
      mode: 'agent',
      agentRole: 'fixer',
      logger: { warn },
    });

    expect(secrets).toHaveLength(MAX_SSH_EXEC_SECRETS);
    // Порядок стабильный: по имени (`key-0`…`key-5`).
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('key-5');
    // Материал в предупреждение не попадает.
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('ключ, который не удалось раскрыть, — пропускается (остальные выдаются)', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'broken', agentIds: ['fixer'], usages: ['ssh'] },
      { id: 'k2', name: 'good', agentIds: ['fixer'], usages: ['ssh'] },
    ]);
    const originalReveal = store.reveal.bind(store);
    store.reveal = async (id: string) => {
      if (id === 'k1') throw new Error('мастер-ключ недоступен');
      return originalReveal(id);
    };
    const warn = vi.fn();

    const secrets = await resolveSshSecretsForExec({
      store,
      mode: 'agent',
      agentRole: 'fixer',
      logger: { warn },
    });

    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.privateKey).toBe(PRIVATE_KEY);
    expect(warn).toHaveBeenCalled();
  });
});

describe('createSshSecretsResolver — правила выдачи', () => {
  it('режим agent — ключи роли', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'deploy', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    const resolve = createSshSecretsResolver({
      store,
      getMode: () => 'agent',
      agentRole: () => 'fixer',
    });

    const secrets = await resolve();
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.mode).toBe('agent');
  });

  it('режим tools — пусто', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'deploy', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    const resolve = createSshSecretsResolver({
      store,
      getMode: () => 'tools',
      agentRole: () => 'fixer',
    });

    expect(await resolve()).toEqual([]);
  });

  it('plan-режим — ключ не выдаётся (инвариант: ключ в plan не попадает)', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'deploy', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    const resolve = createSshSecretsResolver({
      store,
      getMode: () => 'agent',
      agentRole: () => 'fixer',
      isPlan: () => true,
    });

    expect(await resolve()).toEqual([]);
    expect(store.revealCalls).toEqual([]);
  });

  it('роль читается в момент вызова: смена роли меняет выданные ключи', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'for-fixer', agentIds: ['fixer'], usages: ['ssh'] },
      { id: 'k2', name: 'for-tester', agentIds: ['tester'], usages: ['ssh'] },
    ]);
    // Роль исполняющего вызова меняется между вызовами (сабагент/смена роли).
    let currentRole: string | undefined = 'fixer';

    const resolve = createSshSecretsResolver({
      store,
      getMode: () => 'agent',
      agentRole: () => currentRole,
    });

    expect((await resolve()).length).toBe(1);
    expect(store.revealCalls).toEqual(['k1']);

    currentRole = 'tester';
    expect((await resolve()).length).toBe(1);
    // Ключ выдан по **актуальной** роли, а не по роли на момент создания.
    expect(store.revealCalls).toEqual(['k1', 'k2']);
  });

  it('роли нет — пусто (fail-closed)', async () => {
    const store = new FakeSshKeyStore([
      { id: 'k1', name: 'deploy', agentIds: ['fixer'], usages: ['ssh'] },
    ]);

    const resolve = createSshSecretsResolver({
      store,
      getMode: () => 'agent',
      agentRole: () => undefined,
    });

    expect(await resolve()).toEqual([]);
  });

  it('стороны нет — пусто (вызов без ключей)', async () => {
    const resolve = createSshSecretsResolver({
      getMode: () => 'agent',
      agentRole: () => 'fixer',
    });

    expect(await resolve()).toEqual([]);
  });
});
