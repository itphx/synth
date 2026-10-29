/**
 * ADR-106 / ADR-114: компиляция правил в гранты с учётом периметра
 * (`workingDir` + `allowedRoots`) и тула `patch` (`edits[].file_path`).
 */
import { describe, expect, it } from 'vitest';

import type { PermissionConfig } from '@itphx/synth-shared';

import {
  compileAuthorityGrantsForTool,
  hasOutsidePath,
  resolveTargetKind,
} from './compile.js';

const WORKTREE = '/workspace/worktree';
const PROJECT = '/workspace/project';

const ALLOW_ALL: PermissionConfig = { rules: { '*': 'allow' }, askTimeoutMs: 30_000 };

describe('hasOutsidePath — периметр workingDir + allowedRoots', () => {
  it('путь в корне проекта при allowedRoots — не внешний', () => {
    expect(hasOutsidePath([`${PROJECT}/src/a.ts`], WORKTREE, [PROJECT])).toBe(false);
  });

  it('без allowedRoots тот же путь — внешний (прежнее поведение)', () => {
    expect(hasOutsidePath([`${PROJECT}/src/a.ts`], WORKTREE)).toBe(true);
  });

  it('путь вне обоих корней — внешний', () => {
    expect(hasOutsidePath(['/etc/passwd'], WORKTREE, [PROJECT])).toBe(true);
  });
});

describe('resolveTargetKind — patch и roots', () => {
  const base = {
    workingDir: WORKTREE,
    allowedRoots: [PROJECT],
    config: ALLOW_ALL,
    sessionMode: 'act' as const,
  };

  it('patch по первому edits[].file_path в корне проекта → path', () => {
    const kind = resolveTargetKind(
      {
        ...base,
        toolName: 'patch',
        params: { edits: [{ file_path: `${PROJECT}/src/a.ts`, old_string: 'a', new_string: 'b' }] },
      },
      'path',
    );
    expect(kind).toBe('path');
  });

  it('patch с путём вне периметра → outside', () => {
    const kind = resolveTargetKind(
      {
        ...base,
        toolName: 'patch',
        params: { edits: [{ file_path: '/etc/passwd', old_string: 'a', new_string: 'b' }] },
      },
      'path',
    );
    expect(kind).toBe('outside');
  });
});

describe('compileAuthorityGrantsForTool — roots и patch', () => {
  it('patch в корне проекта не уходит в ветку external_directory', () => {
    const grants = compileAuthorityGrantsForTool({
      toolName: 'patch',
      params: { edits: [{ file_path: `${PROJECT}/src/a.ts`, old_string: 'a', new_string: 'b' }] },
      workingDir: WORKTREE,
      allowedRoots: [PROJECT],
      config: ALLOW_ALL,
      sessionMode: 'act',
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.action).toBe('write');
    expect(grants[0]!.targetPattern).toBe('path:**');
    expect(grants[0]!.effect).toBe('allow');
  });

  it('patch вне периметра — дефолт external_directory (ask)', () => {
    const grants = compileAuthorityGrantsForTool({
      toolName: 'patch',
      params: { edits: [{ file_path: '/etc/passwd', old_string: 'a', new_string: 'b' }] },
      workingDir: WORKTREE,
      allowedRoots: [PROJECT],
      config: ALLOW_ALL,
      sessionMode: 'act',
    });
    expect(grants).toEqual([
      { action: 'write', targetPattern: 'outside:**', effect: 'ask' },
    ]);
  });

  it('относительный паттерн правила матчится от корня проекта', () => {
    const config: PermissionConfig = {
      rules: { '*': 'allow', edit: { 'src/*': 'deny' } },
      askTimeoutMs: 30_000,
    };
    const grants = compileAuthorityGrantsForTool({
      toolName: 'patch',
      params: { edits: [{ file_path: `${PROJECT}/src/a.ts`, old_string: 'a', new_string: 'b' }] },
      workingDir: WORKTREE,
      allowedRoots: [PROJECT],
      config,
      sessionMode: 'act',
    });
    expect(grants).toEqual([
      { action: 'write', targetPattern: 'path:src/*', effect: 'deny' },
    ]);
  });

  it('без allowedRoots паттерн от корня проекта не применяется', () => {
    const config: PermissionConfig = {
      rules: { '*': 'allow', edit: { 'src/*': 'deny' } },
      askTimeoutMs: 30_000,
    };
    const grants = compileAuthorityGrantsForTool({
      toolName: 'write_file',
      params: { file_path: `${PROJECT}/src/a.ts` },
      workingDir: WORKTREE,
      config,
      sessionMode: 'act',
    });
    // Путь внешний; правило группы не применяется к внешним путям — дефолт ask.
    expect(grants).toEqual([
      { action: 'write', targetPattern: 'outside:**', effect: 'ask' },
    ]);
  });
});
