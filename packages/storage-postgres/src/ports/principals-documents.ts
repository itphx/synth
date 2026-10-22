/**
 * Порты `providers`/`models`/`agents` PostgreSQL-драйвера (ADR-097, волна 3b).
 *
 * Все три — `DocumentRepository<T>` над одной таблицей `documents(kind, key,
 * value jsonb)`: `kind` = `provider`/`model`/`agent`, ключ документа — как в
 * файловой/in-memory реализации (для моделей — `provider/model`). Драйвер не
 * интерпретирует ключ: он лишь хранит документ целиком, поэтому вложенные ключи
 * работают без специальной обработки.
 *
 * `load` отсутствующего — `null`, `exists` — наличие строки (значение `jsonb`
 * `NOT NULL`, пустых/битых документов в БД не бывает), `delete` идемпотентен.
 */

import type { AgentDefinition, ModelConfig, ProviderConfig } from '@itphx/synth-shared';
import type { DocumentRepository } from '@itphx/synth-core';
import type { PostgresConnection } from '../pool.js';
import { jsonbParam } from '../json-param.js';

/** Документ-провайдер. */
export type ProviderDocument = ProviderConfig;

/** Документ-модель. */
export type ModelDocument = ModelConfig;

/** Документ-агент. */
export type AgentDocument = AgentDefinition;

/** Собрать `DocumentRepository<T>` поверх таблицы `documents` для заданного `kind`. */
export function createDocumentPort<T>(
  conn: PostgresConnection,
  kind: 'provider' | 'model' | 'agent',
): DocumentRepository<T> {
  return {
    async load(key: string): Promise<T | null> {
      const rows = await conn.query<{ value: T }>(
        'SELECT value FROM documents WHERE kind = $1 AND key = $2',
        [kind, key],
      );
      const row = rows[0];
      return row ? row.value : null;
    },

    async save(key: string, value: T): Promise<void> {
      await conn.query(
        `INSERT INTO documents (kind, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (kind, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [kind, key, jsonbParam(value)],
      );
    },

    async delete(key: string): Promise<void> {
      await conn.query('DELETE FROM documents WHERE kind = $1 AND key = $2', [kind, key]);
    },

    async exists(key: string): Promise<boolean> {
      const rows = await conn.query<{ present: number }>(
        'SELECT 1 AS present FROM documents WHERE kind = $1 AND key = $2',
        [kind, key],
      );
      return rows.length > 0;
    },

    async list(): Promise<T[]> {
      const rows = await conn.query<{ value: T }>(
        'SELECT value FROM documents WHERE kind = $1 ORDER BY key',
        [kind],
      );
      return rows.map((row) => row.value);
    },
  };
}
