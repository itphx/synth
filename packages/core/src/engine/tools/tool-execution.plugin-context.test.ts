/**
 * ADR-090: сужение контекста тула для инструментов плагинов.
 *
 * `inline`-плагин исполняется в процессе ядра, поэтому контекст тула не должен
 * выдавать ему internals ядра (`ctx.extra` — `sessionManager`/`projectStore`/
 * `eventBus`/сторы/порт исполнения, `ctx.dataDir` — корень данных инстанса).
 * По проводу (`out-of-process`) плагин получает только сериализуемый DTO —
 * inline-режим должен вести себя так же.
 *
 * Сужение живёт в одном chokepoint'е (`executeToolDef`), поэтому проверяем
 * именно его: встроенные и MCP-тулы получают контекст без изменений.
 *
 * PROP-138 (Ф1): плагинному тулу добавляется **узкий runtime** (`ctx.runtime`) —
 * команды и файловые операции через порт исполнения сессии; `extra`/`dataDir`
 * при этом по-прежнему не передаются.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolCapability, type ToolContext, type ToolDefinition } from '@itphx/synth-shared';
import type { ExecRequest, ExecResult, ExecutionPort } from '../../execution/ports/index.js';
import { executeToolDef } from './tool-execution.js';

/** Контекст вызова тула, как его собирает оркестратор (ADR-090 §Ф3в). */
function fullContext(): ToolContext {
  return {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    agentRole: 'assistant',
    workingDir: '/workspace/project',
    abortSignal: new AbortController().signal,
    dataDir: '/var/synth/data',
    extra: {
      sessionManager: { marker: 'core-internals' },
      projectStore: { marker: 'core-internals' },
      eventBus: { marker: 'core-internals' },
      profilesStore: { marker: 'core-internals' },
      sshKeyStore: { marker: 'core-internals' },
      gitService: { marker: 'core-internals' },
    },
  };
}

/** Тул заданного источника; `execute` запоминает полученный контекст. */
function toolOfSource(source: 'builtin' | 'mcp' | 'plugin', seen: { ctx?: ToolContext }): ToolDefinition {
  const tool: ToolDefinition = {
    name: `tool_${source}`,
    description: `тул источника ${source}`,
    parameters: z.object({ query: z.string() }),
    capabilities: [ToolCapability.SEARCH],
    execute: async (_params, ctx) => {
      seen.ctx = ctx;
      return { content: 'ok' };
    },
  };
  if (source === 'builtin') return tool;
  if (source === 'mcp') return { ...tool, source: 'mcp', mcpServer: 'srv' };
  return { ...tool, source: 'plugin', pluginName: 'my-plugin' };
}

/** Порт исполнения сессии с журналом запросов. */
function fakePort(): { port: ExecutionPort; requests: ExecRequest[] } {
  const requests: ExecRequest[] = [];
  const port: ExecutionPort = {
    async execute(req: ExecRequest): Promise<ExecResult> {
      requests.push(req);
      return { stdout: 'out', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
    },
  };
  return { port, requests };
}

describe('executeToolDef — контекст тула по источнику (ADR-090)', () => {
  it('тул плагина получает суженный контекст: без extra и dataDir', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('plugin', seen);

    const result = await executeToolDef(tool, { query: 'x' }, fullContext(), 'tool_plugin');

    expect(result.isError).toBeFalsy();
    const ctx = seen.ctx!;
    expect(ctx).toBeDefined();
    // Internals ядра наружу не отдаются.
    expect(ctx.extra).toBeUndefined();
    expect(ctx.dataDir).toBeUndefined();
    // Разрешённые поля на месте.
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.messageId).toBe('msg-1');
    expect(ctx.agentRole).toBe('assistant');
    expect(ctx.workingDir).toBe('/workspace/project');
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('суженный контекст плагина не содержит лишних полей', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('plugin', seen);

    await executeToolDef(tool, { query: 'x' }, fullContext(), 'tool_plugin');

    expect(Object.keys(seen.ctx!).sort()).toEqual([
      'abortSignal',
      'agentRole',
      'messageId',
      'sessionId',
      'workingDir',
    ]);
  });

  it('встроенный тул получает extra как раньше', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('builtin', seen);
    const context = fullContext();

    await executeToolDef(tool, { query: 'x' }, context, 'tool_builtin');

    const ctx = seen.ctx!;
    expect(ctx.extra).toBe(context.extra);
    expect(ctx.extra?.sessionManager).toEqual({ marker: 'core-internals' });
    expect(ctx.dataDir).toBe('/var/synth/data');
    expect(ctx).toBe(context);
  });

  it('MCP-тул не затронут: контекст полный', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('mcp', seen);
    const context = fullContext();

    await executeToolDef(tool, { query: 'x' }, context, 'tool_mcp');

    const ctx = seen.ctx!;
    expect(ctx.extra).toBe(context.extra);
    expect(ctx.dataDir).toBe('/var/synth/data');
    expect(ctx).toBe(context);
  });

  it('плагинный тул без agentRole/abortSignal — контекст остаётся валидным', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('plugin', seen);

    await executeToolDef(
      tool,
      { query: 'x' },
      { sessionId: 's', messageId: 'm', workingDir: '/ws' },
      'tool_plugin',
    );

    expect(Object.keys(seen.ctx!).sort()).toEqual(['messageId', 'sessionId', 'workingDir']);
    expect(seen.ctx!.extra).toBeUndefined();
  });
});

