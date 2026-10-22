import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { EventBinding } from '@itphx/synth-shared';
import { generateId, AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';
import type { EventBindingRepository } from './ports/event-binding-repository.js';

/** Версия схемы файла биндингов — для будущей миграции (ADR-096). */
export const EVENT_BINDINGS_SCHEMA_VERSION = 1;

export interface EventBindingStoreConfig {
  dataDir: string;
}

/** Входные данные `upsert`: id опционален (генерируется `bnd_<uuid>`). */
export type UpsertEventBindingInput = Omit<EventBinding, 'id'> & { id?: string };

interface BindingsFile {
  schemaVersion: number;
  bindings: EventBinding[];
}

/**
 * ADR-089: реестр устойчивых привязок внешнего адреса к сессии/шаблону.
 *
 * Хранится одним JSON-файлом `{dataDir}/events/bindings.json` (ADR-005,
 * атомарная запись tmp→rename). Модель PG-ready (ADR-097): плоские записи со
 * стабильным `id` и `schemaVersion`.
 */
export class EventBindingStore implements EventBindingRepository {
  private _lock = new AsyncLock();

  constructor(private _config: EventBindingStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'events', 'bindings.json');
  }

  /** Защита от path traversal в `id` (как в `JsonStore._validateKey`). */
  private _validateId(id: string): void {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Недопустимый id биндинга: ${id}`);
    }
  }

  private async _load(): Promise<BindingsFile> {
    try {
      const raw = await readFile(this._filePath(), 'utf-8');
      const parsed = safeJsonParse<BindingsFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.bindings)) {
        return { schemaVersion: EVENT_BINDINGS_SCHEMA_VERSION, bindings: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? EVENT_BINDINGS_SCHEMA_VERSION,
        bindings: parsed.bindings.filter((b): b is EventBinding => !!b && typeof b.id === 'string'),
      };
    } catch {
      return { schemaVersion: EVENT_BINDINGS_SCHEMA_VERSION, bindings: [] };
    }
  }

  private async _save(file: BindingsFile): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify({ schemaVersion: EVENT_BINDINGS_SCHEMA_VERSION, bindings: file.bindings }, null, 2);
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  async list(): Promise<EventBinding[]> {
    const file = await this._load();
    return [...file.bindings];
  }

  async get(id: string): Promise<EventBinding | null> {
    const file = await this._load();
    return file.bindings.find((b) => b.id === id) ?? null;
  }

  /**
   * Резолвинг привязки события: `threadKey` приоритетнее `chatKey`; матч — по
   * `source` + ключу. Нет подходящей записи — `null`.
   */
  async findByKey(input: { source: string; chatKey?: string; threadKey?: string }): Promise<EventBinding | null> {
    const file = await this._load();
    if (input.threadKey) {
      const byThread = file.bindings.find((b) => b.source === input.source && b.threadKey === input.threadKey);
      if (byThread) return byThread;
    }
    if (input.chatKey) {
      const byChat = file.bindings.find((b) => b.source === input.source && b.chatKey === input.chatKey);
      if (byChat) return byChat;
    }
    return null;
  }

  /** Создаёт или заменяет биндинг по `id` (id отсутствует → `bnd_<uuid>`). */
  async upsert(input: UpsertEventBindingInput): Promise<EventBinding> {
    await this._lock.acquire();
    try {
      const id = input.id ?? `bnd_${generateId()}`;
      this._validateId(id);

      const file = await this._load();
      const binding: EventBinding = { ...input, id };
      const index = file.bindings.findIndex((b) => b.id === id);
      if (index === -1) {
        file.bindings.push(binding);
      } else {
        file.bindings[index] = binding;
      }
      await this._save(file);
      return binding;
    } finally {
      this._lock.release();
    }
  }

  async remove(id: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const next = file.bindings.filter((b) => b.id !== id);
      if (next.length === file.bindings.length) return false;
      file.bindings = next;
      await this._save(file);
      return true;
    } finally {
      this._lock.release();
    }
  }
}
