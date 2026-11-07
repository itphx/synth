/**
 * PROP-124 §4c: тул `ssh_tunnel` — проброс порта через удалённый хост.
 *
 * Проверяем обе стороны границы:
 * - **до запуска**: гейт решает всё (политика хостов/портов/привязки) — при
 *   отказе туннель **не** запускается, а ключ не раскрывается;
 * - **на запуске**: команда уходит argv-формой (без локальной оболочки, без
 *   `-i`), ключ доставляется секретом вызова в режиме `agent`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SSHKeyMeta, SSHKeyUsage, ToolContext } from '@itphx/synth-shared';
import { normalizeSshKeyAllowHosts, normalizeSshKeyAllowPorts, normalizeSshKeyUsages } from '@itphx/synth-shared';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import type { ProcessService } from '../processes/service.js';
import type { ProcessSpawnInput } from '../processes/types.js';
import { computeToolAvailability } from '../permission/availability.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { renderUnavailableTools } from '../context/state-messages.js';
import { zodToJsonSchema } from './json-schema.js';
import { buildSshTunnelCommand, isSocksRequest, sshTunnelTool } from './ssh-tunnel.js';

const PRIVATE_KEY = 'private-key-material';

/** Запись ключа в фейковом сторе. */
interface FakeKey {
  id: string;
  name: string;
  agentIds: string[];
  usages?: SSHKeyUsage[];
  allowHosts?: string[];
  allowPorts?: number[];
}

/** Метаданные ключа — как у настоящего стора. */
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

/** Фейковый стор SSH-ключей со «шпионом» на раскрытие. */
class FakeSshKeyStore implements SSHKeyRepository {
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
    return { privateKey: PRIVATE_KEY };
  }

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

/** Ключ, пригодный для ssh-доступа текущего агента. */
function usableKey(overrides: Partial<FakeKey> = {}): FakeKey {
  return {
    id: 'key-1',
    name: 'deploy',
    agentIds: ['fixer'],
    usages: ['ssh'],
    allowHosts: ['example.com'],
    allowPorts: [22, 2222, 5432],
    ...overrides,
  };
}

function makeCtx(opts: {
  store?: SSHKeyRepository;
  /** `null` — сервиса фоновых процессов нет (тул обязан отказать). */
  processService?: ProcessService | null;
  backgroundEnabled?: boolean;
  agentRole?: string;
  sessionId?: string;
} = {}): { ctx: ToolContext; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(async (_input: ProcessSpawnInput) => ({
    runId: 'bgr_1',
    processId: 'proc_1',
    logPath: 'processes/bgr_1.log',
  }));
  const processService = opts.processService === null
    ? undefined
    : (opts.processService ?? ({ spawn } as unknown as ProcessService));
  const ctx: ToolContext = {
    sessionId: opts.sessionId ?? 's1',
    messageId: 'm1',
    workingDir: '/tmp',
    agentRole: opts.agentRole ?? 'fixer',
    extra: {
      ...(opts.store ? { sshKeyStore: opts.store } : {}),
      ...(processService ? { processService } : {}),
      ...(opts.backgroundEnabled !== undefined ? { backgroundEnabled: opts.backgroundEnabled } : {}),
    },
  };
  return { ctx, spawn };
}

/** Ключ i18n в метаданных результата (метаданные — свободный словарь). */
function i18nKey(result: { metadata?: Record<string, unknown> }): string | undefined {
  const i18n = result.metadata?.i18n as { key?: string } | undefined;
  return i18n?.key;
}

