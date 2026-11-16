import { describe, it, expect } from 'vitest';
import { parseScriptFile } from './parser.js';

/**
 * ADR-126 §5: разбор декларации скрипта.
 *
 * Проверяется:
 *   • валидная декларация (обязательные и необязательные поля);
 *   • отсутствие frontmatter / невалидный YAML;
 *   • отсутствие `description`/`run`;
 *   • недопустимое имя;
 *   • `cwd` с выходом вверх (и абсолютный `cwd`);
 *   • небезопасное имя переменной окружения;
 *   • `timeout` вне диапазона;
 *   • толерантность к неизвестным ключам.
 */

const DIR = '/tmp/scripts';
const FILE = '/tmp/scripts/dev.md';

function parse(raw: string, fileName = 'dev.md') {
  return parseScriptFile(raw, fileName, DIR, FILE, 'project', 1000);
}

function frontmatter(lines: string[], body = 'Описание действия'): string {
  return ['---', ...lines, '---', '', body].join('\n');
}

describe('parseScriptFile — валидная декларация', () => {
  it('разбирает обязательные поля и значения по умолчанию', () => {
    const res = parse(frontmatter(['description: Поднять dev', 'run: ./scripts/dev.sh']));

    expect(res.diagnostics).toEqual([]);
    expect(res.script).toBeTruthy();
    expect(res.script!.name).toBe('dev');
    expect(res.script!.description).toBe('Поднять dev');
    expect(res.script!.run).toBe('./scripts/dev.sh');
    expect(res.script!.shell).toBe(false);
    expect(res.script!.args).toBe(false);
    expect(res.script!.body).toBe('Описание действия');
    expect(res.script!.file).toBe(FILE);
    expect(res.script!.dir).toBe(DIR);
    expect(res.script!.origin).toBe('project');
    expect(res.script!.mtimeMs).toBe(1000);
  });

  it('имя берётся из frontmatter, иначе — из имени файла', () => {
    const fromFm = parse(frontmatter(['name: dev-local', 'description: D', 'run: ./x.sh']));
    expect(fromFm.script!.name).toBe('dev-local');

    const fromFile = parse(frontmatter(['description: D', 'run: ./x.sh']), 'build-all.md');
    expect(fromFile.script!.name).toBe('build-all');
  });

  it('разбирает необязательные поля', () => {
    const res = parse(frontmatter([
      'description: D',
      'run: ./scripts/dev.sh --flag',
      'shell: true',
      'args: true',
      'timeout: 120000',
      'requires: [bash, git]',
      'env:',
      '  PORT: 3000',
      '  DEBUG: "1"',
      'ready: "готов на :5000"',
      'argument-hint: "[port]"',
    ]));

    expect(res.diagnostics).toEqual([]);
    const script = res.script!;
    expect(script.shell).toBe(true);
    expect(script.args).toBe(true);
    expect(script.timeout).toBe(120000);
    expect(script.requires).toEqual(['bash', 'git']);
    expect(script.env).toEqual({ PORT: '3000', DEBUG: '1' });
    expect(script.ready).toBe('готов на :5000');
    expect(script.argumentHint).toBe('[port]');
  });

  it('`background: false` в frontmatter игнорируется — скрипт валиден', () => {
    const res = parse(frontmatter([
      'description: D',
      'run: ./scripts/dev.sh',
      'background: false',
    ]));

    // Ключ больше не поддерживается — но декларация с ним остаётся валидной
    // (обратная совместимость объявлений): запуск всегда фоновый.
    expect(res.diagnostics).toEqual([]);
    expect(res.script).toBeTruthy();
    expect(res.script).not.toHaveProperty('background');
  });

  it('неизвестные ключи frontmatter не ломают discovery', () => {
    const res = parse(frontmatter([
      'description: D',
      'run: ./x.sh',
      'что-то-новое: значение',
      'metadata:',
      '  note: ок',
    ]));

    expect(res.diagnostics).toEqual([]);
    expect(res.script).toBeTruthy();
  });
});

describe('parseScriptFile — невалидные декларации', () => {
  it('без frontmatter — ошибка invalid-frontmatter, записи нет', () => {
    const res = parse('Просто текст без frontmatter');

    expect(res.script).toBeUndefined();
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-frontmatter' });
  });

  it('невалидный YAML — ошибка invalid-frontmatter, записи нет', () => {
    const res = parse(['---', 'description: [не закрытый', '---', 'тело'].join('\n'));

    expect(res.script).toBeUndefined();
    expect(res.diagnostics.some((d) => d.code === 'invalid-frontmatter')).toBe(true);
  });

  it('без description — ошибка, записи нет', () => {
    const res = parse(frontmatter(['run: ./x.sh']));

    expect(res.script).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-frontmatter' });
  });

  it('без run — ошибка invalid-run, записи нет', () => {
    const res = parse(frontmatter(['description: D']));

    expect(res.script).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-run' });
  });

  it('недопустимое имя — ошибка missing-name, записи нет', () => {
    const res = parse(frontmatter(['name: Dev_Local', 'description: D', 'run: ./x.sh']));

    expect(res.script).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({ level: 'error', code: 'missing-name' });
  });

  it('имя файла с недопустимыми символами — ошибка missing-name', () => {
    const res = parse(frontmatter(['description: D', 'run: ./x.sh']), 'Dev Local.md');

    expect(res.script).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({ level: 'error', code: 'missing-name' });
  });

  it('cwd с выходом вверх — ошибка invalid-run, записи нет', () => {
    const res = parse(frontmatter(['description: D', 'run: ./x.sh', 'cwd: ../outside']));

    expect(res.script).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-run' });
  });

  it('абсолютный cwd — ошибка invalid-run, записи нет', () => {
    const res = parse(frontmatter(['description: D', 'run: ./x.sh', 'cwd: /etc']));

    expect(res.script).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-run' });
  });

  it('небезопасное имя переменной окружения — ошибка invalid-run, записи нет', () => {
    const res = parse(frontmatter([
      'description: D',
      'run: ./x.sh',
      'env:',
      '  "BAD-NAME": "1"',
    ]));

    expect(res.script).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-run' });
  });

  it('timeout вне диапазона — ошибка invalid-run, записи нет', () => {
    const tooBig = parse(frontmatter(['description: D', 'run: ./x.sh', 'timeout: 600001']));
    expect(tooBig.script).toBeUndefined();
    expect(tooBig.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-run' });

    const negative = parse(frontmatter(['description: D', 'run: ./x.sh', 'timeout: -1']));
    expect(negative.script).toBeUndefined();
    expect(negative.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-run' });
  });
});
