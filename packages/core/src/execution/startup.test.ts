import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolveExecutionConfig } from '@itphx/synth-shared';
import type { SynthConfig } from '@itphx/synth-shared';
import { assertExecutionModeSupported, checkExecutionMode } from './startup.js';
import { t } from '../engine/system-messages.js';

const cfg: SynthConfig = defaultConfig;

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

describe('checkExecutionMode (PROP-077, шаг 3)', () => {
  it('inline — старт разрешён (прежнее поведение)', () => {
    const check = checkExecutionMode(execution({ mode: 'inline' }));
    expect(check.ok).toBe(true);
    expect(check.issue).toBeUndefined();
    expect(check.message).toBeUndefined();
  });

  it('remote без адресов исполнителей — отдельная причина (fail-closed)', () => {
    const check = checkExecutionMode(execution({ mode: 'remote', url: [] }));
    expect(check.ok).toBe(false);
    expect(check.issue).toBe('remote_url_required');
    expect(check.message).toBe(t('execution.remote_url_required'));
  });

  it('remote с адресами — удалённый исполнитель ещё не реализован (fail-closed)', () => {
    const check = checkExecutionMode(
      execution({ mode: 'remote', url: ['http://synth-executor:8080'] }),
    );
    expect(check.ok).toBe(false);
    expect(check.issue).toBe('remote_not_supported');
    expect(check.message).toBe(t('execution.remote_not_supported'));
  });

  it('сообщения — через ключи shared/i18n (ADR-041), не литералы', () => {
    expect(t('execution.remote_not_supported')).toContain('execution.mode=remote');
    expect(t('execution.remote_url_required')).toContain('SYNTH_EXECUTION_REMOTE_URL');
  });
});

describe('assertExecutionModeSupported (PROP-077, шаг 3)', () => {
  it('inline — не бросает', () => {
    expect(() => assertExecutionModeSupported(execution({ mode: 'inline' }))).not.toThrow();
  });

  it('remote — бросает с локализованным сообщением', () => {
    expect(() =>
      assertExecutionModeSupported(execution({ mode: 'remote', url: ['http://x:8080'] })),
    ).toThrow(t('execution.remote_not_supported'));
    expect(() => assertExecutionModeSupported(execution({ mode: 'remote', url: [] }))).toThrow(
      t('execution.remote_url_required'),
    );
  });
});

describe('CLI-флаг --execution-mode (PROP-077)', () => {
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

describe('CLI: synth serve --execution-mode (PROP-077, шаг 3)', () => {
  const CORE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const MAIN_TS = join(CORE_ROOT, 'src', 'main.ts');

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
    'remote — старт прерывается (удалённый исполнитель не реализован)',
    () => {
      const { status, output } = runServe(['--execution-mode', 'remote'], {
        SYNTH_EXECUTION_REMOTE_URL: 'http://synth-executor:8080',
      });
      expect(status).toBe(1);
      expect(output).toContain('execution.mode=remote');
    },
    90_000,
  );

  it(
    'remote без адресов — отдельное сообщение',
    () => {
      const { status, output } = runServe(['--execution-mode', 'remote']);
      expect(status).toBe(1);
      expect(output).toContain('SYNTH_EXECUTION_REMOTE_URL');
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