describe('ssh_tunnel — сборка команды', () => {
  it('local: -L со спецификацией 127.0.0.1:<listen>:<target>:<port>', () => {
    const command = buildSshTunnelCommand({
      host: 'example.com',
      user: 'deploy',
      direction: 'local',
      listenPort: 8080,
      targetHost: 'db.internal',
      targetPort: 5432,
    });

    expect(command.file).toBe('ssh');
    const args = command.args;
    // Слушающий сокет — только 127.0.0.1 (жёстко, без параметра).
    expect(args).toContain('-L');
    expect(args).toContain('127.0.0.1:8080:db.internal:5432');
    // Никаких других адресов слушателя быть не должно.
    expect(args.some((arg) => arg.startsWith('0.0.0.0'))).toBe(false);
  });

  it('remote: -R со спецификацией 127.0.0.1:<listen>:<target>:<port>', () => {
    const command = buildSshTunnelCommand({
      host: 'example.com',
      user: 'deploy',
      direction: 'remote',
      listenPort: 9090,
      targetHost: '127.0.0.1',
      targetPort: 3000,
    });

    expect(command.args).toContain('-R');
    expect(command.args).toContain('127.0.0.1:9090:127.0.0.1:3000');
    expect(command.args).not.toContain('-L');
  });

  it('общая часть: -F /dev/null, BatchMode, accept-new, ExitOnForwardFailure, -N', () => {
    const command = buildSshTunnelCommand({
      host: 'example.com',
      user: 'deploy',
      direction: 'local',
      listenPort: 8080,
      targetHost: 'db.internal',
      targetPort: 5432,
    });
    const args = command.args;

    // Пользовательский `~/.ssh/config` не читается.
    expect(args.slice(0, 2)).toEqual(['-F', '/dev/null']);
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    // Проброс, которому не удалось занять порт, должен упасть, а не висеть.
    expect(args).toContain('ExitOnForwardFailure=yes');
    // Удалённая команда не выполняется — только проброс порта.
    expect(args).toContain('-N');
    // Путь к ключу в argv не попадает.
    expect(args).not.toContain('-i');
    expect(args.some((arg) => arg.includes(PRIVATE_KEY))).toBe(false);
  });

  it('адрес — после всех опций (ssh перестаёт разбирать опции после адреса)', () => {
    const command = buildSshTunnelCommand({
      host: 'example.com',
      user: 'deploy',
      port: 2222,
      direction: 'local',
      listenPort: 8080,
      targetHost: 'db.internal',
      targetPort: 5432,
    });
    const args = command.args;
    const addressIndex = args.indexOf('deploy@example.com');

    expect(addressIndex).toBeGreaterThan(-1);
    expect(args.indexOf('-p')).toBeLessThan(addressIndex);
    expect(args.indexOf('-L')).toBeLessThan(addressIndex);
    expect(args.indexOf('-N')).toBeLessThan(addressIndex);
    // Последний аргумент — адрес подключения.
    expect(args[args.length - 1]).toBe('deploy@example.com');
  });

  it('порт не задан — `-p` не добавляется', () => {
    const command = buildSshTunnelCommand({
      host: 'example.com',
      user: 'deploy',
      direction: 'local',
      listenPort: 8080,
      targetHost: 'db.internal',
      targetPort: 5432,
    });
    expect(command.args).not.toContain('-p');
  });
});

describe('ssh_tunnel — отказ от SOCKS (-D)', () => {
  it('запрос SOCKS распознаётся в разных формах', () => {
    expect(isSocksRequest({ direction: 'socks' })).toBe(true);
    expect(isSocksRequest({ direction: 'SOCKS5' })).toBe(true);
    expect(isSocksRequest({ type: 'dynamic' })).toBe(true);
    expect(isSocksRequest({ socks: true })).toBe(true);
    // Обычные значения — не SOCKS.
    expect(isSocksRequest({ direction: 'local' })).toBe(false);
    expect(isSocksRequest({ direction: 'remote' })).toBe(false);
    expect(isSocksRequest({ host: 'socks.example.com' })).toBe(false);
    expect(isSocksRequest(undefined)).toBe(false);
  });

  it('вызов с SOCKS отклоняется с внятным текстом, процесс не запускается', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      { host: 'example.com', user: 'deploy', direction: 'socks', listen_port: 1080, target_port: 5432 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('ssh.tunnel.socks_unsupported');
    expect(spawn).not.toHaveBeenCalled();
    expect(store.revealCalls).toHaveLength(0);
  });
});

