import type { AgentDefinition, ToolCapability } from '@synth/shared';
import type { ToolRegistry } from '../tools/registry.js';

export class AgentRegistry {
  private readonly _agents = new Map<string, AgentDefinition>();
  private readonly _toolRegistry: ToolRegistry | null;

  constructor(toolRegistry?: ToolRegistry) {
    this._toolRegistry = toolRegistry ?? null;
  }

  register(agent: AgentDefinition): void {
    this._agents.set(agent.id, agent);
  }

  registerAll(agents: AgentDefinition[]): void {
    for (const agent of agents) {
      this.register(agent);
    }
  }

  get(id: string): AgentDefinition | undefined {
    return this._agents.get(id);
  }

  list(filter?: { mode?: 'primary' | 'subagent' | 'all' }): AgentDefinition[] {
    let agents = [...this._agents.values()].filter((a) => a.enabled);

    if (filter?.mode) {
      agents = agents.filter((a) => {
        const agentMode = a.agentMode ?? 'primary';
        if (filter.mode === 'all') return true;
        if (filter.mode === 'subagent') return agentMode === 'subagent' || agentMode === 'all';
        return agentMode === 'primary' || agentMode === 'all';
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
