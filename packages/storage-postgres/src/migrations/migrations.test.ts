/**
 * Unit-тесты реестра миграций PostgreSQL-драйвера: новая миграция
 * `027_context_files` (ADR-116) зарегистрирована, идемпотентна и стоит
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
import { MIGRATION_025_PACKS_PIPELINES } from './025-packs-pipelines.js';
import { MIGRATION_026_INSTANCE_SKILLS } from './026-instance-skills.js';
import { MIGRATION_027_CONTEXT_FILES } from './027-context-files.js';
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
  it('зарегистрирована в реестре под версией 24', () => {
    const migration = MIGRATIONS.find((m) => m.version === 24);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('024_blob_refs');
    expect(migration!.sql).toBe(MIGRATION_024_BLOB_REFS);
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

describe('миграция 025_packs_pipelines (ADR-116)', () => {
  it('зарегистрирована в реестре под версией 25', () => {
    const migration = MIGRATIONS.find((m) => m.version === 25);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('025_packs_pipelines');
    expect(migration!.sql).toBe(MIGRATION_025_PACKS_PIPELINES);
  });

  it('заводит таблицу реестра установок пакетов с ключом по имени', () => {
    expect(MIGRATION_025_PACKS_PIPELINES).toContain(
      'CREATE TABLE IF NOT EXISTS pack_installations',
    );
    expect(MIGRATION_025_PACKS_PIPELINES).toMatch(/name\s+text PRIMARY KEY/);
    expect(MIGRATION_025_PACKS_PIPELINES).toMatch(/provides\s+jsonb NOT NULL/);
    expect(MIGRATION_025_PACKS_PIPELINES).toMatch(/installed_at\s+timestamptz NOT NULL/);
  });

  it('заводит определения и экземпляры legacy-пайплайнов с индексами выборки', () => {
    expect(MIGRATION_025_PACKS_PIPELINES).toContain(
      'CREATE TABLE IF NOT EXISTS pipeline_definitions',
    );
    expect(MIGRATION_025_PACKS_PIPELINES).toContain(
      'CREATE TABLE IF NOT EXISTS pipeline_instances',
    );
    expect(MIGRATION_025_PACKS_PIPELINES).toContain(
      'CREATE INDEX IF NOT EXISTS pipeline_instances_pipeline_idx ON pipeline_instances (pipeline_id);',
    );
    expect(MIGRATION_025_PACKS_PIPELINES).toContain(
      'CREATE INDEX IF NOT EXISTS pipeline_instances_created_idx ON pipeline_instances (created_at DESC);',
    );
  });

  it('идемпотентна (IF NOT EXISTS)', () => {
    expect(MIGRATION_025_PACKS_PIPELINES).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/);
    expect(MIGRATION_025_PACKS_PIPELINES).not.toMatch(/CREATE INDEX(?! IF NOT EXISTS)/);
  });
});

describe('миграция 026_instance_skills (ADR-116)', () => {
  it('зарегистрирована в реестре под версией 26', () => {
    const migration = MIGRATIONS.find((m) => m.version === 26);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('026_instance_skills');
    expect(migration!.sql).toBe(MIGRATION_026_INSTANCE_SKILLS);
  });

  it('заводит таблицу метаданных скиллов: имя — ключ, frontmatter jsonb', () => {
    expect(MIGRATION_026_INSTANCE_SKILLS).toContain('CREATE TABLE IF NOT EXISTS instance_skills');
    expect(MIGRATION_026_INSTANCE_SKILLS).toMatch(/name\s+text PRIMARY KEY/);
    expect(MIGRATION_026_INSTANCE_SKILLS).toMatch(/frontmatter\s+jsonb/);
    expect(MIGRATION_026_INSTANCE_SKILLS).toMatch(/updated_at\s+timestamptz NOT NULL/);
  });

  it('идемпотентна (IF NOT EXISTS)', () => {
    expect(MIGRATION_026_INSTANCE_SKILLS).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/);
  });
});

describe('миграция 027_context_files (ADR-116)', () => {
  it('зарегистрирована в реестре под версией 27 и последняя по версии', () => {
    const migration = MIGRATIONS.find((m) => m.version === 27);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('027_context_files');
    expect(migration!.sql).toBe(MIGRATION_027_CONTEXT_FILES);
    expect(latestSchemaVersion(MIGRATIONS)).toBe(27);
  });

  it('заводит таблицу файлов контекста: ключ (category, filename), content text', () => {
    expect(MIGRATION_027_CONTEXT_FILES).toContain('CREATE TABLE IF NOT EXISTS context_files');
    expect(MIGRATION_027_CONTEXT_FILES).toMatch(/category\s+text NOT NULL/);
    expect(MIGRATION_027_CONTEXT_FILES).toMatch(/filename\s+text NOT NULL/);
    expect(MIGRATION_027_CONTEXT_FILES).toMatch(/content\s+text NOT NULL/);
    expect(MIGRATION_027_CONTEXT_FILES).toContain('PRIMARY KEY (category, filename)');
  });

  it('идемпотентна (IF NOT EXISTS)', () => {
    expect(MIGRATION_027_CONTEXT_FILES).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/);
  });
});

describe('реестр миграций', () => {
  it('версии строго возрастают и уникальны', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
