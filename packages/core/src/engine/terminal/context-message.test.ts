/**
 * PROP-132: контекст терминала, приходящий с клиента вместе с вопросом
 * (`engine/terminal/context-message.ts`).
 *
 * Проверяется:
 *   • формат текста — тот же `[CONTENT …]` … `[CONTENT END]`, что у
 *     `terminal_read`, с атрибутами в открывающем маркере (только непустые);
 *   • metadata служебного сообщения (`background_run_result`/`terminal`) и
 *     служебность (`isServiceUserMessage`) — контекст не реплика человека;
 *   • разбор тела: валидный контекст, предел 32 КиБ, список статусов,
 *     целое неотрицательное `lines`, игнорирование лишних полей.
 */
import { describe, it, expect } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import {
  buildTerminalContextMessage,
  parseTerminalContext,
  MAX_TERMINAL_CONTEXT_BYTES,
  TERMINAL_CONTEXT_STATUSES,
} from './context-message.js';
import { isServiceUserMessage } from '../../sessions/user-messages.js';

describe('Контекст терминала — сборка сообщения', () => {
  it('текст — обрамление [CONTENT …] … [CONTENT END] с атрибутами', () => {
    const message = buildTerminalContextMessage({
      terminal_id: 'term_1',
      content: 'hello\nworld\n',
      cwd: '/tmp',
      shell: 'bash',
      status: 'running',
      lines: 2,
    });

    expect(message.content.startsWith('[CONTENT ')).toBe(true);
    expect(message.content.endsWith('[CONTENT END]')).toBe(true);
    // Атрибуты открывающего маркера — как у `terminal_read`.
    expect(message.content).toContain('terminal=term_1');
    expect(message.content).toContain('status=running');
    expect(message.content).toContain('cwd=/tmp');
    expect(message.content).toContain('shell=bash');
    expect(message.content).toContain('lines=2');
    expect(message.content).toContain('bytes=11');
    // Нормализация: хвостовые пустые строки срезаны, CRLF → LF.
    expect(message.content).toContain('\nhello\nworld\n[CONTENT END]');
    expect(message.content).not.toContain('\r');
  });

  it('пустые атрибуты в маркер не попадают', () => {
    const message = buildTerminalContextMessage({
      terminal_id: 'term_2',
      content: 'x',
    });

    const open = message.content.split('\n')[0]!;
    expect(open).toBe('[CONTENT terminal=term_2 bytes=1]');
    expect(open).not.toContain('status=');
    expect(open).not.toContain('cwd=');
    expect(open).not.toContain('shell=');
    expect(open).not.toContain('lines=');
  });

  it('metadata — служебное сообщение о фоновом результате терминала', () => {
    const message = buildTerminalContextMessage({
      terminal_id: 'term_3',
      content: 'out',
      cwd: '/work',
      shell: 'zsh',
      status: 'exited',
      lines: 7,
      truncated: true,
    });

    expect(message.role).toBe(MessageRole.USER);
    expect(message.author).toBe('Terminal');
    expect(message.metadata?.type).toBe('background_run_result');
    expect(message.metadata?.kind).toBe('terminal');
    expect(message.metadata?.state).toBe('completed');
    expect(message.metadata?.terminal_id).toBe('term_3');
    expect(message.metadata?.cwd).toBe('/work');
    expect(message.metadata?.shell).toBe('zsh');
    expect(message.metadata?.status).toBe('exited');
    expect(message.metadata?.lines).toBe(7);
    expect(message.metadata?.truncated).toBe(true);
    expect(message.metadata?.bytes).toBe(3);
    // Части — текстовая (как у `terminal_read`).
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]?.type).toBe('text');
  });

  it('контекст — служебное сообщение (не реплика человека)', () => {
    const message = buildTerminalContextMessage({
      terminal_id: 'term_4',
      content: 'out',
    });

    expect(isServiceUserMessage(message)).toBe(true);
  });

  it('id уникален, seq — 0 (порядковый номер проставит порт хранения)', () => {
    const first = buildTerminalContextMessage({ terminal_id: 'term_5', content: 'a' });
    const second = buildTerminalContextMessage({ terminal_id: 'term_5', content: 'a' });

    expect(first.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
    expect(first.seq).toBe(0);
  });
});

describe('Контекст терминала — разбор тела', () => {
  it('валидный контекст разбирается, лишние поля игнорируются', () => {
    const parsed = parseTerminalContext({
      terminal_id: ' term_9 ',
      content: 'вывод',
      cwd: '/tmp',
      shell: 'bash',
      status: 'running',
      lines: 3,
      truncated: false,
      unknown_field: 'ignored',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.terminal_id).toBe('term_9');
    expect(parsed.value.content).toBe('вывод');
    expect(parsed.value.cwd).toBe('/tmp');
    expect(parsed.value.shell).toBe('bash');
    expect(parsed.value.status).toBe('running');
    expect(parsed.value.lines).toBe(3);
    expect(parsed.value.truncated).toBe(false);
  });

  it('не-объект отклоняется', () => {
    expect(parseTerminalContext(null).ok).toBe(false);
    expect(parseTerminalContext('строка').ok).toBe(false);
    expect(parseTerminalContext([]).ok).toBe(false);
    expect(parseTerminalContext(42).ok).toBe(false);
  });

  it('пустой terminal_id отклоняется', () => {
    expect(parseTerminalContext({ terminal_id: '', content: 'x' }).ok).toBe(false);
    expect(parseTerminalContext({ terminal_id: '   ', content: 'x' }).ok).toBe(false);
    expect(parseTerminalContext({ content: 'x' }).ok).toBe(false);
  });

  it('content должен быть строкой', () => {
    expect(parseTerminalContext({ terminal_id: 'term_1', content: 5 }).ok).toBe(false);
    expect(parseTerminalContext({ terminal_id: 'term_1' }).ok).toBe(false);
  });

  it('content длиннее 32 КиБ отклоняется', () => {
    const limit = 'a'.repeat(MAX_TERMINAL_CONTEXT_BYTES);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: limit }).ok).toBe(true);

    const over = parseTerminalContext({
      terminal_id: 'term_1',
      content: `${limit}a`,
    });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.message).toContain(String(MAX_TERMINAL_CONTEXT_BYTES));
  });

  it('статус — только из списка', () => {
    for (const status of TERMINAL_CONTEXT_STATUSES) {
      expect(parseTerminalContext({ terminal_id: 'term_1', content: '', status }).ok).toBe(true);
    }
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', status: 'done' }).ok).toBe(false);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', status: 1 }).ok).toBe(false);
  });

  it('lines — целое неотрицательное', () => {
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', lines: 0 }).ok).toBe(true);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', lines: 12 }).ok).toBe(true);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', lines: -1 }).ok).toBe(false);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', lines: 1.5 }).ok).toBe(false);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', lines: '3' }).ok).toBe(false);
  });

  it('cwd/shell/truncated — проверяются по типу', () => {
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', cwd: 5 }).ok).toBe(false);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', shell: 5 }).ok).toBe(false);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', truncated: 'yes' }).ok).toBe(false);
    expect(parseTerminalContext({ terminal_id: 'term_1', content: '', truncated: true }).ok).toBe(true);
  });
});
