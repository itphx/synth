/**
 * ADR-071 §2.1: тегирование источника инструментов и per-session выборка
 * (встроенные + MCP только активных серверов).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolCapability, type ToolDefinition } from '@itphx/synth-shared';
import { ToolRegistry } from './registry.js';

function builtinTool(name: string): ToolDefinition {
  return {
    name,
    description: `builtin ${name}`,
    parameters: z.object({}),
    capabilities: [ToolCapability.FILE_READ],
    execute: async () => ({ content: '' }),
  };
}

function mcpTool(server: string, name: string): ToolDefinition {
  return {
    name: `${server}_${name}`,
    description: `mcp ${name}`,
    parameters: z.object({}).passthrough(),
    capabilities: [ToolCapability.MCP],
    source: 'mcp',
    mcpServer: server,
    execute: async () => ({ content: '' }),
  };
}

describe('ToolRegistry — источник и per-session выборка (ADR-071 §2.1)', () => {
  it('встроенные тулы получают source: builtin по умолчанию', () => {
    const registry = new ToolRegistry();
    registry.register(builtinTool('read_file'));
    registry.register(mcpTool('srvA', 'search'));

    expect(registry.get('read_file')!.source).toBe('builtin');
    expect(registry.get('srvA_search')!.source).toBe('mcp');
    expect(registry.get('srvA_search')!.mcpServer).toBe('srvA');
  });

  it('selectForSession: builtin всегда, MCP — только активных серверов', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      builtinTool('read_file'),
      builtinTool('write_file'),
      mcpTool('srvA', 'search'),
      mcpTool('srvB', 'fetch'),
    ]);

    const selection = registry.selectForSession(['srvA']);
    expect(selection.builtin.map((t) => t.function.name)).toEqual(['read_file', 'write_file']);
    expect(selection.mcp.map((t) => t.function.name)).toEqual(['srvA_search']);
  });

  it('selectForSession без активных серверов → MCP-слой пуст (нет утечки)', () => {
    const registry = new ToolRegistry();
    registry.registerAll([builtinTool('read_file'), mcpTool('srvA', 'search')]);

    const selection = registry.selectForSession([]);
    expect(selection.mcp).toEqual([]);
    expect(selection.builtin.map((t) => t.function.name)).toEqual(['read_file']);
  });

  it('toLLMFormatForSession: порядок builtin → MCP', () => {
    const registry = new ToolRegistry();
    registry.registerAll([mcpTool('srvA', 'search'), builtinTool('read_file')]);

    const names = registry.toLLMFormatForSession(['srvA']).map((t) => t.function.name);
    expect(names).toEqual(['read_file', 'srvA_search']);
  });

  it('две сессии с разными наборами не влияют друг на друга', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      builtinTool('read_file'),
      mcpTool('srvA', 'search'),
      mcpTool('srvB', 'fetch'),
    ]);

    const sessionA = registry.selectForSession(['srvA']).mcp.map((t) => t.function.name);
    const sessionB = registry.selectForSession(['srvB']).mcp.map((t) => t.function.name);
    const sessionA2 = registry.selectForSession(['srvA']).mcp.map((t) => t.function.name);

    expect(sessionA).toEqual(['srvA_search']);
    expect(sessionB).toEqual(['srvB_fetch']);
    // Реестр не мутирован выборкой: повторная выборка сессии A стабильна.
    expect(sessionA2).toEqual(['srvA_search']);
  });
});
