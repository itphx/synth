import { describe, it, expect } from 'vitest';
import { isModeApplicable } from './mode.js';

describe('isModeApplicable (AD-025)', () => {
  it('агент не найден (undefined/null) → режим применим', () => {
    expect(isModeApplicable(undefined)).toBe(true);
    expect(isModeApplicable(null)).toBe(true);
  });

  it('пустые capabilities → режим не применим (read-only)', () => {
    expect(isModeApplicable({ capabilities: [] })).toBe(false);
  });

  it('read-only агент (file_read/search/mcp без shell/file_write/web) → false', () => {
    expect(isModeApplicable({ capabilities: ['file_read', 'search', 'mcp'] })).toBe(false);
  });

  it('analyst (file_read/search/web/mcp) → true (есть web)', () => {
    expect(isModeApplicable({ capabilities: ['file_read', 'search', 'web', 'mcp'] })).toBe(true);
  });

  it('developer (shell/file_write) → true', () => {
    expect(isModeApplicable({ capabilities: ['file_read', 'file_write', 'search', 'shell', 'git_read', 'git_write', 'mcp'] })).toBe(true);
  });

  it('только shell → true', () => {
    expect(isModeApplicable({ capabilities: ['shell'] })).toBe(true);
  });

  it('только file_write → true', () => {
    expect(isModeApplicable({ capabilities: ['file_write'] })).toBe(true);
  });
});
