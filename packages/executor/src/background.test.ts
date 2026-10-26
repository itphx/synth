import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackgroundExecService,
  type BackgroundProcessRecord,
  type BackgroundExecServiceOptions,
} from './background.js';

let workspace: string;
let outside: string;
let logDir: string;
let service: BackgroundExecService | undefined;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-exec-bg-ws-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'synth-exec-bg-out-')));
  logDir = await realpath(await mkdtemp(join(tmpdir(), 'synth-exec-bg-logs-')));
});

afterEach(async () => {
  await service?.dispose();
  service = undefined;
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(logDir, { recursive: true, force: true });
});

/** Создать сервис (с тестовым каталогом журналов). */
function makeService(opts: Partial<BackgroundExecServiceOptions> = {}): BackgroundExecService {
  service = new BackgroundExecService({ workspaceRoot: workspace, logDir, ...opts });
  return service;
}

/** Дождаться терминального статуса фонового процесса. */
async function waitTerminal(
  svc: BackgroundExecService,
  id: string,
): Promise<BackgroundProcessRecord> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const record = svc.status(id);
    if (record && record.status !== 'running') return record;
    if (Date.now() > deadline) throw new Error(`фоновый процесс ${id} не завершился`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20);
      timer.unref?.();
    });
  }
}

