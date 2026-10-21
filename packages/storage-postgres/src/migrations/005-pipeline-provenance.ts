/**
 * Миграция 005_pipeline_provenance — провенанс установки пайплайна
 * (ADR-101 §2.11): каким пакетом расширения принесён шаблон.
 *
 * Колонка `installed_by` в `pipeline_specs` — jsonb (`{pack, version}`),
 * ровно та же форма, что у legacy-определения ADR-100
 * (`PipelineDefinitionRecord.installedBy`). Значение может быть `NULL`:
 * пайплайн, созданный вручную, провенанса не имеет.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_005_PIPELINE_PROVENANCE = `
-- ── Pipeline Engine: провенанс установки (ADR-101 §2.11) ──────────────────────
ALTER TABLE pipeline_specs ADD COLUMN IF NOT EXISTS installed_by jsonb;
`;
