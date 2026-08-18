import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeShellTool } from './shell.js';
import type { ToolContext } from '@itphx/synth-shared';

describe('execute_shell — cwd resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-'));
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

  it('без cwd — команда выполняется в рабочем каталоге', async () => {
    const result = await executeShellTool.execute({ command: 'pwd' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(tmpDir);
  });

  it('cwd: относительный путь', async () => {
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
    const result = await executeShellTool.execute({ command: 'pwd', cwd: 'sub' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(join(tmpDir, 'sub'));
  });

  it('cwd: абсолютный путь', async () => {
    const result = await executeShellTool.execute({ command: 'pwd', cwd: tmpDir }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(tmpDir);
  });
});
