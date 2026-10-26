/**
 * Unit-тесты реестра миграций PostgreSQL-драйвера: новая миграция
 * `023_session_worktree` (ADR-114) зарегистрирована, идемпотентна и стоит
 * последней по версии.
 *
 * Живая БД не нужна: проверяется сам SQL (идемпотентность `IF NOT EXISTS`,
 * `COMMENT ON COLUMN`) и порядок/версия в реестре. Применение миграций против
 * живой БД — гейт `SYNTH_TEST_POSTGRES_DSN` (`postgres.integration.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import { MIGRATION_023_SESSION_WORKTREE } from './023-session-worktree.js';
import { MIGRATIONS, latestSchemaVersion } from './index.js';

describe('миграция 023_session_worktree (ADR-114)', () => {
  it('зарегистрирована в реестре под версией 23', () => {
    const migration = MIGRATIONS.find((m) => m.version === 23);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('023_session_worktree');
    expect(migration!.sql).toBe(MIGRATION_023_SESSION_WORKTREE);
    expect(latestSchemaVersion(MIGRATIONS)).toBe(23);
  });

  it('добавляет колонку worktree jsonb идемпотентно', () => {
    expect(MIGRATION_023_SESSION_WORKTREE).toContain(
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree jsonb;',
    );
    expect(MIGRATION_023_SESSION_WORKTREE).toContain('COMMENT ON COLUMN sessions.worktree');
  });

  it('версии реестра строго возрастают и уникальны', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
