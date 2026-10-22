/**
 * Состав toolchain'а исполнителя (ADR-077, шаг 7a).
 *
 * Определяется **на старте** (по наличию бинарников и их версиям) и отдаётся
 * в `GET /capabilities`: control plane сверяет состав своего окружения с
 * составом исполнителя (например, `rg` может отсутствовать в воркере — тогда
 * `grep_files` недоступен, ADR-078).
 *
 * Определение — запуск `<бинарник> --version` с коротким таймаутом; бинарник,
 * которого нет или который не ответил, в отчёт не попадает.
 */

import { execFile } from 'node:child_process';

/** Бинарники, состав которых отслеживается. */
export const TOOLCHAIN_BINARIES = ['git', 'rg', 'python3'] as const;

/** Состав toolchain'а: бинарник → строка версии. */
export type ToolchainInfo = Record<string, string>;

/** Таймаут определения версии одного бинарника, мс. */
const PROBE_TIMEOUT_MS = 3_000;

/** Первая непустая строка вывода (версия). */
function firstLine(value: string): string {
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** Версия одного бинарника (`null` — бинарника нет или он не ответил). */
async function probeVersion(bin: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      bin,
      ['--version'],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve(null);
          return;
        }
        const version = firstLine(`${stdout}\n${stderr}`);
        resolve(version.length > 0 ? version : null);
      },
    );
  });
}

/**
 * Определить состав toolchain'а.
 *
 * @param binaries бинарники для проверки (по умолчанию — `TOOLCHAIN_BINARIES`)
 */
export async function detectToolchain(
  binaries: readonly string[] = TOOLCHAIN_BINARIES,
): Promise<ToolchainInfo> {
  const entries = await Promise.all(
    binaries.map(async (bin) => [bin, await probeVersion(bin)] as const),
  );
  const toolchain: ToolchainInfo = {};
  for (const [bin, version] of entries) {
    if (version !== null) toolchain[bin] = version;
  }
  return toolchain;
}
