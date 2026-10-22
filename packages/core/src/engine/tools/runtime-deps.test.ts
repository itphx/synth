import { describe, it, expect, beforeEach } from 'vitest';
import {
  ALL_RUNTIME_DEPS_AVAILABLE,
  RUNTIME_DEP_BINARY,
  TOOL_RUNTIME_DEP,
  detectRuntimeDeps,
  isRuntimeDepAvailable,
  probeBinary,
  resetRuntimeDepsCache,
  runtimeDepUnavailableDetail,
  runtimeRequires,
  toolRuntimeRequires,
} from './runtime-deps.js';
import type { ExecRequest, ExecResult, ExecutionPort } from '../../execution/ports/index.js';

/** Порт-заглушка: отвечает о своих возможностях, команды не выполняет. */
class CapabilityPort implements ExecutionPort {
  readonly probes: string[] = [];

  constructor(
    private readonly available: Record<string, boolean>,
    private readonly summary?: { missing: number; total: number; unreachable: number },
  ) {}

  async execute(_req: ExecRequest): Promise<ExecResult> {
    throw new Error('порт-заглушка не выполняет команды');
  }

  async probe(bin: string): Promise<boolean> {
    this.probes.push(bin);
    return this.available[bin] ?? false;
  }

  async capabilitySummary(): Promise<{
    available: boolean;
    missing: number;
    total: number;
    unreachable: number;
  }> {
    const summary = this.summary ?? { missing: 1, total: 1, unreachable: 0 };
    return { available: false, ...summary };
  }
}

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

  it('runtimeRequires/toolRuntimeRequires: требования берутся из карты тулов', () => {
    expect(runtimeRequires('git')).toEqual(['git']);
    expect(toolRuntimeRequires('execute_shell')).toEqual(['sh']);
    expect(toolRuntimeRequires('grep_files')).toEqual(['rg']);
    expect(toolRuntimeRequires('git_status')).toEqual(['git']);
    expect(toolRuntimeRequires('read_file')).toEqual([]);
  });
});

/**
 * ADR-077: в remote-режиме доступность определяется составом пула
 * исполнителей (ответ порта), а не локальной пробой в control plane.
 */
describe('runtime-deps: детект через порт (ADR-077)', () => {
  beforeEach(() => {
    resetRuntimeDepsCache();
  });

  it('remote: недоступность берётся из ответа порта, деталь — из сводки пула', async () => {
    const port = new CapabilityPort(
      { git: false, rg: true, sh: true },
      { missing: 2, total: 3, unreachable: 1 },
    );
    const deps = await detectRuntimeDeps(port);

    expect(deps.git).toBe(false);
    expect(deps.rg).toBe(true);
    expect(deps.sh).toBe(true);
    expect(port.probes).toEqual(['git', 'rg', 'sh']);
    const detail = runtimeDepUnavailableDetail(deps, 'git');
    expect(detail).toBeTruthy();
    expect(detail).toContain('git');
    expect(detail).toContain('2');
    expect(detail).toContain('3');
  });

  it('remote: локальная проба не отравляет кэш детекции порта', async () => {
    // Сначала — детект без порта (inline), затем — детект с remote-портом:
    // результаты должны быть разными (иначе детект и исполнение разошлись бы).
    const inline = await detectRuntimeDeps();
    const port = new CapabilityPort({ git: false, rg: false, sh: false });
    const remote = await detectRuntimeDeps(port);

    expect(port.probes).toEqual(['git', 'rg', 'sh']);
    expect(remote.git).toBe(false);
    expect(remote.rg).toBe(false);
    expect(remote.sh).toBe(false);
    // Inline-детект остался прежним (локальная проба, не ответ порта).
    expect(inline.sh).toBe(true);
    expect(inline).not.toBe(remote);
  });

  it('inline: поведение прежнее — детект без порта считает зависимости по локальной пробе', async () => {
    const deps = await detectRuntimeDeps();
    // `sh` есть в любом POSIX-окружении; детали появляются только у
    // недоступных зависимостей.
    expect(deps.sh).toBe(true);
    if (deps.rg === false) {
      expect(runtimeDepUnavailableDetail(deps, 'rg')).toContain('rg');
    } else {
      expect(runtimeDepUnavailableDetail(deps, 'rg')).toBeUndefined();
    }
  });
});
