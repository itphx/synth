/**
 * Общий предел вывода инструментов в точке вызова тула (`executeToolDef`).
 *
 * Проверяем правила chokepoint'а:
 * - успешный результат длиннее лимита усекается (маркер + `metadata.truncated`
 *   + `metadata.outputBounded`);
 * - результат, который тул **сам** усек (`metadata.truncated === true`), не
 *   режется второй раз;
 * - результат с ошибкой (`isError`) не трогается;
 * - лимиты берутся из `ctx.extra.toolOutputLimits`, без них — дефолты секции
 *   `tools` (2000 строк / 51200 байт).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolCapability, type ToolContext, type ToolDefinition } from '@itphx/synth-shared';
import { executeToolDef } from './tool-execution.js';

function toolOf(
  execute: ToolDefinition['execute'],
): ToolDefinition {
  return {
    name: 'tool_test',
    description: 'тестовый тул',
    parameters: z.object({}),
    capabilities: [ToolCapability.SEARCH],
    execute,
  };
}

function ctxWith(extra?: Record<string, unknown>): ToolContext {
  return {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    workingDir: '/workspace',
    ...(extra ? { extra } : {}),
  };
}

describe('executeToolDef — общий предел вывода', () => {
  it('результат длиннее лимита усекается: маркер, truncated и outputBounded', async () => {
    const tool = toolOf(async () => ({ content: ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n') }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.isError).toBeFalsy();
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 2, totalLines: 5 });
    expect(result.content.startsWith('l1\nl2')).toBe(true);
    expect(result.content).not.toContain('l3');
    expect(result.content).toContain('Output truncated');
  });

  it('результат в лимите не трогается', async () => {
    const tool = toolOf(async () => ({ content: 'l1\nl2' }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 5, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.content).toBe('l1\nl2');
    expect(result.metadata?.truncated).toBeUndefined();
    expect(result.metadata?.outputBounded).toBeUndefined();
  });

  it('тул, усекший вывод сам (metadata.truncated), не режется второй раз', async () => {
    const content = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const tool = toolOf(async () => ({
      content,
      metadata: { truncated: true },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.content).toBe(content);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toBeUndefined();
  });

  it('результат с ошибкой (isError) не усекается', async () => {
    const content = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const tool = toolOf(async () => ({
      content,
      isError: true,
      metadata: { reason: 'failed' },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe(content);
    expect(result.metadata?.truncated).toBeUndefined();
    expect(result.metadata?.outputBounded).toBeUndefined();
  });

  it('лимиты берутся из ctx.extra.toolOutputLimits', async () => {
    const tool = toolOf(async () => ({ content: 'a'.repeat(100) }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 100, maxBytes: 10 } }),
      'tool_test',
    );

    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 1, totalLines: 1 });
    // Байтовый лимит (10) жёстче лимита строк (100).
    expect(Buffer.byteLength(result.content.split('\n\n')[0]!, 'utf8')).toBeLessThanOrEqual(10);
  });

  it('без лимитов в extra — дефолт секции tools (2000 строк / 51200 байт)', async () => {
    const tool = toolOf(async () => ({ content: 'x'.repeat(60_000) }));

    const result = await executeToolDef(tool, {}, ctxWith(), 'tool_test');

    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 1, totalLines: 1 });
    expect(Buffer.byteLength(result.content.split('\n\n')[0]!, 'utf8')).toBeLessThanOrEqual(51_200);
  });

  it('вывод в дефолтных лимитах не усекается', async () => {
    const tool = toolOf(async () => ({ content: 'x'.repeat(1000) }));

    const result = await executeToolDef(tool, {}, ctxWith(), 'tool_test');

    expect(result.metadata?.truncated).toBeUndefined();
    expect(result.content).toBe('x'.repeat(1000));
  });
});
