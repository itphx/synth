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
 * `sh` — иначе `execute_shell` в remote-режиме считался бы недоступным.
 */
describe('toolchain исполнителя (ADR-077)', () => {
  it('базовый словарь — из core: git/rg/sh', async () => {
    const binaries = await resolveToolchainBinaries();
    expect(binaries).toContain('git');
    expect(binaries).toContain('rg');
    expect(binaries).toContain('sh');
  });

  it('дополнительные сведения отделены от базовых', async () => {
    const binaries = await resolveToolchainBinaries();
    for (const extra of EXTRA_TOOLCHAIN_BINARIES) {
      expect(binaries).toContain(extra);
    }
    // Дополнительные — сверх базовых (не подменяют словарь core).
    expect(binaries.length).toBeGreaterThan(3);
  });

  it('detectToolchain: оболочка `sh` есть в отчёте (есть в любом образе)', async () => {
    const toolchain = await detectToolchain();
    expect(Object.keys(toolchain)).toContain('sh');
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
