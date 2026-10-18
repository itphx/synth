/**
 * Миграция 003_analytics_rollups — пред-агрегированные суточные роллапы (PROP-102).
 *
 * Таблица `analytics_rollups`: бакет = `(family, day, dimensions)` — составной
 * первичный ключ. `jsonb` в PK опирается на btree-операторы `jsonb` (нормализует
 * порядок ключей объекта), поэтому равенство измерений устойчиво и отдельный
 * `dimensions_key` не нужен; `ON CONFLICT (family, day, dimensions)` даёт
 * атомарный конкурентный upsert без advisory-локов. `measures`/`cost_by_currency`
 * — `jsonb`-словари чисел; пустая разбивка по валютам хранится как `NULL`
 * (не `{}`), чтобы отличать «нет стоимости» от «есть, но нулевая».
 */

export const MIGRATION_003_ANALYTICS_ROLLUPS = `
CREATE TABLE analytics_rollups (
  family           text  NOT NULL,
  day              text  NOT NULL,
  dimensions       jsonb NOT NULL,
  measures         jsonb NOT NULL,
  cost_by_currency jsonb,
  PRIMARY KEY (family, day, dimensions)
);
`;
