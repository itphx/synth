/**
 * ADR-076: тул `ssh_keys_list` — метаданные SSH-ключей инстанса.
 *
 * Проверяется главное:
 * - список всех ключей и фильтр по `agent_id` (`listForAgent`);
 * - пустой стор — явное «ключей нет, добавьте в настройках»;
 * - **секретов в выводе нет** (`privateKey`/`passphrase` — даже строкой);
 * - стор не сконфигурирован → понятная ошибка, а не падение;
 * - регистрация и политика: capability/группа `git_read`, доступность без
 *   рабочего каталога проекта, trust, authority.
 */
import { describe, it, expect } from 'vitest';
import type { SSHKey, SSHKeyCreateRequest, SSHKeyMeta, SSHKeyUpdateRequest, ToolContext } from '@itphx/synth-shared';
import {
  SSH_KEYS_LIST_TOOL,
  buildSshKeyRequiredResult,
  formatSshKeysForHint,
  sshKeysListTool,
} from './ssh-keys.js';
import { ALL_BUILTIN_TOOLS } from './index.js';
import { getToolGroups } from '../permission/groups.js';
import { computeToolAvailability, isWorkspaceDependentTool } from '../permission/availability.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { getToolTrust } from '../security/trust.js';
import { authorityActionForTool } from '../authority/actions.js';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';

const PRIVATE_KEY_BODY = 'BEGIN-OPENSSH-PRIVATE-KEY-body';
const PASSPHRASE = 'super-secret-passphrase';

/** Запись стора «как есть» (с секретами) — тул их видеть не должен. */
function rawKey(overrides: Partial<SSHKey> & { id: string; name: string }): SSHKey {
  return {
    agentIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    privateKey: `-----${PRIVATE_KEY_BODY}-----`,
    passphrase: PASSPHRASE,
    ...overrides,
  };
}

/** Публичное представление записи (стор отдаёт только это). */
function meta(key: SSHKey): SSHKeyMeta {
  const copy: Record<string, unknown> = { ...key };
  delete copy.privateKey;
  delete copy.passphrase;
  return copy as unknown as SSHKeyMeta;
}

/** Стор в памяти: наружу — только `list`/`listForAgent`, как у порта. */
class FakeSshKeyStore implements SSHKeyRepository {
  constructor(private readonly keys: SSHKey[]) {}

  async list(): Promise<SSHKeyMeta[]> {
    return this.keys.map(meta);
  }

  async listForAgent(agentId: string): Promise<SSHKeyMeta[]> {
    return this.keys.filter((key) => key.agentIds.includes(agentId)).map(meta);
  }

  async listRaw(): Promise<SSHKey[]> {
    return this.keys;
  }

  async rotateMasterKey(): Promise<never> {
    throw new Error('not used in this test');
  }

  async get(): Promise<never> {
    throw new Error('not used in this test');
  }

  async create(_input: SSHKeyCreateRequest): Promise<never> {
    throw new Error('not used in this test');
  }

  async update(_id: string, _patch: SSHKeyUpdateRequest): Promise<never> {
    throw new Error('not used in this test');
  }

  async delete(): Promise<boolean> {
    return false;
  }

  async linkAgent(): Promise<never> {
    throw new Error('not used in this test');
  }

  async unlinkAgent(): Promise<never> {
    throw new Error('not used in this test');
  }

  async reveal(): Promise<never> {
    throw new Error('not used in this test');
  }
}

function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
  return {
    sessionId: 'ses_test',
    messageId: 'msg_test',
    abortSignal: new AbortController().signal,
    // Рабочий каталог намеренно задан, но тул от него не зависит — см. тесты политики.
    workingDir: '/tmp/synth-ws',
    extra,
  } as ToolContext;
}

