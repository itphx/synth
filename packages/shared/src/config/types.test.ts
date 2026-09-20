import { describe, it, expect } from 'vitest';
import { mcpServerConfigSchema, toolsConfigSchema } from './types.js';

describe('mcpServerConfigSchema (AD-071 §2.2)', () => {
  it('принимает optional description', () => {
    const parsed = mcpServerConfigSchema.parse({
      type: 'sse',
      url: 'http://localhost:8080/mcp',
      description: 'Мой MCP-сервер',
    });
    expect(parsed.description).toBe('Мой MCP-сервер');
  });

  it('description необязателен', () => {
    const parsed = mcpServerConfigSchema.parse({ type: 'stdio', command: 'node' });
    expect(parsed.description).toBeUndefined();
  });
});

describe('toolsConfigSchema (AD-071 §2.3)', () => {
  it('дефолт policy=consistency', () => {
    expect(toolsConfigSchema.parse({}).policy).toBe('consistency');
  });

  it('принимает available/auto', () => {
    expect(toolsConfigSchema.parse({ policy: 'available' }).policy).toBe('available');
    expect(toolsConfigSchema.parse({ policy: 'auto' }).policy).toBe('auto');
  });

  it('отклоняет неизвестную политику', () => {
    expect(toolsConfigSchema.safeParse({ policy: 'all' }).success).toBe(false);
  });
});
