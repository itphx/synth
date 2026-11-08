/**
 * Перепись доступа к маршрутам API v2 (аудит §6.1, F6+F7).
 *
 * Проверяет на **реально смонтированном** приложении (`createBackendApp`):
 *
 * 1) **Единый fail-closed гейт на границе.** Для КАЖДОГО маршрута `/api/v2/*`
 *    (кроме allowlist публичных путей и OPTIONS) запрос без `Authorization`
 *    → `401 UNAUTHORIZED`. Это машинная проверка гейта `app.use('/api/v2/*',
 *    requireAuth)` из `src/app.ts`: роутер, смонтированный без guard'а, больше
 *    не может стать анонимным незаметно.
 * 2) **Реестр динамических маршрутов.** Все маршруты с `:param` (и `*`)
 *    сверяются с явным `DECLARED_PARAM_ROUTES` — запись содержит правило
 *    доступа (`guard`) и ссылку на место реализации. Расхождение в любую
 *    сторону (новый/удалённый маршрут) роняет тест с diff'ом.
 * 3) **Негативная матрица «чужой»** для каждого динамического маршрута:
 *    `Bearer user-key-456` (debug-пользователь `developer`, роль `USER`) на
 *    несуществующий id → не `2xx` и не `500`; допустимые коды зафиксированы в
 *    записи реестра явно. Для ADMIN-гейтов — `403`.
 *
 * Правило проекта (инвариант 16): доступ к ресурсу проверяется на **границе**
 * (prefix-guard/guard фабрики), в обработчике проверок нет — поэтому здесь
 * проверяется именно код ответа границы, а не текст обработчика.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';
import { PUBLIC_API_V2_PATHS, isPublicApiV2Path } from './public-routes.js';

const ADMIN = 'admin-key-123';
const USER = 'user-key-456';
const LEAD = 'lead-key-789';

/** Несуществующий id для всех параметров (`:id`, `:sessionId`, `:name`, …). */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

// ---------------------------------------------------------------------------
// Правила доступа (guard): краткое описание + место реализации
// ---------------------------------------------------------------------------

const G_SESSION =
  'session-prefix (read/write по HTTP-методу): core src/server/session-access-guard.ts';
const G_PROJECT =
  'project-role (read=canReadProject, write=canEditProjectContent): core src/server/routes/project-work.ts';
const G_RUN =
  'run-project-role (прогон → его проект): core src/server/routes/pipeline-project-routes.ts (runGuard)';
const G_PROCESS =
  'process-access (право на сессию-владельца прогона): backend src/routes/processes.ts';
const G_MCP_SESSION =
  'session-owner|ADMIN: backend src/routes/mcp-registry.ts (sessionOwnerGuard)';
const G_OWNER = 'owner-only (только свои записи): core src/server/routes/{identities,oauth}.ts';
const G_AUTH = 'auth: requireAuth (ресурс инстанса — владельца у записи нет)';
const G_ADMIN = 'admin: requirePermission("ADMIN")';
const G_ADMIN_LEAD = 'admin-or-lead: requirePermission("ADMIN","LEAD")';
const G_ADMIN_AUDITOR = 'admin-or-auditor: requirePermission("ADMIN","AUDITOR")';
const G_ADMIN_OR_SCOPE =
  'admin-or-scope: backend src/auth/guards.ts requireAdminRoleOrScope(<scope>)';
const G_ADMIN_PROJECT =
  'admin + project-edit: core src/server/routes/pipeline-project-routes.ts (adminGuard/instantiate)';
const G_SCOPE =
  'service-key scope (интерактив — no-op): backend src/auth/service-scope.ts scopeGuard("events:ingest")';

/** Правила, требующие принадлежности ресурса — чужой USER никогда не получает 2xx. */
const OWNERSHIP_GUARDS = new Set<string>([
  G_SESSION,
  G_PROJECT,
  G_RUN,
  G_PROCESS,
  G_MCP_SESSION,
  G_OWNER,
]);

// ---------------------------------------------------------------------------
// Реестр динамических маршрутов
// ---------------------------------------------------------------------------

interface ParamRoute {
  method: string;
  path: string;
  guard: string;
  /** Допустимые коды для чужого USER на несуществующем id. */
  allow: readonly number[];
  /** Тело запроса (чтобы пройти валидацию и дойти до guard'а). */
  body?: unknown;
  /** Query для probe-запроса (chunked-загрузка требует `offset`). */
  query?: string;
  /** Обоснование, если для чужого USER допустим 2xx. */
  note?: string;
}

