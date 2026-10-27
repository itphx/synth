/**
 * Unit-тесты реестра миграций PostgreSQL-драйвера: новая миграция
 * `024_blob_refs` (ADR-115/ADR-116) зарегистрирована, идемпотентна и стоит
 * последней по версии.
 *
 * Живая БД не нужна: проверяется сам SQL (идемпотентность `IF NOT EXISTS`,
 * первичный ключ, индекс) и порядок/версия в реестре. Применение миграций
 * против живой БД — гейт `SYNTH_TEST_POSTGRES_DSN`
 * (`postgres.integration.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import { MIGRATION_023_SESSION_WORKTREE } from './023-session-worktree.js';
import { MIGRATION_024_BLOB_REFS } from './024-blob-refs.js';
import { MIGRATIONS, latestSchemaVersion } from './index.js';

describe('миграция 023_session_worktree (ADR-114)', () => {
  it('зарегистрирована в реестре под версией 23', () => {
    const migration = MIGRATIONS.find((m) => m.version === 23);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('023_session_worktree');
    expect(migration!.sql).toBe(MIGRATION_023_SESSION_WORKTREE);
  });

  it('добавляет колонку worktree jsonb идемпотентно', () => {
    expect(MIGRATION_023_SESSION_WORKTREE).toContain(
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree jsonb;',
    );
    expect(MIGRATION_023_SESSION_WORKTREE).toContain('COMMENT ON COLUMN sessions.worktree');
  });
});

describe('миграция 024_blob_refs (ADR-115/ADR-116)', () => {
  it('зарегистрирована в реестре под версией 24 и последняя по версии', () => {
    const migration = MIGRATIONS.find((m) => m.version === 24);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('024_blob_refs');
    expect(migration!.sql).toBe(MIGRATION_024_BLOB_REFS);
    expect(latestSchemaVersion(MIGRATIONS)).toBe(24);
  });

  it('заводит таблицу blob_refs с первичным ключом по тройке и индексом по владельцу', () => {
    expect(MIGRATION_024_BLOB_REFS).toContain('CREATE TABLE IF NOT EXISTS blob_refs');
    expect(MIGRATION_024_BLOB_REFS).toContain('PRIMARY KEY (blob_path, owner_kind, owner_id)');
    expect(MIGRATION_024_BLOB_REFS).toContain(
      'CREATE INDEX IF NOT EXISTS blob_refs_owner_idx ON blob_refs (owner_kind, owner_id);',
    );
  });

  it('идемпотентна (IF NOT EXISTS)', () => {
    expect(MIGRATION_024_BLOB_REFS).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/);
    expect(MIGRATION_024_BLOB_REFS).not.toMatch(/CREATE INDEX(?! IF NOT EXISTS)/);
  });
});

describe('реестр миграций', () => {
  it('версии строго возрастают и уникальны', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
