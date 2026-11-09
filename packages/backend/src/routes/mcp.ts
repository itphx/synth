import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, McpManager } from '@itphx/synth-core';
import {
  createMcpRoutes as createCoreMcpRoutes,
  createMcpRelayRoutes as createCoreMcpRelayRoutes,
  createMcpRegistryRoutes as createCoreMcpRegistryRoutes,
} from '@itphx/synth-core';
import type { McpRegistryRoutesOptions } from '@itphx/synth-core';
import { createMcpRemoteRoutes } from './mcp-remote.js';
import { requireAdminOrScope, requireScopeForServiceKey } from '../auth/guards.js';
import { t } from '../lib/i18n.js';

export type { McpRegistryRoutesOptions as McpRoutesOptions } from '@itphx/synth-core';
export type { McpRemoteRoutesOptions } from './mcp-remote.js';
export { createMcpRemoteRoutes } from './mcp-remote.js';

/**
 * Backend MCP: probe (`POST /probe`) — общая логика core-фабрики; legacy
 * `/servers*`, `/session/:id` и единый реестр `/registry*` (ADR-071) — общая
 * core-фабрика `createMcpRegistryRoutes` (backend передаёт RBAC-guard'ы и
 * i18n-сообщения, логика — одна); `/remote/*` — backend-контракт удалённого MCP
 * в режиме `tools` (PROP-125 §1, см. `mcp-remote.ts`); `/relay/*` — серверный
 * MCP-relay, режим `relay` (PROP-125 §1, фабрика `createMcpRelayRoutes` в core).
 * Порядок монтирования: core probe первым, затем backend-only.
 */
export function createMcpRoutes(
  kit: AuthKit,
  mcpManager: McpManager | null,
  sessionManager: SessionManager | null,
  options: McpRegistryRoutesOptions,
): Hono {
  const app = new Hono();

  app.route('/', createCoreMcpRoutes(
    { requireAuth: kit.requireAuth },
    { mcpManager },
  ));
  app.route('/', createCoreMcpRegistryRoutes(
    { requireAuth: kit.requireAuth, isAdmin: (c) => kit.isAdmin(c) },
    mcpManager,
    sessionManager,
    {
      ...options,
      // Managed RBAC (ADR-052/O1): `POST /servers` — только ADMIN; мутации
      // legacy-сервера — ADMIN или scope `addons:install`; `POST /registry` —
      // service-key обязан нести scope `addons:install` (интерактив — без
      // изменений).
      requireAdmin: kit.requireAdmin,
      requireAdminOrScope: requireAdminOrScope('addons:install'),
      requireScopeForServiceKey: requireScopeForServiceKey('addons:install'),
      // i18n (ADR-041): тексты ошибок — через `t()`.
      messages: {
        sessionNotFound: (c) => t('errors.notFound.session', undefined, c),
        forbidden: (c) => t('auth.forbidden', undefined, c),
        credentialNotFound: (c) => t('errors.notFound.credential', undefined, c),
      },
    },
  ));
  app.route('/', createMcpRemoteRoutes(kit, mcpManager, { registry: options.registry }));
  // PROP-125 §1: relay — полноценный MCP-endpoint одного серверного сервера.
  // Авторизация: интерактив — `requireAuth`; service-key — scope `mcp:invoke`.
  app.route('/', createCoreMcpRelayRoutes(
    { requireAuth: kit.requireAuth },
    {
      mcpManager,
      getEntry: (name) => options.registry.getByName(name),
      authorize: requireScopeForServiceKey('mcp:invoke'),
    },
  ));

  return app;
}
