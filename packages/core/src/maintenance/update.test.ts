// ADR-092: тесты `synth update` — проверка/предпросмотр/установка/откат.
//
// Сеть и установка инжектируются через `deps` — реальных запросов в npm нет;
// интерактивное подтверждение заменяется `confirm`.
import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import { MemoryMaintenanceAuditRepository } from '../storage/memory/index.js';
import { _resetTlsTrustForTests, initTlsTrust } from '../security/tls.js';
import {
  buildUpdateInstallArgs,
  describeNpmFailure,
  formatNpmCommand,
  resolveNpmInstallEnvironment,
  runUpdateCommand,
} from './update.js';

/** ADR-133: реестр канала задаётся scoped-ключом, зависимости — из npm по умолчанию. */
describe('buildUpdateInstallArgs (ADR-133)', () => {
  it('стабильный реестр по умолчанию — без флага реестра, с --prefer-online', () => {
    expect(buildUpdateInstallArgs('1.2.3', 'https://registry.npmjs.org', false)).toEqual([
      'install',
      '-g',
      '@itphx/synth@1.2.3',
      '--prefer-online',
    ]);
  });

  it('бета-канал — один scoped-аргумент --@itphx:registry=<url>', () => {
    const args = buildUpdateInstallArgs('1.2.3-beta.1', 'https://git.example/npm', true);
    expect(args).toEqual([
      'install',
      '-g',
      '@itphx/synth@1.2.3-beta.1',
      '--@itphx:registry=https://git.example/npm',
      '--prefer-online',
    ]);
    // `--registry` сломал бы установку: публичные зависимости в Gitea отсутствуют.
    expect(args).not.toContain('--registry');
  });
});

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
    expect(parsed.installCommand).toBe(
      'npm install -g @itphx/synth@1.0.0 --prefer-online',
    );
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
    expect(list[0]!.details).toMatchObject({
      from: '0.10.0',
      to: '1.0.0',
      channel: 'stable',
      registry: 'https://registry.npmjs.org',
      version: '1.0.0',
    });
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
    expect(list[0]!.details).toMatchObject({
      from: '0.10.0',
      to: '0.9.0',
      channel: 'stable',
      registry: 'https://registry.npmjs.org',
      version: '0.9.0',
    });
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

describe('runUpdateCommand: каналы и preflight (ADR-133)', () => {
  it('--to beta (dist-tag) → ошибка, сеть не трогается', async () => {
    const { errors, error } = capture();
    let called = false;
    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: 'beta',
      error,
      deps: {
        currentVersion: '0.13.7',
        fetchVersions: async () => {
          called = true;
          return [];
        },
      },
    });

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(errors.join('\n')).toContain('не semver');
    expect(errors.join('\n')).toContain('dist-tag');
  });

  it('--to вне реестра канала → exit 1 с указанием канала', async () => {
    const { errors, error } = capture();
    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '0.12.0',
      channel: 'beta',
      error,
      deps: { currentVersion: '0.13.7-beta.1', fetchVersions: async () => ['0.13.7-beta.1'] },
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('0.12.0');
    expect(errors.join('\n')).toContain('канала beta');
  });

  it('preflight prefix вне HOME → exit 1 с инструкцией, установки нет', async () => {
    const { errors, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(0);

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
        install,
        preflight: async () =>
          'npm prefix -g (/usr) вне $HOME (/home/user)\n  npm config set prefix ~/.npm-global',
      },
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(errors.join('\n')).toContain('npm config set prefix');
    expect(await audit.list()).toEqual([]);
  });

  it('--check --json: только проверка, установка не вызывается, аудит update.checked', async () => {
    const { logs, log, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(0);

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      check: true,
      apply: true,
      json: true,
      log,
      error,
      audit,
      deps: { currentVersion: '0.10.0', fetchLatest: async () => '1.0.0', install },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const parsed = JSON.parse(logs[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      currentVersion: '0.10.0',
      targetVersion: '1.0.0',
      channel: 'stable',
      registry: 'https://registry.npmjs.org',
      apply: false,
    });
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['update.checked']);
  });

  it('beta → stable: откат «на релиз»', async () => {
    const { log, error } = capture();
    const audit = new MemoryMaintenanceAuditRepository();
    const { calls, install } = fakeInstall(0);
    const questions: string[] = [];

    const code = await runUpdateCommand({
      dataDir: '/tmp/does-not-matter',
      to: '0.14.0',
      apply: true,
      log,
      error,
      audit,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
      deps: {
        currentVersion: '0.14.0-beta.1',
        fetchVersions: async () => ['0.14.0-beta.1', '0.14.0'],
        install,
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual(['0.14.0']);
    expect(questions[0]).toContain('ОТКАТ');
    expect(questions[0]).toContain('релиз');
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['rollback.applied']);
    expect(list[0]!.details).toMatchObject({ channel: 'beta', version: '0.14.0' });
  });
});

