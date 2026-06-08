import type { ToolDefinition, ToolForLLM, ToolCapability } from '@synth/shared';
import { zodToJsonSchema } from './json-schema.js';

export class ToolRegistry {
  private readonly _tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this._tools.has(tool.name)) {
      throw new Error(`Инструмент с именем "${tool.name}" уже зарегистрирован`);
    }
    this._tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this._tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this._tools.values()];
  }

  toLLMFormat(): ToolForLLM[] {
    const result: ToolForLLM[] = [];
    for (const tool of this._tools.values()) {
      result.push(this._toolToLLM(tool));
    }
    return result;
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
