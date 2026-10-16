// ADR-092: тесты `synth update` — проверка/предпросмотр/установка/откат.
//
// Сеть и установка инжектируются через `deps` — реальных запросов в npm нет;
// интерактивное подтверждение заменяется `confirm`.
import { describe, expect, it } from 'vitest';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import { MemoryMaintenanceAuditRepository } from '../storage/memory/index.js';
import { runUpdateCommand } from './update.js';

/** Собирает вывод `log`/`error` в массивы. */
function capture(): { logs: string[]; errors: string[]; log: (m: string) => void; error: (m: string) => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, log: (m) => logs.push(m), error: (m) => errors.push(m) };
}

/** Фейковый `install`: фиксирует вызовы и возвращает заданный код. */
function fakeInstall(code = 0): { calls: string[]; install: (version: string) => Promise<number> } {
  const calls: string[] = [];
  return {
    calls,
    install: async (version: string) => {
      calls.push(version);
      return code;
    },
  };
}

describe('runUpdateCommand (ADR-092)', () => {
  it('без --apply: печатает текущую/целевую версию и что делать, exit 0', async () => {
    const { logs, log, error } = capture();
    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      log,
      error,
      deps: { currentVersion: '0.10.0', fetchLatest: async () => '0.11.0' },
    });

    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('Текущая версия: 0.10.0');
    expect(out).toContain('Целевая версия: 0.11.0');
    expect(out).toContain('обновление');
    expect(out).toContain('synth update --apply --to 0.11.0');
  });

  it('без --apply и без обновления: «Обновление не требуется», exit 0', async () => {
    const { logs, log, error } = capture();
    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      log,
      error,
      deps: { currentVersion: '1.0.0', fetchLatest: async () => '1.0.0' },
    });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Обновление не требуется');
  });

  it('--json без --apply: валидный JSON с версиями и типом операции', async () => {
    const { logs, log, error } = capture();
    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      json: true,
      log,
      error,
      deps: { currentVersion: '0.10.0', fetchLatest: async () => '1.0.0' },
    });

    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      currentVersion: '0.10.0',
      targetVersion: '1.0.0',
      operation: 'update',
      apply: false,
    });
    expect(parsed.installCommand).toBe('npm install -g @itphx/synth@1.0.0');
  });

  it('--to несуществующей версии: exit 1, update.failed с error', async () => {
    const { logs, errors, log, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '0.10.99',
      log,
      error,
      audit,
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.10.0', '0.11.0'] },
    });

    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join('\n')).toContain('0.10.99');
    expect(errors.join('\n')).toContain('не найдена');
    // Последняя известная версия подсказывается пользователю.
    expect(errors.join('\n')).toContain('0.11.0');

    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['update.failed']);
    expect(list[0]!.status).toBe('failed');
    expect(list[0]!.actor).toBe('cli');
    expect(list[0]!.details).toMatchObject({ from: '0.10.0', to: '0.10.99' });
    expect(list[0]!.error).toBeTruthy();
  });

  it('--to не-semver: exit 1, без обращения к сети и без аудита', async () => {
    const { errors, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    let called = false;
    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: 'not-a-version',
      error,
      audit,
      deps: {
        fetchVersions: async () => {
          called = true;
          return [];
        },
      },
    });

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(errors.join('\n')).toContain('не semver');
    expect(await audit.list()).toEqual([]);
  });

  it('--apply --to новее: update.applied с {from,to}', async () => {
    const { log, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(0);

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: 'v1.0.0',
      apply: true,
      yes: true,
      log,
      error,
      audit,
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.10.0', '1.0.0'], install },
    });

    expect(code).toBe(0);
    expect(calls).toEqual(['1.0.0']);
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['update.applied']);
    expect(list[0]!.status).toBe('ok');
    expect(list[0]!.actor).toBe('cli');
    expect(list[0]!.details).toEqual({ from: '0.10.0', to: '1.0.0' });
  });

  it('--apply --to старше: rollback.applied, в приглашении «ОТКАТ»', async () => {
    const { log, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(0);
    const questions: string[] = [];

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '0.9.0',
      apply: true,
      log,
      error,
      audit,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.9.0', '0.10.0'], install },
    });

    expect(code).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('ОТКАТ');
    expect(questions[0]).toContain('0.9.0');
    expect(calls).toEqual(['0.9.0']);

    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['rollback.applied']);
    expect(list[0]!.details).toEqual({ from: '0.10.0', to: '0.9.0' });
  });

  it('--apply --yes: приглашения нет', async () => {
    const { log, error } = capture();
    const { install } = fakeInstall(0);
    let confirmCalled = false;

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '1.0.0',
      apply: true,
      yes: true,
      log,
      error,
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.10.0', '1.0.0'], install },
    });

    expect(code).toBe(0);
    expect(confirmCalled).toBe(false);
  });

  it('--apply без --yes и отказ в приглашении: отменяется, установки и аудита нет', async () => {
    const { logs, log, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(0);

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '1.0.0',
      apply: true,
      log,
      error,
      audit,
      confirm: async () => false,
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.10.0', '1.0.0'], install },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain('Отменено');
    expect(await audit.list()).toEqual([]);
  });

  it('--dry-run --apply: install не вызывается, аудита нет, печатается план', async () => {
    const { logs, log, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(0);

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '1.0.0',
      apply: true,
      dryRun: true,
      log,
      error,
      audit,
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.10.0', '1.0.0'], install },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(await audit.list()).toEqual([]);
    const out = logs.join('\n');
    expect(out).toContain('[dry-run]');
    expect(out).toContain('сейчас: 0.10.0');
    expect(out).toContain('станет: 1.0.0');
    expect(out).toContain('тип операции: обновление');
    expect(out).toContain('npm install -g @itphx/synth@1.0.0');
  });

  it('--apply --to равной версии: установка не запускается, аудита нет', async () => {
    const { logs, log, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(0);

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '0.10.0',
      apply: true,
      yes: true,
      log,
      error,
      audit,
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.10.0'], install },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(await audit.list()).toEqual([]);
    expect(logs.join('\n')).toContain('уже установлена');
  });

  it('install вернул ≠0: exit 1 и update.failed с error', async () => {
    const { errors, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(1);

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '1.0.0',
      apply: true,
      yes: true,
      error,
      audit,
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.10.0', '1.0.0'], install },
    });

    expect(code).toBe(1);
    expect(calls).toEqual(['1.0.0']);
    expect(errors.join('\n')).toContain('с кодом 1');
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['update.failed']);
    expect(list[0]!.status).toBe('failed');
    expect(list[0]!.details).toMatchObject({ from: '0.10.0', to: '1.0.0' });
    expect(list[0]!.error).toContain('кодом 1');
  });

  it('install бросил исключение: exit 1 и update.failed с error', async () => {
    const { errors, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '1.0.0',
      apply: true,
      yes: true,
      error,
      audit,
      deps: {
        currentVersion: '0.10.0',
        fetchVersions: async () => ['0.10.0', '1.0.0'],
        install: async () => {
          throw new Error('npm не найден');
        },
      },
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('npm не найден');
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['update.failed']);
    expect(list[0]!.error).toContain('npm не найден');
  });

  it('ошибка проверки версий (сеть): exit 1, аудита нет', async () => {
    const { errors, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '1.0.0',
      error,
      audit,
      deps: {
        currentVersion: '0.10.0',
        fetchVersions: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('ECONNREFUSED');
    expect(await audit.list()).toEqual([]);
  });

  it('ошибка аудит-порта не ломает успешное обновление', async () => {
    const { logs, log, error } = capture();
    const brokenAudit = {
      append: async () => {
        throw new Error('журнал недоступен');
      },
      list: async () => [],
      clear: async () => 0,
    } as unknown as MaintenanceAuditRepository;
    const { calls, install } = fakeInstall(0);

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '1.0.0',
      apply: true,
      yes: true,
      log,
      error,
      audit: brokenAudit,
      deps: { currentVersion: '0.10.0', fetchVersions: async () => ['0.10.0', '1.0.0'], install },
    });

    expect(code).toBe(0);
    expect(calls).toEqual(['1.0.0']);
    expect(logs.join('\n')).toContain('synth doctor');
  });
});
