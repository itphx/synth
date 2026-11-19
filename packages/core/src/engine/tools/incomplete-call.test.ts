/**
 * ADR-041 × opencode `tool.input-incomplete`: обрезанный лимитом вывода
 * tool-call.
 *
 * Контракт помощника: «аргументы оборваны» ставится только при **обоих**
 * признаках — `finish_reason` лимита вывода И невалидный JSON аргументов.
 * Полный вызов, пришедший с тем же `finish_reason`, не затронут: модель может
 * дописать вызов и упереться в лимит уже на тексте.
 */
import { describe, it, expect } from 'vitest';
import { ENGINE_MESSAGE_PARAMS } from '@itphx/synth-shared/i18n';
import { inputIncompleteResult, isIncompleteArguments, isIncompleteToolCall } from './incomplete-call.js';

describe('isIncompleteArguments', () => {
  it('полный JSON — не обрезан', () => {
    expect(isIncompleteArguments('{}')).toBe(false);
    expect(isIncompleteArguments('{"path":"a.txt","limit":10}')).toBe(false);
    expect(isIncompleteArguments('[1,2,3]')).toBe(false);
  });

  it('оборванный payload — обрезан', () => {
    expect(isIncompleteArguments('{"path": "a.txt')).toBe(true);
    expect(isIncompleteArguments('{"path":"a.txt","content":"начало текс')).toBe(true);
    // Оборван на самом начале: пустая строка — тоже недописанный payload
    // (`finish_reason` лимита), а полный вызов без аргументов несёт `{}`.
    expect(isIncompleteArguments('')).toBe(true);
    expect(isIncompleteArguments('not json at all')).toBe(true);
  });
});

describe('isIncompleteToolCall — оба признака обрезки', () => {
  it('лимит вывода + битый JSON → вызов считается обрезанным', () => {
    expect(isIncompleteToolCall('length', '{"path": "a.txt')).toBe(true);
    expect(isIncompleteToolCall('max_tokens', '{"path": "a.txt')).toBe(true);
    expect(isIncompleteToolCall('length', '')).toBe(true);
  });

  it('полный tool-call при лимите вывода не затронут', () => {
    expect(isIncompleteToolCall('length', '{"path":"a.txt"}')).toBe(false);
    expect(isIncompleteToolCall('length', '{}')).toBe(false);
  });

  it('битый JSON без лимита вывода — не наш класс (поведение прежнее)', () => {
    expect(isIncompleteToolCall('end_turn', '{"path": "a.txt')).toBe(false);
    expect(isIncompleteToolCall('tool_use', '{"path": "a.txt')).toBe(false);
    expect(isIncompleteToolCall(undefined, '{"path": "a.txt')).toBe(false);
    expect(isIncompleteToolCall('stop', '{"path": "a.txt')).toBe(false);
  });

  it('нестроковые аргументы не анализируются', () => {
    expect(isIncompleteToolCall('length', { path: 'a.txt' })).toBe(false);
    expect(isIncompleteToolCall('length', undefined)).toBe(false);
    expect(isIncompleteToolCall('length', null)).toBe(false);
  });
});

describe('inputIncompleteResult — контракт tool.input_incomplete', () => {
  it('текст говорит про лимит вывода и подсказывает разбить payload', () => {
    const result = inputIncompleteResult('write_file');

    expect(result.isError).toBe(true);
    expect(result.content).toContain('write_file');
    expect(result.content).toContain('output token limit');
    expect(result.content).toContain('split it into smaller calls');
    // Причина — лимит вывода, а не «некорректный вызов»: иначе модель
    // повторяет тот же вызов и снова упирается в лимит.
    expect(result.content).not.toContain('malformed');
    expect(result.content).not.toContain('argument error');
  });

  it('metadata.i18n несёт ключ и параметры для UI-локализации', () => {
    const result = inputIncompleteResult('patch');
    const i18n = result.metadata?.i18n as { key: string; params: Record<string, unknown> };

    expect(i18n.key).toBe('tool.input_incomplete');
    expect(i18n.params).toMatchObject({ tool: 'patch' });
    for (const name of ENGINE_MESSAGE_PARAMS['tool.input_incomplete']) {
      expect(i18n.params, `параметр ${name} отсутствует в metadata.i18n`).toHaveProperty([name]);
    }
    // Машиночитаемый маркер для аналитики/UI (по аналогии с прочими классами).
    expect(result.metadata?.input_incomplete).toBe(true);
    expect(result.metadata?.isError).toBe(true);
  });
});
