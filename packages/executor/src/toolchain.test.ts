import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTRA_TOOLCHAIN_BINARIES,
  detectToolchain,
  resolveToolchainBinaries,
} from './toolchain.js';

/**
 * ADR-077: единый словарь возможностей.
 *
 * Базовый словарь — в core (`EXECUTION_BASE_CAPABILITIES`): по нему control
 * plane судит о доступности встроенных тулов. Исполнитель обязан отдавать и
 * `sh`, и `bash`: `execute_shell` требует **bash** (в образах `/bin/sh` —
 * dash/busybox ash, bash-синтаксис там не работает), без `bash` в отчёте тул в
 * remote-режиме считался бы недоступным.
 */
describe('toolchain исполнителя (ADR-077)', () => {
  it('базовый словарь — из core: git/rg/sh/bash', async () => {
    const binaries = await resolveToolchainBinaries();
    expect(binaries).toContain('git');
    expect(binaries).toContain('rg');
    expect(binaries).toContain('sh');
    expect(binaries).toContain('bash');
  });

  it('дополнительные сведения отделены от базовых', async () => {
    const binaries = await resolveToolchainBinaries();
    for (const extra of EXTRA_TOOLCHAIN_BINARIES) {
      expect(binaries).toContain(extra);
    }
    // Дополнительные — сверх базовых (не подменяют словарь core).
    expect(binaries.length).toBeGreaterThan(3);
  });

  /**
   * PROP-124 §4/§5: клиенты удалённого доступа (`ssh`/`scp`/`sftp`/`rsync`) —
   * в дополнительном составе исполнителя, а **не** в базовом словаре core
   * (`EXECUTION_BASE_CAPABILITIES`): в slim-образе их нет, а базовый словарь —
   * это «всегда доступно» (ADR-078). Remote-маршрутизация по
   * `ExecRequest.requires` видит их только через инвентарь `/capabilities`.
   */
  it('инвентарь исполнителя включает клиенты удалённого доступа', async () => {
    const binaries = await resolveToolchainBinaries();
    for (const bin of ['ssh', 'scp', 'sftp', 'rsync']) {
      expect(EXTRA_TOOLCHAIN_BINARIES).toContain(bin);
      expect(binaries).toContain(bin);
    }
    // В базовый словарь core они не попадают — иначе slim-образ был бы
    // объявлен как умеющий ssh.
    const core = (await import('@itphx/synth-core')) as {
      EXECUTION_BASE_CAPABILITIES: readonly string[];
    };
    for (const bin of ['ssh', 'scp', 'sftp', 'rsync']) {
      expect(core.EXECUTION_BASE_CAPABILITIES).not.toContain(bin);
    }
  });

  it('detectToolchain: оболочки `sh` и `bash` есть в отчёте (tier 0 образов)', async () => {
    const toolchain = await detectToolchain();
    expect(Object.keys(toolchain)).toContain('sh');
    // bash — требование `execute_shell`: без него тул недоступен (fail-closed).
    expect(Object.keys(toolchain)).toContain('bash');
  });

  it('detectToolchain: отсутствующий бинарник в отчёт не попадает', async () => {
    const toolchain = await detectToolchain(['synth-executor-missing-binary']);
    expect(toolchain).toEqual({});
  });

  /**
   * Программа без поддержки `--version` (`ssh`/`scp`/`sftp` печатают usage в
   * stderr и выходят с ненулевым кодом) — в отчёте должна быть **признак
   * наличия** (`present`), а не текст usage: иначе `/capabilities` отдаёт
   * мусор вроде «unknown option -- -» вместо версии.
   */
  it('detectToolchain: программа без `--version` → «present», а не usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-toolchain-'));
    const bin = join(dir, 'fake-no-version');
    await writeFile(bin, '#!/bin/sh\necho "usage: fake-no-version [-h]" >&2\nexit 1\n');
    await chmod(bin, 0o755);
    try {
      const toolchain = await detectToolchain([bin]);
      expect(toolchain[bin]).toBe('present');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detectToolchain: заданный состав проверяется целиком', async () => {
    const toolchain = await detectToolchain(['sh', 'synth-executor-missing-binary']);
    expect(Object.keys(toolchain)).toEqual(['sh']);
  });
});
