/**
 * Юнит-тесты writePayloadLog/readPayloadLog: append-only JSONL полного лога
 * запросов/ответов LLM. Запись не должна ронять запрос.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writePayloadLog,
  readPayloadLog,
  type LlmPayloadEntry,
} from './payload-logger.js';

function makeEntry(ts: string, sessionId: string): LlmPayloadEntry {
  return {
    ts,
    sessionId,
    userId: 'u1',
    provider: 'itphx',
    model: 'local.qwen3:14b',
    request: {
      messages: [{
        id: 'm1',
        role: 'user',
        content: 'привет',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: 'b1',
      }],
      systemPrompt: 'ты помощник',
    },
    response: { content: 'здравствуйте', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
  };
}

describe('payload-logger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-payload-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('append пишет JSON-строку в файл (создаёт директорию)', async () => {
    const logPath = join(dir, 'audit', 'llm-payloads.jsonl');
    const append = (entry: LlmPayloadEntry) => writePayloadLog(logPath, entry);
    const entry = makeEntry('2026-01-01T00:00:00Z', 's1');

    await append(entry);

    const content = await readFile(logPath, 'utf8');
    expect(content.trim()).toBe(JSON.stringify(entry));
  });

  it('каждая запись на новой строке (append-only)', async () => {
    const logPath = join(dir, 'payloads.jsonl');
    const append = (entry: LlmPayloadEntry) => writePayloadLog(logPath, entry);

    await append(makeEntry('1', 's1'));
    await append(makeEntry('2', 's2'));
    await append(makeEntry('3', 's1'));

    const content = await readFile(logPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string).ts).toBe('1');
    expect(JSON.parse(lines[2] as string).ts).toBe('3');
  });

  it('writePayloadLog не бросает при ошибке записи (директория заблокирована файлом)', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    await expect(writePayloadLog(join(blocker, 'sub', 'payloads.jsonl'), makeEntry('1', 's1')))
      .resolves.toBeUndefined();
  });

  it('readPayloadLog читает записи и фильтрует по sessionId', async () => {
    const logPath = join(dir, 'payloads.jsonl');
    const append = (entry: LlmPayloadEntry) => writePayloadLog(logPath, entry);

    await append(makeEntry('1', 's1'));
    await append(makeEntry('2', 's2'));
    await append(makeEntry('3', 's1'));

    const all = await readPayloadLog(logPath);
    expect(all.total).toBe(3);
    expect(all.entries).toHaveLength(3);

    const s1 = await readPayloadLog(logPath, { sessionId: 's1' });
    expect(s1.total).toBe(2);
    expect(s1.entries.every((e) => e.sessionId === 's1')).toBe(true);
  });

  it('readPayloadLog поддерживает limit (последние N записей, total до лимита)', async () => {
    const logPath = join(dir, 'payloads.jsonl');
    const append = (entry: LlmPayloadEntry) => writePayloadLog(logPath, entry);

    await append(makeEntry('1', 's1'));
    await append(makeEntry('2', 's2'));
    await append(makeEntry('3', 's3'));

    const res = await readPayloadLog(logPath, { limit: 2 });
    expect(res.total).toBe(3);
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]?.ts).toBe('2');
    expect(res.entries[1]?.ts).toBe('3');
  });

  it('readPayloadLog пропускает повреждённые строки', async () => {
    const logPath = join(dir, 'payloads.jsonl');
    const append = (entry: LlmPayloadEntry) => writePayloadLog(logPath, entry);
    await append(makeEntry('1', 's1'));
    await appendFile(logPath, 'not-json-garbage\n', 'utf8');
    await append(makeEntry('2', 's2'));

    const res = await readPayloadLog(logPath);
    expect(res.total).toBe(2);
  });

  it('readPayloadLog для несуществующего файла → пустой результат без ошибки', async () => {
    const res = await readPayloadLog(join(dir, 'missing.jsonl'));
    expect(res.entries).toEqual([]);
    expect(res.total).toBe(0);
  });
});
