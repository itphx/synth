/**
 * PROP-124 §4b: тул `ssh_copy` — передача файлов на удалённый хост.
 *
 * Проверяем обе стороны границы:
 * - **до запуска**: гейт решает всё (политика хостов/портов/привязки) — при
 *   отказе команда **не** запускается, а ключ не раскрывается; локальный путь
 *   не выходит за периметр сессии;
 * - **на запуске**: команда уходит argv-формой, batch собран только из
 *   проверенных значений, а ключ доставляется секретом вызова в режиме
 *   `agent`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SSHKeyMeta, SSHKeyUsage, ToolContext } from '@itphx/synth-shared';
import { normalizeSshKeyAllowHosts, normalizeSshKeyAllowPorts, normalizeSshKeyUsages } from '@itphx/synth-shared';
import type { ExecRequest, ExecResult, ExecutionPort } from '../../execution/ports/index.js';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { computeToolAvailability } from '../permission/availability.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { buildSftpBatch, buildSftpCommand, sshCopyTool } from './ssh-copy.js';

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

/** Порт исполнения — шпион на запросы (реальный `sftp` не запускается). */
class FakeExecutionPort implements ExecutionPort {
  readonly requests: ExecRequest[] = [];

  async execute(req: ExecRequest): Promise<ExecResult> {
    this.requests.push(req);
    return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
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
  agentRole?: string;
  workingDir?: string;
} = {}): { ctx: ToolContext; port: FakeExecutionPort } {
  const port = (opts.port as FakeExecutionPort) ?? new FakeExecutionPort();
  const ctx: ToolContext = {
    sessionId: 's1',
    messageId: 'm1',
    workingDir: opts.workingDir ?? '/tmp',
    agentRole: opts.agentRole ?? 'fixer',
    extra: {
      ...(opts.store ? { sshKeyStore: opts.store } : {}),
      executionPort: port,
    },
  };
  return { ctx, port };
}

/** Первый запрос порта (инструмент обязан вызвать порт ровно один раз). */
function onlyRequest(port: FakeExecutionPort): ExecRequest {
  expect(port.requests).toHaveLength(1);
  return port.requests[0]!;
}

/** Аргументы argv-команды запроса (тул всегда отправляет argv-форму). */
function argvArgs(request: ExecRequest): string[] {
  if (request.command.kind !== 'argv') throw new Error('ожидалась argv-команда');
  return request.command.args ?? [];
}

/** Ключ i18n в метаданных результата (метаданные — свободный словарь). */
function i18nKey(result: { metadata?: Record<string, unknown> }): string | undefined {
  const i18n = result.metadata?.i18n as { key?: string } | undefined;
  return i18n?.key;
}

