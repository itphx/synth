/**
 * ADR-090, п. 9 «Решения» (владелец, 2026-10-23): **подтверждение установки**
 * бандла из карантина — привязано к **content-hash** бандла, действует **24 ч**,
 * выдаёт **ADMIN**.
 *
 * ```text
 * установка (verdict caution) → бандл в quarantine/ + ПОДТВЕРЖДЕНИЕ
 *                                (content-hash, кто выдал, когда, срок 24 ч)
 * approve → проверка подтверждения:
 *   • истекло (больше 24 ч) → plugin.approval_expired
 *   • хеш бандла не совпал   → plugin.approval_stale
 *   • иначе → гейты → перенос в installed/ + lock
 * ```
 *
 * **Где живёт состояние.** Файл `plugin-approvals.json` в **корне раскладки**
 * слоя плагинов (`<home>/plugin/` или `{dataDir}/plugin/`) — рядом с
 * `plugins.lock.json` и `plugins.json`. Это тот же механизм раскладки слоя
 * плагинов, поэтому запись идёт **не** напрямую в `$SYNTH_DATA_DIR` мимо слоя
 * (инвариант 2): путь приходит из `PluginLayout.approvalsPath`.
 *
 * **Почему не внутри каталога бандла.** Карантин — это каталог, и его замена
 * (переустановка/подмена бандла) удалила бы подтверждение вместе с бандлом:
 * подменённое содержимое прошло бы под старым подтверждением. Отдельный файл
 * переживает такую замену — поэтому расхождение хешей и ловится
 * (`plugin.approval_stale`).
 *
 * **Персистентность.** Подтверждение — **файл**, а не запись в памяти: после
 * рестарта процесса (перезапуск инстанса, деплой) оно остаётся в силе и
 * продолжает ограничивать срок. in-memory-реализация — только для тестов.
 *
 * **Кто выдаёт.** Подтверждение выдаёт инициатор постановки бандла в карантин
 * (в managed — `ADMIN` либо service-key со scope `addons:install`, который
 * выдал админ; в core — `requireAuth`). Окончательное действие — подтверждение
 * установки `POST /api/v2/plugins/:name/approve` — в managed доступно **только
 * `ADMIN`** (роут `approveGuard`).
 */
import { AsyncLock } from '@itphx/synth-shared';

import {
  readCollectionFile,
  writeCollectionFile,
} from '../../storage/json-collection-file.js';

/**
 * Срок действия подтверждения — **24 ч** (ADR-090 п. 9).
 *
 * Фиксированная величина (без ключа конфига): решение владельца. Экспортируется
 * из слоя плагинов, чтобы на неё ссылались тесты и документация.
 */
export const PLUGIN_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Срок действия подтверждения в часах (для текстов и документации). */
export const PLUGIN_APPROVAL_TTL_HOURS = 24;

/**
 * Запись подтверждения установки.
 *
 * Привязка — к **content-hash** бандла: подтверждение относится ровно к тому
 * содержимому, которое было одобрено, и перестаёт действовать, если содержимое
 * изменилось.
 */
export interface PluginApprovalRecord {
  /** Имя плагина. */
  name: string;
  /** Версия бандла в карантине. */
  version: string;
  /** Content-hash одобренного бандла (sha256 от состава файлов). */
  contentHash: string;
  /** Кто выдал подтверждение (инициатор постановки в карантин). */
  approvedBy: string;
  /** Момент выдачи (ISO-8601) — от него считается срок. */
  approvedAt: string;
  /** Срок действия (ISO-8601) — `approvedAt` + 24 ч. */
  expiresAt: string;
}

/**
 * Хранилище подтверждений установки.
 *
 * Ключ записи — бандл (`<name>@<version>`): у разных версий одного плагина
 * подтверждения независимы.
 */
export interface PluginApprovalStore {
  /** Подтверждение бандла (`null` — не выдавалось). */
  get(name: string, version: string): Promise<PluginApprovalRecord | null>;
  /** Выдать подтверждение (перезапись записи того же бандла). */
  save(record: PluginApprovalRecord): Promise<void>;
  /** Снять подтверждение бандла. */
  delete(name: string, version: string): Promise<boolean>;
  /** Все подтверждения (детерминированный порядок — по имени и версии). */
  list(): Promise<PluginApprovalRecord[]>;
}

