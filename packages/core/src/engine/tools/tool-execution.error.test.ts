/**
 * tool-слой: ошибки исполнения и аргументов (ADR-041).
 *
 * `content` — полный en-текст от движка, `metadata.i18n` — та же информация
 * ключом и **всеми** параметрами шаблона: UI подставляет их сам, а потерянный
 * параметр дал бы в ленте сырой `{error}`/`{issues}` вместо текста.
 *
 * git-слой (ADR-076) бросает не только `Error`, но и plain-объекты
 * `{ error, code }` — `String()` от такого объекта даёт `[object Object]`.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolCapability, type ToolContext, type ToolDefinition } from '@itphx/synth-shared';
import { executeToolDef } from './tool-execution.js';

const context: ToolContext = {
  sessionId: 'sess-1',
  messageId: 'msg-1',
  workingDir: '/workspace/project',
};

/** Тул, который бросает заданное значение на любом вызове. */
function throwingTool(toolName: string, thrown: unknown): ToolDefinition {
  return {
    name: toolName,
    description: 'бросает ошибку',
    parameters: z.object({ path: z.string().optional() }),
    capabilities: [ToolCapability.RUNTIME],
    execute: async () => {
      throw thrown;
    },
  };
}

describe('executeToolDef — ошибка исполнения (tool.exec_error)', () => {
  it('plain-объект git-слоя: текст вместо [object Object], параметр error в metadata.i18n', async () => {
    const message = 'Директория не является git-репозиторием';
    const result = await executeToolDef(
      throwingTool('project_repo_fetch', { error: message, code: 'NOT_FOUND' }),
      {},
      context,
      'project_repo_fetch',
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(message);
    expect(result.content).not.toContain('[object Object]');
    expect(result.metadata?.i18n).toEqual({
      key: 'tool.exec_error',
      params: { tool: 'project_repo_fetch', error: message },
    });
  });

  it('Error: сообщение уходит и в content, и в metadata.i18n', async () => {
    const result = await executeToolDef(
      throwingTool('execute_shell', new Error('boom')),
      {},
      context,
      'execute_shell',
    );

    expect(result.content).toContain('boom');
    expect(result.metadata?.i18n).toEqual({
      key: 'tool.exec_error',
      params: { tool: 'execute_shell', error: 'boom' },
    });
  });
});

describe('executeToolDef — ошибка аргументов (tool.args_error)', () => {
  it('issues уходит в metadata.i18n — шаблон локализации не теряет {issues}', async () => {
    const tool: ToolDefinition = {
      name: 'project_repo_add',
      description: 'принимает path',
      parameters: z.object({ path: z.string() }),
      capabilities: [ToolCapability.RUNTIME],
      execute: async () => ({ content: 'ok' }),
    };

    const result = await executeToolDef(tool, { path: 42 }, context, 'project_repo_add');

    expect(result.isError).toBe(true);
    const params = result.metadata?.i18n as { key: string; params?: Record<string, string> };
    expect(params.key).toBe('tool.args_error');
    expect(params.params?.tool).toBe('project_repo_add');
    // Имя поля и сообщение валидатора — те же, что в content.
    expect(params.params?.issues).toContain('path');
    expect(result.content).toContain(params.params?.issues ?? '<нет issues>');
  });
});
