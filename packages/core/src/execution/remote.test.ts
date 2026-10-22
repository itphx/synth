/**
 * Загрузчик удалённого порта (ADR-077, шаг 7b) — fail-closed и секреты.
 *
 * Проверяется:
 * - токен читается из файла, указанного в `execution.remote.tokenSecret`
 *   (это **путь**, а не значение — инвариант 13);
 * - значение токена не попадает ни в текст ошибки, ни в конфигурацию;
 * - недоступность токена/адресов/пакета — **понятная ошибка**, а не молчаливый
 *   возврат в inline-исполнение.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, resolveExecutionConfig } from '@itphx/synth-shared';
import { InlineExecutionPort } from './inline-execution-port.js';
import { createExecutionPortForConfig } from './factory.js';
import {
  RemoteExecutionUnavailableError,
  createRemoteExecutionPortFromConfig,
  isExecutorPackageAvailable,
  readExecutorToken,
} from './remote.js';

const SECRET = 's3cr3t-executor-token-value';

/** Собрать эффективную секцию `execution` из куска конфигурации. */
function execution(overrides: { mode?: 'inline' | 'remote'; url?: string[]; tokenSecret?: string }) {
  return resolveExecutionConfig(
    {
      ...defaultConfig,
      execution: {
        mode: overrides.mode ?? 'inline',
        remote: {
          url: overrides.url ?? [],
          timeoutMs: 30_000,
          concurrency: 2,
          failMode: 'fail',
          tokenSecret: overrides.tokenSecret ?? '',
        },
      },
    },
    {},
  );
}

describe('ADR-077: чтение токена исполнителя', () => {
  it('читает значение из файла и обрезает пробелы', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'token');
      await writeFile(file, `  ${SECRET}\n`, 'utf-8');
      expect(await readExecutorToken(file)).toBe(SECRET);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('пустой путь — ошибка (токен не настроен)', async () => {
    await expect(readExecutorToken('')).rejects.toBeInstanceOf(RemoteExecutionUnavailableError);
  });

  it('несуществующий файл — понятная ошибка (путь — в тексте, значение токена — нет)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'missing-token');
      const err = await readExecutorToken(file).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteExecutionUnavailableError);
      expect((err as Error).message).toContain(file);
      expect((err as Error).message).not.toContain(SECRET);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('пустой файл — понятная ошибка', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'empty-token');
      await writeFile(file, '   \n', 'utf-8');
      await expect(readExecutorToken(file)).rejects.toBeInstanceOf(RemoteExecutionUnavailableError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ADR-077: загрузчик удалённого порта — fail-closed', () => {
  it('пустой список адресов — ошибка (не молчаливый inline)', async () => {
    const err = await createRemoteExecutionPortFromConfig(execution({ mode: 'remote' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RemoteExecutionUnavailableError);
    expect((err as Error).message).toContain('execution.remote.url');
  });

  it('нечитаемый токен — ошибка (значение токена в тексте ошибки нет)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'token');
      await writeFile(file, SECRET, 'utf-8');
      // Секрет испорчен: путь указывает на каталог — чтение невозможно.
      const err = await createRemoteExecutionPortFromConfig(
        execution({ mode: 'remote', url: ['http://127.0.0.1:59999'], tokenSecret: dir }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteExecutionUnavailableError);
      expect((err as Error).message).not.toContain(SECRET);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ADR-077: фабрика выбора порта по режиму', () => {
  it('inline — исполнение в процессе (прежнее поведение)', async () => {
    const port = await createExecutionPortForConfig(execution({ mode: 'inline' }));
    expect(port).toBeInstanceOf(InlineExecutionPort);
  });

  it('конфиг не задан — тоже inline (fail-safe для сборок без секции)', async () => {
    const port = await createExecutionPortForConfig(undefined);
    expect(port).toBeInstanceOf(InlineExecutionPort);
  });
});

/**
 * Remote-режим целиком — только при установленном пакете исполнителя
 * (`@itphx/synth-executor` — опциональная зависимость core). Без собранного
 * пакета блок пропускается явно.
 */
describe.skipIf(!(await isExecutorPackageAvailable()))('ADR-077: фабрика в remote-режиме', () => {
  it('remote — порт не inline (исполнение уходит к исполнителю)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-token-'));
    try {
      const file = join(dir, 'token');
      await writeFile(file, `${SECRET}\n`, 'utf-8');
      const port = await createExecutionPortForConfig(
        execution({ mode: 'remote', url: ['http://127.0.0.1:59999'], tokenSecret: file }),
      );
      expect(port).not.toBeInstanceOf(InlineExecutionPort);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
