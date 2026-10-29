/**
 * ADR-106 / ADR-114: периметр цели Authority-слоя.
 *
 * Проверяется, что файл в корне проекта (`allowedRoots`) — это цель `path` с
 * относительной ссылкой от **того** корня, в котором он лежит, а не `outside`.
 * Без `allowedRoots` поведение прежнее: путь вне рабочего каталога — `outside`.
 */
import { describe, expect, it } from 'vitest';

import {
  deriveAuthorityTarget,
  resolveAuthorityPathTarget,
} from './target.js';

const WORKTREE = '/workspace/worktree';
const PROJECT = '/workspace/project';

describe('resolveAuthorityPathTarget — периметр workingDir + allowedRoots', () => {
  it('путь внутри рабочего каталога → path, ref от workingDir', () => {
    const resolved = resolveAuthorityPathTarget(
      'write_file',
      { file_path: 'src/a.ts' },
      WORKTREE,
    );
    expect(resolved).toEqual({
      kind: 'path',
      ref: 'src/a.ts',
      absolute: `${WORKTREE}/src/a.ts`,
    });
  });

  it('путь в корне проекта при allowedRoots → path, ref от корня проекта', () => {
    const resolved = resolveAuthorityPathTarget(
      'write_file',
      { file_path: `${PROJECT}/src/a.ts` },
      WORKTREE,
      [PROJECT],
    );
    expect(resolved?.kind).toBe('path');
    expect(resolved?.ref).toBe('src/a.ts');
    expect(resolved?.absolute).toBe(`${PROJECT}/src/a.ts`);
  });

  it('тот же путь без allowedRoots → outside (прежнее поведение)', () => {
    const resolved = resolveAuthorityPathTarget(
      'write_file',
      { file_path: `${PROJECT}/src/a.ts` },
      WORKTREE,
    );
    expect(resolved?.kind).toBe('outside');
    // Сырой абсолютный путь в ссылку цели не попадает (инвариант 25).
    expect(resolved?.ref).not.toContain('/workspace');
  });

  it('сам корень проекта → path с ref "."', () => {
    const resolved = resolveAuthorityPathTarget(
      'read_file',
      { file_path: PROJECT },
      WORKTREE,
      [PROJECT],
    );
    expect(resolved).toEqual({ kind: 'path', ref: '.', absolute: PROJECT });
  });

  it('patch: цель по первому edits[].file_path (корень проекта)', () => {
    const resolved = resolveAuthorityPathTarget(
      'patch',
      {
        edits: [
          { file_path: `${PROJECT}/src/a.ts`, old_string: 'a', new_string: 'b' },
          { file_path: 'src/b.ts', old_string: 'c', new_string: 'd' },
        ],
      },
      WORKTREE,
      [PROJECT],
    );
    expect(resolved?.kind).toBe('path');
    expect(resolved?.ref).toBe('src/a.ts');
  });

  it('patch: путь вне периметра → outside', () => {
    const resolved = resolveAuthorityPathTarget(
      'patch',
      { edits: [{ file_path: '/etc/passwd', old_string: 'a', new_string: 'b' }] },
      WORKTREE,
      [PROJECT],
    );
    expect(resolved?.kind).toBe('outside');
  });

  it('patch без edits → цели нет', () => {
    expect(resolveAuthorityPathTarget('patch', {}, WORKTREE, [PROJECT])).toBeUndefined();
    expect(resolveAuthorityPathTarget('patch', { edits: [] }, WORKTREE, [PROJECT])).toBeUndefined();
  });
});

describe('deriveAuthorityTarget — рабочая область по периметру', () => {
  it('cwd в корне проекта при allowedRoots → workspace с относительным ref', () => {
    const derived = deriveAuthorityTarget({
      toolName: 'execute_shell',
      params: { cwd: `${PROJECT}/src` },
      workingDir: WORKTREE,
      allowedRoots: [PROJECT],
      sessionId: 's1',
    });
    expect(derived.target).toEqual({ kind: 'workspace', ref: 'src' });
    // Абсолютный путь остаётся только для сопоставления с грантом.
    expect(derived.altRefs).toEqual([`${PROJECT}/src`]);
  });

  it('cwd вне периметра → workspace "." (прежнее поведение)', () => {
    const derived = deriveAuthorityTarget({
      toolName: 'execute_shell',
      params: { cwd: '/tmp/elsewhere' },
      workingDir: WORKTREE,
      allowedRoots: [PROJECT],
      sessionId: 's1',
    });
    expect(derived.target).toEqual({ kind: 'workspace', ref: '.' });
  });

  it('patch: цель path от корня проекта', () => {
    const derived = deriveAuthorityTarget({
      toolName: 'patch',
      params: { edits: [{ file_path: `${PROJECT}/src/a.ts`, old_string: 'a', new_string: 'b' }] },
      workingDir: WORKTREE,
      allowedRoots: [PROJECT],
      sessionId: 's1',
    });
    expect(derived.target).toEqual({ kind: 'path', ref: 'src/a.ts' });
  });
});
