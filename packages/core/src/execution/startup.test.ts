import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolveExecutionConfig } from '@itphx/synth-shared';
import type { SynthConfig } from '@itphx/synth-shared';
import {
  assertExecutionModeSupported,
  checkExecutionMode,
  type ExecutionEnvironmentProbe,
} from './startup.js';
import {
  EXECUTOR_PACKAGE_UNAVAILABLE_REASON,
  EXECUTOR_TOKEN_UNAVAILABLE_REASON,
  isExecutorPackageAvailable,
} from './remote.js';
import { t } from '../engine/system-messages.js';

const cfg: SynthConfig = defaultConfig;

/** Корень пакета core — для запуска CLI в тестах (`tsx src/main.ts`). */
const CORE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Точка входа CLI core. */
const MAIN_TS = join(CORE_ROOT, 'src', 'main.ts');

/** Пауза (мс). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Свободный порт для запуска сервера в тесте.
 *
 * `--port 0` не годится: `core.port` в схеме конфигурации — целое **≥ 1**
 * (`z.number().int().min(1)`, `shared/src/config/types.ts`), поэтому «порт 0»
 * отвергается валидацией конфигурации и сервер не стартует вовсе.
 */
async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Ждать наступления условия (или выхода дочернего процесса).
 *
 * @returns `true` — условие наступило; `false` — истёк таймаут ожидания.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

function execution(overrides: {
  mode?: 'inline' | 'remote';
  url?: string[];
  timeoutMs?: number;
  concurrency?: number;
  failMode?: 'fail' | 'inline-fallback';
  tokenSecret?: string;
}) {
  return resolveExecutionConfig(
    {
      ...cfg,
      execution: {
        mode: overrides.mode ?? cfg.execution.mode,
        remote: {
          url: overrides.url ?? [],
          timeoutMs: overrides.timeoutMs ?? 30_000,
          concurrency: overrides.concurrency ?? 4,
          failMode: overrides.failMode ?? 'fail',
          tokenSecret: overrides.tokenSecret ?? '',
        },
      },
    },
    {},
  );
}

/** Проба окружения: пакет доступен, токен читается. */
const okProbe: ExecutionEnvironmentProbe = {
  isPackageAvailable: async () => true,
  readToken: async () => 'token',
};

/** Проба окружения: пакет исполнителя не установлен. */
const noPackageProbe: ExecutionEnvironmentProbe = {
  isPackageAvailable: async () => false,
  readToken: async () => 'token',
};

/** Проба окружения: токен не читается. */
const noTokenProbe: ExecutionEnvironmentProbe = {
  isPackageAvailable: async () => true,
  readToken: async () => {
    throw new Error('no token');
  },
};

describe('checkExecutionMode (ADR-077, шаги 3 и 7b)', () => {
  it('inline — старт разрешён (прежнее поведение)', async () => {
    const check = await checkExecutionMode(execution({ mode: 'inline' }));
    expect(check.ok).toBe(true);
    expect(check.issue).toBeUndefined();
    expect(check.message).toBeUndefined();
  });

  it('remote без адресов исполнителей — отдельная причина (fail-closed)', async () => {
    const check = await checkExecutionMode(execution({ mode: 'remote', url: [] }));
    expect(check.ok).toBe(false);
    expect(check.issue).toBe('remote_url_required');
    expect(check.message).toBe(t('execution.remote_url_required'));
  });

  it('remote с адресами и готовым окружением — старт разрешён', async () => {
    const check = await checkExecutionMode(
      execution({ mode: 'remote', url: ['http://synth-executor:8080'] }),
      okProbe,
    );
    expect(check.ok).toBe(true);
    expect(check.issue).toBeUndefined();
  });

  it('remote без пакета исполнителя — fail-closed с понятной причиной', async () => {
    const check = await checkExecutionMode(
      execution({ mode: 'remote', url: ['http://synth-executor:8080'] }),
      noPackageProbe,
    );
    expect(check.ok).toBe(false);
    expect(check.issue).toBe('remote_unavailable');
    expect(check.message).toBe(
      t('execution.remote_unavailable', { reason: EXECUTOR_PACKAGE_UNAVAILABLE_REASON }),
    );
  });

  it('remote без читаемого токена — fail-closed с понятной причиной', async () => {
    const check = await checkExecutionMode(
      execution({ mode: 'remote', url: ['http://synth-executor:8080'] }),
      noTokenProbe,
    );
    expect(check.ok).toBe(false);
    expect(check.issue).toBe('remote_unavailable');
    expect(check.message).toBe(
      t('execution.remote_unavailable', { reason: EXECUTOR_TOKEN_UNAVAILABLE_REASON }),
    );
  });

  it('сообщения — через ключи shared/i18n (ADR-041), не литералы', async () => {
    expect(t('execution.remote_url_required')).toContain('SYNTH_EXECUTION_REMOTE_URL');
    expect(t('execution.remote_unavailable', { reason: 'X' })).toContain('execution.mode=remote');
  });
});

describe('assertExecutionModeSupported (ADR-077, шаги 3 и 7b)', () => {
  it('inline — не бросает', async () => {
    await expect(assertExecutionModeSupported(execution({ mode: 'inline' }))).resolves.toBeUndefined();
  });

  it('remote без адресов — бросает с локализованным сообщением', async () => {
    await expect(
      assertExecutionModeSupported(execution({ mode: 'remote', url: [] })),
    ).rejects.toThrow(t('execution.remote_url_required'));
  });

  it('remote без пакета исполнителя — бросает с локализованным сообщением', async () => {
    await expect(
      assertExecutionModeSupported(
        execution({ mode: 'remote', url: ['http://x:8080'] }),
        noPackageProbe,
      ),
    ).rejects.toThrow(t('execution.remote_unavailable', { reason: EXECUTOR_PACKAGE_UNAVAILABLE_REASON }));
  });
});

