import { describe, it, expect } from 'vitest';
import { parseCommandFile } from './parser.js';

const DIR = '/tmp/commands';
const FILE = '/tmp/commands/my-cmd.md';

describe('parseCommandFile (ADR-046 §7.2)', () => {
  it('парсит frontmatter и тело', () => {
    const raw = [
      '---',
      'name: api-review',
      'description: Ревью API',
      'argument-hint: "[path]"',
      'agent: reviewer',
      'model: local.qwen',
      'allowed-tools: [read_file, grep_files]',
      '---',
      '# Заголовок',
      'Шаги.',
    ].join('\n');
    const { command, diagnostics } = parseCommandFile(raw, 'ignored.md', DIR, FILE, 'instance', 1);
    expect(diagnostics).toEqual([]);
    expect(command?.name).toBe('api-review');
    expect(command?.description).toBe('Ревью API');
    expect(command?.argumentHint).toBe('[path]');
    expect(command?.agent).toBe('reviewer');
    expect(command?.model).toBe('local.qwen');
    expect(command?.allowedTools).toEqual(['read_file', 'grep_files']);
    expect(command?.body).toBe('# Заголовок\nШаги.');
    expect(command?.origin).toBe('instance');
  });

  it('имя команды — из имени файла, если name не задан', () => {
    const raw = ['---', 'description: без имени', '---', 'тело'].join('\n');
    const { command } = parseCommandFile(raw, 'my-cmd.md', DIR, FILE, 'project', 1);
    expect(command?.name).toBe('my-cmd');
  });

  it('без frontmatter — ошибка, команды нет', () => {
    const { command, diagnostics } = parseCommandFile('просто текст', 'x.md', DIR, FILE, 'config', 1);
    expect(command).toBeUndefined();
    expect(diagnostics[0]?.code).toBe('invalid-frontmatter');
    expect(diagnostics[0]?.level).toBe('error');
  });

  it('описание необязательно', () => {
    const raw = ['---', 'name: bare', '---', 'тело'].join('\n');
    const { command } = parseCommandFile(raw, 'bare.md', DIR, FILE, 'instance', 1);
    expect(command?.description).toBe('');
  });
});
