/**
 * ADR-046 §7.2 + PROP-126 §1: реестр встроенных `/`-команд.
 *
 * `/compact` — ручной запуск компактизации контекста (ADR-119).
 * `/review` — prompt-команда ревью изменений кода в git-репозитории.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_COMMAND_NAMES,
  BUILTIN_COMMANDS,
  isBuiltinCommand,
  renderHelp,
  renderReviewPrompt,
} from './builtin.js';

describe('Встроенные команды (ADR-046 §7.2, PROP-126 §1)', () => {
  it('/compact есть в реестре встроенных команд', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('compact');
    expect(isBuiltinCommand('compact')).toBe(true);
  });

  it('/compact — описание компактизации, доступна по умолчанию', () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.name === 'compact');
    expect(cmd).toBeDefined();
    expect(cmd?.kind).toBe('builtin');
    expect(cmd?.available).toBe(true);
    expect(cmd?.description).toBe('Сжать контекст (компактизация)');
  });

  it('имена встроенных команд уникальны, /summary и /compact на месте', () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('summary');
    expect(names).toContain('compact');
    // Набор имён и сводок — один источник истины.
    expect([...BUILTIN_COMMAND_NAMES].sort()).toEqual([...names].sort());
  });

  it('/help перечисляет /compact', () => {
    expect(renderHelp()).toContain('/compact');
  });

  it('/review есть в реестре встроенных команд', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('review');
    expect(isBuiltinCommand('review')).toBe(true);
  });

  it('/review — описание ревью изменений, доступна по умолчанию', () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.name === 'review');
    expect(cmd).toBeDefined();
    expect(cmd?.kind).toBe('builtin');
    expect(cmd?.available).toBe(true);
    expect(cmd?.description).toBe('Ревью изменений кода в git-репозитории');
  });

  it('/help перечисляет /review', () => {
    expect(renderHelp()).toContain('/review');
  });

  it('renderReviewPrompt: цель ревью из аргумента + ключевые секции', () => {
    const prompt = renderReviewPrompt('feature/my-branch');
    // Аргумент (commit/branch/PR) уходит в промпт как есть.
    expect(prompt).toContain('feature/my-branch');
    // Структура opencode review.txt, адаптированная под Synth.
    expect(prompt).toContain('## 1. Determine what to review');
    expect(prompt).toContain('## 2. Gathering Context');
    expect(prompt).toContain('## 3. What to Look For');
    expect(prompt).toContain('## 4. Before You Flag Something');
    expect(prompt).toContain('## 5. When the Review Is Not Possible');
    expect(prompt).toContain('## 6. Output');
    // «diff ≠ контекст», «only changed lines», «be certain».
    expect(prompt).toContain('Diffs alone are not enough');
    expect(prompt).toContain('Only review the changes');
    expect(prompt).toContain('Be certain');
    // Реальные тулы Synth — не выдуманные.
    expect(prompt).toContain('git_diff');
    expect(prompt).toContain('git_status');
    expect(prompt).toContain('git_show');
  });

  it('renderReviewPrompt без аргументов — дефолт «незакоммиченные изменения»', () => {
    const prompt = renderReviewPrompt('');
    expect(prompt).toContain('not provided');
    expect(prompt).toContain('uncommitted changes');
  });

  it('renderReviewPrompt: без git/workspace ревью недоступно — выдумывать нельзя', () => {
    const prompt = renderReviewPrompt('');
    expect(prompt).toContain('not available');
    expect(prompt).toContain('Never invent a diff');
    expect(prompt).toContain('is not a git repository');
  });
});
