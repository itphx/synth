/**
 * Состав toolchain'а исполнителя (ADR-077, шаг 7a).
 *
 * Определяется **на старте** (по наличию бинарников и их версиям) и отдаётся
 * в `GET /capabilities`: control plane строит по этому ответу **инвентарь
 * пула** — карту «адрес → множество программ» — и решает по нему, куда
 * уходит команда с бинарным требованием (`ExecRequest.requires`, ADR-077).
 *
 * ## Единый словарь возможностей
 *
 * Словарь базовых возможностей — **в core** (`EXECUTION_BASE_CAPABILITIES`:
 * `git`/`rg`/`sh`): это ровно те программы, доступность которых проверяет
 * слой доступности тулов (ADR-078). Исполнитель обязан отдавать и `sh`
 * (оболочка есть в любом образе) — иначе `execute_shell` в remote-режиме
 * считался бы недоступным.
 *
 * Прочие программы (`python3` и т. п.) — **дополнительные сведения** о
 * составе окружения: control plane сравнивает по базовым, поэтому на
 * доступность встроенных тулов они не влияют.
 *
 * Определение — запуск `<бинарник> --version` с коротким таймаутом. Отсутствие
 * бинарника (`ENOENT`) — его нет в отчёте; прочая ошибка (программа есть, но
 * `--version` не поддерживается) — программа **есть** (в отчёт попадает).
 */

import { execFile } from 'node:child_process';

/** Состав toolchain'а: бинарник → строка версии. */
export type ToolchainInfo = Record<string, string>;

/**
 * Дополнительные программы, состав которых исполнитель отдаёт «для
 * сведения» (на доступность встроенных тулов не влияют).
 */
export const EXTRA_TOOLCHAIN_BINARIES = ['python3'] as const;

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

/**
 * Версия одного бинарника (`null` — бинарника нет).
 *
 * `ENOENT` — программы нет. Прочие ошибки (ненулевой код выхода, таймаут) —
 * программа **есть**: отсутствие поддержки `--version` не означает, что
 * программы нет (например, некоторые оболочки).
 */
async function probeVersion(bin: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      bin,
      ['--version'],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve(null);
          return;
        }
        const version = firstLine(`${stdout}\n${stderr}`);
        resolve(version.length > 0 ? version : 'present');
      },
    );
  });
}

/**
 * Базовый словарь возможностей — из core (источник истины, ADR-077).
 *
 * Точечный рантайм-импорт: пакет тянет core как peer-зависимость и в образе
 * исполнителя core присутствует (`/opt/synth-core`), но статический импорт
 * сделал бы загрузку индекса core обязательной при любом импорте пакета.
 */
async function resolveBaseCapabilities(): Promise<readonly string[]> {
  const core = await import('@itphx/synth-core');
  return core.EXECUTION_BASE_CAPABILITIES;
}

/**
 * Полный состав, который исполнитель определяет и отдаёт в `/capabilities`:
 * базовый словарь core + дополнительные сведения.
 */
export async function resolveToolchainBinaries(): Promise<readonly string[]> {
  const base = await resolveBaseCapabilities();
  return [...base, ...EXTRA_TOOLCHAIN_BINARIES];
}

/**
 * Определить состав toolchain'а.
 *
 * @param binaries бинарники для проверки (по умолчанию — базовый словарь core
 *                 + дополнительные сведения)
 */
export async function detectToolchain(
  binaries?: readonly string[],
): Promise<ToolchainInfo> {
  const list = binaries ?? (await resolveToolchainBinaries());
  const entries = await Promise.all(
    list.map(async (bin) => [bin, await probeVersion(bin)] as const),
  );
  const toolchain: ToolchainInfo = {};
  for (const [bin, version] of entries) {
    if (version !== null) toolchain[bin] = version;
  }
  return toolchain;
}
