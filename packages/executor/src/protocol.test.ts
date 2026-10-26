/**
 * ADR-077 (протокол 4): разбор тела `POST /exec` с секретами вызова.
 *
 * Секреты — это материал, который исполнитель **записывает на диск** (временный
 * ключ `0600`), поэтому проверки строгие: неизвестный `kind`, непустой/слишком
 * большой ключ, нестроковая passphrase — отказ (`invalid_request`). Молчаливый
 * пропуск означал бы, что команда выполнится **без** ключа, а операция упадёт
 * с невнятной ошибкой аутентификации.
 *
 * Фоновые процессы (`POST /exec/spawn`) секреты **не поддерживают**: процесс
 * переживает вызов, а материал доставляется «на время вызова».
 */

import { describe, expect, it } from 'vitest';
import {
  EXEC_SECRET_LIMITS,
  parseExecRequestBody,
  parseExecSecrets,
  parseSpawnExecRequestBody,
} from './protocol.js';

const COMMAND = { kind: 'shell' as const, command: 'printf hi' };
const VALID_SECRET = { kind: 'ssh-key' as const, privateKey: '-----BEGIN KEY-----\nkey\n' };

describe('разбор secrets[] в POST /exec (протокол 4)', () => {
  it('валидный секрет принимается', () => {
    const parsed = parseExecRequestBody({ command: COMMAND, secrets: [VALID_SECRET] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.secrets).toHaveLength(1);
    expect(parsed.value.secrets?.[0]?.kind).toBe('ssh-key');
    expect(parsed.value.secrets?.[0]?.privateKey).toBe(VALID_SECRET.privateKey);
  });

  it('секретов нет — поле необязательное', () => {
    const parsed = parseExecRequestBody({ command: COMMAND });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.secrets).toBeUndefined();
  });

  it('больше 4 секретов — отказ', () => {
    const secrets = Array.from({ length: EXEC_SECRET_LIMITS.maxEntries + 1 }, () => VALID_SECRET);
    const parsed = parseExecRequestBody({ command: COMMAND, secrets });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('secrets');
  });

  it('неизвестный kind — отказ', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [{ kind: 'gpg-key', privateKey: 'x' }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('ssh-key');
  });

  it('пустой privateKey — отказ', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [{ kind: 'ssh-key', privateKey: '' }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('privateKey больше 16 КиБ — отказ', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [{ kind: 'ssh-key', privateKey: 'x'.repeat(EXEC_SECRET_LIMITS.maxPrivateKeyBytes + 1) }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('privateKey');
  });

  it('passphrase больше 4 КиБ — отказ', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [
        {
          kind: 'ssh-key',
          privateKey: 'key',
          passphrase: 'p'.repeat(EXEC_SECRET_LIMITS.maxPassphraseBytes + 1),
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('passphrase');
  });

  it('passphrase не строка — отказ', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [{ kind: 'ssh-key', privateKey: 'key', passphrase: 42 }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('secrets не массив — отказ', () => {
    const parsed = parseExecRequestBody({ command: COMMAND, secrets: { kind: 'ssh-key' } });
    expect(parsed.ok).toBe(false);
  });

  it('запись не объект — отказ', () => {
    const parsed = parseExecRequestBody({ command: COMMAND, secrets: ['key'] });
    expect(parsed.ok).toBe(false);
  });

  it('parseExecSecrets — тот же разбор без команды', () => {
    expect(parseExecSecrets([VALID_SECRET]).ok).toBe(true);
    expect(parseExecSecrets([]).ok).toBe(true);
    expect(parseExecSecrets(undefined).ok).toBe(false);
  });
});

describe('разбор секретов в POST /exec/spawn — отказ', () => {
  it('секреты в фоне не поддерживаются', () => {
    const parsed = parseSpawnExecRequestBody({ command: COMMAND, secrets: [VALID_SECRET] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('синхронн');
  });

  it('пустой список секретов в фоне тоже отказ (поле не принимается вовсе)', () => {
    const parsed = parseSpawnExecRequestBody({ command: COMMAND, secrets: [] });
    expect(parsed.ok).toBe(false);
  });
});
