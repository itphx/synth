/**
 * PROP-124 §4a: тул `ssh_exec` — адресный SSH-доступ.
 *
 * Проверяем обе стороны границы:
 * - **до запуска**: гейт решает всё (политика хостов/портов/привязки) — при
 *   отказе команда **не** запускается, а ключ не раскрывается;
 * - **на запуске**: команда уходит argv-формой (без локальной оболочки, без
 *   `-i`), а ключ доставляется секретом вызова в режиме `agent`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SSHKeyMeta, SSHKeyUsage, ToolContext } from '@itphx/synth-shared';
import { normalizeSshKeyAllowHosts, normalizeSshKeyAllowPorts, normalizeSshKeyUsages } from '@itphx/synth-shared';
import type { ExecRequest, ExecResult, ExecutionPort } from '../../execution/ports/index.js';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import type { ProcessService } from '../processes/service.js';
import type { ProcessSpawnInput } from '../processes/types.js';
import { computeToolAvailability } from '../permission/availability.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { renderUnavailableTools } from '../context/state-messages.js';
import { zodToJsonSchema } from './json-schema.js';
import { buildSshCommand, sshExecTool } from './ssh-exec.js';

const PRIVATE_KEY = 'private-key-material';

/** Запись ключа в фейковом сторе. */
interface FakeKey {
  id: string;
  name: string;
  agentIds: string[];
  usages?: SSHKeyUsage[];
  allowHosts?: string[];
  allowPorts?: number[];
  passphrase?: string;
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
    return found.passphrase === undefined
      ? { privateKey: PRIVATE_KEY }
      : { privateKey: PRIVATE_KEY, passphrase: found.passphrase };
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

/** Порт исполнения — шпион на запросы (реальный `ssh` не запускается). */
class FakeExecutionPort implements ExecutionPort {
  readonly requests: ExecRequest[] = [];

  async execute(req: ExecRequest): Promise<ExecResult> {
    this.requests.push(req);
    return { stdout: 'ok\n', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
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
    allowPorts: [22, 2222],
    ...overrides,
  };
}

function makeCtx(opts: {
  store?: SSHKeyRepository;
  port?: ExecutionPort;
  processService?: ProcessService;
  backgroundEnabled?: boolean;
  agentRole?: string;
} = {}): { ctx: ToolContext; port: FakeExecutionPort } {
  const port = (opts.port as FakeExecutionPort) ?? new FakeExecutionPort();
  const ctx: ToolContext = {
    sessionId: 's1',
    messageId: 'm1',
    workingDir: '/tmp',
    agentRole: opts.agentRole ?? 'fixer',
    extra: {
      ...(opts.store ? { sshKeyStore: opts.store } : {}),
      executionPort: port,
      ...(opts.processService ? { processService: opts.processService } : {}),
      backgroundEnabled: opts.backgroundEnabled ?? true,
    },
  };
  return { ctx, port };
}

describe('ssh_exec — сборка команды', () => {
  it('argv-форма: порт, пользователь, `--`; `-i` в команде нет', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', port: 2222, argv: ['ls', '-la', '/srv'] },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(port.requests).toHaveLength(1);
    const request = port.requests[0]!;
    // Команда — argv, локальной оболочки нет.
    expect(request.command.kind).toBe('argv');
    if (request.command.kind !== 'argv') throw new Error('ожидалась argv-команда');
    expect(request.command.file).toBe('ssh');
    const args = request.command.args ?? [];
    // `-i` (путь к ключу) в команде не участвует — ключ доставляется агентом.
    expect(args).not.toContain('-i');
    expect(args.some((arg) => arg.includes(PRIVATE_KEY))).toBe(false);
    expect(args.some((arg) => arg.includes('/tmp/synth-ssh-'))).toBe(false);
    // Порт и адрес — отдельными полями.
    expect(args).toContain('-p');
    expect(args).toContain('2222');
    expect(args).toContain('deploy@example.com');
    // Пользовательский `~/.ssh/config` не читается — иначе конфиг мог бы
    // подсунуть `ProxyCommand`/`LocalCommand`.
    expect(args.slice(0, 2)).toEqual(['-F', '/dev/null']);
    // Разделитель: после адреса и перед командой.
    expect(args).toContain('--');
    expect(args.indexOf('deploy@example.com')).toBeLessThan(args.indexOf('--'));
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['ls', '-la', '/srv']);
    // Неинтерактивность и политика known_hosts.
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
  });

  it('порт не задан — `-p` не добавляется', () => {
    const command = buildSshCommand({ host: 'example.com', user: 'deploy', argv: ['uptime'] });
    expect(command.args).not.toContain('-p');
    expect(command.args).toEqual([
      '-F',
      '/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      'deploy@example.com',
      '--',
      'uptime',
    ]);
  });