describe('ssh_tunnel — запуск (фоновый процесс)', () => {
  it('туннель всегда уходит в фон и возвращает process_id и журнал', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
    const input = spawn.mock.calls[0]![0];
    expect(input.argv?.file).toBe('ssh');
    const args = input.argv?.args ?? [];
    expect(args).toContain('-L');
    expect(args).toContain('127.0.0.1:8080:db.internal:5432');
    expect(args).toContain('-N');
    // Бинарное требование — клиент SSH.
    expect(input.requires).toEqual(['ssh']);
    // Таймаут не задан — туннель живёт до `process_stop`.
    expect(input.timeoutMs).toBeUndefined();

    // Идентификатор процесса и путь журнала — в метаданных.
    expect(result.metadata?.process_id).toBe('proc_1');
    expect(result.metadata?.background_run_id).toBe('bgr_1');
    expect(result.metadata?.log_path).toBe('processes/bgr_1.log');
    expect(result.metadata?.status).toBe('running');
    expect(result.metadata?.direction).toBe('local');
    expect(result.metadata?.listen_port).toBe(8080);
    expect(result.metadata?.target_host).toBe('db.internal');
    expect(result.metadata?.target_port).toBe(5432);
  });

  it('remote: целевой хост по умолчанию — 127.0.0.1', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      { host: 'example.com', user: 'deploy', direction: 'remote', listen_port: 9090, target_port: 5432 },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const input = spawn.mock.calls[0]![0];
    expect(input.argv?.args).toContain('127.0.0.1:9090:127.0.0.1:5432');
    expect(input.argv?.args).toContain('-R');
    expect(result.metadata?.target_host).toBe('127.0.0.1');
  });

  it('секрет вызова уходит в режиме agent (эфемерный ssh-agent)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    const input = spawn.mock.calls[0]![0];
    expect(input.secrets).toHaveLength(1);
    const secret = input.secrets![0]!;
    expect(secret.kind).toBe('ssh-key');
    expect(secret.mode).toBe('agent');
    expect(secret.privateKey).toBe(PRIVATE_KEY);
    // Материал ключа не попадает ни в argv, ни в окружение.
    expect(JSON.stringify(input.argv ?? {})).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(input.env ?? {})).not.toContain(PRIVATE_KEY);
  });

  it('явный timeout_ms ограничивает жизнь туннеля', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
        timeout_ms: 60_000,
      },
      ctx,
    );

    expect(spawn.mock.calls[0]![0].timeoutMs).toBe(60_000);
  });
});

