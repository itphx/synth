import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitStatusTool } from './git.js';
import type { ToolContext } from '@synth/shared';

const execFileAsync = promisify(execFile);

describe('git tools — path resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-git-'));
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('git_status: без path — использует рабочий каталог', async () => {
    const result = await gitStatusTool.execute({}, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('master');
  });

  it('git_status: относительный path резолвится относительно рабочего каталога', async () => {
    const result = await gitStatusTool.execute({ path: '.' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata!.cwd).toBe(tmpDir);
  });

  it('git_status: абсолютный path', async () => {
    const result = await gitStatusTool.execute({ path: tmpDir }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata!.cwd).toBe(tmpDir);
  });
});