  it('адрес всегда с пользователем (`user@host`) — «умолчательного» пользователя нет', () => {
    // Конфиг ssh не читается (`-F /dev/null`), поэтому адрес без `@` означал бы
    // локального пользователя исполнителя (`node`) — `Permission denied`.
    const command = buildSshCommand({ host: 'example.com', user: 'deploy', argv: ['uptime'] });
    expect(command.args).toContain('deploy@example.com');
    expect(command.args.some((arg) => arg === 'example.com')).toBe(false);
  });
});

describe('ssh_exec — пользователь обязателен', () => {
  it('в JSON-схеме тула `user` — обязательное поле', () => {
    // Модель видит схему тула: `user` должен быть в `required`, иначе она
    // снова позовёт тул без пользователя.
    const schema = zodToJsonSchema(sshExecTool.parameters) as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.required).toContain('user');
    // Описание объясняет модели, почему поле обязательно.
    expect(schema.properties?.user?.description).toContain('required');
  });

  it('без `user` → отказ валидации, команда не запускается', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute(
      { host: 'example.com', argv: ['uptime'] },
      ctx,
    );

    expect(result.isError).toBe(true);
    // Текст отказа называет проблемное поле — модель должна повторить вызов
    // с пользователем.
    expect(result.content).toContain('user');
    // Точка исполнения не вызвана — команда не запускалась.
    expect(port.requests).toHaveLength(0);
    // Секрет не раскрывался.
    expect(store.revealCalls).toHaveLength(0);
  });

  it('пустой `user` → отказ валидации', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: '', argv: ['uptime'] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('`user` с пробелом или ведущим дефисом → отказ валидации', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const withSpace = await sshExecTool.execute(
      { host: 'example.com', user: 'de ploy', argv: ['uptime'] },
      ctx,
    );
    const withDash = await sshExecTool.execute(
      { host: 'example.com', user: '-oProxyCommand=id', argv: ['uptime'] },
      ctx,
    );

    expect(withSpace.isError).toBe(true);
    expect(withDash.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('границы `user`: 64 символа — можно, 65 — нет; `@` в имени нельзя', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const tooLong = await sshExecTool.execute(
      { host: 'example.com', user: 'a'.repeat(65), argv: ['uptime'] },
      ctx,
    );
    // `root@evil.com` в поле `user` — попытка подменить адрес: имя не может
    // содержать `@`, адрес собирается только как `user@host`.
    const withAt = await sshExecTool.execute(
      { host: 'example.com', user: 'root@evil.com', argv: ['uptime'] },
      ctx,
    );

    expect(tooLong.isError).toBe(true);
    expect(withAt.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });
});

describe('ssh_exec — гейт доступа (политика)', () => {
  it('отказ гейта: команда не запускается, ключ не раскрывается', async () => {
    // Ключ только для git — для ssh-доступа не пригоден. Явный `key_id`: без
    // него гейт отбирает кандидатов по usage и честно отвечает `key_not_found`.
    const store = new FakeSshKeyStore([usableKey({ usages: ['git'] })]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', key_id: 'key-1', argv: ['uptime'] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('usage_denied');
    // Точка исполнения не вызвана — команда не запускалась.
    expect(port.requests).toHaveLength(0);
    // Секрет не раскрывался.
    expect(store.revealCalls).toHaveLength(0);
  });

  it('несуществующий key_id → key_not_found', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', key_id: 'missing', argv: ['uptime'] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('key_not_found');
    expect(port.requests).toHaveLength(0);
  });

  it('хост вне политики ключа → host_denied, команда не запускается', async () => {
    const store = new FakeSshKeyStore([usableKey({ allowHosts: ['other.example.com'] })]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute({ host: 'example.com', user: 'deploy', argv: ['uptime'] }, ctx);

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('host_denied');
    expect(port.requests).toHaveLength(0);
  });

  it('порт вне политики ключа → port_denied', async () => {
    const store = new FakeSshKeyStore([usableKey({ allowPorts: [22] })]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', port: 2222, argv: ['uptime'] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('port_denied');
    expect(port.requests).toHaveLength(0);
  });

  it('ключ не привязан к роли агента → agent_not_linked', async () => {
    const store = new FakeSshKeyStore([usableKey({ agentIds: ['researcher'] })]);
    const { ctx, port } = makeCtx({ store });

    // Явный `key_id`: без него гейт отбирает кандидатов по привязке к роли и
    // отвечает `key_not_found`.
    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', key_id: 'key-1', argv: ['uptime'] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('agent_not_linked');
    expect(port.requests).toHaveLength(0);
  });

  it('в тексте отказа нет перечня ключей инстанса', async () => {
    // Два подходящих ключа роли — гейт отвечает `ambiguous`; имён ключей в
    // тексте быть не должно (перечень даёт инструмент `ssh_keys_list`).
    const store = new FakeSshKeyStore([
      usableKey({ id: 'key-1', name: 'deploy' }),
      usableKey({ id: 'key-2', name: 'backup' }),
    ]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute({ host: 'example.com', user: 'deploy', argv: ['uptime'] }, ctx);

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('ambiguous');
    expect(result.content).not.toContain('deploy');
    expect(result.content).not.toContain('backup');
    expect(port.requests).toHaveLength(0);
  });
});

describe('ssh_exec — доставка ключа', () => {
  it('секрет вызова уходит в режиме agent (эфемерный ssh-agent)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    await sshExecTool.execute({ host: 'example.com', user: 'deploy', argv: ['uptime'] }, ctx);

    const request = port.requests[0]!;
    expect(request.secrets).toHaveLength(1);
    const secret = request.secrets![0]!;
    expect(secret.kind).toBe('ssh-key');
    expect(secret.mode).toBe('agent');
    expect(secret.privateKey).toBe(PRIVATE_KEY);
    // Материал ключа не попадает в окружение вызова (доставляет его точка
    // исполнения через сокет агента).
    expect(JSON.stringify(request.env ?? {})).not.toContain(PRIVATE_KEY);
  });
});

describe('ssh_exec — валидация аргументов', () => {
  it('пустой argv → отказ (аргументная ошибка)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute({ host: 'example.com', user: 'deploy', argv: [] }, ctx);

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('host с ведущим дефисом отклоняется', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute({ host: '-oProxyCommand=id', user: 'deploy', argv: ['uptime'] }, ctx);

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('host с пробелом отклоняется', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute({ host: 'example.com -oX', user: 'deploy', argv: ['uptime'] }, ctx);

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('аргумент с NUL отклоняется', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', argv: ['ls\0la'] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('порт вне диапазона отклоняется', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx } = makeCtx({ store });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', port: 70000, argv: ['uptime'] },
      ctx,
    );

    expect(result.isError).toBe(true);
  });
});

describe('ssh_exec — фоновый запуск', () => {
  it('фон получает те же секреты и argv-команду', async () => {
    const spawn = vi.fn(async (_input: ProcessSpawnInput) => ({
      runId: 'bgr_1',
      processId: 'proc_1',
      logPath: 'processes/bgr_1.log',
    }));
    const processService = { spawn } as unknown as ProcessService;
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store, processService });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', port: 2222, argv: ['sleep', '60'], background: true },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    // Синхронный запуск не выполнялся — команда ушла в фон.
    expect(port.requests).toHaveLength(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const input = spawn.mock.calls[0]![0];
    expect(input.argv?.file).toBe('ssh');
    expect(input.argv?.args).toContain('--');
    expect(input.secrets).toHaveLength(1);
    expect(input.secrets![0]!.mode).toBe('agent');
  });

  it('фон выключен инстансом → отказ', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx } = makeCtx({ store, backgroundEnabled: false });

    const result = await sshExecTool.execute(
      { host: 'example.com', user: 'deploy', argv: ['uptime'], background: true },
      ctx,
    );

    expect(result.isError).toBe(true);
  });
});

