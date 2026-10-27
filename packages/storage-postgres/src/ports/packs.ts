/**
 * PG-реализация порта **реестра установок пакетов расширений**
 * (ADR-086 §5 / PROP-068, ADR-116, ADR-097).
 *
 * Хранение — таблица `pack_installations` (миграция `025_packs_pipelines`):
 * ключ записи — **имя пакета** (уникально в инстансе), `manifest`/`files`/
 * `provides` — `jsonb`.
 *
 * Семантика повторяет файловую реализацию core (`FilePackStore`) и in-memory
 * (`MemoryPackRepository`):
 * - `save` — upsert по `name`: `installed_at` не перезаписывается, `updated_at`
 *   монотонно не убывает (в SQL — `GREATEST` + сдвиг 1 мс, паритет с
 *   `record-timestamps.ts` core);
 * - `get` — `null` для неизвестного имени;
 * - `list` — детерминированный порядок (`ORDER BY name ASC`);
 * - `delete` — `true`, если запись была удалена (снятие установки), иначе `false`.
 */

import type { CatalogTrustLevel } from '@itphx/synth-shared';
import type {
  PackInstallation,
  PackInstallationProvides,
  PackInstallationStatus,
  PackRepository,
  StorageContext,
} from '@itphx/synth-core';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';
import { compact, toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет группа «packs». */
export type PackPorts = Pick<StorageContext, 'packs'>;

/**
 * Выражение `updated_at` при upsert: максимум из «сейчас», входящего и
 * сохранённого значения; если максимум совпал с сохранённым — сдвиг на 1 мс
 * (паритет с `resolveUpdatedAt` в `record-timestamps.ts` core: метка не
 * откатывается и всегда наблюдаема). Локальная реплика — как в
 * `ports/pipelines.ts`: драйвер не тянет core рантаймом.
 */
function updatedAtExpr(table: string): string {
  return `CASE
    WHEN GREATEST(EXCLUDED.updated_at, ${table}.updated_at, now()) <= ${table}.updated_at
      THEN ${table}.updated_at + interval '1 millisecond'
    ELSE GREATEST(EXCLUDED.updated_at, ${table}.updated_at, now())
  END`;
}

/** Пустой набор вкладов (страховка для чтения битой/пустой записи `provides`). */
function emptyProvides(): PackInstallationProvides {
  return { agents: [], skills: [], mcp: [], pipelines: [] };
}

type PackRow = {
  name: string;
  version: string;
  kind: string;
  pack_type: string | null;
  description: string | null;
  status: string;
  requires_approval: boolean;
  trust_level: string | null;
  manifest: unknown;
  files: unknown;
  provides: unknown;
  installed_by: string | null;
  installed_at: Date | string;
  updated_at: Date | string;
};

/** Запись реестра из колонок: `null` → отсутствие необязательного поля. */
function toPack(row: PackRow): PackInstallation {
  return compact({
    name: row.name,
    version: row.version,
    kind: row.kind,
    packType: row.pack_type ?? undefined,
    description: row.description ?? undefined,
    status: row.status as PackInstallationStatus,
    requiresApproval: row.requires_approval,
    trustLevel: (row.trust_level ?? undefined) as CatalogTrustLevel | undefined,
    provides: (row.provides ?? emptyProvides()) as PackInstallationProvides,
    manifest: row.manifest ?? undefined,
    files: (row.files ?? undefined) as Record<string, string> | undefined,
    installedAt: toIsoRequired(row.installed_at),
    updatedAt: toIsoRequired(row.updated_at),
    installedBy: row.installed_by ?? undefined,
  }) as PackInstallation;
}

/** Реестр установок пакетов поверх таблицы `pack_installations`. */
export class PgPackRepository implements PackRepository {
  constructor(private readonly _deps: PortDeps) {}

  async save(pack: PackInstallation): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO pack_installations
         (name, version, kind, pack_type, description, status, requires_approval,
          trust_level, manifest, files, provides, installed_by, installed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12,
               $13::timestamptz, GREATEST($14::timestamptz, now()))
       ON CONFLICT (name) DO UPDATE SET
         version = EXCLUDED.version,
         kind = EXCLUDED.kind,
         pack_type = EXCLUDED.pack_type,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         requires_approval = EXCLUDED.requires_approval,
         trust_level = EXCLUDED.trust_level,
         manifest = EXCLUDED.manifest,
         files = EXCLUDED.files,
         provides = EXCLUDED.provides,
         installed_by = EXCLUDED.installed_by,
         installed_at = pack_installations.installed_at,
         updated_at = ${updatedAtExpr('pack_installations')}`,
      [
        pack.name,
        pack.version,
        pack.kind,
        pack.packType ?? null,
        pack.description ?? null,
        pack.status,
        pack.requiresApproval,
        pack.trustLevel ?? null,
        pack.manifest !== undefined ? jsonbParam(pack.manifest) : null,
        pack.files !== undefined ? jsonbParam(pack.files) : null,
        jsonbParam(pack.provides ?? emptyProvides()),
        pack.installedBy ?? null,
        pack.installedAt,
        pack.updatedAt,
      ],
    );
  }

  async get(name: string): Promise<PackInstallation | null> {
    const rows = await this._deps.connection.query<PackRow>(
      'SELECT * FROM pack_installations WHERE name = $1 LIMIT 1',
      [name],
    );
    return rows[0] ? toPack(rows[0]) : null;
  }

  async list(): Promise<PackInstallation[]> {
    const rows = await this._deps.connection.query<PackRow>(
      'SELECT * FROM pack_installations ORDER BY name ASC',
    );
    return rows.map(toPack);
  }

  async delete(name: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ name: string }>(
      'DELETE FROM pack_installations WHERE name = $1 RETURNING name',
      [name],
    );
    return rows.length > 0;
  }
}

/** Собрать порт реестра установок пакетов (ADR-086 §5). */
export function buildPackPorts(deps: PortDeps): PackPorts {
  return {
    packs: new PgPackRepository(deps),
  };
}