function r(
  method: string,
  path: string,
  guard: string,
  allow: readonly number[],
  extra: Omit<ParamRoute, 'method' | 'path' | 'guard' | 'allow'> = {},
): ParamRoute {
  return { method, path, guard, allow, ...extra };
}

const DECLARED_PARAM_ROUTES: readonly ParamRoute[] = [
  // --- Сессии: единый prefix-guard (владелец|ADMIN|проектная роль; LEAD/ADMIN — обзор) ---
  r('GET', '/api/v2/sessions/:id', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/status', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/prompt', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/memory', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/questions', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/stats', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/messages', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/messages/:messageId', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/children', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/tree', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/references', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/optimization', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/notes', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/todos', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/skills', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/skills/effective', G_SESSION, [404]),
  r('GET', '/api/v2/sessions/:id/attachments/:partId', G_SESSION, [404]),
  // Экспорт: доступ решает prefix-guard, привилегию карты обфускации — route-level
  // guard core (`createSessionExportGuard`); чужой — отказ границы.
  r('GET', '/api/v2/sessions/:id/export', G_SESSION, [404]),
  // MCP-скоуп сессии — владелец|ADMIN (ADR-071 §2.4): участники/LEAD не допускаются.
  // На неизвестной сессии prefix-guard отдаёт 404 раньше ролевого guard'а.
  r('GET', '/api/v2/sessions/:id/mcp', G_SESSION, [404]),
  // Карта обфускации — только ADMIN|AUDITOR (ролевой guard фабрики).
  r('GET', '/api/v2/sessions/:id/secrets', G_ADMIN_AUDITOR, [403]),
  r('PATCH', '/api/v2/sessions/:id', G_SESSION, [404]),
  r('PATCH', '/api/v2/sessions/:id/optimization', G_SESSION, [404]),
  r('PATCH', '/api/v2/sessions/:id/notes/:noteId', G_SESSION, [404]),
  r('PATCH', '/api/v2/sessions/:id/todos/:todoId', G_SESSION, [404]),
  r('PUT', '/api/v2/sessions/:id/mcp', G_SESSION, [404], { body: { mcpServers: [] } }),
  r('PUT', '/api/v2/sessions/:id/skills', G_SESSION, [404], { body: {} }),
  r('PUT', '/api/v2/sessions/:id/todos/order', G_SESSION, [404], { body: {} }),
  r('PUT', '/api/v2/sessions/:id/attachments/uploads/:uploadId', G_SESSION, [404], { query: 'offset=0' }),
  r('DELETE', '/api/v2/sessions/:id', G_SESSION, [404]),
  r('DELETE', '/api/v2/sessions/:id/notes/:noteId', G_SESSION, [404]),
  r('DELETE', '/api/v2/sessions/:id/references/:refSid', G_SESSION, [404]),
  r('DELETE', '/api/v2/sessions/:id/todos/:todoId', G_SESSION, [404]),
  r('DELETE', '/api/v2/sessions/:id/attachments/uploads/:uploadId', G_SESSION, [404]),
  r('POST', '/api/v2/sessions/:id/prompt', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/clear', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/abort', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/background', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/resume-subagent', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/summarize', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/fork', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/references', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/messages/merge', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/permissions/:approvalId', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/questions/:qid/answer', G_SESSION, [404], { body: { answers: [['a']] } }),
  r('POST', '/api/v2/sessions/:id/questions/:qid/cancel', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/notes', G_SESSION, [404], { body: { content: 'n' } }),
  r('POST', '/api/v2/sessions/:id/todos', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/todos/clear', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/optimization/check', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/optimization/cancel-summarization', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/debug-system-message', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/sessions/:id/attachments', G_SESSION, [404]),
  r('POST', '/api/v2/sessions/:id/attachments/uploads', G_SESSION, [404]),
  r('POST', '/api/v2/sessions/:id/attachments/uploads/:uploadId/complete', G_SESSION, [404], { body: {} }),

  // --- Сообщения и очередь: тот же предикат сессии (`:sessionId`) ---
  r('GET', '/api/v2/messages/:sessionId/:messageId/debug', G_SESSION, [404]),
  r('PATCH', '/api/v2/messages/:sessionId/:messageId/pin', G_SESSION, [404], { body: {} }),
  r('PATCH', '/api/v2/messages/:sessionId/:messageId/toggle', G_SESSION, [404], { body: {} }),
  r('DELETE', '/api/v2/messages/:sessionId/:messageId', G_SESSION, [404]),
  r('POST', '/api/v2/messages/:sessionId/:messageId/retry', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/messages/:sessionId/batch', G_SESSION, [404], { body: { action: 'pin', messageIds: [] } }),
  r('POST', '/api/v2/queue/:sessionId/clear', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/queue/:sessionId/return', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/queue/:sessionId/steer', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/queue/:sessionId/resume', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/queue/:sessionId/retry-now', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/queue/:sessionId/cancel-retry', G_SESSION, [404], { body: {} }),
  r('POST', '/api/v2/queue/:sessionId/reorder', G_SESSION, [404], { body: { ids: [] } }),

  // --- Проекты: правила проекта (чтение — canReadProject, мутации — canEditProjectContent) ---
  r('GET', '/api/v2/projects/:id', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/export', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/invariants', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/log', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/mcp', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/plan', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/skills', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/stats', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/worktrees', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/pipelines', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/pipelines/:pid', G_PROJECT, [404]),
  r('GET', '/api/v2/projects/:id/pipelines/:pid/runs', G_PROJECT, [404]),
  r('PUT', '/api/v2/projects/:id', G_PROJECT, [404], { body: {} }),
  r('PUT', '/api/v2/projects/:id/mcp', G_PROJECT, [404], { body: {} }),
  r('PUT', '/api/v2/projects/:id/skills', G_PROJECT, [404], { body: {} }),
  r('PUT', '/api/v2/projects/:id/invariants', G_PROJECT, [404], { body: { invariants: '' } }),
  r('PUT', '/api/v2/projects/:id/pipelines/:pid', G_PROJECT, [404], { body: {} }),
  r('PUT', '/api/v2/projects/:id/plan/columns/order', G_PROJECT, [404], { body: { order: [], version: 1 } }),
  // Валидация тела у plan/log идёт до проверки доступа; даём валидное тело,
  // чтобы проверить именно код границы (иначе было бы 400 «валидация тела»).
  r('POST', '/api/v2/projects/:id/log', G_PROJECT, [404], { body: { text: 'entry' } }),
  r('POST', '/api/v2/projects/:id/pipelines', G_PROJECT, [404], { body: {} }),
  r('POST', '/api/v2/projects/:id/pipelines/:pid/publish', G_PROJECT, [404], { body: {} }),
  r('POST', '/api/v2/projects/:id/pipelines/:pid/runs', G_PROJECT, [404], { body: {} }),
  r('POST', '/api/v2/projects/:id/plan/items', G_PROJECT, [404], { body: { title: 'x' } }),
  r('POST', '/api/v2/projects/:id/plan/columns', G_PROJECT, [404], { body: { name: 'c' } }),
  r('POST', '/api/v2/projects/:id/worktrees', G_PROJECT, [404], { body: {} }),
  r('POST', '/api/v2/projects/:id/worktrees/prune', G_PROJECT, [404], { body: {} }),
  r('PATCH', '/api/v2/projects/:id/log/:entryId', G_PROJECT, [404], { body: { text: 'entry' } }),
  r('PATCH', '/api/v2/projects/:id/plan/items/:itemId', G_PROJECT, [404], { body: { title: 'x' } }),
  r('PATCH', '/api/v2/projects/:id/plan/items/:itemId/move', G_PROJECT, [404], { body: { columnId: 'c' } }),
  r('PATCH', '/api/v2/projects/:id/plan/columns/:columnId', G_PROJECT, [404], { body: { name: 'c' } }),
  r('DELETE', '/api/v2/projects/:id', G_PROJECT, [404]),
  r('DELETE', '/api/v2/projects/:id/log/:entryId', G_PROJECT, [404]),
  r('DELETE', '/api/v2/projects/:id/pipelines/:pid', G_PROJECT, [404]),
  r('DELETE', '/api/v2/projects/:id/plan/items/:itemId', G_PROJECT, [404]),
  r('DELETE', '/api/v2/projects/:id/plan/columns/:columnId', G_PROJECT, [404], {
    body: { moveItemsTo: null, version: 1 },
  }),
  r('DELETE', '/api/v2/projects/:id/worktrees/:wid', G_PROJECT, [404]),

  // --- Прогоны пайплайнов и шаблоны ---
  r('GET', '/api/v2/pipeline-runs/:runId', G_RUN, [404]),
  r('GET', '/api/v2/pipeline-runs/:runId/artifacts/:name', G_RUN, [404]),
  r('POST', '/api/v2/pipeline-runs/:runId/cancel', G_RUN, [404], { body: {} }),
  r('POST', '/api/v2/pipeline-runs/:runId/resume', G_RUN, [404], { body: {} }),
  r('POST', '/api/v2/pipeline-templates/:tid/instantiate', G_ADMIN_PROJECT, [403], { body: {} }),

  // --- Legacy-контур пайплайнов инстанса (ADR-100) ---
  r('GET', '/api/v2/pipelines/:id', G_ADMIN, [403]),
  r('GET', '/api/v2/pipelines/instances/:instanceId', G_ADMIN, [403]),
  r('POST', '/api/v2/pipelines/:id/instances', G_ADMIN_OR_SCOPE, [403], { body: {} }),

  // --- Агенты и SSH-ключи ---
  r('GET', '/api/v2/agents/:id', G_ADMIN, [403]),
  r('PATCH', '/api/v2/agents/:id/enabled', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/agents/:id', G_ADMIN, [403]),
  // Чтение метаданных ключей агента — requireAuth (ADR-076: ключи — ресурс
  // инстанса, владельца у записи нет); неизвестный агент → пустой список.
  // Секрет наружу не отдаётся (`reveal()` только для git) — утечки нет.
  r('GET', '/api/v2/agents/:agentId/ssh-keys', G_AUTH, [200], {
    note: 'чтение метаданных ключей инстанса по requireAuth; неизвестный агент → {keys: []}',
  }),
  r('POST', '/api/v2/agents/:agentId/ssh-keys', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/agents/:agentId/ssh-keys/:keyId', G_ADMIN, [403]),
  r('GET', '/api/v2/ssh-keys/:id', G_AUTH, [404]),
  r('PATCH', '/api/v2/ssh-keys/:id', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/ssh-keys/:id', G_ADMIN, [403]),

  // --- Провайдеры, модели, контекст ---
  r('GET', '/api/v2/providers/:name', G_ADMIN, [403]),
  r('POST', '/api/v2/providers/:name/test', G_ADMIN, [403], { body: {} }),
  r('PATCH', '/api/v2/providers/:name', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/providers/:name', G_ADMIN, [403]),
  r('DELETE', '/api/v2/models/:id', G_ADMIN, [403]),
  r('GET', '/api/v2/context/files/:name', G_ADMIN, [403]),
  r('POST', '/api/v2/context/files/:name', G_ADMIN, [403], { body: {} }),
  r('POST', '/api/v2/context/files/:name/restore_to_default', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/context/files/:name', G_ADMIN, [403]),

  // --- Скиллы, команды, bundles, словари ---
  r('GET', '/api/v2/skills/:name', G_AUTH, [404]),
  r('GET', '/api/v2/skills/:name/files', G_AUTH, [404]),
  r('GET', '/api/v2/skills/:name/files/*', G_AUTH, [404]),
  r('PATCH', '/api/v2/skills/:name', G_ADMIN_OR_SCOPE, [403], { body: {} }),
  r('DELETE', '/api/v2/skills/:name', G_ADMIN_OR_SCOPE, [403]),
  r('PUT', '/api/v2/skills/:name/files/*', G_ADMIN_OR_SCOPE, [403], { body: {} }),
  r('DELETE', '/api/v2/skills/:name/files/*', G_ADMIN_OR_SCOPE, [403]),
  r('GET', '/api/v2/skill-bundles/:name', G_AUTH, [404]),
  r('PATCH', '/api/v2/skill-bundles/:name', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/skill-bundles/:name', G_ADMIN, [403]),
  // Чтение словаря — requireAuth (ресурс инстанса). Неизвестная категория
  // валидируется до чтения → 400; существующая, но не созданная — 404.
  r('GET', '/api/v2/dictionaries/:category/:lang', G_AUTH, [400, 404], {
    note: 'чтение справочника инстанса по requireAuth; неизвестная категория — 400 валидации',
  }),
  r('PUT', '/api/v2/dictionaries/:category/:lang', G_ADMIN, [403], { body: { entries: [] } }),
  r('DELETE', '/api/v2/dictionaries/:category/:lang', G_ADMIN, [403]),

  // --- События (ADR-089): биндинги и правила — ADMIN/LEAD ---
  r('GET', '/api/v2/events/bindings/:id/keys', G_ADMIN_LEAD, [403]),
  r('POST', '/api/v2/events/bindings/:id/keys', G_ADMIN_LEAD, [403], { body: {} }),
  r('PATCH', '/api/v2/events/bindings/:id/keys/:keyId', G_ADMIN_LEAD, [403], { body: {} }),
  r('DELETE', '/api/v2/events/bindings/:id/keys/:keyId', G_ADMIN_LEAD, [403]),
  r('POST', '/api/v2/events/bindings/:id/keys/:keyId/revoke', G_ADMIN_LEAD, [403], { body: {} }),
  r('DELETE', '/api/v2/events/bindings/:id', G_ADMIN_LEAD, [403]),
  r('DELETE', '/api/v2/events/routes/:id', G_ADMIN_LEAD, [403]),

  // --- Расписания (ADR-051): чтение — requireAuth, мутации — ADMIN ---
  r('GET', '/api/v2/schedules/:id/jobs', G_AUTH, [404]),
  r('PUT', '/api/v2/schedules/:id', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/schedules/:id', G_ADMIN, [403]),
  r('POST', '/api/v2/schedules/:id/run', G_ADMIN, [403], { body: {} }),

  // --- Service-key (ADR-052): только ADMIN ---
  r('GET', '/api/v2/service-keys/:id', G_ADMIN, [403]),
  r('PATCH', '/api/v2/service-keys/:id', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/service-keys/:id', G_ADMIN, [403]),
  r('POST', '/api/v2/service-keys/:id/revoke', G_ADMIN, [403], { body: {} }),

  // --- Webhooks (ADR-052 этап II): только ADMIN ---
  r('GET', '/api/v2/webhooks/:id', G_ADMIN, [403]),
  r('GET', '/api/v2/webhooks/:id/deliveries', G_ADMIN, [403]),
  r('PATCH', '/api/v2/webhooks/:id', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/webhooks/:id', G_ADMIN, [403]),
  r('POST', '/api/v2/webhooks/:id/regenerate', G_ADMIN, [403], { body: {} }),
  r('POST', '/api/v2/webhooks/:id/revoke', G_ADMIN, [403], { body: {} }),
  r('POST', '/api/v2/webhooks/:id/test', G_ADMIN, [403], { body: {} }),

  // --- Пользователи, логи, обслуживание ---
  r('GET', '/api/v2/users/:id', G_ADMIN, [403]),
  r('PUT', '/api/v2/users/:id', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/users/:id', G_ADMIN, [403]),
  r('GET', '/api/v2/logs/:name', G_ADMIN_AUDITOR, [403]),
  r('GET', '/api/v2/maintenance/backups/:name/download', G_ADMIN, [403]),
  r('DELETE', '/api/v2/maintenance/backups/:name', G_ADMIN, [403]),

  // --- MCP (ADR-071/ADR-125) ---
  r('GET', '/api/v2/mcp/servers/:name', G_AUTH, [404]),
  r('GET', '/api/v2/mcp/servers/:name/tools', G_AUTH, [404]),
  r('PUT', '/api/v2/mcp/servers/:name', G_ADMIN_OR_SCOPE, [403], { body: {} }),
  r('DELETE', '/api/v2/mcp/servers/:name', G_ADMIN_OR_SCOPE, [403]),
  r('POST', '/api/v2/mcp/servers/:name/test', G_ADMIN_OR_SCOPE, [403], { body: {} }),
  // Legacy-путь MCP-скоупа сессии — та же политика, что у `/sessions/:id/mcp`
  // (владелец|ADMIN). Дыра «любой аутентифицированный» закрыта guard'ом в
  // `src/routes/mcp-registry.ts` по результатам этой переписи.
  r('GET', '/api/v2/mcp/session/:sessionId', G_MCP_SESSION, [404]),
  r('PUT', '/api/v2/mcp/session/:sessionId', G_MCP_SESSION, [404], { body: {} }),
  // Реестр: мутации — автор записи или ADMIN (неизвестный id → 404 до роли).
  r('PUT', '/api/v2/mcp/registry/:id', 'admin-or-author: backend src/routes/mcp-registry.ts', [404], { body: {} }),
  r('DELETE', '/api/v2/mcp/registry/:id', 'admin-or-author: backend src/routes/mcp-registry.ts', [404]),
  // Relay (ADR-125): stateless JSON-режим — GET/DELETE не поддерживаются (405);
  // POST требует auth (+ scope `mcp:invoke` для service-key).
  r('GET', '/api/v2/mcp/relay/:name', G_AUTH, [405]),
  r('DELETE', '/api/v2/mcp/relay/:name', G_AUTH, [405]),
  r('POST', '/api/v2/mcp/relay/:name', G_AUTH, [404], { body: {} }),

  // --- Внешние доступы (ADR-105 Ф4): только свои (владелец|ADMIN/LEAD) ---
  r('GET', '/api/v2/oauth/credentials/:id', G_OWNER, [404]),
  r('DELETE', '/api/v2/oauth/credentials/:id', G_OWNER, [404]),
  r('POST', '/api/v2/oauth/credentials/:id/refresh', G_OWNER, [404], { body: {} }),
  r('POST', '/api/v2/oauth/credentials/:id/bind', G_OWNER, [404], { body: { connectorId: 'c' } }),

  // --- Идентичности (ADR-089): только свои ---
  r('DELETE', '/api/v2/me/identities/:provider/:externalId', G_OWNER, [404]),

  // --- Память (ADR-107/ADR-122): портал инстанса — только ADMIN ---
  r('GET', '/api/v2/memory/facts/:id', G_ADMIN, [403]),
  r('PATCH', '/api/v2/memory/indexes/:id', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/memory/indexes/:id', G_ADMIN, [403]),
  r('POST', '/api/v2/memory/indexes/:id/rebuild', G_ADMIN, [403], { body: {} }),

  // --- Вложения (ADR-115): staging без сессии, content-addressed ---
  r('GET', '/api/v2/attachments/:sha256', G_SCOPE, [404]),
  r('PUT', '/api/v2/attachments/uploads/:uploadId', G_SCOPE, [404], { query: 'offset=0' }),
  r('POST', '/api/v2/attachments/uploads/:uploadId/complete', G_SCOPE, [404], { body: {} }),
  // Отмена незавершённой chunked-загрузки идемпотентна (204 и для неизвестного
  // id): сессия загрузки — не ресурс владельца, данных не раскрывает.
  r('DELETE', '/api/v2/attachments/uploads/:uploadId', G_SCOPE, [204], {
    note: 'идемпотентная отмена staging-загрузки по uuid; объект не привязан к владельцу',
  }),

  // --- Пакеты расширений и плагины (ADR-086/ADR-090) ---
  r('GET', '/api/v2/packs/:name', G_ADMIN, [403]),
  r('POST', '/api/v2/packs/:name/approve', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/packs/:name', G_ADMIN, [403]),
  r('GET', '/api/v2/plugins/:name', G_ADMIN, [403]),
  r('POST', '/api/v2/plugins/:name/approve', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/plugins/:name', G_ADMIN, [403]),
  r('POST', '/api/v2/plugins/:name/enable', G_ADMIN_OR_SCOPE, [403], { body: {} }),
  r('POST', '/api/v2/plugins/:name/disable', G_ADMIN_OR_SCOPE, [403], { body: {} }),
  r('POST', '/api/v2/plugins/:name/rollback', G_ADMIN_OR_SCOPE, [403], { body: {} }),

  // --- Фоновые прогоны (PROP-096/097): право на сессию-владельца ---
  r('GET', '/api/v2/processes/:id', G_PROCESS, [404]),
  r('GET', '/api/v2/processes/:id/logs', G_PROCESS, [404]),
  r('POST', '/api/v2/processes/:id/stop', G_PROCESS, [404], { body: {} }),
  r('DELETE', '/api/v2/processes/:id', G_PROCESS, [404]),

  // --- Настройки: прокси/TLS профилей (ADR-099) — только ADMIN ---
  r('PUT', '/api/v2/settings/proxy/profiles/:name/password', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/settings/proxy/profiles/:name/password', G_ADMIN, [403]),
  r('PUT', '/api/v2/settings/proxy/profiles/:name/tls/ca', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/settings/proxy/profiles/:name/tls/ca', G_ADMIN, [403]),
  r('PUT', '/api/v2/settings/proxy/profiles/:name/tls/client', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/settings/proxy/profiles/:name/tls/client', G_ADMIN, [403]),
  r('PUT', '/api/v2/settings/tls/mappings/:id', G_ADMIN, [403], { body: {} }),
  r('DELETE', '/api/v2/settings/tls/mappings/:id', G_ADMIN, [403]),
];

// ---------------------------------------------------------------------------
// Интроспекция смонтированного приложения
// ---------------------------------------------------------------------------

interface HonoRoute {
  method: string;
  path: string;
}

function routesOf(app: Hono): HonoRoute[] {
  return (app as unknown as { routes: HonoRoute[] }).routes;
}

/** Уникальные маршруты `/api/v2/*` (без middleware `ALL`). */
function apiV2Routes(app: Hono): HonoRoute[] {
  const seen = new Map<string, HonoRoute>();
  for (const route of routesOf(app)) {
    if (route.method === 'ALL') continue;
    if (!route.path.startsWith('/api/v2/')) continue;
    seen.set(`${route.method} ${route.path}`, route);
  }
  return [...seen.values()].sort(
    (a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
  );
}

/** Динамические маршруты (`:param`, wildcard `*`) — предмет реестра. */
function paramRoutes(app: Hono): HonoRoute[] {
  return apiV2Routes(app).filter((route) => route.path.includes(':'));
}

/** Конкретный путь для probe: параметры и wildcard заменяются на заведомо чужие. */
function concretePath(path: string): string {
  return path
    .replace(/:([A-Za-z][A-Za-z0-9]*)/g, UNKNOWN_ID)
    .replace(/\*/g, 'probe.txt');
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

describe('API v2: перепись доступа (route access census)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-route-census-'));
    backend = await createBackendApp({
      dataDir,
      authDebug: true,
      // Метрики выключены фиксированно: внешний env инстанса не должен влиять
      // на набор маршрутов/побочные серии.
      env: { SYNTH_METRICS_ENABLED: 'false' },
    });
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    backend.stopWebhookService();
    backend.stopWebhookDeliveryPruner();
    backend.stopMetrics();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = (
    path: string,
    init: RequestInit = {},
    token?: string,
  ): Promise<Response> =>
    Promise.resolve(backend.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    }));

  // -------------------------------------------------------------------------
  // 1. Публичные пути — ровно allowlist, ничего больше
  // -------------------------------------------------------------------------

  it('allowlist публичных путей доступен без аутентификации', async () => {
    for (const route of PUBLIC_API_V2_PATHS) {
      const res = await req(route.path, { method: route.method });
      expect(res.status, `публичный ${route.method} ${route.path}`).toBe(200);
    }
  });

  it('публичность строгая по методу+пути: неизвестный i18n-язык и мутация того же пути → 401', async () => {
    for (const [method, path] of [
      ['GET', '/api/v2/i18n/translations/de'],
      ['POST', '/api/v2/i18n/current'],
      ['GET', '/api/v2/meta/extra'],
    ] as const) {
      const res = await req(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Fail-closed гейт: аноним на КАЖДОМ маршруте → 401 UNAUTHORIZED
  // -------------------------------------------------------------------------

  it('каждый маршрут /api/v2/* без креды → 401 UNAUTHORIZED (кроме публичных)', async () => {
    const routes = apiV2Routes(backend.app);
    // Перепись реально широкая (59 route-модулей) — защита от случайного
    // «пустого» списка маршрутов при поломке монтирования.
    expect(routes.length).toBeGreaterThan(400);

    for (const route of routes) {
      if (route.method === 'OPTIONS') continue;
      if (isPublicApiV2Path(route.method, route.path)) continue;
      const path = concretePath(route.path);
      const res = await req(path, {
        method: route.method,
        ...(BODY_METHODS.has(route.method)
          ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
          : {}),
      });
      expect(res.status, `аноним ${route.method} ${route.path}`).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${route.path}`).toBe('UNAUTHORIZED');
    }
  });

  it('неизвестный путь под /api/v2 тоже требует аутентификации (fail-closed)', async () => {
    const res = await req('/api/v2/__probe_no_such_route');
    expect(res.status).toBe(401);
  });

  it('CORS preflight (OPTIONS) не ломается гейтом', async () => {
    const res = await req('/api/v2/sessions', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5002',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
  });

  // -------------------------------------------------------------------------
  // 3. Реестр динамических маршрутов: сверка в обе стороны
  // -------------------------------------------------------------------------

  it('реестр динамических маршрутов совпадает с фактически смонтированными', () => {
    const actual = paramRoutes(backend.app).map((route) => `${route.method} ${route.path}`);
    const declared = DECLARED_PARAM_ROUTES.map((route) => `${route.method} ${route.path}`);
    const declaredSet = new Set(declared);
    const actualSet = new Set(actual);
    const missing = actual.filter((key) => !declaredSet.has(key));
    const extra = declared.filter((key) => !actualSet.has(key));
    // Diff в сообщении: добавили/убрали маршрут — видно, что именно.
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    // Дубликаты в реестре — тоже ошибка (скрывают расхождение).
    expect(declared.length).toBe(declaredSet.size);
  });

  it('допустимый 2xx для чужого USER — только с обоснованием в записи', () => {
    for (const route of DECLARED_PARAM_ROUTES) {
      const has2xx = route.allow.some((status) => status >= 200 && status < 300);
      if (has2xx) {
        expect(route.note, `${route.method} ${route.path}: 2xx без note`).toBeTruthy();
      }
      // Коды — только из известного набора (иначе «ожидание» превращается в
      // маскировку 500/произвольного ответа).
      for (const status of route.allow) {
        expect([200, 204, 400, 403, 404, 405], `${route.method} ${route.path} → ${status}`)
          .toContain(status);
      }
    }
  });

  it('правила принадлежности ресурса не допускают 2xx для чужого USER', () => {
    for (const route of DECLARED_PARAM_ROUTES) {
      if (!OWNERSHIP_GUARDS.has(route.guard)) continue;
      expect(
        route.allow.every((status) => status === 403 || status === 404),
        `${route.method} ${route.path} (${route.guard})`,
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Негативная матрица «чужой»: USER на несуществующий id
  // -------------------------------------------------------------------------

  it('чужой USER на каждом динамическом маршруте: не 2xx и не 500', async () => {
    for (const route of DECLARED_PARAM_ROUTES) {
      const path = concretePath(route.path) + (route.query ? `?${route.query}` : '');
      const res = await req(path, {
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
        ...(BODY_METHODS.has(route.method) ? { body: JSON.stringify(route.body ?? {}) } : {}),
      }, USER);
      expect(res.status, `чужой USER ${route.method} ${route.path}: 500`).not.toBe(500);
      expect(
        route.allow,
        `чужой USER ${route.method} ${route.path} → ${res.status} (допустимо: ${route.allow.join(', ')})`,
      ).toContain(res.status);
      if (!route.allow.some((status) => status >= 200 && status < 300)) {
        expect(res.status, `чужой USER ${route.method} ${route.path}`).toBeGreaterThanOrEqual(400);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 5. Порядок middleware: service-key проходит гейт (attachUser → гейт)
  // -------------------------------------------------------------------------

  it('service-key проходит гейт: scoped-ключ получает защищённый маршрут', async () => {
    const keyRes = await req('/api/v2/service-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'census-service', roles: ['USER'], scopes: ['sessions:read'] }),
    }, ADMIN);
    expect(keyRes.status).toBe(201);
    const key = ((await keyRes.json()) as { key: string }).key;

    // Гейт не блокирует service-key: кредентал разрешён `attachUser` до гейта,
    // `requireAuth` берёт пользователя из контекста.
    const res = await req('/api/v2/sessions', {}, key);
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 6. Закрытая дыра: legacy MCP-скоуп сессии (`/mcp/session/:sessionId`)
  //    Перепись выше видит только «несуществующую» сессию (404), поэтому
  //    владение проверяется отдельно на реальной чужой сессии.
  // -------------------------------------------------------------------------

  it('legacy MCP-скоуп сессии: чужой USER → 403, владелец → 200, ADMIN → 200', async () => {
    const created = await req('/api/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'census-mcp-scope' }),
    }, USER);
    expect(created.status).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;

    // Владелец читает и меняет свой MCP-скоуп.
    expect((await req(`/api/v2/mcp/session/${sessionId}`, {}, USER)).status).toBe(200);
    const ownWrite = await req(`/api/v2/mcp/session/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: [] }),
    }, USER);
    expect(ownWrite.status).toBe(200);

    // ADMIN — сквозной доступ (как у `/sessions/:id/mcp`).
    expect((await req(`/api/v2/mcp/session/${sessionId}`, {}, ADMIN)).status).toBe(200);

    // LEAD — нет: политика именно владелец|ADMIN (паритет с core-фабрикой).
    expect((await req(`/api/v2/mcp/session/${sessionId}`, {}, LEAD)).status).toBe(403);
    expect((await req(`/api/v2/mcp/session/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: [] }),
    }, LEAD)).status).toBe(403);

    // Чужой USER (service-key с ролью USER — другой principal) → 403.
    const keyRes = await req('/api/v2/service-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'census-stranger', roles: ['USER'], scopes: ['sessions:read'] }),
    }, ADMIN);
    expect(keyRes.status).toBe(201);
    const strangerKey = ((await keyRes.json()) as { key: string }).key;
    const denied = await req(`/api/v2/mcp/session/${sessionId}`, {}, strangerKey);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    const deniedWrite = await req(`/api/v2/mcp/session/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: [] }),
    }, strangerKey);
    expect(deniedWrite.status).toBe(403);
  });
});
