import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepFilesTool } from './search.js';
import { globTool } from './fs-read.js';
import { t as sm } from '../system-messages.js';
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
    expect(miss.metadata?.i18n).toEqual({ key: 'search.no_matches' });
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
 * Кап длины строки совпадения: одна гигантская строка (минифицированный
 * source map) не должна съедать контекстное окно модели.
 *
 * Инцидент 2026-11-08: `grep_files` вернул 242 999 символов при 46 совпадениях,
 * из них 236 487 — одна строка `*.js.map` (файл целиком в одну строку).
 *
 * Фикстуры подстроены под правила исключений (P1): `*.map` по умолчанию не
 * попадает в вывод поиска, поэтому кап проверяется на явно запрошенном файле
 * (`path` — opt-in) и на минифицированном бандле `bundle.js`.
 */
describe('grep_files — кап длины строки совпадения', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-grep-long-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  /** Строка как в минифицированном source map: ~236 487 символов в одну строку. */
  function sourceMapLine(): string {
    return `{"version":3,"sources":["a.ts"],"mappings":"${'a'.repeat(236_450)} GATEWAY_DATA_DIR"}`;
  }

  it('строка длиннее капа обрезается, маркер — из i18n-словаря', async () => {
    await writeFile(join(tmpDir, 'bundle.js.map'), sourceMapLine());

    // Явный путь на файл: `*.map` исключён по умолчанию, но пользователь
    // запросил именно его — ищем (и кап строки тут же проверяется).
    const out = await grepFilesTool.execute(
      { pattern: 'GATEWAY_DATA_DIR', path: 'bundle.js.map' },
      makeCtx(),
    );
    expect(out.isError).toBeFalsy();

    const lines = String(out.content).split('\n');
    expect(lines[0]).toBe('bundle.js.map:');
    const matchLine = lines[1]!;
    expect(matchLine.startsWith('  Line 1: ')).toBe(true);
    const text = matchLine.slice(matchLine.indexOf(': ') + 2);

    // Маркер усечения строки — i18n-ключ (`search.line_truncated`), не литерал.
    const marker = sm('search.line_truncated');
    expect(marker).not.toBe('');
    expect(text.endsWith(marker)).toBe(true);

    // Обрезанная строка — не длиннее капа (2000 символов).
    const truncated = text.slice(0, text.length - marker.length);
    expect(truncated.length).toBeLessThanOrEqual(2_000);

    // Итоговый вывод — килобайты, а не сотни килобайт.
    expect(String(out.content).length).toBeLessThanOrEqual(2_500);

    // Число совпадений остаётся реальным (кап строки его не меняет).
    expect(out.metadata?.matches).toBe(1);
  });

  it('кап строки не меняет группировку и общее число совпадений', async () => {
    // Минифицированный бандл (файл целиком в одну строку) — тот же сценарий,
    // что и source map, но имя файла не попадает под исключения `*.map`.
    await writeFile(join(tmpDir, 'bundle.js'), sourceMapLine());
    await writeFile(join(tmpDir, 'a.ts'), 'const GATEWAY_DATA_DIR = "x";\n');
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'b.ts'), '// GATEWAY_DATA_DIR\n');

    const out = await grepFilesTool.execute({ pattern: 'GATEWAY_DATA_DIR' }, makeCtx());
    const lines = String(out.content).split('\n');

    // Три файла → три группы, каждая со своей строкой пути.
    expect(lines.filter((l) => l.endsWith(':'))).toHaveLength(3);
    expect(out.metadata?.matches).toBe(3);
    expect(String(out.content).length).toBeLessThanOrEqual(2_500);
  });

  it('обычная строка совпадения не обрезается', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'const GATEWAY_DATA_DIR = "x";\n');

    const out = await grepFilesTool.execute({ pattern: 'GATEWAY_DATA_DIR' }, makeCtx());

    expect(String(out.content)).toContain('const GATEWAY_DATA_DIR = "x";');
    expect(String(out.content)).not.toContain(sm('search.line_truncated'));
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

/**
 * Исключения по умолчанию: зависимости и артефакты сборки не попадают в вывод
 * поиска.
 *
 * Инцидент 2026-11-08: `grep_files` из корня workspace нашёл совпадение в
 * `node_modules/@itphx/synth-ui/dist/assets/*.js.map` (строка в 236 487
 * символов) и унёс в контекст модели 243 КБ. Кап строки (P0) ограничила одну
 * строку, но источник мусора остался — поэтому мусорные пути скрываются, а
 * модель получает маркер: сколько совпадений не показано и почему.
 *
 * Явный путь важнее исключения: поиск внутри `node_modules` по запросу
 * пользователя работает.
 */