describe('ssh_copy — сборка batch', () => {
  it('upload: put <local> <remote>', () => {
    expect(buildSftpBatch({ direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt' })).toBe(
      'put a.txt /tmp/a.txt\n',
    );
  });

  it('download: get <remote> <local> — порядок аргументов sftp', () => {
    expect(buildSftpBatch({ direction: 'download', local: 'a.txt', remote: '/tmp/a.txt' })).toBe(
      'get /tmp/a.txt a.txt\n',
    );
  });

  it('recursive → флаг -R в команде batch', () => {
    expect(buildSftpBatch({ direction: 'upload', local: 'dir', remote: '/tmp/dir', recursive: true })).toBe(
      'put -R dir /tmp/dir\n',
    );
    expect(buildSftpBatch({ direction: 'download', local: 'dir', remote: '/tmp/dir', recursive: true })).toBe(
      'get -R /tmp/dir dir\n',
    );
  });

  it('recursive=false — флага -R нет', () => {
    expect(buildSftpBatch({ direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt', recursive: false })).toBe(
      'put a.txt /tmp/a.txt\n',
    );
  });

  it('путь с пробелом → в кавычках (правило sftp(1))', () => {
    expect(buildSftpBatch({ direction: 'upload', local: 'my file.txt', remote: '/tmp/x.txt' })).toBe(
      'put "my file.txt" /tmp/x.txt\n',
    );
  });

  it('batch — только проверенные значения: никакого свободного текста', () => {
    const batch = buildSftpBatch({ direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt' });
    // В batch попадают ровно две строки: команда и ничего постороннего.
    expect(batch.split('\n').filter(Boolean)).toHaveLength(1);
    expect(batch).not.toContain('\r');
  });
});

describe('ssh_copy — сборка команды', () => {
  it('batch идёт позиционным параметром скрипта, а не текстом команды', () => {
    const command = buildSftpCommand({
      host: 'example.com',
      user: 'deploy',
      port: 2222,
      batch: 'put a.txt /tmp/a.txt\n',
    });
    expect(command.file).toBe('bash');
    expect(command.args[0]).toBe('-c');
    // Скрипт — константа: пользовательских данных в нём нет.
    expect(command.args[1]).not.toContain('a.txt');
    expect(command.args[1]).toContain('sftp');
    expect(command.args[1]).toContain('-b -');
    // Batch, порт и адрес — отдельными аргументами.
    expect(command.args[3]).toBe('put a.txt /tmp/a.txt\n');
    expect(command.args[4]).toBe('2222');
    expect(command.args[5]).toBe('deploy@example.com');
  });

  it('порт по умолчанию — 22, пользователь не задан — адрес без @', () => {
    const command = buildSftpCommand({ host: 'example.com', batch: 'put a /b\n' });
    expect(command.args[4]).toBe('22');
    expect(command.args[5]).toBe('example.com');
  });
});

describe('ssh_copy — вызов порта', () => {
  it('argv-форма: клиент sftp, порт и адрес — отдельными полями', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', user: 'deploy', port: 2222, direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const request = onlyRequest(port);
    expect(request.command.kind).toBe('argv');
    const args = argvArgs(request);
    expect(args[3]).toBe('put a.txt /tmp/a.txt\n');
    expect(args[4]).toBe('2222');
    expect(args[5]).toBe('deploy@example.com');
    // Ключ в команде не участвует — он доставляется агентом.
    expect(JSON.stringify(args)).not.toContain(PRIVATE_KEY);
    expect(args).not.toContain('-i');
    // Бинарные требования: клиент sftp + оболочка обёртки.
    expect(request.requires).toContain('sftp');
    // Рабочий каталог — рабочий каталог сессии.
    expect(request.cwd).toBe(ctx.workingDir);
  });

  it('recursive меняет batch', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'dir', remote: '/tmp/dir', recursive: true },
      ctx,
    );

    expect(argvArgs(onlyRequest(port))[3]).toBe('put -R dir /tmp/dir\n');
  });

  it('скачивание: get <remote> <local>', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    await sshCopyTool.execute(
      { host: 'example.com', direction: 'download', local: 'a.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(argvArgs(onlyRequest(port))[3]).toBe('get /tmp/a.txt a.txt\n');
  });
});

describe('ssh_copy — доставка ключа', () => {
  it('секрет вызова уходит в режиме agent (эфемерный ssh-agent)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    const request = onlyRequest(port);
    expect(request.secrets).toHaveLength(1);
    const secret = request.secrets![0]!;
    expect(secret.kind).toBe('ssh-key');
    expect(secret.mode).toBe('agent');
    expect(secret.privateKey).toBe(PRIVATE_KEY);
    // Материал ключа не попадает в окружение вызова.
    expect(JSON.stringify(request.env ?? {})).not.toContain(PRIVATE_KEY);
  });
});

describe('ssh_copy — гейт доступа (политика)', () => {
  it('отказ гейта: команда не запускается, ключ не раскрывается', async () => {
    // Ключ только для git — для ssh-доступа не пригоден.
    const store = new FakeSshKeyStore([usableKey({ usages: ['git'] })]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', key_id: 'key-1', direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('usage_denied');
    // Точка исполнения не вызвана — команда не запускалась.
    expect(port.requests).toHaveLength(0);
    // Секрет не раскрывался.
    expect(store.revealCalls).toHaveLength(0);
  });

  it('хост вне политики ключа → host_denied', async () => {
    const store = new FakeSshKeyStore([usableKey({ allowHosts: ['other.example.com'] })]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('host_denied');
    expect(port.requests).toHaveLength(0);
  });

  it('порт вне политики ключа → port_denied', async () => {
    const store = new FakeSshKeyStore([usableKey({ allowPorts: [22] })]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', port: 2222, direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.keyCode).toBe('port_denied');
    expect(port.requests).toHaveLength(0);
  });
});

describe('ssh_copy — валидация аргументов', () => {
  it('перевод строки в local → отказ (batch — построчный протокол)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'a.txt\nput /etc/shadow /tmp/x', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('перевод строки в remote → отказ', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt\rput /etc/shadow /tmp/x' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('NUL в пути → отказ', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'a.txt\0b', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('remote с ведущим дефисом → отказ (иначе это опция sftp)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'a.txt', remote: '-R' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('glob-метасимвол в пути → отказ (копия — один путь, а не набор файлов)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: '*.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('абсолютный local → отказ (локальный путь — относительный)', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: '/etc/passwd', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });

  it('неизвестное направление → отказ', async () => {
    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'sideways', local: 'a.txt', remote: '/tmp/a.txt' } as never,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(port.requests).toHaveLength(0);
  });
});

describe('ssh_copy — периметр сессии (локальный путь)', () => {
  it('путь за пределами рабочего каталога → существующая ошибка доступа', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-ssh-copy-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    await mkdir(workspace, { recursive: true });
    await writeFile(outside, 'secret', 'utf-8');

    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store, workingDir: workspace });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: '../outside.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    // Отказ — существующей ошибкой доступа (тот же контракт, что у fs-тулов).
    expect(i18nKey(result)).toBe('permission.external_directory_default');
    expect(port.requests).toHaveLength(0);
  });

  it('симлинк наружу → отказ (побег за периметр)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-ssh-copy-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    await mkdir(workspace, { recursive: true });
    await writeFile(outside, 'secret', 'utf-8');
    await symlink(outside, join(workspace, 'link.txt'));

    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store, workingDir: workspace });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'link.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('permission.external_directory_default');
    expect(port.requests).toHaveLength(0);
  });

  it('файл внутри рабочего каталога — путь принимается', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-ssh-copy-'));
    await writeFile(join(root, 'a.txt'), 'data', 'utf-8');

    const store = new FakeSshKeyStore([usableKey()]);
    const { ctx, port } = makeCtx({ store, workingDir: root });

    const result = await sshCopyTool.execute(
      { host: 'example.com', direction: 'upload', local: 'a.txt', remote: '/tmp/a.txt' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(port.requests).toHaveLength(1);
  });
});

describe('ssh_copy — доступность (permission-слой)', () => {
  it('plan-режим: тул заблокирован permission-слоем (отказ целиком)', () => {
    expect(isPlanBlockedTool('ssh_copy', ['ssh'])).toBe(true);
    expect(
      computeToolAvailability('ssh_copy', ['ssh'], {
        sessionMode: 'plan',
        planMode: 'auto',
        planApproved: false,
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('режим инстанса `agent` → unavailable(policy)', () => {
    expect(
      computeToolAvailability('ssh_copy', ['ssh'], { getSshMode: () => 'agent' }),
    ).toEqual({ available: false, reason: 'policy' });
  });

  it('режим инстанса `tools` → тул доступен', () => {
    expect(
      computeToolAvailability('ssh_copy', ['ssh'], { getSshMode: () => 'tools' }),
    ).toEqual({ available: true });
  });
});
