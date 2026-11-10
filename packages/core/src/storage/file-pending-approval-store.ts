import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type { PendingApprovalRepository, PendingApprovalRecord } from './ports/pending-approval-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';

export interface FilePendingApprovalStoreConfig {
  dataDir: string;
}

/** Ключ массива записей внутри JSON-файла. */
const PENDING_APPROVALS_KEY = 'pendingApprovals';

/**
 * Файловая реализация порта ожиданий подтверждения прав (ADR-096 — слой
 * хранения; ADR-005 — JSON + атомарная запись tmp→rename; ADR-029 — ожидания
 * переживают рестарт инстанса).
 *
 * Физическое расположение: `{dataDir}/pending-approvals.json`.
 *
 * Почему отдельный файл, а не поле документа сессии: документ сессии пишется
 * полной перезаменой (`save`), а результаты параллельных тулов — точечно
 * (`appendMessage`, ADR-118). Запись ожидания в тот же документ затирала бы
 * точечные записи → гонка lost update (ADR-118 §4).
 *
 * Каталог создаётся при первой записи; отсутствие файла — пустой репозиторий
 * (не ошибка). Повреждённый JSON — понятная ошибка, а не тихий пустой список
 * (`readCollectionFile`): молчаливая пустая коллекция выглядела бы как «все
 * ожидания потеряны».
 *
 * Конкурентные записи сериализуются `AsyncLock` — тот же приём, что у соседних
 * коллекций (`FileQuestionStore`, `FileWorktreeStore`).
 */
export class FilePendingApprovalStore implements PendingApprovalRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FilePendingApprovalStoreConfig) {}

  /** Путь файла записей (`{dataDir}/pending-approvals.json`). */
  path(): string {
    return join(this._config.dataDir, 'pending-approvals.json');
  }

  async save(record: PendingApprovalRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const index = records.findIndex((r) => r.approvalId === record.approvalId);
      if (index === -1) records.push(record);
      else records[index] = record;
      await this._write(records);
    } finally {
      this._lock.release();
    }
  }

  async delete(approvalId: string): Promise<void> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const kept = records.filter((r) => r.approvalId !== approvalId);
      // Записи нет — идемпотентно, файл не трогаем.
      if (kept.length === records.length) return;
      await this._write(kept);
    } finally {
      this._lock.release();
    }
  }

  async list(sessionId?: string): Promise<PendingApprovalRecord[]> {
    const records = await this._read();
    if (sessionId === undefined) return records;
    return records.filter((r) => r.sessionId === sessionId);
  }

  async clear(sessionId?: string): Promise<number> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      if (records.length === 0) return 0;
      const kept = sessionId === undefined
        ? []
        : records.filter((r) => r.sessionId !== sessionId);
      const removed = records.length - kept.length;
      if (removed === 0) return 0;
      await this._write(kept);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  private async _read(): Promise<PendingApprovalRecord[]> {
    return readCollectionFile<PendingApprovalRecord>(
      this.path(),
      PENDING_APPROVALS_KEY,
      'файл ожиданий подтверждения',
    );
  }

  private async _write(records: PendingApprovalRecord[]): Promise<void> {
    await writeCollectionFile(this.path(), PENDING_APPROVALS_KEY, records);
  }
}
