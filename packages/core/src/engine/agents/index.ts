export { AgentRegistry } from './registry.js';
export { SUBAGENT_DEFINITIONS } from './definitions.js';

import { AgentRegistry } from './registry.js';
import { SUBAGENT_DEFINITIONS } from './definitions.js';
import type { ToolRegistry } from '../tools/registry.js';

export function createAgentRegistry(toolRegistry?: ToolRegistry): AgentRegistry {
  const registry = new AgentRegistry(toolRegistry);
  registry.registerAll(SUBAGENT_DEFINITIONS);
  return registry;
}
