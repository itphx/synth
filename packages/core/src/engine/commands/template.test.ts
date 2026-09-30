import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTemplate, looksBinary, resolveInDir, TEMPLATE_SHELL_MAX_BYTES } from './template.js';
import type { TemplateCommand } from './types.js';

let dir: string;

function cmd(body: string): TemplateCommand {
  return {
    name: 'test',
    description: '',
    body,
    file: join(dir, 'test.md'),
    dir,
    origin: 'instance',
    trusted: true,
    mtimeMs: 1,
  };
}

const OPTS = { maxArgumentsLength: 1000, maxRenderedBytes: 100_000 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'synth-cmd-template-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('renderTemplate (AD-046 §7.2)', () => {
  it('подставляет $ARGUMENTS и позиционные $1..$9', async () => {
    const res = await renderTemplate(cmd('ARGS=[$ARGUMENTS] F2=[$2]'), {
      ...OPTS, workingDir: dir, args: 'one two three',
    });
    expect(res.content).toBe('ARGS=[one two three] F2=[two]');
    expect(res.diagnostics).toEqual([]);
  });

  it('подставляет @file относительно workingDir', async () => {
    await writeFile(join(dir, 'notes.md'), 'СОДЕРЖИМОЕ', 'utf-8');
    const res = await renderTemplate(cmd('см. @notes.md'), { ...OPTS, workingDir: dir, args: '' });
    expect(res.content).toBe('см. СОДЕРЖИМОЕ');
    expect(res.files).toEqual(['notes.md']);
  });

  it('@../escape выходит за пределы — диагностика, без чтения', async () => {
    const res = await renderTemplate(cmd('@../secret.txt'), { ...OPTS, workingDir: dir, args: '' });
    expect(res.content).not.toContain('secret');
    expect(res.diagnostics.some((d) => d.message.includes('пределы'))).toBe(true);
  });

  it('бинарный файл не подставляется', async () => {
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0]));
    const res = await renderTemplate(cmd('@bin.dat'), { ...OPTS, workingDir: dir, args: '' });
    expect(res.diagnostics.some((d) => d.message.includes('бинарный'))).toBe(true);
  });

  it('ограничивает длину $ARGUMENTS', async () => {
    const res = await renderTemplate(cmd('$ARGUMENTS'), {
      ...OPTS, workingDir: dir, args: 'abcdefghij', maxArgumentsLength: 4,
    });
    expect(res.content).toBe('abcd');
  });

  it('обрезает результат по maxRenderedBytes', async () => {
    const res = await renderTemplate(cmd('x'.repeat(500)), {
      ...OPTS, workingDir: dir, args: '', maxRenderedBytes: 100,
    });
    expect(Buffer.byteLength(res.content, 'utf-8')).toBeLessThanOrEqual(100 + 64);
    expect(res.diagnostics.some((d) => d.message.includes('обрезан'))).toBe(true);
  });

  it('looksBinary/resolveInDir — базовые проверки', () => {
    expect(looksBinary(Buffer.from('text'))).toBe(false);
    expect(looksBinary(Buffer.from([65, 0, 66]))).toBe(true);
    expect(resolveInDir(dir, '../x')).toBeNull();
    expect(resolveInDir(dir, 'a/b.txt')).toContain('a');
  });

  it('создаёт подкаталог и читает вложенный файл', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'f.md'), 'V', 'utf-8');
    const res = await renderTemplate(cmd('@sub/f.md'), { ...OPTS, workingDir: dir, args: '' });
    expect(res.content).toBe('V');
  });
});

describe('renderTemplate — inline shell (AD-046 §7.4)', () => {
  it('выключено по умолчанию: литерал не тронут, раннер не вызван, диагностики нет', async () => {
    let called = false;
    const res = await renderTemplate(cmd('A !`echo hi` B'), {
      ...OPTS, workingDir: dir, args: '',
      runShell: async () => { called = true; return { output: 'X', isError: false }; },
    });
    expect(res.content).toBe('A !`echo hi` B');
    expect(called).toBe(false);
    expect(res.diagnostics).toEqual([]);
  });

  it('включено + раннер: подставляет вывод команды', async () => {
    const res = await renderTemplate(cmd('A !`echo hi` B'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
      runShell: async (c) => ({ output: `[${c}]`, isError: false }),
    });
    expect(res.content).toBe('A [echo hi] B');
    expect(res.diagnostics).toEqual([]);
  });

  it('пустой вывод → пустая строка', async () => {
    const res = await renderTemplate(cmd('X !`true` Y'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
      runShell: async () => ({ output: '', isError: false }),
    });
    expect(res.content).toBe('X  Y');
  });

  it('несколько вхождений заменяются все', async () => {
    const res = await renderTemplate(cmd('!`a` mid !`b`'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
      runShell: async (c) => ({ output: c.toUpperCase(), isError: false }),
    });
    expect(res.content).toBe('A mid B');
  });

  it('ошибка: вывод подставлен + warning-диагностика с текстом вывода', async () => {
    const res = await renderTemplate(cmd('!`false`'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
      runShell: async () => ({ output: 'boom', isError: true }),
    });
    expect(res.content).toBe('boom');
    expect(res.diagnostics.some((d) => d.code === 'read-error' && d.message.includes('boom'))).toBe(true);
  });

  it('исключение раннера → ошибка-диагностика, литерал заменён пустым', async () => {
    const res = await renderTemplate(cmd('!`x`'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
      runShell: async () => { throw new Error('nope'); },
    });
    expect(res.content).toBe('');
    expect(res.diagnostics.some((d) => d.code === 'read-error')).toBe(true);
  });

  it('вывод команды обрезается до TEMPLATE_SHELL_MAX_BYTES', async () => {
    const big = 'y'.repeat(TEMPLATE_SHELL_MAX_BYTES + 10);
    const res = await renderTemplate(cmd('!`big`'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
      runShell: async () => ({ output: big, isError: false }),
    });
    expect(Buffer.byteLength(res.content, 'utf-8')).toBeLessThanOrEqual(TEMPLATE_SHELL_MAX_BYTES);
    expect(res.diagnostics.some((d) => d.message.includes('truncated'))).toBe(true);
  });

  it('включено, но раннер не передан → warning, литерал сохранён', async () => {
    const res = await renderTemplate(cmd('!`whoami`'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
    });
    expect(res.content).toBe('!`whoami`');
    expect(res.diagnostics.some((d) => d.message.includes('unavailable'))).toBe(true);
  });

  it('токен не в начале и не после пробела — не команда', async () => {
    let called = false;
    const res = await renderTemplate(cmd('OUT=!`echo hi`'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
      runShell: async () => { called = true; return { output: 'X', isError: false }; },
    });
    expect(called).toBe(false);
    expect(res.content).toBe('OUT=!`echo hi`');
  });

  it('команда с переносом строки не исполняется (regex без \\n)', async () => {
    let called = false;
    const res = await renderTemplate(cmd('!`echo a\nb`'), {
      ...OPTS, workingDir: dir, args: '', inlineShell: true,
      runShell: async () => { called = true; return { output: 'X', isError: false }; },
    });
    expect(called).toBe(false);
    expect(res.content).toBe('!`echo a\nb`');
  });
});
