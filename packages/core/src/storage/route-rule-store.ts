import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { EventRouteRule } from '@itphx/synth-shared';
import { generateId, AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';

/** Версия схемы файла правил маршрутизации — для будущей миграции (PROP-032). */
export const ROUTE_RULES_SCHEMA_VERSION = 1;

export interface RouteRuleStoreConfig {
  dataDir: string;
}

/** Входные данные `upsert`: id опционален (генерируется `rule_<uuid>`). */
export type UpsertRouteRuleInput = Omit<EventRouteRule, 'id'> & { id?: string };

interface RouteRulesFile {
  schemaVersion: number;
  rules: EventRouteRule[];
}

function isRouteRule(value: unknown): value is EventRouteRule {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as EventRouteRule).id === 'string' &&
    typeof (value as EventRouteRule).priority === 'number' &&
    !!(value as EventRouteRule).match &&
    typeof (value as EventRouteRule).match === 'object' &&
    !!(value as EventRouteRule).target &&
    typeof (value as EventRouteRule).target === 'object'
  );
}

/**
 * ADR-089: реестр правил маршрутизации внешних событий (проектные/инстанс-правила).
 *
 * Хранится одним JSON-файлом `{dataDir}/events/routes.json` (ADR-005, атомарная
 * запись tmp→rename). Модель PG-ready (PROP-032): плоские записи со стабильным
 * `id` и `schemaVersion`.
 */
export class RouteRuleStore {
  private _lock = new AsyncLock();

  constructor(private _config: RouteRuleStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'events', 'routes.json');
  }

  /** Защита от path traversal в `id` (как в `JsonStore._validateKey`). */
  private _validateId(id: string): void {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Недопустимый id правила: ${id}`);
    }
  }

  private async _load(): Promise<RouteRulesFile> {
    try {
      const raw = await readFile(this._filePath(), 'utf-8');
      const parsed = safeJsonParse<RouteRulesFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.rules)) {
        return { schemaVersion: ROUTE_RULES_SCHEMA_VERSION, rules: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? ROUTE_RULES_SCHEMA_VERSION,
        rules: parsed.rules.filter(isRouteRule),
      };
    } catch {
      return { schemaVersion: ROUTE_RULES_SCHEMA_VERSION, rules: [] };
    }
  }

  private async _save(file: RouteRulesFile): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(
      { schemaVersion: ROUTE_RULES_SCHEMA_VERSION, rules: file.rules },
      null,
      2,
    );
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  async list(): Promise<EventRouteRule[]> {
    const file = await this._load();
    return [...file.rules];
  }

  /** Только включённые правила (удобно провайдеру). */
  async listEnabled(): Promise<EventRouteRule[]> {
    const file = await this._load();
    return file.rules.filter((r) => r.enabled);
  }

  async get(id: string): Promise<EventRouteRule | null> {
    const file = await this._load();
    return file.rules.find((r) => r.id === id) ?? null;
  }

  /** Создаёт или заменяет правило по `id` (id отсутствует → `rule_<uuid>`). */
  async upsert(input: UpsertRouteRuleInput): Promise<EventRouteRule> {
    await this._lock.acquire();
    try {
      const id = input.id ?? `rule_${generateId()}`;
      this._validateId(id);

      const file = await this._load();
      const rule: EventRouteRule = { ...input, id };
      const index = file.rules.findIndex((r) => r.id === id);
      if (index === -1) {
        file.rules.push(rule);
      } else {
        file.rules[index] = rule;
      }
      await this._save(file);
      return rule;
    } finally {
      this._lock.release();
    }
  }

  async remove(id: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const next = file.rules.filter((r) => r.id !== id);
      if (next.length === file.rules.length) return false;
      file.rules = next;
      await this._save(file);
      return true;
    } finally {
      this._lock.release();
    }
  }
}
