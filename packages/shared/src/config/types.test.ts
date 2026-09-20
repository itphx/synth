import { describe, it, expect } from 'vitest';
import { mcpServerConfigSchema } from './types.js';

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
