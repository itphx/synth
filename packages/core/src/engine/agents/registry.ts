import type { AgentDefinition } from '@itphx/synth-shared';
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

  /**
   * AD-070 §2.9 + AD-071 §2.1: тулы постоянны — найденный агент видит **все
   * встроенные** тулы, без фильтра по capabilities. Definition остаётся в
   * запросе; ролевые ограничения передаются permission-слоем как
   * `unavailable(role)` (см. AD-070 §2.9.1), а не скрытием тула.
   *
   * MCP-тулы — per-session: в выборку попадают только инструменты активных
   * серверов (`mcpServers`), переданных вызывающей стороной. Без `mcpServers`
   * MCP-слой пуст (нет кросс-сессионной утечки). Неизвестный агент (или
   * отсутствующий ToolRegistry) → `undefined` — safety-fallback.
   */
  getToolsForAgent(agentId: string, mcpServers?: Iterable<string>) {
    if (!this._toolRegistry) return undefined;

    const agent = this._agents.get(agentId);
    if (!agent) return undefined;

    return this._toolRegistry.toLLMFormatForSession(mcpServers);
  }
}
