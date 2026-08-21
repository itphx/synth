import type { AgentDefinition, ToolCapability } from '@itphx/synth-shared';
import { normalizeAgentModes } from './normalize.js';
import type { ToolRegistry } from '../tools/registry.js';

export type AgentListFilterMode = 'primary' | 'subagent' | 'system' | 'all';

export class AgentRegistry {
  private readonly _agents = new Map<string, AgentDefinition>();
  private readonly _toolRegistry: ToolRegistry | null;

  constructor(toolRegistry?: ToolRegistry) {
    this._toolRegistry = toolRegistry ?? null;
  }

  register(agent: AgentDefinition): void {
    // Всегда храним agentMode как нормализованный массив
    this._agents.set(agent.id, { ...agent, agentMode: normalizeAgentModes(agent.agentMode) });
  }

  unregister(id: string): void {
    this._agents.delete(id);
  }

  registerAll(agents: AgentDefinition[]): void {
    for (const agent of agents) {
      this.register(agent);
    }
  }

  get(id: string): AgentDefinition | undefined {
    return this._agents.get(id);
  }

  list(filter?: { mode?: AgentListFilterMode }): AgentDefinition[] {
    let agents = [...this._agents.values()].filter((a) => a.enabled);

    if (filter?.mode) {
      const mode = filter.mode;
      agents = agents.filter((a) => {
        const modes = normalizeAgentModes(a.agentMode);
        if (mode === 'all') return true;
        return modes.includes(mode);
      });
    }

    return agents;
  }

  getSubagents(): AgentDefinition[] {
    return this.list({ mode: 'subagent' });
  }

  getToolsForAgent(agentId: string) {
    if (!this._toolRegistry) return undefined;

    const agent = this._agents.get(agentId);
    if (!agent) return undefined;

    const capabilities = (agent.capabilities || []) as ToolCapability[];
    return this._toolRegistry.filterByCapabilities(capabilities);
  }
}
