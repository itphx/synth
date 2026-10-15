import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { readFileTool, listDirectoryTool } from './fs-read.js';
import { writeFileTool, editFileTool, createDirectoryTool, deleteFileTool } from './fs-write.js';
import { grepFilesTool } from './search.js';
import { executeShellTool } from './shell.js';
import { gitStatusTool, resolveRepoCwd } from './git.js';
import { PermissionEvaluator } from '../permission/evaluator.js';

/**
 * Класс «побег за пределы workspace через симлинк»: файловые тулы, shell-cwd,
 * git repo_path и permission-слой не должны следовать за симлинком наружу.
 * Легитимные симлинки внутрь workspace продолжают работать.
 */
describe('containment файловых тулов с симлинками', () => {
  let tmpDir: string;
  let workspace: string;
  let outside: string;

  function makeCtx(): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: workspace };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-symlink-'));
    workspace = join(tmpDir, 'ws');
    outside = join(tmpDir, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET');
    await writeFile(join(workspace, 'inside.txt'), 'inside-data');
    await mkdir(join(workspace, 'sub'), { recursive: true });
    await writeFile(join(workspace, 'sub', 'f.txt'), 'sub-data');

    // Симлинки наружу
    await symlink(outside, join(workspace, 'escape'));                       // каталог -> наружу
    await symlink(join(outside, 'secret.txt'), join(workspace, 'leak.txt')); // файл -> наружу
    // Симлинк внутрь
    await symlink(join(workspace, 'sub'), join(workspace, 'inlink'));
    // Битый симлинк
    await symlink(join(workspace, 'no-target'), join(workspace, 'dangling'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('read_file: симлинк наружу (файл) отклонён и не читает цель', async () => {
    const res = await readFileTool.execute({ file_path: 'leak.txt' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).not.toContain('TOP-SECRET');
  });

  it('read_file: симлинк наружу (через каталог) отклонён', async () => {
    const res = await readFileTool.execute({ file_path: 'escape/secret.txt' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).not.toContain('TOP-SECRET');
  });

  it('read_file: симлинк внутрь — разрешён', async () => {
    const res = await readFileTool.execute({ file_path: 'inlink/f.txt' }, makeCtx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('sub-data');
  });

  it('read_file: битый симлинк → отказ (fail-closed)', async () => {
    const res = await readFileTool.execute({ file_path: 'dangling' }, makeCtx());
    expect(res.isError).toBe(true);
  });

  it('write_file: битый симлинк → отказ, цель не создаётся (fail-closed)', async () => {
    const res = await writeFileTool.execute({ file_path: 'dangling', content: 'pwned' }, makeCtx());
    expect(res.isError).toBe(true);
    await expect(stat(join(workspace, 'no-target'))).rejects.toThrow();
  });

  it('read_file: абсолютный путь вне workspace по-прежнему разрешён тулом', async () => {
    const res = await readFileTool.execute({ file_path: join(outside, 'secret.txt') }, makeCtx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('TOP-SECRET');
  });

  it('write_file: через симлинк наружу отклонён, цель не создаётся', async () => {
    const res = await writeFileTool.execute({ file_path: 'escape/evil.txt', content: 'pwned' }, makeCtx());
    expect(res.isError).toBe(true);
    await expect(stat(join(outside, 'evil.txt'))).rejects.toThrow();
  });

  it('write_file: в симлинк-файл наружу отклонён, цель не перезаписана', async () => {
    const res = await writeFileTool.execute({ file_path: 'leak.txt', content: 'pwned' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(await readFile(join(outside, 'secret.txt'), 'utf-8')).toBe('TOP-SECRET');
  });

  it('write_file: в симлинк-каталог внутрь — разрешён', async () => {
    const res = await writeFileTool.execute({ file_path: 'inlink/new.txt', content: 'ok' }, makeCtx());
    expect(res.isError).toBeFalsy();
    expect(await readFile(join(workspace, 'sub', 'new.txt'), 'utf-8')).toBe('ok');
  });

  it('edit_file: через симлинк наружу отклонён', async () => {
    const res = await editFileTool.execute(
      { file_path: 'escape/secret.txt', old_string: 'TOP-SECRET', new_string: 'x' },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(await readFile(join(outside, 'secret.txt'), 'utf-8')).toBe('TOP-SECRET');
  });

  it('create_directory: через симлинк наружу отклонён', async () => {
    const res = await createDirectoryTool.execute({ path: 'escape/newdir' }, makeCtx());
    expect(res.isError).toBe(true);
    await expect(stat(join(outside, 'newdir'))).rejects.toThrow();
  });

  it('delete_file: через симлинк наружу отклонён, цель не удалена', async () => {
    const res = await deleteFileTool.execute({ file_path: 'escape/secret.txt' }, makeCtx());
    expect(res.isError).toBe(true);
    expect((await stat(join(outside, 'secret.txt'))).isFile()).toBe(true);
  });

  it('list_directory: симлинк наружу отклонён', async () => {
    const res = await listDirectoryTool.execute({ path: 'escape' }, makeCtx());
    expect(res.isError).toBe(true);
  });

  it('grep_files: поиск через симлинк наружу отклонён', async () => {
    const res = await grepFilesTool.execute({ pattern: 'TOP-SECRET', path: 'escape' }, makeCtx());
    expect(res.isError).toBe(true);
  });

  it('execute_shell: cwd через симлинк наружу отклонён', async () => {
    const res = await executeShellTool.execute({ command: 'pwd', cwd: 'escape' }, makeCtx());
    expect(res.isError).toBe(true);
  });

  it('execute_shell: cwd через симлинк внутрь — разрешён', async () => {
    const res = await executeShellTool.execute({ command: 'pwd', cwd: 'inlink' }, makeCtx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(join(workspace, 'sub'));
  });

  it('git: repo_path через симлинк наружу → RepoPathError', async () => {
    expect(() => resolveRepoCwd('escape', workspace)).toThrow();
  });

  it('git: repo_path симлинк внутрь — резолвится (не отклоняется)', async () => {
    expect(resolveRepoCwd('inlink', workspace)).toBe(join(workspace, 'inlink'));
  });

  it('git: repo_path `..` и абсолютный — по-прежнему отклоняются', () => {
    expect(() => resolveRepoCwd('..', workspace)).toThrow();
    expect(() => resolveRepoCwd(join(outside), workspace)).toThrow();
  });

  it('git_status: repo_path через симлинк наружу → ошибка тула, без git-операции', async () => {
    const res = await gitStatusTool.execute({ repo_path: 'escape' }, makeCtx());
    expect(res.isError).toBe(true);
  });

  it('permission: симлинк наружу — путь трактуется как external_directory (ask)', async () => {
    const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 });
    const leak = evaluator.check({ toolName: 'read_file', params: { file_path: 'leak.txt' }, workingDir: workspace });
    expect(leak.action).toBe('ask');

    const inside = evaluator.check({ toolName: 'read_file', params: { file_path: 'inside.txt' }, workingDir: workspace });
    expect(inside.action).toBe('allow');

    const viaDir = evaluator.check({ toolName: 'read_file', params: { file_path: 'escape/secret.txt' }, workingDir: workspace });
    expect(viaDir.action).toBe('ask');
  });

  it('permission: симлинк наружу в plan-режиме → deny', async () => {
    const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 });
    const d = evaluator.check({
      toolName: 'read_file',
      params: { file_path: 'leak.txt' },
      workingDir: workspace,
      sessionMode: 'plan',
    });
    expect(d.action).toBe('deny');
  });

  it('permission: симлинк внутрь — путь остаётся внутренним (allow)', async () => {
    const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 });
    const d = evaluator.check({ toolName: 'read_file', params: { file_path: 'inlink/f.txt' }, workingDir: workspace });
    expect(d.action).toBe('allow');
  });
});
