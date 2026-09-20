import type { ToolDefinition, ToolForLLM, ToolCapability } from '@itphx/synth-shared';
import { zodToJsonSchema } from './json-schema.js';

export class ToolRegistry {
  private readonly _tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    // AD-071 §2.1: встроенные инструменты не тегируют источник явно — дефолт
    // `builtin` проставляется централизованно здесь; MCP-регистрация передаёт
    // `source: 'mcp'` + `mcpServer` и сохраняется как есть.
    this._tools.set(tool.name, { source: 'builtin', ...tool });
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  deregister(name: string): boolean {
    return this._tools.delete(name);
  }

  deregisterAll(names: string[]): void {
    for (const name of names) {
      this._tools.delete(name);
    }
  }

  deregisterByCapability(capability: ToolCapability): number {
    let count = 0;
    for (const [name, tool] of this._tools) {
      if (tool.capabilities.includes(capability)) {
        this._tools.delete(name);
        count++;
      }
    }
    return count;
  }

  get(name: string): ToolDefinition | undefined {
    return this._tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this._tools.values()];
  }

  /** AD-071 §2.1: встроенные инструменты (слой `tools`, stable). */
  listBuiltin(): ToolDefinition[] {
    return [...this._tools.values()].filter((tool) => (tool.source ?? 'builtin') === 'builtin');
  }

  /**
   * AD-071 §2.1: MCP-инструменты. Без `serverNames` — все зарегистрированные;
   * с набором — только инструменты указанных серверов (per-session выборка).
   */
  listMcp(serverNames?: Iterable<string>): ToolDefinition[] {
    const allowed = serverNames ? new Set(serverNames) : null;
    return [...this._tools.values()].filter((tool) => {
      if ((tool.source ?? 'builtin') !== 'mcp') return false;
      if (!allowed) return true;
      return tool.mcpServer != null && allowed.has(tool.mcpServer);
    });
  }

  /**
   * AD-071 §2.1: per-session выборка инструментов — встроенные + MCP только
   * активных серверов сессии. Порядок: сначала встроенные, затем MCP
   * (кэш-брейкпоинт ставится после встроенных, см. `stableToolCount`).
   *
   * AD-071 §2.3: фильтр отбирает только доступные тулы (режим `available`) —
   * на уровне `ToolDefinition`, до конвертации в LLM-формат (capabilities
   * теряются в `ToolForLLM`). Встроенные и MCP фильтруются **независимо**:
   * `predicate`-функция применяется к обоим слоям, объект — по слоям.
   */
  selectForSession(
    mcpServers?: Iterable<string>,
    predicate?:
      | ((tool: ToolDefinition) => boolean)
      | { builtin?: (tool: ToolDefinition) => boolean; mcp?: (tool: ToolDefinition) => boolean },
  ): { builtin: ToolForLLM[]; mcp: ToolForLLM[] } {
    const allowBuiltin = typeof predicate === 'function'
      ? predicate
      : (predicate?.builtin ?? (() => true));
    const allowMcp = typeof predicate === 'function'
      ? predicate
      : (predicate?.mcp ?? (() => true));
    return {
      builtin: this.listBuiltin().filter(allowBuiltin).map((tool) => this._toolToLLM(tool)),
      // Без набора серверов MCP-слой пуст (не «все MCP»): safety против утечки.
      mcp: this.listMcp(mcpServers ?? []).filter(allowMcp).map((tool) => this._toolToLLM(tool)),
    };
  }

  toLLMFormat(): ToolForLLM[] {
    const result: ToolForLLM[] = [];
    for (const tool of this._tools.values()) {
      result.push(this._toolToLLM(tool));
    }
    return result;
  }

  /**
   * AD-071 §2.1: инструменты для сессии — встроенные + MCP активных серверов.
   * Без `mcpServers` MCP-слой пуст (safety: не отдавать чужие MCP-тулы).
   */
  toLLMFormatForSession(mcpServers?: Iterable<string>): ToolForLLM[] {
    const selection = this.selectForSession(mcpServers);
    return [...selection.builtin, ...selection.mcp];
  }

  filterByCapabilities(capabilities: ToolCapability[]): ToolForLLM[] {
    const capabilitySet = new Set(capabilities);
    const result: ToolForLLM[] = [];
    for (const tool of this._tools.values()) {
      const hasCapability = tool.capabilities.some((c) => capabilitySet.has(c));
      if (hasCapability) {
        result.push(this._toolToLLM(tool));
      }
    }
    return result;
  }

  /**
   * AD-071 §2.6: LLM-представление одного тула — для расчёта `chars`/`estTokens`
   * (тот же формат, что уходит в слой `tools`/`mcp.tools` манифеста).
   */
  toLLM(tool: ToolDefinition): ToolForLLM {
    return this._toolToLLM(tool);
  }

  private _toolToLLM(tool: ToolDefinition): ToolForLLM {
    const jsonSchema = tool.jsonSchema ?? zodToJsonSchema(tool.parameters);
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: jsonSchema,
      },
    };
  }
}