describe('ssh_tunnel — гейт доступа (политика)', () => {
  it('целевой порт вне политики ключа → port_denied, туннель не запускается', async () => {
    const store = new FakeSshKeyStore([usableKey({ allowPorts: [22] })]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('port_denied');
    expect(spawn).not.toHaveBeenCalled();
    expect(store.revealCalls).toHaveLength(0);
  });

  it('пустой allowPorts — разрешён только порт 22', async () => {
    const store = new FakeSshKeyStore([usableKey({ allowPorts: [] })]);
    const { ctx, spawn } = makeCtx({ store });

    const denied = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );
    expect(denied.metadata?.keyCode).toBe('port_denied');
    expect(spawn).not.toHaveBeenCalled();

    // Порт 22 — единственный разрешённый при пустом списке.
    const allowed = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 22,
      },
      ctx,
    );
    expect(allowed.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('хост вне политики ключа → host_denied, туннель не запускается', async () => {
    const store = new FakeSshKeyStore([usableKey({ allowHosts: ['other.example.com'] })]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('host_denied');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('ключ не привязан к роли агента → agent_not_linked', async () => {
    const store = new FakeSshKeyStore([usableKey({ agentIds: ['researcher'] })]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        key_id: 'key-1',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('agent_not_linked');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('в тексте отказа нет перечня ключей инстанса', async () => {
    const store = new FakeSshKeyStore([
      usableKey({ id: 'key-1', name: 'deploy' }),
      usableKey({ id: 'key-2', name: 'backup' }),
    ]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('ambiguous');
    expect(result.content).not.toContain('deploy');
    expect(result.content).not.toContain('backup');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('ssh_tunnel — валидация аргументов', () => {
  it('в JSON-схеме тула `user` — обязательное поле', () => {
    // Модель видит схему тула: `user` должен быть в `required`, иначе она
    // снова позовёт тул без пользователя.
    const schema = zodToJsonSchema(sshTunnelTool.parameters) as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.required).toContain('user');
    expect(schema.properties?.user?.description).toContain('required');
  });

  it('без `user` → отказ валидации, туннель не запускается', async () => {
    // Конфиг ssh не читается (`-F /dev/null`): без явного пользователя ssh
    // подставил бы локального пользователя исполнителя (`node`) — вызов
    // выглядел бы как сломанный инструмент.
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      { host: 'example.com', direction: 'local', listen_port: 8080, target_port: 5432 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('user');
    expect(spawn).not.toHaveBeenCalled();
    // Секрет не раскрывался.
    expect(store.revealCalls).toHaveLength(0);
  });

  it('пустой `user` и `user` с пробелом → отказ валидации', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const empty = await sshTunnelTool.execute(
      { host: 'example.com', user: '', direction: 'local', listen_port: 8080, target_port: 5432 },
      ctx,
    );
    const withSpace = await sshTunnelTool.execute(
      { host: 'example.com', user: 'de ploy', direction: 'local', listen_port: 8080, target_port: 5432 },
      ctx,
    );

    expect(empty.isError).toBe(true);
    expect(withSpace.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('local без target_host → отказ (целевой хост обязателен)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      { host: 'example.com', user: 'deploy', direction: 'local', listen_port: 8080, target_port: 5432 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('невалидный target_host → отказ', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db internal; rm -rf /',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('порт вне диапазона отклоняется', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 70000,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('неизвестный параметр отклоняется (strict-схема)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
        bind_address: '0.0.0.0',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('ssh_tunnel — недоступность фоновых процессов', () => {
  it('нет processService → понятная ошибка', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx } = makeCtx({ store, processService: null });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('process.deps_unavailable');
  });

  it('фоновые процессы выключены инстансом → process.background_disabled', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, spawn } = makeCtx({ store, backgroundEnabled: false });

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('process.background_disabled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('нет стора ключей → sshkeys.tool.deps_unavailable', async () => {
    const { ctx, spawn } = makeCtx({});

    const result = await sshTunnelTool.execute(
      {
        host: 'example.com',
        user: 'deploy',
        direction: 'local',
        listen_port: 8080,
        target_host: 'db.internal',
        target_port: 5432,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('sshkeys.tool.deps_unavailable');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('ssh_tunnel — доступность (permission-слой)', () => {
  it('plan-режим: тул заблокирован permission-слоем (отказ целиком)', () => {
    expect(isPlanBlockedTool('ssh_tunnel', ['ssh'])).toBe(true);
    expect(
      computeToolAvailability('ssh_tunnel', ['ssh'], {
        sessionMode: 'plan',
        planMode: 'auto',
        planApproved: false,
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('режим инстанса `agent` → unavailable(policy)', () => {
    expect(
      computeToolAvailability('ssh_tunnel', ['ssh'], { getSshMode: () => 'agent' }),
    ).toEqual({ available: false, reason: 'policy' });
  });

  it('режим инстанса `tools` → тул доступен', () => {
    expect(
      computeToolAvailability('ssh_tunnel', ['ssh'], { getSshMode: () => 'tools' }),
    ).toEqual({ available: true });
  });

  it('подсказка модели для причины policy', () => {
    const text = renderUnavailableTools([{ name: 'ssh_tunnel', reason: 'policy' }], 'ru');
    expect(text).toContain('ssh_tunnel');
    expect(text).toContain('tools');
    const en = renderUnavailableTools([{ name: 'ssh_tunnel', reason: 'policy' }], 'en');
    expect(en).toContain('ssh_tunnel');
    expect(en).toContain('tools');
  });
});
