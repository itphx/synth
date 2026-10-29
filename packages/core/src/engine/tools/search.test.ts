import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepFilesTool } from './search.js';
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

    expect(outLines).toHaveLength(5); // 4 совпадения + маркер
    expect(outLines[4]).toContain('showing 4 of 10 matches');
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
});
