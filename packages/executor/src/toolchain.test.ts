import { describe, expect, it } from 'vitest';
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

  it('detectToolchain: заданный состав проверяется целиком', async () => {
    const toolchain = await detectToolchain(['sh', 'synth-executor-missing-binary']);
    expect(Object.keys(toolchain)).toEqual(['sh']);
  });
});
