/**
 * Юнит-тесты AuditLogger (ADR-036): append-only JSONL, одна строка = одна запись.
 * Запись не должна ронять запрос: при ошибке — warning и продолжение.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLogger, readAuditLog, type AuditEntry } from './audit-logger.js';

describe('AuditLogger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-audit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('append пишет JSON-строку в файл (создаёт директорию)', async () => {
    const logPath = join(dir, 'audit', 'llm-gateway.jsonl');
    const logger = new AuditLogger(logPath);
    const entry: AuditEntry = { ts: '2026-01-01T00:00:00Z', type: 'obfuscated', sessionId: 's1', userId: 'u1' };

    await logger.append(entry);

    const content = await readFile(logPath, 'utf8');
    expect(content.trim()).toBe(JSON.stringify(entry));
  });

  it('каждая запись на новой строке (append-only)', async () => {
    const logPath = join(dir, 'audit.jsonl');
    const logger = new AuditLogger(logPath);

    await logger.append({ ts: '1', type: 'obfuscated' });
    await logger.append({ ts: '2', type: 'blocked' });
    await logger.append({ ts: '3', type: 'rate_limited' });

    const content = await readFile(logPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string).ts).toBe('1');
    expect(JSON.parse(lines[2] as string).ts).toBe('3');
  });

  it('append не бросает при ошибке записи (директория заблокирована файлом)', async () => {
    // Создаём файл на месте будущей директории → mkdir внутри append упадёт,
    // но append должен проглотить ошибку и не бросить.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const logger = new AuditLogger(join(blocker, 'sub', 'audit.jsonl'));

    await expect(logger.append({ ts: '1', type: 'obfuscated' })).resolves.toBeUndefined();
  });

  it('readAuditLog читает записи и фильтрует по userId', async () => {
    const logPath = join(dir, 'audit.jsonl');
    const logger = new AuditLogger(logPath);

    await logger.append({ ts: '1', type: 'obfuscated', userId: 'u1', sessionId: 's1' });
    await logger.append({ ts: '2', type: 'blocked', userId: 'u2', sessionId: 's1' });
    await logger.append({ ts: '3', type: 'obfuscated', userId: 'u1', sessionId: 's2' });

    const all = await readAuditLog(logPath);
    expect(all.total).toBe(3);

    const u1 = await readAuditLog(logPath, { userId: 'u1' });
    expect(u1.total).toBe(2);
    expect(u1.entries.every((e) => e.userId === 'u1')).toBe(true);
  });

  it('readAuditLog пропускает повреждённые строки', async () => {
    const logPath = join(dir, 'audit.jsonl');
    const logger = new AuditLogger(logPath);
    await logger.append({ ts: '1', type: 'obfuscated', userId: 'u1' });
    await appendFile(logPath, 'not-json-garbage\n', 'utf8');
    await logger.append({ ts: '2', type: 'blocked', userId: 'u2' });

    const res = await readAuditLog(logPath);
    expect(res.total).toBe(2);
  });

  it('readAuditLog для несуществующего файла → пустой результат без ошибки', async () => {
    const res = await readAuditLog(join(dir, 'missing.jsonl'));
    expect(res.entries).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('readAuditLog поддерживает since/until и limit', async () => {
    const logPath = join(dir, 'audit.jsonl');
    const logger = new AuditLogger(logPath);
    await logger.append({ ts: '2026-01-01T00:00:00Z', type: 'obfuscated' });
    await logger.append({ ts: '2026-01-02T00:00:00Z', type: 'blocked' });
    await logger.append({ ts: '2026-01-03T00:00:00Z', type: 'rate_limited' });

    const since = await readAuditLog(logPath, { since: '2026-01-02T00:00:00Z' });
    expect(since.total).toBe(2);
    expect(since.entries[0]?.ts).toBe('2026-01-02T00:00:00Z');

    const limit = await readAuditLog(logPath, { limit: 1 });
    expect(limit.entries).toHaveLength(1);
    expect(limit.total).toBe(3);
  });
});