describe('фоновые процессы: запуск и статус', () => {
  it('запуск — id формата proc_, pid и раздельные логи', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({
      command: { kind: 'shell', command: 'printf out; printf err 1>&2' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.processId.startsWith('proc_')).toBe(true);
    expect(outcome.pid).toBeGreaterThan(0);

    const record = await waitTerminal(svc, outcome.processId);
    expect(record.status).toBe('exited');
    expect(record.exitCode).toBe(0);
    expect(record.signal).toBeNull();
    expect(record.finishedAt).toBeGreaterThanOrEqual(record.startedAt);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);

    const logs = await svc.logs(outcome.processId);
    expect(logs?.status).toBe('exited');
    expect(logs?.stdout.content).toBe('out');
    expect(logs?.stderr.content).toBe('err');
    expect(logs?.totalBytes).toBe(6);
    expect(logs?.truncated).toBe(false);
  });

  it('ненулевой код выхода — статус failed', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({ command: { kind: 'shell', command: 'exit 3' } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = await waitTerminal(svc, outcome.processId);
    expect(record.status).toBe('failed');
    expect(record.exitCode).toBe(3);
  });

  it('argv-форма — бинарник запускается без shell', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({
      command: { kind: 'argv', file: 'sh', args: ['-c', 'printf argv'] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    await waitTerminal(svc, outcome.processId);
    const logs = await svc.logs(outcome.processId);
    expect(logs?.stdout.content).toBe('argv');
  });

  it('неизвестный процесс — status и logs возвращают null', async () => {
    const svc = makeService();
    expect(svc.status('proc_missing')).toBeNull();
    expect(await svc.logs('proc_missing')).toBeNull();
    expect(svc.stop('proc_missing')).toBe(false);
  });
});

describe('фоновые процессы: остановка и таймаут', () => {
  it('stop — процесс убит сигналом, повторный вызов идемпотентен', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({ command: { kind: 'shell', command: 'sleep 30' } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(svc.stop(outcome.processId)).toBe(true);
    // Повторный stop — не ошибка и не дублирует эскалацию.
    expect(svc.stop(outcome.processId)).toBe(true);
    const record = await waitTerminal(svc, outcome.processId);
    expect(record.status).toBe('killed');
    expect(record.signal).toBe('SIGTERM');
  });

  it('таймаут — процесс убит по истечении', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({
      command: { kind: 'shell', command: 'sleep 30' },
      timeoutMs: 300,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = await waitTerminal(svc, outcome.processId);
    expect(record.status).toBe('killed');
    expect(record.signal).toBe('SIGTERM');
  });
});

describe('фоновые процессы: лимиты', () => {
  it('превышение лимита живых процессов — too_many_requests', async () => {
    const svc = makeService({ maxProcesses: 1 });
    const first = await svc.spawn({ command: { kind: 'shell', command: 'sleep 5' } });
    expect(first.ok).toBe(true);
    const second = await svc.spawn({ command: { kind: 'shell', command: 'sleep 5' } });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('too_many_requests');
    expect(second.code).toBe('ELIMIT');
    if (first.ok) {
      svc.stop(first.processId);
      await waitTerminal(svc, first.processId);
    }
  });

  it('параллельные запуски не проходят лимит', async () => {
    const svc = makeService({ maxProcesses: 2 });
    const outcomes = await Promise.all([
      svc.spawn({ command: { kind: 'shell', command: 'sleep 5' } }),
      svc.spawn({ command: { kind: 'shell', command: 'sleep 5' } }),
      svc.spawn({ command: { kind: 'shell', command: 'sleep 5' } }),
      svc.spawn({ command: { kind: 'shell', command: 'sleep 5' } }),
    ]);
    const started = outcomes.filter((outcome) => outcome.ok);
    expect(started).toHaveLength(2);
    for (const outcome of started) {
      if (!outcome.ok) continue;
      svc.stop(outcome.processId);
      await waitTerminal(svc, outcome.processId);
    }
  });

  it('неудача запуска (нет бинарника) — failed с кодом libuv', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({
      command: { kind: 'argv', file: 'synth-executor-missing-binary' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = await waitTerminal(svc, outcome.processId);
    expect(record.status).toBe('failed');
    expect(record.exitCode).toBe(-2);
  });

  it('превышение лимита журнала — truncated, процесс продолжает работать', async () => {
    const svc = makeService({ maxLogBytes: 16 });
    const outcome = await svc.spawn({
      command: { kind: 'shell', command: 'printf abcdefghijklmnopqrstuvwxyz0123456789; sleep 0.2' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = await waitTerminal(svc, outcome.processId);
    // Процесс не убит — он завершился штатно.
    expect(record.status).toBe('exited');
    expect(record.truncated).toBe(true);
    const logs = await svc.logs(outcome.processId);
    expect(logs?.truncated).toBe(true);
    expect(logs?.stdout.content.length).toBeLessThanOrEqual(16);
  });
});

describe('фоновые процессы: containment рабочего каталога', () => {
  it('cwd вне workspace — отказ cwd_outside_workspace', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({
      command: { kind: 'shell', command: 'pwd' },
      cwd: outside,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('cwd_outside_workspace');
    expect(outcome.code).toBe('EWORKSPACE');
  });

  it('cwd с выходом через ".." — отказ cwd_outside_workspace', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({
      command: { kind: 'shell', command: 'pwd' },
      cwd: '../..',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('cwd_outside_workspace');
  });

  it('cwd внутри workspace — команда выполняется в нём', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({
      command: { kind: 'shell', command: 'pwd' },
      cwd: workspace,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    await waitTerminal(svc, outcome.processId);
    const logs = await svc.logs(outcome.processId);
    expect(logs?.stdout.content.trim()).toBe(workspace);
  });
});

describe('фоновые процессы: журнал и очистка реестра', () => {
  it('чтение журнала — отрезки со смещением и лимитом', async () => {
    const svc = makeService();
    const outcome = await svc.spawn({
      command: { kind: 'shell', command: 'printf abcdefghij' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    await waitTerminal(svc, outcome.processId);

    const head = await svc.logs(outcome.processId, { limit: 4 });
    expect(head?.stdout.content).toBe('abcd');
    expect(head?.stdout.offset).toBe(0);
    expect(head?.stdout.nextOffset).toBe(4);

    const tail = await svc.logs(outcome.processId, { stdoutOffset: 4 });
    expect(tail?.stdout.content).toBe('efghij');
    expect(tail?.stdout.offset).toBe(4);
    expect(tail?.stdout.nextOffset).toBe(10);
  });

  it('prune — терминальные записи и их журналы удаляются, живые остаются', async () => {
    let clock = Date.now();
    const svc = makeService({ now: () => clock });
    const finished = await svc.spawn({ command: { kind: 'shell', command: 'printf done' } });
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    await waitTerminal(svc, finished.processId);
    const logPath = join(svc.logDir, `${finished.processId}.out.log`);
    expect((await stat(logPath)).isFile()).toBe(true);

    const running = await svc.spawn({ command: { kind: 'shell', command: 'sleep 5' } });
    expect(running.ok).toBe(true);

    // Два часа прошло — терминальная запись устарела.
    clock += 2 * 60 * 60 * 1000;
    await svc.prune();

    expect(svc.status(finished.processId)).toBeNull();
    await expect(stat(logPath)).rejects.toThrow();
    if (running.ok) {
      expect(svc.status(running.processId)).not.toBeNull();
      svc.stop(running.processId);
      await waitTerminal(svc, running.processId);
    }
  });
});
