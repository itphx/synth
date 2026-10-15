import { describe, it, expect } from 'vitest';
import { isModeApplicable } from './mode.js';

describe('isModeApplicable (ADR-025)', () => {
  it('агент не найден (undefined/null) → режим применим', () => {
    expect(isModeApplicable(undefined)).toBe(true);
    expect(isModeApplicable(null)).toBe(true);
  });

  it('пустые capabilities → режим не применим (read-only)', () => {
    expect(isModeApplicable({ capabilities: [] })).toBe(false);
  });

  it('read-only агент (file_read/search/mcp без shell/file_write) → false', () => {
    expect(isModeApplicable({ capabilities: ['file_read', 'search', 'mcp'] })).toBe(false);
  });

  it('read-only агент с web (analyst: file_read/search/web/mcp) → false (web не мутирует)', () => {
    expect(isModeApplicable({ capabilities: ['file_read', 'search', 'web', 'mcp'] })).toBe(false);
  });

  it('read-only агент с git_read и web → false', () => {
    expect(isModeApplicable({ capabilities: ['file_read', 'search', 'web', 'git_read', 'mcp'] })).toBe(false);
  });

  it('developer (shell/file_write) → true', () => {
    expect(isModeApplicable({ capabilities: ['file_read', 'file_write', 'search', 'shell', 'git_read', 'git_write', 'mcp'] })).toBe(true);
  });

  it('полный набор (shell/file_write/web/git/task/mcp/runtime) → true', () => {
    expect(isModeApplicable({ capabilities: ['file_read', 'file_write', 'search', 'shell', 'web', 'git_read', 'git_write', 'task', 'mcp', 'runtime'] })).toBe(true);
  });

  it('только shell → true', () => {
    expect(isModeApplicable({ capabilities: ['shell'] })).toBe(true);
  });

  it('только file_write → true', () => {
    expect(isModeApplicable({ capabilities: ['file_write'] })).toBe(true);
  });
});
