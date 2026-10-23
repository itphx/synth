/**
 * ADR-090 Ф1: формат файла точных исключений семвер-гейта
 * (`plugins.exactHostExceptions`).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readExactHostExceptions } from './exact-host-exceptions.js';

async function tmpFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-plugin-exceptions-'));
  const path = join(dir, 'exceptions.txt');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('readExactHostExceptions', () => {
  it('пустой путь — исключений нет', async () => {
    expect(await readExactHostExceptions('')).toEqual([]);
    expect(await readExactHostExceptions('   ')).toEqual([]);
  });

  it('читает версии по одной на строку, комментарии и пустые строки пропускает', async () => {
    const path = await tmpFile(
      ['# точные исключения', '', '0.11.0', '  0.11.1  ', '# комментарий', '0.12.0'].join('\n'),
    );
    expect(await readExactHostExceptions(path)).toEqual(['0.11.0', '0.11.1', '0.12.0']);
  });

  it('не-semver строка пропускается (fail-closed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const path = await tmpFile('0.11.0\nне-версия\n1.0\n');
    expect(await readExactHostExceptions(path)).toEqual(['0.11.0']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('дубли не повторяются', async () => {
    const path = await tmpFile('0.11.0\n0.11.0\n');
    expect(await readExactHostExceptions(path)).toEqual(['0.11.0']);
  });

  it('нечитаемый файл → пустой список + предупреждение (fail-closed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await readExactHostExceptions('/нет/такого/файла.txt')).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