describe('executeToolDef — ctx.runtime плагинного тула (PROP-138 Ф1)', () => {
  it('плагинный тул получает runtime: команды идут через порт сессии', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('plugin', seen);
    const { port, requests } = fakePort();

    await executeToolDef(
      tool,
      { query: 'x' },
      { ...fullContext(), extra: { executionPort: port } },
      'tool_plugin',
    );

    const runtime = seen.ctx!.runtime;
    expect(runtime).toBeDefined();

    const result = await runtime!.exec(['git', 'status'], { cwd: '/workspace/project' });
    expect(result).toEqual({ stdout: 'out', stderr: '', exitCode: 0 });
    expect(requests[0]?.command).toEqual({ kind: 'argv', file: 'git', args: ['status'] });
    expect(requests[0]?.cwd).toBe('/workspace/project');
  });

  it('runtime не отменяет сужение: extra и dataDir по-прежнему не передаются', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('plugin', seen);
    const { port } = fakePort();

    await executeToolDef(
      tool,
      { query: 'x' },
      { ...fullContext(), extra: { executionPort: port } },
      'tool_plugin',
    );

    const ctx = seen.ctx!;
    expect(ctx.extra).toBeUndefined();
    expect(ctx.dataDir).toBeUndefined();
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.runtime).toBeDefined();
  });

  it('без порта исполнения runtime не добавляется', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('plugin', seen);

    await executeToolDef(tool, { query: 'x' }, fullContext(), 'tool_plugin');

    expect(seen.ctx!.runtime).toBeUndefined();
    expect(Object.keys(seen.ctx!).sort()).toEqual([
      'abortSignal',
      'agentRole',
      'messageId',
      'sessionId',
      'workingDir',
    ]);
  });

  it('чужой объект в extra.executionPort не считается портом — runtime нет', async () => {
    const seen: { ctx?: ToolContext } = {};
    const tool = toolOfSource('plugin', seen);

    await executeToolDef(
      tool,
      { query: 'x' },
      { ...fullContext(), extra: { executionPort: { notAPort: true } } },
      'tool_plugin',
    );

    expect(seen.ctx!.runtime).toBeUndefined();
  });

  it('встроенный и MCP-тулы runtime не получают (контекст без изменений)', async () => {
    for (const source of ['builtin', 'mcp'] as const) {
      const seen: { ctx?: ToolContext } = {};
      const tool = toolOfSource(source, seen);
      const { port } = fakePort();
      const context: ToolContext = { ...fullContext(), extra: { executionPort: port } };

      await executeToolDef(tool, { query: 'x' }, context, `tool_${source}`);

      expect(seen.ctx).toBe(context);
      expect(seen.ctx!.runtime).toBeUndefined();
    }
  });
});