describe('CLI-флаг --execution-mode (ADR-077)', () => {
  it('CLI важнее env (ADR-023)', () => {
    const resolved = resolveExecutionConfig(cfg, { SYNTH_EXECUTION_MODE: 'inline' }, { mode: 'remote' });
    expect(resolved.mode).toBe('remote');
  });

  it('fail-closed: неверное значение CLI-флага → ошибка', () => {
    expect(() => resolveExecutionConfig(cfg, {}, { mode: 'inlne' })).toThrow(
      /--execution-mode="inlne"/,
    );
  });
});

describe('CLI: synth serve --execution-mode (ADR-077, шаг 7b)', () => {
  function runServe(args: string[], env: NodeJS.ProcessEnv = {}): {
    status: number | null;
    output: string;
  } {
    const dataDir = mkdtempSync(join(tmpdir(), 'synth-execution-cli-'));
    try {
      const res = spawnSync(
        process.execPath,
        ['--import', 'tsx', MAIN_TS, 'serve', '--data-dir', dataDir, ...args],
        {
          cwd: CORE_ROOT,
          encoding: 'utf-8',
          timeout: 60_000,
          env: {
            ...process.env,
            // Гермётичность: свой (несуществующий) конфиг и пустой режим из env.
            SYNTH_CONFIG: join(dataDir, 'no-such-config.yaml'),
            SYNTH_EXECUTION_MODE: '',
            ...env,
          },
        },
      );
      return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  it(
    'remote без адресов — старт прерывается (нужен хотя бы один адрес исполнителя)',
    () => {
      const { status, output } = runServe(['--execution-mode', 'remote']);
      expect(status).toBe(1);
      expect(output).toContain('SYNTH_EXECUTION_REMOTE_URL');
    },
    90_000,
  );

  it(
    'remote с адресом, но без токена — старт прерывается (fail-closed)',
    () => {
      const { status, output } = runServe(['--execution-mode', 'remote'], {
        SYNTH_EXECUTION_REMOTE_URL: 'http://synth-executor:8080',
        SYNTH_EXECUTION_TOKEN: '',
      });
      expect(status).toBe(1);
      expect(output).toContain('execution.mode=remote');
    },
    90_000,
  );

  it(
    'неверное значение флага — fail-closed (не молчаливый дефолт)',
    () => {
      const { status, output } = runServe(['--execution-mode', 'inlne']);
      expect(status).toBe(1);
      expect(output).toContain('--execution-mode="inlne"');
    },
    90_000,
  );
});

/**
 * Remote-режим, который **разрешён**: сервер поднимается (порт собран по
 * конфигурации) и не печатает fail-closed сообщение.
 *
 * Пакет исполнителя — **опциональная** зависимость core: без собранного
 * `@itphx/synth-executor` удалённый режим недоступен by design, и проверять
 * тут нечего — блок пропускается явно (не молча).
 */
describe.skipIf(!(await isExecutorPackageAvailable()))(
  'CLI: synth serve --execution-mode remote (старт разрешён)',
  () => {
    it(
      'remote с адресом и читаемым токеном — старт разрешён',
      async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'synth-execution-cli-ok-'));
        const tokenFile = join(dataDir, 'executor-token');
        writeFileSync(tokenFile, 'cli-executor-token\n', 'utf-8');
        const port = await findFreePort();
        const child = spawn(
          process.execPath,
          [
            '--import', 'tsx', MAIN_TS, 'serve',
            '--data-dir', dataDir,
            '--execution-mode', 'remote',
            '--port', String(port),
          ],
          {
            cwd: CORE_ROOT,
            env: {
              ...process.env,
              SYNTH_CONFIG: join(dataDir, 'no-such-config.yaml'),
              SYNTH_EXECUTION_MODE: '',
              SYNTH_EXECUTION_REMOTE_URL: 'http://127.0.0.1:59999',
              SYNTH_EXECUTION_TOKEN: tokenFile,
            },
          },
        );
        // Слушатель 'exit' подписывается **сразу при spawn**: процесс может
        // завершиться ДО проверки вывода (например, из-за невалидной
        // конфигурации) — тогда подписка «после» уже не сработает, и
        // ожидание выхода зависло бы навсегда.
        const exited = new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        });
        let output = '';
        child.stdout?.on('data', (chunk) => {
          output += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
          output += String(chunk);
        });
        try {
          // Сервер остаётся жить (режим запуска) — ждём строку старта.
          const started = await waitUntil(
            () => output.includes('synth-core starting on') || child.exitCode !== null,
            30_000,
          );
          expect(started, `сервер не стартовал; вывод:\n${output}`).toBe(true);
          // Fail-closed-сообщения нет — старт в remote-режиме разрешён.
          expect(output).not.toContain('execution.mode=remote');
          expect(output).toContain('synth-core starting on');
        } finally {
          child.kill('SIGTERM');
          await Promise.race([exited, delay(15_000)]);
          rmSync(dataDir, { recursive: true, force: true });
        }
      },
      90_000,
    );
  },
);
