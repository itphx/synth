import { describe, it, expect } from 'vitest';
import { mcpServerConfigSchema, toolsConfigSchema, mcpNetworkPolicySchema, mcpConfigSchema, skillsConfigSchema } from './types.js';
import { DEFAULT_MCP_PRIVATE_CIDRS } from '../types/index.js';

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

  it('принимает HTTP-транспорт', () => {
    expect(mcpServerConfigSchema.parse({ type: 'http', url: 'https://x/mcp' }).type).toBe('http');
  });
});

describe('mcpNetworkPolicySchema (AD-071 §2.3.1)', () => {
  it('дефолт — deny приватных диапазонов', () => {
    const policy = mcpNetworkPolicySchema.parse({});
    expect(policy.mode).toBe('deny');
    expect(policy.list).toEqual([...DEFAULT_MCP_PRIVATE_CIDRS]);
  });

  it('mcpConfigSchema подставляет networkPolicy', () => {
    const parsed = mcpConfigSchema.parse({});
    expect(parsed.networkPolicy.mode).toBe('deny');
    expect(parsed.servers).toEqual({});
  });

  it('mcpConfigSchema: policy по умолчанию auto (AD-071 §2.3)', () => {
    expect(mcpConfigSchema.parse({}).policy).toBe('auto');
  });

  it('mcpConfigSchema принимает available/consistency', () => {
    expect(mcpConfigSchema.parse({ policy: 'available' }).policy).toBe('available');
    expect(mcpConfigSchema.parse({ policy: 'consistency' }).policy).toBe('consistency');
  });

  it('mcpConfigSchema отклоняет неизвестную политику', () => {
    expect(mcpConfigSchema.safeParse({ policy: 'all' }).success).toBe(false);
  });

  it('принимает настраиваемую allow-политику', () => {
    const parsed = mcpNetworkPolicySchema.parse({ mode: 'allow', list: ['127.0.0.0/8'] });
    expect(parsed.mode).toBe('allow');
    expect(parsed.list).toEqual(['127.0.0.0/8']);
  });

  it('отклоняет неизвестный режим', () => {
    expect(mcpNetworkPolicySchema.safeParse({ mode: 'block' }).success).toBe(false);
  });
});

describe('toolsConfigSchema (AD-071 §2.3)', () => {
  it('дефолт policy=auto', () => {
    expect(toolsConfigSchema.parse({}).policy).toBe('auto');
  });

  it('принимает available/auto', () => {
    expect(toolsConfigSchema.parse({ policy: 'available' }).policy).toBe('available');
    expect(toolsConfigSchema.parse({ policy: 'auto' }).policy).toBe('auto');
  });

  it('отклоняет неизвестную политику', () => {
    expect(toolsConfigSchema.safeParse({ policy: 'all' }).success).toBe(false);
  });
});

describe('skillsConfigSchema (AD-046)', () => {
  it('дефолты: пустые списки, inlineShell=false', () => {
    const parsed = skillsConfigSchema.parse({});
    expect(parsed.paths).toEqual([]);
    expect(parsed.urls).toEqual([]);
    expect(parsed.trustedProjectDirs).toEqual([]);
    expect(parsed.inlineShell).toBe(false);
  });

  it('принимает paths/urls/trustedProjectDirs/inlineShell', () => {
    const parsed = skillsConfigSchema.parse({
      paths: ['~/my-skills'],
      urls: ['https://example.com/skills'],
      trustedProjectDirs: ['/work/proj'],
      inlineShell: true,
    });
    expect(parsed.paths).toEqual(['~/my-skills']);
    expect(parsed.urls).toEqual(['https://example.com/skills']);
    expect(parsed.trustedProjectDirs).toEqual(['/work/proj']);
    expect(parsed.inlineShell).toBe(true);
  });

  it('urls: не-строковые значения отклоняются', () => {
    expect(skillsConfigSchema.safeParse({ urls: [42] }).success).toBe(false);
  });
});
