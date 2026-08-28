/**
 * Тесты SystemMessages — словарь системных сообщений ядра (i18n ядра):
 * интерполяция {param}, fallback на ключ для неизвестного ключа,
 * согласованность i18n()-метаданных.
 */
import { describe, it, expect } from 'vitest';
import { ENGINE_MESSAGE_KEYS, ENGINE_MESSAGE_PARAMS, extractParams } from '@itphx/synth-shared/i18n';
import { SYSTEM_MESSAGES, t, i18n, hasSystemMessage, type SystemMessageKey } from './system-messages.js';

describe('SystemMessages', () => {
  it('t() возвращает en-текст по известному ключу', () => {
    expect(t('session.default_title')).toBe('New session');
    expect(t('tool.aborted')).toBe('Execution interrupted by the user.');
  });

  it('t() интерполирует {param}-плейсхолдеры', () => {
    expect(t('fs.file_written', { path: 'src/a.ts', lines: '10', bytes: '512' })).toBe(
      'File written: src/a.ts (10 lines, 512 bytes)',
    );
    expect(t('session.stopped', { reason: 'denied by the user' })).toBe(
      'Processing stopped: denied by the user',
    );
    expect(t('tool.doom_loop', { tool: 'execute_shell', count: '3' })).toBe(
      'Error: tool "execute_shell" called 3 time(s) with the same arguments. Loop broken.',
    );
  });

  it('t() без params оставляет шаблон как есть (плейсхолдеры не ломаются)', () => {
    const template = SYSTEM_MESSAGES['router.provider_not_found'];
    expect(t('router.provider_not_found')).toBe(template);
    expect(template).toContain('{provider}');
  });

  it('t() для неизвестного ключа возвращает сам ключ (fallback, никогда не undefined)', () => {
    const unknown = 'totally.unknown.key' as SystemMessageKey;
    expect(t(unknown)).toBe('totally.unknown.key');
  });

  it('t() с лишними params не портит шаблон, неизвестные плейсхолдеры остаются', () => {
    expect(t('tool.not_found', { tool: 'x', extra: 'y' })).toBe('Tool "x" not found');
    // параметр, которого нет в шаблоне, просто игнорируется
    expect(t('todo.list_empty', { foo: '1' })).toBe('Todo list is empty');
  });

  it('интерполяция безопасна для $-символов в значениях', () => {
    expect(t('fs.dir_created', { path: '$HOME/a$b' })).toBe('Directory created: $HOME/a$b');
  });

  it('i18n() возвращает metadata.i18n с ключом и params', () => {
    expect(i18n('tool.not_found', { tool: 'grep_files' })).toEqual({
      key: 'tool.not_found',
      params: { tool: 'grep_files' },
    });
    expect(i18n('session.max_iterations')).toEqual({ key: 'session.max_iterations' });
  });

  it('i18n() допускает динамические ключи (security.{messageId})', () => {
    expect(i18n('security.deny_command', { command: 'rm -rf /' })).toEqual({
      key: 'security.deny_command',
      params: { command: 'rm -rf /' },
    });
  });

  it('hasSystemMessage различает известные и неизвестные ключи', () => {
    expect(hasSystemMessage('session.stopped')).toBe(true);
    expect(hasSystemMessage('session.unknown_key_xyz')).toBe(false);
  });

  it('словарь непуст и не содержит русских текстов (LLM-канал — en)', () => {
    const keys = Object.keys(SYSTEM_MESSAGES);
    expect(keys.length).toBeGreaterThan(100);
    const cyrillic = /[\u0400-\u04FF]/;
    for (const [key, text] of Object.entries(SYSTEM_MESSAGES)) {
      expect(cyrillic.test(text), `ключ ${key} содержит кириллицу`).toBe(false);
    }
  });

  it('плейсхолдеры в шаблонах используют формат {param}', () => {
    for (const [key, text] of Object.entries(SYSTEM_MESSAGES)) {
      const legacy = text.match(/\{\{(\w+)\}\}/);
      expect(legacy, `ключ ${key} использует устаревший {{param}}`).toBeNull();
    }
  });

  it('набор ключей SYSTEM_MESSAGES set-равен контракту ENGINE_MESSAGE_KEYS', () => {
    const keys = Object.keys(SYSTEM_MESSAGES).slice().sort();
    const contract = [...ENGINE_MESSAGE_KEYS].sort();
    expect(keys).toEqual(contract);
    expect(keys.length).toBe(ENGINE_MESSAGE_KEYS.length);
  });

  it('для каждого ключа extractParams(SYSTEM_MESSAGES[key]) совпадает с ENGINE_MESSAGE_PARAMS[key]', () => {
    for (const key of Object.keys(SYSTEM_MESSAGES) as SystemMessageKey[]) {
      const actual = extractParams(SYSTEM_MESSAGES[key]).slice().sort();
      const expected = [...ENGINE_MESSAGE_PARAMS[key]].sort();
      expect(actual, `параметры ключа ${key} не совпадают с контрактом`).toEqual(expected);
    }
  });
});
