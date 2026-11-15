/**
 * PROP-132: снимки терминалов (`engine/terminal/snapshot.ts`).
 *
 * Проверяется: запись/чтение пары `meta.json` + `output.txt`, хвост вывода
 * (≤ 512 КиБ, обрезка по границе кода), удаление снимка, перечисление
 * идентификаторов и устойчивость к битому `meta.json`.
 *
 * Хранилище — файловый порт по конструкции (ADR-116), в тестах — его
 * реализация в памяти (`MemoryBlobStore`): контракт порта тот же.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import {
  deleteTerminalSnapshot,
  listTerminalSnapshotIds,
  readTerminalSnapshot,
  readTerminalSnapshotOutput,
  TERMINAL_SNAPSHOT_OUTPUT_BYTES,
  terminalSnapshotMetaPath,
  terminalSnapshotOutputPath,
  writeTerminalSnapshot,
} from './snapshot.js';
import type { TerminalRecord } from './types.js';

/** Запись реестра для снимка. */
function makeRecord(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id: 'term_1',
    projectId: 'proj-1',
    ownerId: 'user-1',
    cwd: '/work',
    shell: 'bash',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    target: 'inline',
    ...overrides,
  };
}

describe('Снимки терминалов', () => {
  let blobs: MemoryBlobStore;

  beforeEach(() => {
    blobs = new MemoryBlobStore();
  });

  it('пишет и читает пару meta.json + output.txt', async () => {
    const record = makeRecord();
    await writeTerminalSnapshot(blobs, record, 'строка вывода\n', 1_700_000_000_500);

    expect(await blobs.exists(terminalSnapshotMetaPath(record.id))).toBe(true);
    expect(await blobs.exists(terminalSnapshotOutputPath(record.id))).toBe(true);

    const meta = await readTerminalSnapshot(blobs, record.id);
    expect(meta).not.toBeNull();
    expect(meta?.savedAt).toBe(1_700_000_000_500);
    expect(meta?.record.id).toBe('term_1');
    expect(meta?.record.cwd).toBe('/work');
    expect(await readTerminalSnapshotOutput(blobs, record.id)).toBe('строка вывода\n');
  });

  it('хвост вывода ограничен 512 КиБ и режется по границе кода', async () => {
    const record = makeRecord({ id: 'term_big' });
    // Символ по 4 байта (эмодзи) — обрезка не должна рвать суррогатную пару.
    const emoji = '😀';
    const text = emoji.repeat(Math.ceil(TERMINAL_SNAPSHOT_OUTPUT_BYTES / 4) + 100);
    await writeTerminalSnapshot(blobs, record, text, 1_700_000_000_500);

    const output = await readTerminalSnapshotOutput(blobs, record.id);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(TERMINAL_SNAPSHOT_OUTPUT_BYTES);
    expect(output.length).toBeGreaterThan(0);
    // Последний символ — целая кодовая точка (нет «битого» суррогата).
    expect(output.endsWith(emoji)).toBe(true);
    expect(output.includes('�')).toBe(false);
  });

  it('удаление снимка убирает оба файла', async () => {
    const record = makeRecord();
    await writeTerminalSnapshot(blobs, record, 'вывод', 1);
    await deleteTerminalSnapshot(blobs, record.id);

    expect(await blobs.exists(terminalSnapshotMetaPath(record.id))).toBe(false);
    expect(await blobs.exists(terminalSnapshotOutputPath(record.id))).toBe(false);
    expect(await readTerminalSnapshot(blobs, record.id)).toBeNull();
  });

  it('перечисляет идентификаторы терминалов со снимками', async () => {
    await writeTerminalSnapshot(blobs, makeRecord({ id: 'term_a' }), 'a', 1);
    await writeTerminalSnapshot(blobs, makeRecord({ id: 'term_b' }), 'b', 1);

    const ids = await listTerminalSnapshotIds(blobs);
    expect(ids.sort()).toEqual(['term_a', 'term_b']);
  });

  it('битый meta.json читается как отсутствующий снимок', async () => {
    await blobs.write(terminalSnapshotMetaPath('term_bad'), '{не json');
    expect(await readTerminalSnapshot(blobs, 'term_bad')).toBeNull();
  });

  it('meta.json без обязательных полей — отсутствующий снимок', async () => {
    await blobs.write(terminalSnapshotMetaPath('term_partial'), JSON.stringify({ record: { id: '' } }));
    expect(await readTerminalSnapshot(blobs, 'term_partial')).toBeNull();
  });
});
