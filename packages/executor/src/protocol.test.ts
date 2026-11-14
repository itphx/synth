/**
 * ADR-077 (протокол 4): разбор тела `POST /exec` с секретами вызова.
 *
 * Секреты — это материал, который исполнитель **записывает на диск** (временный
 * ключ `0600`), поэтому проверки строгие: неизвестный `kind`, непустой/слишком
 * большой ключ, нестроковая passphrase, неизвестный `mode` — отказ
 * (`invalid_request`). Молчаливый пропуск означал бы, что команда выполнится **без** ключа, а операция упадёт
 * с невнятной ошибкой аутентификации.
 *
 * Фоновые процессы (`POST /exec/spawn`) принимают секреты **на тех же**
 * условиях (протокол 6, PROP-124 §7) — отдельный набор проверок ниже.
 */

import { describe, expect, it } from 'vitest';
import {
  EXEC_ERROR_STATUS,
  EXEC_SECRET_LIMITS,
  EXECUTOR_FS_MAX_DOWNLOAD_BYTES,
  EXECUTOR_FS_MAX_READ_RAW_BYTES,
  EXECUTOR_PROTOCOL_VERSION,
  parseExecRequestBody,
  parseExecSecrets,
  parseFsBytesRequestBody,
  parseFsDownloadRequestBody,
  parseFsRawTextRequestBody,
  parseFsRenameRequestBody,
  parseFsSniffRequestBody,
  parseFsTextRequestBody,
  parseFsUploadQuery,
  parsePtyInputBody,
  parsePtyOpenBody,
  parsePtyResizeBody,
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

/**
 * Протокол 6 (PROP-124 §7): секреты вызова в **фоновом** запуске.
 *
 * `POST /exec/spawn` принимает `secrets[]` на **тех же** условиях, что и
 * `POST /exec`: тот же разбор (`parseExecSecrets`), те же лимиты и та же
 * строгость. Молчаливый пропуск означал бы, что фоновый процесс пойдёт **без
 * ключа**, а операция упадёт с невнятной ошибкой аутентификации.
 */
describe('разбор secrets[] в POST /exec/spawn (протокол 6)', () => {
  it('валидный секрет принимается', () => {
    const parsed = parseSpawnExecRequestBody({ command: COMMAND, secrets: [VALID_SECRET] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.secrets).toHaveLength(1);
    expect(parsed.value.secrets?.[0]?.kind).toBe('ssh-key');
    expect(parsed.value.secrets?.[0]?.privateKey).toBe(VALID_SECRET.privateKey);
  });

  it('секретов нет — поле необязательное', () => {
    const parsed = parseSpawnExecRequestBody({ command: COMMAND });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.secrets).toBeUndefined();
  });

  it('режим agent принимается', () => {
    const parsed = parseSpawnExecRequestBody({
      command: COMMAND,
      secrets: [{ ...VALID_SECRET, mode: 'agent' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.secrets?.[0]?.mode).toBe('agent');
  });

  it('больше 4 секретов — отказ', () => {
    const secrets = Array.from({ length: EXEC_SECRET_LIMITS.maxEntries + 1 }, () => VALID_SECRET);
    const parsed = parseSpawnExecRequestBody({ command: COMMAND, secrets });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('secrets');
  });

  it('неизвестный kind — отказ', () => {
    const parsed = parseSpawnExecRequestBody({
      command: COMMAND,
      secrets: [{ kind: 'gpg-key', privateKey: 'x' }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('ssh-key');
  });

  it('пустой privateKey — отказ', () => {
    const parsed = parseSpawnExecRequestBody({
      command: COMMAND,
      secrets: [{ kind: 'ssh-key', privateKey: '' }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('privateKey больше 16 КиБ — отказ', () => {
    const parsed = parseSpawnExecRequestBody({
      command: COMMAND,
      secrets: [
        { kind: 'ssh-key', privateKey: 'x'.repeat(EXEC_SECRET_LIMITS.maxPrivateKeyBytes + 1) },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('privateKey');
  });

  it('passphrase больше 4 КиБ — отказ', () => {
    const parsed = parseSpawnExecRequestBody({
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

  it('неизвестный mode — отказ', () => {
    const parsed = parseSpawnExecRequestBody({
      command: COMMAND,
      secrets: [{ ...VALID_SECRET, mode: 'tools' }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('mode');
  });

  it('secrets не массив — отказ', () => {
    const parsed = parseSpawnExecRequestBody({
      command: COMMAND,
      secrets: { kind: 'ssh-key' },
    });
    expect(parsed.ok).toBe(false);
  });
});

/**
 * Протокол 6 (PROP-124 §2): режим доставки ключа — `git` (по умолчанию) либо
 * `agent` (эфемерный `ssh-agent`).
 *
 * Неизвестный `mode` — отказ: молчаливый фоллбек в git-режим означал бы, что
 * команда выполнится без `SSH_AUTH_SOCK` (тихий сбой аутентификации).
 */
describe('разбор mode секрета вызова (протокол 6)', () => {
  it('mode не задан — режим по умолчанию (git)', () => {
    const parsed = parseExecRequestBody({ command: COMMAND, secrets: [VALID_SECRET] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.secrets?.[0]?.mode).toBeUndefined();
  });

  it('mode: "agent" принимается', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [{ ...VALID_SECRET, mode: 'agent' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.secrets?.[0]?.mode).toBe('agent');
  });

  it('mode: "git" принимается', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [{ ...VALID_SECRET, mode: 'git' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.secrets?.[0]?.mode).toBe('git');
  });

  it('неизвестный mode — отказ', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [{ ...VALID_SECRET, mode: 'tools' }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('mode');
  });

  it('mode не строка — отказ', () => {
    const parsed = parseExecRequestBody({
      command: COMMAND,
      secrets: [{ ...VALID_SECRET, mode: 42 }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('версия протокола — 8 (PTY-сессии)', () => {
    expect(EXECUTOR_PROTOCOL_VERSION).toBe(8);
  });
});

/**
 * Разбор тел PTY-роутов (протокол 8).
 *
 * Строгость — как у прочих разборов: молчаливый пропуск потолка или размера
 * означал бы запуск терминала **не с теми** параметрами, которые запросили.
 */
describe('разбор тел PTY-роутов (протокол 8)', () => {
  it('open: валидное тело принимается', () => {
    const parsed = parsePtyOpenBody({
      id: 'pty_fixed',
      cwd: '/workspace',
      shell: '/bin/bash',
      args: ['-i'],
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color' },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cwd).toBe('/workspace');
    expect(parsed.value.cols).toBe(80);
    expect(parsed.value.rows).toBe(24);
    expect(parsed.value.id).toBe('pty_fixed');
    expect(parsed.value.args).toEqual(['-i']);
  });

  it('open: без cwd — отказ', () => {
    const parsed = parsePtyOpenBody({ cols: 80, rows: 24 });
    expect(parsed.ok).toBe(false);
  });

  it('open: размеры вне диапазона — отказ', () => {
    expect(parsePtyOpenBody({ cwd: '/workspace', cols: 0, rows: 24 }).ok).toBe(false);
    expect(parsePtyOpenBody({ cwd: '/workspace', cols: 80, rows: 5000 }).ok).toBe(false);
    expect(parsePtyOpenBody({ cwd: '/workspace', cols: 80.5, rows: 24 }).ok).toBe(false);
  });

  it('open: env не со строковыми значениями — отказ', () => {
    const parsed = parsePtyOpenBody({
      cwd: '/workspace',
      cols: 80,
      rows: 24,
      env: { A: 1 },
    });
    expect(parsed.ok).toBe(false);
  });

  it('input: валидное тело и превышение потолка', () => {
    const parsed = parsePtyInputBody({ data: 'ls\n' });
    expect(parsed.ok).toBe(true);
    const tooLarge = parsePtyInputBody({ data: 'x'.repeat(32) }, 16);
    expect(tooLarge.ok).toBe(false);
    if (tooLarge.ok) return;
    expect(tooLarge.tooLarge).toBe(true);
  });

  it('resize: валидное тело и неверный размер', () => {
    const parsed = parsePtyResizeBody({ cols: 120, rows: 40 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ cols: 120, rows: 40 });
    expect(parsePtyResizeBody({ cols: 0, rows: 40 }).ok).toBe(false);
  });

  it('коды ошибок PTY — по HTTP-классам', () => {
    expect(EXEC_ERROR_STATUS.pty_unsupported).toBe(501);
    expect(EXEC_ERROR_STATUS.pty_not_found).toBe(404);
    expect(EXEC_ERROR_STATUS.pty_limit).toBe(429);
  });
});

/**
 * Разбор тел FS-роутов чтения содержимого (протокол 7, слайс 2 Ф1).
 *
 * Строгость — как у прочих разборов: молчаливый пропуск потолка означал бы,
 * что читается не та страница (или файл без ограничения размера).
 */
describe('разбор тел FS-роутов чтения содержимого (протокол 7)', () => {
  it('read-text: валидное тело — offset/limit/maxBytes принимаются', () => {
    const parsed = parseFsTextRequestBody({
      path: '/workspace/a.txt',
      cwd: '/workspace',
      offset: 2,
      limit: 10,
      maxBytes: 1024,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      path: '/workspace/a.txt',
      cwd: '/workspace',
      offset: 2,
      limit: 10,
      maxBytes: 1024,
    });
  });

  it('read-text: путь обязателен', () => {
    expect(parseFsTextRequestBody({ cwd: '/workspace' }).ok).toBe(false);
    expect(parseFsTextRequestBody({ path: '  ' }).ok).toBe(false);
  });

  it('read-text: отрицательный offset и нецелый limit — отказ', () => {
    expect(parseFsTextRequestBody({ path: '/a', offset: -1 }).ok).toBe(false);
    expect(parseFsTextRequestBody({ path: '/a', limit: 1.5 }).ok).toBe(false);
    expect(parseFsTextRequestBody({ path: '/a', limit: 0 }).ok).toBe(false);
    expect(parseFsTextRequestBody({ path: '/a', maxBytes: 0 }).ok).toBe(false);
  });

  it('sniff: необязательный maxBytes принимается, неверный — отказ', () => {
    const parsed = parseFsSniffRequestBody({ path: '/a.png', maxBytes: 4096 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.maxBytes).toBe(4096);
    expect(parseFsSniffRequestBody({ path: '/a.png', maxBytes: -1 }).ok).toBe(false);
  });

  it('read-bytes: maxBytes обязателен и положителен', () => {
    const parsed = parseFsBytesRequestBody({ path: '/a.bin', maxBytes: 1024 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.maxBytes).toBe(1024);
    expect(parseFsBytesRequestBody({ path: '/a.bin' }).ok).toBe(false);
    expect(parseFsBytesRequestBody({ path: '/a.bin', maxBytes: 0 }).ok).toBe(false);
  });
});

/**
 * Разбор тел FS-роутов правки (протокол 7, слайс 3b Ф2).
 *
 * `read-raw` — потолок размера обязателен (иначе файл любого размера уехал бы
 * в ответе целиком); `rename` — цель (`to`) обязательна и непуста.
 */
describe('разбор тел FS-роутов правки (протокол 7)', () => {
  it('read-raw: валидное тело — maxBytes принимается', () => {
    const parsed = parseFsRawTextRequestBody({ path: '/workspace/a.txt', maxBytes: 4096 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ path: '/workspace/a.txt', maxBytes: 4096 });
  });

  it('read-raw: maxBytes обязателен, положителен и не выше потолка тела', () => {
    expect(parseFsRawTextRequestBody({ path: '/a.txt' }).ok).toBe(false);
    expect(parseFsRawTextRequestBody({ path: '/a.txt', maxBytes: 0 }).ok).toBe(false);
    expect(parseFsRawTextRequestBody({ path: '/a.txt', maxBytes: 1.5 }).ok).toBe(false);
    expect(
      parseFsRawTextRequestBody({ path: '/a.txt', maxBytes: EXECUTOR_FS_MAX_READ_RAW_BYTES + 1 }).ok,
    ).toBe(false);
  });

  it('read-raw: путь обязателен', () => {
    expect(parseFsRawTextRequestBody({ maxBytes: 10 }).ok).toBe(false);
    expect(parseFsRawTextRequestBody({ path: '  ', maxBytes: 10 }).ok).toBe(false);
  });

  it('rename: валидное тело — источник и цель', () => {
    const parsed = parseFsRenameRequestBody({
      path: '/workspace/a.txt',
      to: '/workspace/b.txt',
      cwd: '/workspace',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      path: '/workspace/a.txt',
      to: '/workspace/b.txt',
      cwd: '/workspace',
    });
  });

  it('rename: цель обязательна и непуста', () => {
    expect(parseFsRenameRequestBody({ path: '/a.txt' }).ok).toBe(false);
    expect(parseFsRenameRequestBody({ path: '/a.txt', to: '  ' }).ok).toBe(false);
    expect(parseFsRenameRequestBody({ path: '/a.txt', to: 42 }).ok).toBe(false);
  });

  it('rename: путь-источник обязателен', () => {
    expect(parseFsRenameRequestBody({ to: '/b.txt' }).ok).toBe(false);
  });

  it('download: валидное тело — путь и потолок размера', () => {
    const parsed = parseFsDownloadRequestBody({ path: '/workspace/a.bin', maxBytes: 4096 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ path: '/workspace/a.bin', maxBytes: 4096 });
  });

  it('download: maxBytes обязателен и положителен', () => {
    expect(parseFsDownloadRequestBody({ path: '/a.bin' }).ok).toBe(false);
    expect(parseFsDownloadRequestBody({ path: '/a.bin', maxBytes: 0 }).ok).toBe(false);
    expect(parseFsDownloadRequestBody({ path: '/a.bin', maxBytes: 1.5 }).ok).toBe(false);
    expect(parseFsDownloadRequestBody({ path: '/a.bin', maxBytes: '10' }).ok).toBe(false);
  });

  it('download: путь обязателен', () => {
    expect(parseFsDownloadRequestBody({ maxBytes: 10 }).ok).toBe(false);
    expect(parseFsDownloadRequestBody({ path: '  ', maxBytes: 10 }).ok).toBe(false);
  });

  it('download: потолок выше лимита исполнителя не отвергается (обрезается на стороне исполнителя)', () => {
    const parsed = parseFsDownloadRequestBody({
      path: '/a.bin',
      maxBytes: EXECUTOR_FS_MAX_DOWNLOAD_BYTES + 1,
    });
    expect(parsed.ok).toBe(true);
  });
});

/**
 * Разбор query публикации байтов (`PUT /fs/upload`, протокол 7, PROP-135 Ф3).
 *
 * Параметры — в query (тело — сырые байты), значения — URL-encoded.
 */
describe('разбор query публикации байтов (протокол 7)', () => {
  it('валидные параметры — путь, cwd и режим публикации', () => {
    const parsed = parseFsUploadQuery(
      new URLSearchParams({ path: '/workspace/a.bin', cwd: '/workspace', ifExists: 'overwrite' }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      path: '/workspace/a.bin',
      cwd: '/workspace',
      ifExists: 'overwrite',
    });
  });

  it('без ifExists — режим по умолчанию fail (цель не перезаписывается)', () => {
    const parsed = parseFsUploadQuery(new URLSearchParams({ path: '/workspace/a.bin' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ifExists).toBe('fail');
    expect(parsed.value.cwd).toBeUndefined();
  });

  it('путь обязателен и без NUL', () => {
    expect(parseFsUploadQuery(new URLSearchParams({})).ok).toBe(false);
    expect(parseFsUploadQuery(new URLSearchParams({ path: '  ' })).ok).toBe(false);
    expect(parseFsUploadQuery(new URLSearchParams({ path: '/a\u0000b' })).ok).toBe(false);
  });

  it('cwd — необязателен, но непустой и без NUL', () => {
    expect(parseFsUploadQuery(new URLSearchParams({ path: '/a.bin', cwd: '  ' })).ok).toBe(false);
    expect(parseFsUploadQuery(new URLSearchParams({ path: '/a.bin', cwd: '/a\u0000b' })).ok).toBe(
      false,
    );
  });

  it('ifExists — только fail или overwrite', () => {
    expect(parseFsUploadQuery(new URLSearchParams({ path: '/a.bin', ifExists: 'fail' })).ok).toBe(true);
    expect(
      parseFsUploadQuery(new URLSearchParams({ path: '/a.bin', ifExists: 'overwrite' })).ok,
    ).toBe(true);
    expect(parseFsUploadQuery(new URLSearchParams({ path: '/a.bin', ifExists: 'maybe' })).ok).toBe(
      false,
    );
  });
});
