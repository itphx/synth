import { describe, it, expect, beforeEach } from 'vitest';
import {
  ALL_RUNTIME_DEPS_AVAILABLE,
  RUNTIME_DEP_BINARY,
  TOOL_RUNTIME_DEP,
  detectRuntimeDeps,
  isRuntimeDepAvailable,
  probeBinary,
  resetRuntimeDepsCache,
} from './runtime-deps.js';

describe('runtime-deps (ADR-070 §2.9.1)', () => {
  beforeEach(() => {
    resetRuntimeDepsCache();
  });

  it('probeBinary: отсутствующий бинарник → false (ENOENT)', async () => {
    expect(await probeBinary('synth-definitely-missing-binary-xyz')).toBe(false);
  });

  it('probeBinary: прочая ошибка запуска → true (fail-open)', async () => {
    // Существующий бинарник с заведомо неверным флагом: ненулевой код выхода —
    // не ENOENT, значит зависимость считается доступной (fail-open).
    expect(await probeBinary(process.execPath, ['--synth-invalid-flag'])).toBe(true);
  });

  it('probeBinary: существующий бинарник → true', async () => {
    expect(await probeBinary(process.execPath)).toBe(true);
  });

  it('detectRuntimeDeps: кэширует промис (дедупликация)', async () => {
    const first = detectRuntimeDeps();
    const second = detectRuntimeDeps();
    expect(second).toBe(first);
    const deps = await first;
    expect(deps).toEqual({
      git: expect.any(Boolean),
      rg: expect.any(Boolean),
      sh: expect.any(Boolean),
    });
  });

  it('resetRuntimeDepsCache: сбрасывает кэш — новый промис', async () => {
    const first = detectRuntimeDeps();
    await first;
    resetRuntimeDepsCache();
    const second = detectRuntimeDeps();
    expect(second).not.toBe(first);
    await second;
  });

  it('isRuntimeDepAvailable: undefined → true (fail-open), false → false', () => {
    expect(isRuntimeDepAvailable(undefined, 'git')).toBe(true);
    expect(isRuntimeDepAvailable({ ...ALL_RUNTIME_DEPS_AVAILABLE, git: false }, 'git')).toBe(false);
    expect(isRuntimeDepAvailable(ALL_RUNTIME_DEPS_AVAILABLE, 'rg')).toBe(true);
  });

  it('TOOL_RUNTIME_DEP: покрытие встроенных тулов с внешней зависимостью', () => {
    expect(TOOL_RUNTIME_DEP.grep_files).toBe('rg');
    expect(TOOL_RUNTIME_DEP.execute_shell).toBe('sh');
    for (const name of [
      'git_status', 'git_diff', 'git_log', 'git_commit', 'git_push', 'git_pull',
      'git_checkout', 'git_branch_list', 'git_show', 'git_blame', 'git_stash',
    ]) {
      expect(TOOL_RUNTIME_DEP[name], name).toBe('git');
    }
    // Файловые/plan/todo/web/task/skill-тулы зависимости не имеют.
    expect(TOOL_RUNTIME_DEP.read_file).toBeUndefined();
    expect(TOOL_RUNTIME_DEP.web_search).toBeUndefined();
  });

  it('RUNTIME_DEP_BINARY: человекочитаемые имена', () => {
    expect(RUNTIME_DEP_BINARY.git).toBe('git');
    expect(RUNTIME_DEP_BINARY.rg).toBe('rg (ripgrep)');
    expect(RUNTIME_DEP_BINARY.sh).toBe('sh');
  });
});
