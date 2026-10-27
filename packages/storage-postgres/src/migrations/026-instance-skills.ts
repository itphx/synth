/**
 * Миграция 026_instance_skills — instance-скиллы в SQL (ADR-116, ADR-046 §4):
 * метаданные (`frontmatter` из `SKILL.md`) — в таблице, **содержимое**
 * (`SKILL.md` и supporting-файлы) — в blob-сторе под `skills/<name>/…`
 * (blobs остаются файловыми по конструкции, ADR-116 §2).
 *
 * Таблица — только «какие скиллы есть» и их заголовок (для листингов и
 * дешёвой инвалидации кэша); тело и файлы читаются через `BlobStore` портом
 * `PgSkillRepository`.
 *
 * `frontmatter` — разобранный заголовок `SKILL.md` (jsonb, nullable: скилл может
 * быть создан без frontmatter — тогда `null`). `updated_at` — метка последней
 * записи (не отдаётся домену, служебная).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_026_INSTANCE_SKILLS = `
-- ADR-116: instance-скиллы — метаданные в SQL, содержимое в blob-сторе.
CREATE TABLE IF NOT EXISTS instance_skills (
  name        text PRIMARY KEY,
  frontmatter jsonb,
  updated_at  timestamptz NOT NULL
);
COMMENT ON TABLE instance_skills IS 'Instance-скиллы: заголовок SKILL.md в таблице, содержимое (SKILL.md + supporting) в blob-сторе skills/<name>/ (ADR-116)';
`;