/**
 * ADR-099 × ADR-133: дочерний npm не наследует доверие TLS/прокси инстанса.
 * Env установки собирается из `security.tls` (CA) и маршрута прокси реестра.
 */
describe('resolveNpmInstallEnvironment (ADR-099)', () => {
  /** CA-фикстура (самоподписанный тестовый серт) — валидный PEM. */
  const CERT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'security',
    '__fixtures__',
    'tls-test-selfsigned.pem',
  );

  afterEach(() => {
    _resetTlsTrustForTests();
  });

  it('без TLS/прокси — env пустой (поведение прежнее)', async () => {
    await initTlsTrust(undefined, {});
    expect(await resolveNpmInstallEnvironment('https://registry.npmjs.org')).toEqual({});
  });

  it('security.tls.caFile → NODE_EXTRA_CA_CERTS дочернего npm', async () => {
    await initTlsTrust({ security: { tls: { caFile: CERT_PATH } } }, {});
    const env = await resolveNpmInstallEnvironment('https://git.itphx.ru/api/packages/itphx/npm');
    expect(env.NODE_EXTRA_CA_CERTS).toBe(CERT_PATH);
  });

  it('прокси инстанса → HTTPS_PROXY для хоста реестра', async () => {
    await initTlsTrust(
      {
        security: {},
        proxy: {
          mode: 'all',
          fromEnv: false,
          profiles: { default: { url: 'http://proxy.corp:3128' } },
        },
      },
      {},
    );
    const env = await resolveNpmInstallEnvironment('https://git.itphx.ru/api/packages/itphx/npm');
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp:3128');
    expect(env.HTTP_PROXY).toBe('http://proxy.corp:3128');
  });
});

/** Диагностика провала `npm install` (инцидент: TLS маскировался под ETARGET). */
describe('describeNpmFailure (ADR-133)', () => {
  it('SELF_SIGNED_CERT_IN_CHAIN → понятный текст про CA/прокси', () => {
    const failure = describeNpmFailure({
      code: 1,
      registry: 'https://git.itphx.ru/api/packages/itphx/npm',
      stderr: 'npm http fetch failed with SELF_SIGNED_CERT_IN_CHAIN',
    });
    expect(failure.reason).toBe('tls');
    expect(failure.message).toContain('SELF_SIGNED_CERT_IN_CHAIN');
    expect(failure.message).toContain('security.tls / NODE_EXTRA_CA_CERTS');
    expect(failure.message).toContain('https://git.itphx.ru/api/packages/itphx/npm');
  });

  it('остальные TLS-коды распознаются так же', () => {
    for (const code of [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'CERT_HAS_EXPIRED',
    ]) {
      expect(describeNpmFailure({ code: 1, registry: 'r', stderr: code }).reason).toBe('tls');
    }
  });

  it('ETARGET — отдельная причина (реестр, а не TLS)', () => {
    const failure = describeNpmFailure({
      code: 1,
      registry: 'https://git.itphx.ru/api/packages/itphx/npm',
      stderr: 'npm error code ETARGET\nnpm error notarget No matching version found',
    });
    expect(failure.reason).toBe('etarget');
    expect(failure.message).toContain('ETARGET');
    expect(failure.message).toContain('https://git.itphx.ru/api/packages/itphx/npm');
  });

  it('прочий провал — прежний текст «npm завершился с кодом N»', () => {
    expect(describeNpmFailure({ code: 7, registry: 'r' })).toEqual({
      reason: 'exit',
      message: 'npm завершился с кодом 7',
    });
  });
});

describe('formatNpmCommand', () => {
  it('печатает argv без секретов', () => {
    expect(formatNpmCommand(buildUpdateInstallArgs('1.2.3', 'https://git.example/npm', true))).toBe(
      'npm install -g @itphx/synth@1.2.3 --@itphx:registry=https://git.example/npm --prefer-online',
    );
  });
});
