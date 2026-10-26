/**
 * ADR-077 (протокол 4): секреты вызова в inline-режиме.
 *
 * В inline-режиме точкой исполнения является процесс control plane: секрет
 * материализуется **здесь** (временный ключ `0600` в каталоге `0700`) и
 * **обязательно** удаляется после вызова — при успехе, ошибке команды,
 * таймауте и отмене. Никаких файлов в control plane после вызова не остаётся.
 *
 * Фоновые процессы секреты **не поддерживают** (fail-closed): процесс
 * переживает вызов, а материал доставляется «на время вызова».
 */

import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InlineExecutionPort } from './inline-execution-port.js';
import { EXECUTION_SECRETS_UNSUPPORTED_CODE, isExecutionError } from './ports/index.js';

const PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\ninline-secret-material\n-----END OPENSSH PRIVATE KEY-----\n';

/** Команда печатает путь к ключу, извлечённый из `GIT_SSH_COMMAND`. */
const PRINT_KEY_PATH =
  'p=$(printf "%s" "$GIT_SSH_COMMAND" | sed "s/.*-i \\([^ ]*\\).*/\\1/"); printf "%s" "$p"';

describe('inline-порт: материализация секрета вызова', () => {
  it('секрет доступен команде и удалён после вызова', async () => {
    const port = new InlineExecutionPort();
    const res = await port.execute({
      command: { kind: 'shell', command: PRINT_KEY_PATH },
      secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
    });

    const keyPath = res.stdout.trim();
    expect(keyPath.length).toBeGreaterThan(0);
    expect(keyPath).toContain('synth-ssh-');
    // Файл ключа существовал во время команды — и удалён после неё.
    await expect(access(keyPath)).rejects.toBeTruthy();
    await expect(access(dirname(keyPath))).rejects.toBeTruthy();
  });

  it('файл ключа есть во время выполнения команды', async () => {
    const port = new InlineExecutionPort();
    const res = await port.execute({
      command: {
        kind: 'shell',
        command:
          'p=$(printf "%s" "$GIT_SSH_COMMAND" | sed "s/.*-i \\([^ ]*\\).*/\\1/"); ' +
          'if [ -f "$p" ]; then printf "exists"; else printf "missing"; fi',
      },
      secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
    });
    expect(res.stdout).toBe('exists');
  });

  it('ненулевой код выхода — ошибка, но каталог с ключом тоже удалён', async () => {
    const port = new InlineExecutionPort();
    const err = await port
      .execute({
        command: { kind: 'shell', command: `${PRINT_KEY_PATH}; exit 3` },
        secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
      })
      .catch((e) => e);
    expect(isExecutionError(err)).toBe(true);
    if (!isExecutionError(err)) return;
    expect(err.reason).toBe('nonzero_exit');
    expect(err.code).toBe(3);
    const keyPath = err.stdout.trim();
    expect(keyPath.length).toBeGreaterThan(0);
    await expect(access(keyPath)).rejects.toBeTruthy();
    await expect(access(dirname(keyPath))).rejects.toBeTruthy();
  });

  it('без секретов окружение вызова не меняется', async () => {
    const port = new InlineExecutionPort();
    const res = await port.execute({
      command: { kind: 'shell', command: 'printf "%s" "$GIT_SSH_COMMAND"' },
    });
    expect(res.stdout).toBe('');
  });

  it('фоновый запуск с секретами — fail-closed ESECRETS', async () => {
    const port = new InlineExecutionPort();
    const err = await port
      .spawnBackground({
        command: { kind: 'shell', command: 'sleep 1' },
        secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
      })
      .catch((e) => e);
    expect(isExecutionError(err)).toBe(true);
    if (!isExecutionError(err)) return;
    expect(err.code).toBe(EXECUTION_SECRETS_UNSUPPORTED_CODE);
  });
});