describe('ssh_exec — доступность (permission-слой)', () => {
  it('plan-режим: тул заблокирован permission-слоем (отказ целиком)', () => {
    expect(isPlanBlockedTool('ssh_exec', ['ssh'])).toBe(true);
    expect(
      computeToolAvailability('ssh_exec', ['ssh'], {
        sessionMode: 'plan',
        planMode: 'auto',
        planApproved: false,
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('режим инстанса `agent` → unavailable(policy)', () => {
    expect(
      computeToolAvailability('ssh_exec', ['ssh'], { getSshMode: () => 'agent' }),
    ).toEqual({ available: false, reason: 'policy' });
  });

  it('режим инстанса `tools` → тул доступен', () => {
    expect(
      computeToolAvailability('ssh_exec', ['ssh'], { getSshMode: () => 'tools' }),
    ).toEqual({ available: true });
  });

  it('подсказка модели для причины policy', () => {
    const text = renderUnavailableTools([{ name: 'ssh_exec', reason: 'policy' }], 'ru');
    expect(text).toContain('ssh_exec');
    expect(text).toContain('tools');
    const en = renderUnavailableTools([{ name: 'ssh_exec', reason: 'policy' }], 'en');
    expect(en).toContain('ssh_exec');
    expect(en).toContain('tools');
  });
});
