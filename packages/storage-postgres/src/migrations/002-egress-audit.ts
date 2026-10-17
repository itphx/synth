/**
 * Миграция 002_egress_audit — журналы безопасности (egress/ADR-071).
 *
 * - `security_audit` — append-only аудит изменений egress/security-политик
 *   (`before_jsonb`/`after_jsonb` — снимки политики, `version` — версия записи);
 * - `egress_requests` — append-only журнал внешних запросов (без тел/заголовков;
 *   `url` — без query/userinfo, обрезан до 2048 символов); `via` — фактический
 *   маршрут `proxy`/`direct`/`fallback` (ADR-099 D1).
 *
 * `seq bigserial` — стабильный порядок «свежие первыми» (как у `maintenance_audit`).
 */

export const MIGRATION_002_EGRESS_AUDIT = `
-- Аудит изменений security/egress-политик.
CREATE TABLE security_audit (
  seq          bigserial PRIMARY KEY,
  id           text NOT NULL,
  ts           timestamptz NOT NULL,
  actor        text NOT NULL,
  scope        text NOT NULL,
  action       text NOT NULL,
  source       text NOT NULL,
  before_jsonb jsonb,
  after_jsonb  jsonb,
  version      integer NOT NULL DEFAULT 1
);
CREATE INDEX security_audit_ts_idx        ON security_audit (ts DESC);
CREATE INDEX security_audit_scope_ts_idx  ON security_audit (scope, ts DESC);

-- Журнал внешних запросов (egress); тела/заголовки не сохраняются.
CREATE TABLE egress_requests (
  seq          bigserial PRIMARY KEY,
  id           text NOT NULL,
  ts           timestamptz NOT NULL,
  scope        text NOT NULL,
  host         text NOT NULL,
  url          text NOT NULL,
  method       text,
  status       text NOT NULL,
  via          text,
  http_status  integer,
  bytes        bigint,
  duration_ms  integer,
  reason       text,
  matched_rule text,
  session_id   text,
  project_id   text,
  actor        text
);
CREATE INDEX egress_requests_ts_idx          ON egress_requests (ts DESC);
CREATE INDEX egress_requests_scope_ts_idx    ON egress_requests (scope, ts DESC);
CREATE INDEX egress_requests_status_ts_idx   ON egress_requests (status, ts DESC);
`;
