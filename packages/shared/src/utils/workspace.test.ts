import { describe, it, expect } from 'vitest';
import { slugifyWorkspaceName, uniqueWorkspaceName, MAX_WORKSPACE_SLUG_LENGTH } from './workspace.js';

describe('slugifyWorkspaceName (AD-075)', () => {
  it('приводит имя к безопасному слагу', () => {
    expect(slugifyWorkspaceName('My Cool Project!')).toBe('my-cool-project');
  });

  it('не-латиница и пустая строка → fallback project', () => {
    expect(slugifyWorkspaceName('Кириллица')).toBe('project');
    expect(slugifyWorkspaceName('')).toBe('project');
    expect(slugifyWorkspaceName('   ')).toBe('project');
  });

  it('спецсимволы схлопываются в одиночный дефис', () => {
    expect(slugifyWorkspaceName('a  /  b___c')).toBe('a-b-c');
    expect(slugifyWorkspaceName('___')).toBe('project');
  });

  it('обрезает до MAX_WORKSPACE_SLUG_LENGTH без хвостового дефиса', () => {
    const long = 'a'.repeat(MAX_WORKSPACE_SLUG_LENGTH + 10);
    expect(slugifyWorkspaceName(long)).toBe('a'.repeat(MAX_WORKSPACE_SLUG_LENGTH));

    const longDashed = `${'a'.repeat(MAX_WORKSPACE_SLUG_LENGTH - 1)}-bcd`;
    const result = slugifyWorkspaceName(longDashed);
    expect(result.length).toBeLessThanOrEqual(MAX_WORKSPACE_SLUG_LENGTH);
    expect(result.endsWith('-')).toBe(false);
  });
});

describe('uniqueWorkspaceName (AD-075)', () => {
  it('свободное имя возвращается как есть', () => {
    expect(uniqueWorkspaceName('proj', [])).toBe('proj');
    expect(uniqueWorkspaceName('proj', ['other'])).toBe('proj');
  });

  it('при коллизии добавляет суффикс -2/-3', () => {
    expect(uniqueWorkspaceName('proj', ['proj'])).toBe('proj-2');
    expect(uniqueWorkspaceName('proj', ['proj', 'proj-2'])).toBe('proj-3');
    expect(uniqueWorkspaceName('proj', ['proj', 'proj-2', 'proj-3'])).toBe('proj-4');
  });

  it('пустая база → project', () => {
    expect(uniqueWorkspaceName('', [])).toBe('project');
    expect(uniqueWorkspaceName('', ['project'])).toBe('project-2');
  });
});
