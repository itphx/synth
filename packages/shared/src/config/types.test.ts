import { describe, it, expect } from 'vitest';
import { mcpServerConfigSchema, toolsConfigSchema, mcpNetworkPolicySchema, mcpConfigSchema, skillsConfigSchema, instructionsConfigSchema, instructionSourceConfigSchema, metricsConfigSchema, executionConfigSchema } from './types.js';
import { DEFAULT_MCP_PRIVATE_CIDRS } from '../types/index.js';

describe('mcpServerConfigSchema (ADR-071 §2.2)', () => {
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

  it('PROP-107 Ф0: принимает auth.kind=credential со ссылкой на доступ', () => {
    const parsed = mcpServerConfigSchema.parse({
      type: 'http',
      url: 'https://x/mcp',
      auth: { kind: 'credential', credentialId: 'extc_1' },
    });
    expect(parsed.auth).toEqual({ kind: 'credential', credentialId: 'extc_1' });
  });

  it('PROP-107 Ф0: старые записи без auth остаются валидными', () => {
    const parsed = mcpServerConfigSchema.parse({ type: 'stdio', command: 'node' });
    expect(parsed.auth).toBeUndefined();
  });

  it('PROP-107 Ф0: невалидный auth отклоняется (пустой credentialId/неизвестный kind)', () => {
    expect(
      mcpServerConfigSchema.safeParse({
        type: 'http',
        url: 'https://x/mcp',
        auth: { kind: 'credential', credentialId: '' },
      }).success,
    ).toBe(false);
    expect(
      mcpServerConfigSchema.safeParse({
        type: 'http',
        url: 'https://x/mcp',
        auth: { kind: 'header', credentialId: 'extc_1' },
      }).success,
    ).toBe(false);
  });
});

describe('mcpNetworkPolicySchema (ADR-071 §2.3.1)', () => {
  it('дефолт — deny приватных диапазонов + пустые exceptions', () => {
    const policy = mcpNetworkPolicySchema.parse({});
    expect(policy.mode).toBe('deny');
    expect(policy.list).toEqual([...DEFAULT_MCP_PRIVATE_CIDRS]);
    expect(policy.exceptions).toEqual([]);
  });

  it('mcpConfigSchema подставляет networkPolicy', () => {
    const parsed = mcpConfigSchema.parse({});
    expect(parsed.networkPolicy.mode).toBe('deny');
    expect(parsed.servers).toEqual({});
  });

  it('mcpConfigSchema: policy по умолчанию auto (ADR-071 §2.3)', () => {
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

describe('toolsConfigSchema (ADR-071 §2.3)', () => {
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

describe('skillsConfigSchema (ADR-046)', () => {
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

describe('instructionsConfigSchema (ADR-069)', () => {
  it('дефолты: enabled/claudeCompat, кап от окна, пустые sources/excludeProjects', () => {
    const parsed = instructionsConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.claudeCompat).toBe(true);
    expect(parsed.contextCompat).toBe(false);
    expect(parsed.headRatio).toBe(0.7);
    expect(parsed.tailRatio).toBe(0.2);
    expect(parsed.maxChars).toBeUndefined();
    expect(parsed.windowRatio).toBe(0.06);
    expect(parsed.minChars).toBe(20_000);
    expect(parsed.maxCharsCeiling).toBe(500_000);
    expect(parsed.sources).toEqual([]);
    expect(parsed.excludeProjects).toEqual([]);
    expect(parsed.allowInstallTreeFallback).toBe(false);
  });

  it('дефолты lazy и fetch (ADR-069 §4/§5.1)', () => {
    const parsed = instructionsConfigSchema.parse({});
    expect(parsed.lazy).toEqual({
      enabled: true,
      maxAncestors: 5,
      maxChars: 8_000,
      excludeDirs: ['node_modules', '.git', 'vendor', 'dist', 'build', '.next', 'coverage', 'tmp', '.cache'],
    });
    expect(parsed.fetch).toEqual({ timeoutMs: 5_000, cacheTtlSec: 3_600, maxBytes: 262_144 });
  });

  it('источник: position по умолчанию after, kind path|url, ttlSec опционален', () => {
    const parsed = instructionSourceConfigSchema.parse({ kind: 'url', value: 'https://x/AGENTS.md' });
    expect(parsed.position).toBe('after');
    expect(parsed.ttlSec).toBeUndefined();
    expect(
      instructionSourceConfigSchema.parse({
        kind: 'path',
        value: './extra.md',
        position: 'before',
        label: 'extra',
        ttlSec: 60,
      }).position,
    ).toBe('before');
  });

  it('источник: неизвестный kind/position отклоняются', () => {
    expect(instructionSourceConfigSchema.safeParse({ kind: 'ftp', value: 'x' }).success).toBe(false);
    expect(
      instructionSourceConfigSchema.safeParse({ kind: 'path', value: 'x', position: 'middle' }).success,
    ).toBe(false);
  });

  it('принимает maxChars-override и excludeProjects', () => {
    const parsed = instructionsConfigSchema.parse({
      maxChars: 40_000,
      excludeProjects: ['remote:p1'],
      sources: [{ kind: 'url', value: 'https://example.com/AGENTS.md' }],
    });
    expect(parsed.maxChars).toBe(40_000);
    expect(parsed.excludeProjects).toEqual(['remote:p1']);
    expect(parsed.sources).toHaveLength(1);
  });
});

describe('executionConfigSchema (ADR-077)', () => {
  it('дефолты: mode=inline, remote без адресов, 30 с, fail-closed', () => {
    const parsed = executionConfigSchema.parse({});
    expect(parsed.mode).toBe('inline');
    expect(parsed.remote.url).toEqual([]);
    expect(parsed.remote.timeoutMs).toBe(30_000);
    expect(parsed.remote.failMode).toBe('fail');
    expect(parsed.remote.tokenSecret).toBe('');
    expect(parsed.remote.concurrency).toBeUndefined();
  });

  it('принимает список адресов исполнителей и параметры remote', () => {
    const parsed = executionConfigSchema.parse({
      mode: 'remote',
      remote: {
        url: ['http://synth-executor:8080'],
        timeoutMs: 60_000,
        concurrency: 4,
        failMode: 'inline-fallback',
        tokenSecret: '/var/synth/secrets/executor-token',
      },
    });
    expect(parsed.mode).toBe('remote');
    expect(parsed.remote.url).toEqual(['http://synth-executor:8080']);
    expect(parsed.remote.timeoutMs).toBe(60_000);
    expect(parsed.remote.concurrency).toBe(4);
    expect(parsed.remote.failMode).toBe('inline-fallback');
    expect(parsed.remote.tokenSecret).toBe('/var/synth/secrets/executor-token');
  });

  it('fail-closed: неизвестный mode отклоняется схемой', () => {
    expect(executionConfigSchema.safeParse({ mode: 'inlne' }).success).toBe(false);
  });

  it('fail-closed: неизвестный failMode отклоняется схемой', () => {
    expect(
      executionConfigSchema.safeParse({ remote: { failMode: 'fallback' } }).success,
    ).toBe(false);
  });

  it('нечисловые/неположительные значения отклоняются', () => {
    expect(
      executionConfigSchema.safeParse({ remote: { timeoutMs: 0 } }).success,
    ).toBe(false);
    expect(
      executionConfigSchema.safeParse({ remote: { concurrency: 0 } }).success,
    ).toBe(false);
  });
});
