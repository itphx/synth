export { AgentRegistry } from './registry.js';
export { SUBAGENT_DEFINITIONS, PRIMARY_AGENT_DEFINITIONS } from './definitions.js';

import { AgentRegistry } from './registry.js';
import { SUBAGENT_DEFINITIONS, PRIMARY_AGENT_DEFINITIONS } from './definitions.js';
import type { ToolRegistry } from '../tools/registry.js';

export function createAgentRegistry(toolRegistry?: ToolRegistry): AgentRegistry {
  const registry = new AgentRegistry(toolRegistry);
  registry.registerAll([...PRIMARY_AGENT_DEFINITIONS, ...SUBAGENT_DEFINITIONS]);
  return registry;
}