/** Ключ записи подтверждения — `<name>@<version>` (как каталог бандла). */
function approvalKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Просрочено ли подтверждение на момент `now` (ISO-8601).
 *
 * Истёкшим считается подтверждение, у которого `now` **не меньше** `expiresAt`.
 * Битое/пустое `expiresAt` считается истёкшим (fail-closed: подтверждение без
 * срока не должно продлеваться молча).
 */
export function isPluginApprovalExpired(
  record: PluginApprovalRecord,
  now: string,
): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  const current = Date.parse(now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(current)) return true;
  return current >= expiresAt;
}

/**
 * Сформировать запись подтверждения: срок — `approvedAt` + 24 ч.
 *
 * `approvedAt` берётся у вызывающего (часы инсталлера — инъекция `now` в
 * тестах), срок считается от него же: «24 ч с момента выдачи» (ADR-090 п. 9).
 */
export function buildPluginApproval(input: {
  name: string;
  version: string;
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
}): PluginApprovalRecord {
  const issued = Date.parse(input.approvedAt);
  const base = Number.isFinite(issued) ? issued : Date.now();
  return {
    name: input.name,
    version: input.version,
    contentHash: input.contentHash,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    expiresAt: new Date(base + PLUGIN_APPROVAL_TTL_MS).toISOString(),
  };
}

/**
 * Файловая реализация хранилища подтверждений (ADR-005: JSON + атомарная
 * запись tmp→rename).
 *
 * Файл лежит в корне раскладки слоя плагинов (`<home>/plugin/` или
 * `{dataDir}/plugin/`) — путь приходит из `PluginLayout.approvalsPath`, поэтому
 * запись не идёт в `$SYNTH_DATA_DIR` в обход слоя (инвариант 2).
 *
 * **Повреждённый файл** — не «пустое хранилище»: чтение падает с понятной
 * ошибкой (как lock-файл), чтобы молчаливая потеря подтверждений не выглядела
 * как «подтверждения не было».
 */
export class FilePluginApprovalStore implements PluginApprovalStore {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: { path: string }) {}

  /** Путь файла подтверждений. */
  path(): string {
    return this._config.path;
  }

  async get(name: string, version: string): Promise<PluginApprovalRecord | null> {
    const records = await this._read();
    return records.find((item) => item.name === name && item.version === version) ?? null;
  }

  async save(record: PluginApprovalRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const index = records.findIndex(
        (item) => item.name === record.name && item.version === record.version,
      );
      if (index === -1) {
        records.push(record);
      } else {
        records[index] = record;
      }
      await this._write(records);
    } finally {
      this._lock.release();
    }
  }

  async delete(name: string, version: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const next = records.filter((item) => !(item.name === name && item.version === version));
      if (next.length === records.length) return false;
      await this._write(next);
      return true;
    } finally {
      this._lock.release();
    }
  }

  async list(): Promise<PluginApprovalRecord[]> {
    const records = await this._read();
    return [...records].sort(
      (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );
  }

  private async _read(): Promise<PluginApprovalRecord[]> {
    return readCollectionFile<PluginApprovalRecord>(
      this._config.path,
      'approvals',
      'файл подтверждений установки плагинов',
    );
  }

  private async _write(records: PluginApprovalRecord[]): Promise<void> {
    await writeCollectionFile(this._config.path, 'approvals', records);
  }
}

/**
 * Хранилище подтверждений в памяти — **только для тестов** (герметичный
 * прогон без файловой системы). Боевой контур — `FilePluginApprovalStore`.
 */
export class MemoryPluginApprovalStore implements PluginApprovalStore {
  private readonly _records = new Map<string, PluginApprovalRecord>();

  async get(name: string, version: string): Promise<PluginApprovalRecord | null> {
    return this._records.get(approvalKey(name, version)) ?? null;
  }

  async save(record: PluginApprovalRecord): Promise<void> {
    this._records.set(approvalKey(record.name, record.version), record);
  }

  async delete(name: string, version: string): Promise<boolean> {
    return this._records.delete(approvalKey(name, version));
  }

  async list(): Promise<PluginApprovalRecord[]> {
    return [...this._records.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );
  }
}