describe('ssh_keys_list (ADR-076)', () => {
  const keys: SSHKey[] = [
    rawKey({ id: 'key_deploy', name: 'deploy', type: 'deploy', agentIds: ['fixer'], createdAt: '2026-02-01T00:00:00.000Z' }),
    rawKey({ id: 'key_work', name: 'work', agentIds: ['fixer', 'assistant'], createdAt: '2026-03-01T00:00:00.000Z' }),
  ];

  it('без параметров возвращает все ключи с метаданными', async () => {
    const result = await sshKeysListTool.execute({}, makeCtx({ sshKeyStore: new FakeSshKeyStore(keys) }));

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.count).toBe(2);
    // `id → name` — ровно та форма, по которой модель выберет `sshKeyId`.
    expect(result.content).toContain('key_deploy → deploy');
    expect(result.content).toContain('key_work → work');
    expect(result.content).toContain('type=deploy');
    expect(result.content).toContain('agents=fixer,assistant');
    expect(result.content).toContain('SSH keys (2):');
    expect(result.metadata?.keys).toEqual([
      { id: 'key_deploy', name: 'deploy', type: 'deploy', agentIds: ['fixer'], createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'key_work', name: 'work', type: 'user', agentIds: ['fixer', 'assistant'], createdAt: '2026-03-01T00:00:00.000Z' },
    ]);
  });

  it('agent_id фильтрует ключи через listForAgent', async () => {
    const result = await sshKeysListTool.execute(
      { agent_id: 'assistant' },
      makeCtx({ sshKeyStore: new FakeSshKeyStore(keys) }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.count).toBe(1);
    expect(result.content).toContain('key_work → work');
    expect(result.content).not.toContain('key_deploy');
    expect(result.metadata?.agent_id).toBe('assistant');
  });

  it('пустой список → явное «ключей нет, добавьте в настройках»', async () => {
    const result = await sshKeysListTool.execute({}, makeCtx({ sshKeyStore: new FakeSshKeyStore([]) }));

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.count).toBe(0);
    expect(result.content).toMatch(/No SSH keys are configured/);
    expect(result.content).toMatch(/Settings → SSH keys/);
  });

  it('в выводе нет секретов: ни privateKey, ни passphrase', async () => {
    const result = await sshKeysListTool.execute({}, makeCtx({ sshKeyStore: new FakeSshKeyStore(keys) }));

    // Проверяем и текст, и метаданные: ни значения секрета, ни имён полей.
    for (const line of result.content.split('\n')) {
      expect(line.toLowerCase()).not.toContain('privatekey');
      expect(line.toLowerCase()).not.toContain('passphrase');
      expect(line.toLowerCase()).not.toContain('private');
      expect(line).not.toContain(PRIVATE_KEY_BODY);
      expect(line).not.toContain(PASSPHRASE);
    }
    const serialized = JSON.stringify(result.metadata);
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('passphrase');
    expect(serialized).not.toContain(PRIVATE_KEY_BODY);
    expect(serialized).not.toContain(PASSPHRASE);
  });

  it('стор не сконфигурирован → понятная ошибка, не падение', async () => {
    const result = await sshKeysListTool.execute({}, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'sshkeys.tool.deps_unavailable' });
    expect(result.content).toMatch(/SSH key store is unavailable/);
  });

  it('ошибка стора при чтении → tool.exec_error (не падение)', async () => {
    const broken: SSHKeyRepository = {
      list: async () => {
        throw new Error('store is down');
      },
      listForAgent: async () => [],
      listRaw: async () => [],
      rotateMasterKey: async () => {
        throw new Error('not used');
      },
      get: async () => null,
      create: async () => {
        throw new Error('not used');
      },
      update: async () => null,
      delete: async () => false,
      linkAgent: async () => null,
      unlinkAgent: async () => null,
      reveal: async () => null,
    };
    const result = await sshKeysListTool.execute({}, makeCtx({ sshKeyStore: broken }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('store is down');
  });

  it('ошибка аргументов → tool.args_error', async () => {
    const result = await sshKeysListTool.execute(
      { agent_id: '' },
      makeCtx({ sshKeyStore: new FakeSshKeyStore(keys) }),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({
      key: 'tool.args_error',
      params: { tool: SSH_KEYS_LIST_TOOL },
    });
    const params = (result.metadata?.i18n as { params?: Record<string, unknown> }).params;
    expect(String(params?.issues)).toContain('agent_id');
  });
});

describe('подсказка «требуется SSH-ключ» (ADR-076)', () => {
  const keys: SSHKey[] = [
    rawKey({ id: 'key_deploy', name: 'deploy' }),
    rawKey({ id: 'key_work', name: 'work' }),
  ];

  it('formatSshKeysForHint: `id → name`, пусто — «нет ни одного»', () => {
    expect(formatSshKeysForHint(keys.map(meta))).toBe('key_deploy → deploy, key_work → work');
    expect(formatSshKeysForHint([])).toBe('none configured');
  });

  it('formatSshKeysForHint: больше 10 ключей — список усечён', () => {
    const many = Array.from({ length: 12 }, (_v, i) => rawKey({ id: `key_${i}`, name: `k${i}` }));
    const text = formatSshKeysForHint(many.map(meta));
    expect(text).toContain('key_9 → k9');
    expect(text).not.toContain('key_10 → k10');
    expect(text).toContain('… +2');
  });

  it('buildSshKeyRequiredResult: список ключей и отсылка к ssh_keys_list', async () => {
    const result = await buildSshKeyRequiredResult(new FakeSshKeyStore(keys), 'app');

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain('key_deploy → deploy');
    expect(result?.content).toContain('ssh_keys_list');
    expect(result?.metadata?.i18n).toEqual({
      key: 'git.ssh_key_required_hint',
      params: { path: 'app', keys: 'key_deploy → deploy, key_work → work' },
    });
    // Секретов в подсказке нет.
    expect(JSON.stringify(result?.metadata)).not.toContain('passphrase');
  });

  it('buildSshKeyRequiredResult: пустой стор — текст про добавление ключа', async () => {
    const result = await buildSshKeyRequiredResult(new FakeSshKeyStore([]), 'app');

    expect(result?.content).toMatch(/Settings → SSH keys/);
    expect(result?.content).toContain('none configured');
  });

  it('buildSshKeyRequiredResult: стора нет → null (прежний текст без списка)', async () => {
    expect(await buildSshKeyRequiredResult(undefined, 'app')).toBeNull();
  });

  it('buildSshKeyRequiredResult: стор отказывает → null (прежний текст без списка)', async () => {
    const broken: SSHKeyRepository = {
      list: async () => {
        throw new Error('store is down');
      },
      listForAgent: async () => [],
      listRaw: async () => [],
      rotateMasterKey: async () => {
        throw new Error('not used');
      },
      get: async () => null,
      create: async () => {
        throw new Error('not used');
      },
      update: async () => null,
      delete: async () => false,
      linkAgent: async () => null,
      unlinkAgent: async () => null,
      reveal: async () => null,
    };

    expect(await buildSshKeyRequiredResult(broken, 'app')).toBeNull();
  });
});

describe('ssh_keys_list: регистрация и политика', () => {
  it('зарегистрирован в ALL_BUILTIN_TOOLS с capability git_read', () => {
    const tool = ALL_BUILTIN_TOOLS.find((t) => t.name === SSH_KEYS_LIST_TOOL);
    expect(tool, 'ssh_keys_list не зарегистрирован в ALL_BUILTIN_TOOLS').toBeDefined();
    expect(tool?.capabilities).toEqual(['git_read']);
  });

  it('группа git_read (значит, и группа git)', () => {
    const groups = getToolGroups(SSH_KEYS_LIST_TOOL, ['git_read']);
    expect(groups).toContain('git_read');
    expect(groups).toContain('git');
  });

  it('в plan-режиме разрешён (это чтение)', () => {
    expect(isPlanBlockedTool(SSH_KEYS_LIST_TOOL, ['git_read'])).toBe(false);
  });

  it('не зависит от рабочего каталога проекта', () => {
    expect(isWorkspaceDependentTool(['git_read'], SSH_KEYS_LIST_TOOL)).toBe(false);
    expect(
      computeToolAvailability(SSH_KEYS_LIST_TOOL, ['git_read'], { workspaceReady: false }),
    ).toEqual({ available: true });
    // Прочие git_read-тулы зависимость сохраняют — исключение точечное.
    expect(isWorkspaceDependentTool(['git_read'], 'git_status')).toBe(true);
  });

  it('trusted, источник project', () => {
    const trust = getToolTrust(SSH_KEYS_LIST_TOOL, {}, '/tmp/synth-ws', ['git_read']);
    expect(trust).toEqual({ trust: 'trusted', source: 'project', attrs: {} });
  });

  it('authority: действие read', () => {
    expect(authorityActionForTool(SSH_KEYS_LIST_TOOL, ['git_read'])).toBe('read');
  });
});
