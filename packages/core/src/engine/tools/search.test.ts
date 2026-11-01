import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepFilesTool } from './search.js';
import { globTool } from './fs-read.js';
import type { ToolContext } from '@itphx/synth-shared';
import type { ExecRequest, ExecResult } from '../../execution/ports/index.js';

/**
 * `grep_files` идёт через `rg` (порт исполнения, inline-фоллбэк) — тесты
 * проверяют фактические флаги рипгрепа: literal, регистр, hidden, лимит.
 */
describe('grep_files — параметры ripgrep', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-grep-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'a.txt'), 'alpha X.BETA\ngamma hello\n');
    await writeFile(join(tmpDir, 'src', 'b.txt'), 'HELLO world\n');
    await writeFile(join(tmpDir, '.hidden.txt'), 'hello secret\n');
    await mkdir(join(tmpDir, '.git'), { recursive: true });
    await writeFile(join(tmpDir, '.git', 'config'), 'hello git\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  it('regex по умолчанию: . — любой символ', async () => {
    const out = await grepFilesTool.execute({ pattern: 'X.BETA' }, makeCtx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('X.BETA');
  });

  it('literal=true: точка ищется как текст, а не как regex', async () => {
    // как текст «X.BETA» есть в файле
    const out = await grepFilesTool.execute({ pattern: 'X.BETA', literal: true }, makeCtx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('X.BETA');

    // а «X.BET.» как текст не встречается (regex бы совпал с «X.BETA»)
    const miss = await grepFilesTool.execute({ pattern: 'X.BET.', literal: true }, makeCtx());
    expect(miss.content).toContain('no matches found');
  });

  it('literal=false (regex): точка матчит любой символ', async () => {
    const out = await grepFilesTool.execute({ pattern: 'X.BET.', path: 'a.txt' }, makeCtx());
    expect(out.content).toContain('X.BETA');
  });

  it('регистр: по умолчанию чувствительный, caseSensitive=false — нет', async () => {
    const strict = await grepFilesTool.execute({ pattern: 'hello', path: 'src' }, makeCtx());
    expect(strict.content).toContain('no matches found');

    const loose = await grepFilesTool.execute({ pattern: 'hello', caseSensitive: false, path: 'src' }, makeCtx());
    expect(loose.isError).toBeFalsy();
    expect(loose.content).toContain('HELLO world');
  });

  it('hidden=true ищет в скрытых файлах, но не в .git', async () => {
    const without = await grepFilesTool.execute({ pattern: 'secret' }, makeCtx());
    expect(without.content).toContain('no matches found');

    const withHidden = await grepFilesTool.execute({ pattern: 'hello', hidden: true }, makeCtx());
    expect(withHidden.content).toContain('.hidden.txt');
    expect(withHidden.content).not.toContain('.git/config');
  });

  it('limit обрезает строки совпадений и добавляет маркер усечения', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `needle-${i}`);
    await writeFile(join(tmpDir, 'many.txt'), lines.join('\n'));

    const out = await grepFilesTool.execute({ pattern: 'needle', path: 'many.txt', limit: 4 }, makeCtx());
    const outLines = String(out.content).split('\n');

    // Группировка по файлу: строка пути + 4 строки совпадений + маркер
    expect(outLines).toHaveLength(6);
    expect(outLines[0]).toBe('many.txt:');
    expect(outLines[1]).toBe('  Line 1: needle-0');
    expect(outLines[4]).toBe('  Line 4: needle-3');
    expect(outLines[5]).toContain('showing 4 of 10 matches');
    expect(out.metadata).toMatchObject({ matches: 10, truncated: true });
  });

  it('укладывается в лимит — маркера нет', async () => {
    const out = await grepFilesTool.execute({ pattern: 'gamma' }, makeCtx());
    expect(String(out.content)).not.toContain('showing');
    expect(out.metadata).toMatchObject({ matches: 1 });
  });

  it('argv: один флаг --line-number, без дублирования -n и с requires: [rg]', async () => {
    const calls: ExecRequest[] = [];
    const port = {
      execute: async (req: ExecRequest): Promise<ExecResult> => {
        calls.push(req);
        return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
      },
    };

    await grepFilesTool.execute({ pattern: 'x', literal: true, caseSensitive: false }, makeCtx({ extra: { executionPort: port } }));

    expect(calls).toHaveLength(1);
    const cmd = calls[0]!.command as { kind: 'argv'; file: string; args: string[] };
    expect(cmd.file).toBe('rg');
    expect(cmd.args.filter((a) => a === '-n' || a === '--line-number')).toEqual(['--line-number']);
    expect(cmd.args).toContain('--fixed-strings');
    expect(cmd.args).toContain('-i');
    expect(calls[0]!.requires).toEqual(['rg']);
  });

  it('argv: --no-config — пользовательский RIPGREP_CONFIG_PATH не меняет поведение', async () => {
    const calls: ExecRequest[] = [];
    const port = {
      execute: async (req: ExecRequest): Promise<ExecResult> => {
        calls.push(req);
        return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
      },
    };

    await grepFilesTool.execute({ pattern: 'x' }, makeCtx({ extra: { executionPort: port } }));

    const cmd = calls[0]!.command as { kind: 'argv'; file: string; args: string[] };
    expect(cmd.args).toContain('--no-config');
  });
});