describe('grep_files — исключения мусорных путей по умолчанию', () => {
  let tmpDir: string;

  /** Source map из инцидента: одна строка в ~236 487 символов. */
  const sourceMapLine = (): string =>
    `{"version":3,"sources":["a.ts"],"mappings":"${'a'.repeat(236_450)} GATEWAY_DATA_DIR"}`;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-grep-excl-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'const GATEWAY_DATA_DIR = "x";\n');
    // Зависимость с минифицированным source map (инцидент 2026-11-08).
    await mkdir(join(tmpDir, 'node_modules', '@itphx', 'synth-ui', 'dist', 'assets'), { recursive: true });
    await writeFile(
      join(tmpDir, 'node_modules', '@itphx', 'synth-ui', 'dist', 'assets', 'currency-D7Ta9S_Z.js.map'),
      sourceMapLine(),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  it('совпадение в node_modules скрыто: маркер исключений и счётчик в metadata', async () => {
    const out = await grepFilesTool.execute({ pattern: 'GATEWAY_DATA_DIR' }, makeCtx());

    expect(out.isError).toBeFalsy();
    // Обычное совпадение на месте, мусор — нет.
    expect(out.content).toContain('src/a.ts:');
    expect(out.content).not.toContain('currency-D7Ta9S_Z.js.map');
    // Гигантская строка не попала в вывод (вывод — килобайты).
    expect(String(out.content).length).toBeLessThanOrEqual(2_500);

    // Маркер исключений — из i18n-словаря (не литерал).
    const marker = sm('search.matches_excluded', { count: '1', categories: 'node_modules' });
    expect(out.content).toContain(marker);
    expect(out.metadata).toMatchObject({
      excludedMatches: 1,
      excludedCategories: ['node_modules'],
    });
    // Число показанных совпадений — реальное (без мусора).
    expect(out.metadata?.matches).toBe(1);
  });

  it('файлы-мусор по шаблону имени (*.map) тоже скрыты', async () => {
    await writeFile(join(tmpDir, 'src', 'app.js.map'), 'GATEWAY_DATA_DIR\n');

    const out = await grepFilesTool.execute({ pattern: 'GATEWAY_DATA_DIR' }, makeCtx());

    expect(out.content).not.toContain('app.js.map');
    expect(out.content).toContain(
      sm('search.matches_excluded', { count: '2', categories: '*.map, node_modules' }),
    );
    expect(out.metadata).toMatchObject({
      excludedMatches: 2,
      excludedCategories: ['*.map', 'node_modules'],
    });
    expect(out.metadata?.matches).toBe(1);
  });

  it('явный путь на исключённый файл: совпадение найдено (opt-in)', async () => {
    const out = await grepFilesTool.execute(
      {
        pattern: 'GATEWAY_DATA_DIR',
        path: 'node_modules/@itphx/synth-ui/dist/assets/currency-D7Ta9S_Z.js.map',
      },
      makeCtx(),
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('currency-D7Ta9S_Z.js.map:');
    expect(out.metadata?.matches).toBe(1);
    // Исключения не применялись — маркера и счётчика нет.
    expect(out.metadata?.excludedMatches).toBeUndefined();
    expect(out.metadata?.excludedNote).toBeUndefined();
  });

  it('явный путь на каталог внутри node_modules: поиск идёт по нему', async () => {
    const out = await grepFilesTool.execute(
      { pattern: 'GATEWAY_DATA_DIR', path: 'node_modules/@itphx/synth-ui' },
      makeCtx(),
    );

    expect(out.isError).toBeFalsy();
    // Внутри корня исключения не применяются — в том числе на каталог `dist`.
    expect(out.content).toContain('currency-D7Ta9S_Z.js.map:');
    expect(out.metadata?.matches).toBe(1);
    expect(out.metadata?.excludedMatches).toBeUndefined();
  });

  it('проект без мусорных каталогов: поведение не изменилось', async () => {
    await mkdir(join(tmpDir, 'clean'), { recursive: true });
    await writeFile(join(tmpDir, 'clean', 'a.ts'), 'const GATEWAY_DATA_DIR = "x";\n');

    const out = await grepFilesTool.execute({ pattern: 'GATEWAY_DATA_DIR', path: 'clean' }, makeCtx());

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('a.ts:');
    expect(out.metadata?.matches).toBe(1);
    // Ни маркера исключений, ни счётчика — вывод полный.
    expect(out.metadata?.excludedMatches).toBeUndefined();
    expect(out.metadata?.excludedNote).toBeUndefined();
    expect(out.content).not.toContain(
      sm('search.matches_excluded', { count: '1', categories: 'node_modules' }),
    );
  });

  it('все совпадения скрыты: виден маркер исключений, а не «no matches»', async () => {
    await rm(join(tmpDir, 'src', 'a.ts'));

    const out = await grepFilesTool.execute({ pattern: 'GATEWAY_DATA_DIR' }, makeCtx());

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('no matches found');
    expect(out.content).toContain(
      sm('search.matches_excluded', { count: '1', categories: 'node_modules' }),
    );
    expect(out.metadata?.matches).toBe(0);
    expect(out.metadata).toMatchObject({ excludedMatches: 1 });
  });

  it('маркер усечения и маркер исключений не конфликтуют: оба доезжают до модели', async () => {
    await rm(join(tmpDir, 'src', 'a.ts'));
    const lines = Array.from({ length: 10 }, (_, i) => `const GATEWAY_DATA_DIR = "${i}";`);
    await writeFile(join(tmpDir, 'src', 'many.ts'), lines.join('\n'));

    const out = await grepFilesTool.execute({ pattern: 'GATEWAY_DATA_DIR', limit: 4 }, makeCtx());

    const content = String(out.content);
    expect(content).toContain('showing 4 of 10 matches');
    expect(content).toContain(
      sm('search.matches_excluded', { count: '1', categories: 'node_modules' }),
    );
    expect(out.metadata).toMatchObject({
      matches: 10,
      truncated: true,
      excludedMatches: 1,
    });
  });
});
