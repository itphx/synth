import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, McpManager } from '@itphx/synth-core';
import {
  createMcpRoutes as createCoreMcpRoutes,
  createMcpRelayRoutes as createCoreMcpRelayRoutes,
} from '@itphx/synth-core';
import { createMcpRegistryRoutes } from './mcp-registry.js';
import type { McpRoutesOptions } from './mcp-registry.js';
import { createMcpRemoteRoutes } from './mcp-remote.js';
import { requireScopeForServiceKey } from '../auth/guards.js';

export type { McpRoutesOptions } from './mcp-registry.js';
export type { McpRemoteRoutesOptions } from './mcp-remote.js';
export { createMcpRemoteRoutes } from './mcp-remote.js';

/**
 * Backend MCP: probe (`POST /probe`) — общая логика core-фабрики; legacy
 * `/servers*`, `/session/:id` и единый реестр `/registry*` (ADR-071) —
 * backend-only (см. `mcp-registry.ts`); `/remote/*` — backend-контракт
 * удалённого MCP в режиме `tools` (PROP-125 §1, см. `mcp-remote.ts`);
 * `/relay/*` — серверный MCP-relay, режим `relay` (PROP-125 §1, фабрика
 * `createMcpRelayRoutes` в core).
 * Порядок монтирования: core probe первым, затем backend-only.
 */
export function createMcpRoutes(
  kit: AuthKit,
  mcpManager: McpManager | null,
  sessionManager: SessionManager | null,
  options: McpRoutesOptions,
): Hono {
  const app = new Hono();

  app.route('/', createCoreMcpRoutes(
    { requireAuth: kit.requireAuth },
    { mcpManager },
  ));
  app.route('/', createMcpRegistryRoutes(kit, mcpManager, sessionManager, options));
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
