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
import { MIGRATION_028_MESSAGE_REASONING_SIGNATURE } from './028-message-reasoning-signature.js';
import { MIGRATION_029_MESSAGE_STREAM_V2 } from './029-message-stream-v2.js';
import { MIGRATION_030_SESSION_RETRY } from './030-session-retry.js';
import { MIGRATION_031_SSH_KEY_POLICY } from './031-ssh-key-policy.js';
import { MIGRATION_032_MCP_REMOTE_MODE } from './032-mcp-remote-mode.js';
import { MIGRATION_033_SESSION_SOURCE_ID } from './033-session-source-id.js';
import { MIGRATION_034_PENDING_APPROVALS } from './034-pending-approvals.js';
import { MIGRATION_035_PROJECT_ACCESS } from './035-project-access.js';
import { MIGRATION_036_MESSAGE_MENTIONS } from './036-message-mentions.js';
import { MIGRATION_037_TIMERS } from './037-timers.js';
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
  it('зарегистрирована в реестре под версией 27', () => {
    const migration = MIGRATIONS.find((m) => m.version === 27);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('027_context_files');
    expect(migration!.sql).toBe(MIGRATION_027_CONTEXT_FILES);
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

describe('миграция 028_message_reasoning_signature (Anthropic thinking)', () => {
  it('зарегистрирована в реестре под версией 28', () => {
    const migration = MIGRATIONS.find((m) => m.version === 28);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('028_message_reasoning_signature');
    expect(migration!.sql).toBe(MIGRATION_028_MESSAGE_REASONING_SIGNATURE);
  });

  it('добавляет колонки подписи thinking и redacted-блоков идемпотентно', () => {
    expect(MIGRATION_028_MESSAGE_REASONING_SIGNATURE).toContain(
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS reasoning_signature text;',
    );
    expect(MIGRATION_028_MESSAGE_REASONING_SIGNATURE).toContain(
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS reasoning_redacted jsonb;',
    );
    expect(MIGRATION_028_MESSAGE_REASONING_SIGNATURE).toContain(
      'COMMENT ON COLUMN messages.reasoning_signature',
    );
  });
});

describe('миграция 029_message_stream_v2 (ADR-118)', () => {
  it('зарегистрирована в реестре под версией 29', () => {
    const migration = MIGRATIONS.find((m) => m.version === 29);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('029_message_stream_v2');
    expect(migration!.sql).toBe(MIGRATION_029_MESSAGE_STREAM_V2);
  });

  it('добавляет колонки ord/turn_id/step_index/status идемпотентно', () => {
    expect(MIGRATION_029_MESSAGE_STREAM_V2).toContain(
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS ord integer;',
    );
    expect(MIGRATION_029_MESSAGE_STREAM_V2).toContain(
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_id text;',
    );
    expect(MIGRATION_029_MESSAGE_STREAM_V2).toContain(
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS step_index integer;',
    );
    expect(MIGRATION_029_MESSAGE_STREAM_V2).toContain(
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS status text;',
    );
  });

  it('заводит индекс по (session_id, ord) и не трогает seq', () => {
    expect(MIGRATION_029_MESSAGE_STREAM_V2).toContain(
      'CREATE INDEX IF NOT EXISTS messages_session_ord_idx ON messages (session_id, ord);',
    );
    // `seq` остаётся позиционным: ни колонка, ни уникальность не меняются.
    expect(MIGRATION_029_MESSAGE_STREAM_V2).not.toMatch(/ALTER TABLE messages\s+ADD COLUMN[^;]*\bseq\b/i);
    expect(MIGRATION_029_MESSAGE_STREAM_V2).not.toMatch(/DROP\s+(INDEX|CONSTRAINT)/i);
  });

  it('идемпотентна (IF NOT EXISTS)', () => {
    expect(MIGRATION_029_MESSAGE_STREAM_V2).not.toMatch(/ALTER TABLE(?! messages ADD COLUMN IF NOT EXISTS)/);
    expect(MIGRATION_029_MESSAGE_STREAM_V2).not.toMatch(/CREATE INDEX(?! IF NOT EXISTS)/);
  });
});

describe('миграция 030_session_retry (ADR-118 — активность сессии)', () => {
  it('зарегистрирована в реестре под версией 30', () => {
    const migration = MIGRATIONS.find((m) => m.version === 30);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('030_session_retry');
    expect(migration!.sql).toBe(MIGRATION_030_SESSION_RETRY);
  });

  it('добавляет колонку retry идемпотентно', () => {
    expect(MIGRATION_030_SESSION_RETRY).toContain(
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS retry jsonb;',
    );
    expect(MIGRATION_030_SESSION_RETRY).toContain('COMMENT ON COLUMN sessions.retry');
    expect(MIGRATION_030_SESSION_RETRY).not.toMatch(/ALTER TABLE(?! sessions ADD COLUMN IF NOT EXISTS)/);
  });
});

describe('реестр миграций', () => {
  it('версии строго возрастают и уникальны', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
describe('миграция 031_ssh_key_policy (PROP-124 — политика SSH-ключа)', () => {
  it('зарегистрирована в реестре под версией 31', () => {
    const migration = MIGRATIONS.find((m) => m.version === 31);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('031_ssh_key_policy');
    expect(migration!.sql).toBe(MIGRATION_031_SSH_KEY_POLICY);
  });

  it('добавляет колонки политики идемпотентно', () => {
    expect(MIGRATION_031_SSH_KEY_POLICY).toContain(
      'ALTER TABLE ssh_keys ADD COLUMN IF NOT EXISTS usages text[] NOT NULL DEFAULT ARRAY[\'git\'];',
    );
    expect(MIGRATION_031_SSH_KEY_POLICY).toContain(
      'ALTER TABLE ssh_keys ADD COLUMN IF NOT EXISTS allow_hosts text[] NOT NULL DEFAULT ARRAY[]::text[];',
    );
    expect(MIGRATION_031_SSH_KEY_POLICY).toContain(
      'ALTER TABLE ssh_keys ADD COLUMN IF NOT EXISTS allow_ports integer[] NOT NULL DEFAULT ARRAY[]::integer[];',
    );
    expect(MIGRATION_031_SSH_KEY_POLICY).not.toMatch(/ALTER TABLE(?! ssh_keys ADD COLUMN IF NOT EXISTS)/);
  });
});

describe('миграция 032_mcp_remote_mode (PROP-125 — режим доставки MCP-сервера)', () => {
  it('зарегистрирована в реестре под версией 32', () => {
    const migration = MIGRATIONS.find((m) => m.version === 32);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('032_mcp_remote_mode');
    expect(migration!.sql).toBe(MIGRATION_032_MCP_REMOTE_MODE);
  });

  it('добавляет колонку remote_mode идемпотентно', () => {
    expect(MIGRATION_032_MCP_REMOTE_MODE).toContain(
      "ALTER TABLE mcp_registry ADD COLUMN IF NOT EXISTS remote_mode text NOT NULL DEFAULT 'auto';",
    );
    expect(MIGRATION_032_MCP_REMOTE_MODE).toContain('COMMENT ON COLUMN mcp_registry.remote_mode');
    expect(MIGRATION_032_MCP_REMOTE_MODE).not.toMatch(/ALTER TABLE(?! mcp_registry ADD COLUMN IF NOT EXISTS)/);
  });
});

describe('миграция 033_session_source_id (маркер источника при переносе)', () => {
  it('зарегистрирована в реестре под версией 33', () => {
    const migration = MIGRATIONS.find((m) => m.version === 33);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('033_session_source_id');
    expect(migration!.sql).toBe(MIGRATION_033_SESSION_SOURCE_ID);
  });

  it('добавляет колонку и partial-индекс идемпотентно', () => {
    expect(MIGRATION_033_SESSION_SOURCE_ID).toContain(
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_session_id text;',
    );
    expect(MIGRATION_033_SESSION_SOURCE_ID).toContain(
      'CREATE INDEX IF NOT EXISTS sessions_project_source_idx ON sessions (project_id, source_session_id) WHERE source_session_id IS NOT NULL;',
    );
    expect(MIGRATION_033_SESSION_SOURCE_ID).toContain('COMMENT ON COLUMN sessions.source_session_id');
  });
});

describe('миграция 034_pending_approvals (ожидания подтверждений, ADR-029)', () => {
  it('зарегистрирована в реестре под версией 34', () => {
    const migration = MIGRATIONS.find((m) => m.version === 34);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('034_pending_approvals');
    expect(migration!.sql).toBe(MIGRATION_034_PENDING_APPROVALS);
  });

  it('создаёт таблицу ожиданий и индекс по сессии идемпотентно', () => {
    expect(MIGRATION_034_PENDING_APPROVALS).toContain(
      'CREATE TABLE IF NOT EXISTS pending_approvals (',
    );
    expect(MIGRATION_034_PENDING_APPROVALS).toContain(
      'CREATE INDEX IF NOT EXISTS pending_approvals_session_idx ON pending_approvals (session_id);',
    );
    expect(MIGRATION_034_PENDING_APPROVALS).toContain(
      'COMMENT ON TABLE pending_approvals',
    );
    // Ожидания лежат в отдельной таблице, а не в документе сессии: полная
    // запись сессии затирала бы точечные записи результатов параллельных тулов.
    expect(MIGRATION_034_PENDING_APPROVALS).not.toContain('ALTER TABLE sessions');
  });
});

describe('миграция 035_project_access (список доступа к проекту, PROP-133)', () => {
  it('зарегистрирована в реестре под версией 35', () => {
    const migration = MIGRATIONS.find((m) => m.version === 35);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('035_project_access');
    expect(migration!.sql).toBe(MIGRATION_035_PROJECT_ACCESS);
    expect(latestSchemaVersion(MIGRATIONS)).toBe(37);
  });

  it('добавляет колонки group_members и everyone_role идемпотентно', () => {
    expect(MIGRATION_035_PROJECT_ACCESS).toContain(
      'ALTER TABLE projects ADD COLUMN IF NOT EXISTS group_members jsonb',
    );
    expect(MIGRATION_035_PROJECT_ACCESS).toContain(
      'ALTER TABLE projects ADD COLUMN IF NOT EXISTS everyone_role text',
    );
    expect(MIGRATION_035_PROJECT_ACCESS).toContain(
      'COMMENT ON COLUMN projects.group_members',
    );
    expect(MIGRATION_035_PROJECT_ACCESS).not.toMatch(
      /ALTER TABLE(?! projects ADD COLUMN IF NOT EXISTS)/,
    );
  });

  it('аддитивна: состояние доступа по умолчанию — «только автор»', () => {
    // Пустые группы и NULL в «всем» — поведение до PROP-133 не меняется.
    expect(MIGRATION_035_PROJECT_ACCESS).toContain(
      "group_members jsonb NOT NULL DEFAULT '{}'::jsonb",
    );
    expect(MIGRATION_035_PROJECT_ACCESS).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    expect(MIGRATION_035_PROJECT_ACCESS).not.toMatch(/ALTER TABLE projects\s+ADD COLUMN(?! IF NOT EXISTS)/);
  });
});

describe('миграция 036_message_mentions (@-упоминания, ADR-126 §2)', () => {
  it('зарегистрирована под версией 36', () => {
    const migration = MIGRATIONS.find((m) => m.version === 36);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('036_message_mentions');
    expect(migration!.sql).toBe(MIGRATION_036_MESSAGE_MENTIONS);
    expect(latestSchemaVersion(MIGRATIONS)).toBe(37);
  });

  it('добавляет messages.mentions jsonb идемпотентно', () => {
    expect(MIGRATION_036_MESSAGE_MENTIONS).toContain(
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions jsonb',
    );
    expect(MIGRATION_036_MESSAGE_MENTIONS).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });
});

describe('миграция 037_timers (таймеры и будильники, PROP-141)', () => {
  it('зарегистрирована под версией 37 и последняя', () => {
    const migration = MIGRATIONS.find((m) => m.version === 37);
    expect(migration).toBeDefined();
    expect(migration!.id).toBe('037_timers');
    expect(migration!.sql).toBe(MIGRATION_037_TIMERS);
    expect(latestSchemaVersion(MIGRATIONS)).toBe(37);
  });

  it('заводит таблицу timers: проект и сессия обязательны, повтор — jsonb', () => {
    expect(MIGRATION_037_TIMERS).toContain('CREATE TABLE IF NOT EXISTS timers (');
    expect(MIGRATION_037_TIMERS).toMatch(/project_id\s+text NOT NULL/);
    expect(MIGRATION_037_TIMERS).toMatch(/session_id\s+text NOT NULL/);
    expect(MIGRATION_037_TIMERS).toMatch(/repeat\s+jsonb NOT NULL/);
    expect(MIGRATION_037_TIMERS).toMatch(/fires_at\s+timestamptz NOT NULL/);
  });

  it('заводит append-only таблицу timer_firings с порядком добавления', () => {
    expect(MIGRATION_037_TIMERS).toContain('CREATE TABLE IF NOT EXISTS timer_firings (');
    expect(MIGRATION_037_TIMERS).toMatch(/seq\s+bigserial PRIMARY KEY/);
    expect(MIGRATION_037_TIMERS).toMatch(/lag_ms\s+bigint NOT NULL/);
  });

  it('идемпотентна (IF NOT EXISTS)', () => {
    expect(MIGRATION_037_TIMERS).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/);
    expect(MIGRATION_037_TIMERS).not.toMatch(/CREATE INDEX(?! IF NOT EXISTS)/);
    expect(MIGRATION_037_TIMERS).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });
});
