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
 * Прочие программы (`python3`, `ffmpeg` и т. п.) — **дополнительные сведения**
 * о составе окружения: control plane сравнивает по базовым, поэтому на
 * доступность встроенных тулов они не влияют. `ffmpeg` нужен не встроенному
 * тулу, а **медиа-слою** (ADR-115: транскод аудио и кадры видео): медиа-раннер
 * core передаёт `ExecRequest.requires: ['ffmpeg']`, и без записи в этом
 * инвентаре команда не была бы маршрутизирована в подходящий адрес пула.
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
 *
 * `ffmpeg` — возможность медиа-слоя (ADR-115), не встроенного тула: медиа-раннер
 * core маршрутизирует команду по `requires: ['ffmpeg']`, а remote-порт решает
 * это по инвентарю `/capabilities`.
 *
 * `ssh`/`scp`/`sftp`/`rsync` — клиенты удалённого доступа (PROP-124 §4/§5):
 * адресные ssh-тулы (`ssh_exec`, `ssh_copy`) требуют их в окружении
 * исполнения. В базовый словарь core (`EXECUTION_BASE_CAPABILITIES`) они
 * **не входят**: в slim-образе их нет, и базовый словарь — это «всегда
 * доступно» (ADR-078). Поэтому они здесь: инвентарь `/capabilities` — единственный
 * способ узнать про них control plane, а remote-маршрутизация по
 * `ExecRequest.requires` (`['ssh']`, `['rsync']`) смотрит именно в него.
 */
export const EXTRA_TOOLCHAIN_BINARIES = [
  'python3',
  'ffmpeg',
  'ssh',
  'scp',
  'sftp',
  'rsync',
] as const;

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
 *
 * Непустой вывод при **неудачном** запуске версией **не** считается: программа
 * без `--version` печатает usage/ошибку в stderr и выходит с ненулевым кодом
 * (`ssh`/`scp`/`sftp` — «unknown option -- -»). Такой текст в отчёте был бы
 * мусором, поэтому при ошибке в отчёт идёт признак наличия (`present`) —
 * ровно как задокументировано для этого случая.
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
        const stdoutLine = firstLine(stdout);
        if (err) {
          // Программа есть (не ENOENT), но версию не отдала — «present».
          resolve(stdoutLine.length > 0 ? stdoutLine : 'present');
          return;
        }
        const version = stdoutLine.length > 0 ? stdoutLine : firstLine(stderr);
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
