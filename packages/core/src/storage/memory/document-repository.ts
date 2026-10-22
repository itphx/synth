import type { DocumentRepository } from '../ports/document-repository.js';

/**
 * In-memory реализация `DocumentRepository` (ADR-096, шаг W2.4).
 *
 * Состояние — `Map<key, T>`; значения клонируются (`structuredClone`) на входе и
 * выходе, чтобы вызывающий не мог мутировать «стор» через переданный/полученный
 * объект (паритет с JSON round-trip файловой реализации). `list()` детерминирован
 * по ключу (файловая реализация порядок не гарантирует, memory — гарантирует).
 */
export class MemoryDocumentRepository<T> implements DocumentRepository<T> {
  private readonly _docs = new Map<string, T>();

  async load(key: string): Promise<T | null> {
    const value = this._docs.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async save(key: string, value: T): Promise<void> {
    this._docs.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this._docs.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this._docs.has(key);
  }

  async list(): Promise<T[]> {
    return [...this._docs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => structuredClone(value));
  }
}
