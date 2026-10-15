import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, McpManager } from '@itphx/synth-core';
import { createMcpRoutes as createCoreMcpRoutes } from '@itphx/synth-core';
import { createMcpRegistryRoutes } from './mcp-registry.js';
import type { McpRoutesOptions } from './mcp-registry.js';

export type { McpRoutesOptions } from './mcp-registry.js';

/**
 * Backend MCP: probe (`POST /probe`) — общая логика core-фабрики; legacy
 * `/servers*`, `/session/:id` и единый реестр `/registry*` (ADR-071) —
 * backend-only (см. `mcp-registry.ts`). Порядок монтирования: core probe
 * первым, затем backend-only.
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

  return app;
}