/**
 * Вывод `grep_files`: относительные пути и группировка по файлу (opencode).
 */
describe('grep_files — вывод: относительные пути и группировка', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-grep-out-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'a.txt'), 'alpha needle\ngamma needle\n');
    await writeFile(join(tmpDir, 'src', 'b.txt'), 'beta needle\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  it('пути печатаются относительно рабочего каталога, не абсолютными', async () => {
    const out = await grepFilesTool.execute({ pattern: 'needle' }, makeCtx());

    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain(tmpDir);
    expect(out.content).toContain('a.txt:');
    expect(out.content).toContain('src/b.txt:');
  });

  it('вывод сгруппирован по файлу: строка пути и строки совпадений', async () => {
    const out = await grepFilesTool.execute({ pattern: 'needle' }, makeCtx());
    const lines = String(out.content).split('\n');

    // Файлы отсортированы по имени (детерминированный порядок)
    expect(lines[0]).toBe('a.txt:');
    expect(lines[1]).toBe('  Line 1: alpha needle');
    expect(lines[2]).toBe('  Line 2: gamma needle');
    expect(lines[3]).toBe('src/b.txt:');
    expect(lines[4]).toBe('  Line 1: beta needle');
  });

  it('путь вне рабочего каталога печатается относительно каталога поиска', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'synth-grep-outside-'));
    try {
      await writeFile(join(outside, 'x.txt'), 'needle outside\n');

      const out = await grepFilesTool.execute({ pattern: 'needle', path: outside }, makeCtx());

      expect(out.isError).toBeFalsy();
      expect(out.content).toContain('x.txt:');
      expect(out.content).not.toContain(outside);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('цель-файл: путь известен, текст с двоеточием и цифрами не ломает разбор', async () => {
    await writeFile(join(tmpDir, 'time.txt'), 'error at 12:30:45\n');

    const out = await grepFilesTool.execute({ pattern: 'error', path: 'time.txt' }, makeCtx());
    const lines = String(out.content).split('\n');

    expect(lines[0]).toBe('time.txt:');
    expect(lines[1]).toBe('  Line 1: error at 12:30:45');
  });
});

/**
 * Различимые ошибки поиска: путь не найден / путь не каталог / невалидный
 * regex — вместо общего «(file search error)».
 */
describe('поиск — различимые ошибки', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-grep-err-'));
    await writeFile(join(tmpDir, 'a.txt'), 'alpha\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  it('grep_files: несуществующий путь → path_not_found', async () => {
    const out = await grepFilesTool.execute({ pattern: 'x', path: 'nope' }, makeCtx());

    expect(out.isError).toBe(true);
    expect(out.content).toContain('not found');
    expect(out.content).toContain('nope');
  });

  it('glob: несуществующий путь → path_not_found', async () => {
    const out = await globTool.execute({ pattern: '*', path: 'nope' }, makeCtx());

    expect(out.isError).toBe(true);
    expect(out.content).toContain('not found');
  });

  it('glob: путь-файл вместо каталога → path_not_directory', async () => {
    const out = await globTool.execute({ pattern: '*', path: 'a.txt' }, makeCtx());

    expect(out.isError).toBe(true);
    expect(out.content).toContain('not a directory');
  });

  it('grep_files: невалидный regex → invalid_regex с подсказкой', async () => {
    const out = await grepFilesTool.execute({ pattern: 'X(BETA' }, makeCtx());

    expect(out.isError).toBe(true);
    expect(out.content).toContain('Invalid regular expression');
    expect(out.content).toContain('regex parse error');
    // Подсказка: что делать модели дальше
    expect(out.content).toContain('pattern');
  });

  it('glob: argv содержит --no-config', async () => {
    const calls: ExecRequest[] = [];
    const port = {
      execute: async (req: ExecRequest): Promise<ExecResult> => {
        calls.push(req);
        return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
      },
    };

    await globTool.execute({ pattern: '*.ts' }, makeCtx({ extra: { executionPort: port } }));

    expect(calls).toHaveLength(1);
    const cmd = calls[0]!.command as { kind: 'argv'; file: string; args: string[] };
    expect(cmd.file).toBe('rg');
    expect(cmd.args).toContain('--no-config');
    expect(cmd.args).toContain('--files');
  });
});
