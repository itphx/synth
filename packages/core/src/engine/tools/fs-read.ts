import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition } from '@itphx/synth-shared';
import { resolvePath, validateInputPath } from './path-utils.js';
import { isAborted, abortedResult } from './abort.js';

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read contents of a file from the local filesystem. You can access any file directly by using this tool.',
  parameters: z.object({
    file_path: z.string().optional().describe('Path to the file to read (absolute or relative to the working directory; defaults to working directory)'),
    offset: z.number().int().min(0).optional().describe('Line offset to start reading from (0-based)'),
    limit: z.number().int().min(1).optional().describe('Maximum number of lines to read'),
  }),
  capabilities: [ToolCapability.FILE_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { file_path?: string; offset?: number; limit?: number };
    if (params.file_path !== undefined) validateInputPath(params.file_path, 'file_path');
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);

    let content = await readFile(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    const offset = params.offset ?? 0;
    const limit = params.limit ?? totalLines;

    if (offset > 0 || limit < totalLines) {
      content = lines.slice(offset, offset + limit).join('\n');
    }

    let output = '';
    for (let i = 0; i < lines.length; i++) {
      output += `${i + 1}: ${lines[i]}\n`;
    }

    return {
      content: output,
      metadata: { path: resolvedPath, totalLines, offset, limit },
    };
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description:
    'List files and directories in a given path. Use this to explore the project structure.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the directory to list (absolute or relative to the working directory; defaults to working directory)'),
  }),
  capabilities: [ToolCapability.FILE_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string };
    if (params.path !== undefined) validateInputPath(params.path, 'path');
    const resolvedPath = resolvePath(params.path, ctx.workingDir);

    const entries = await readdir(resolvedPath, { withFileTypes: true });
    const lines: string[] = [];

    for (const entry of entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })) {
      const fullPath = join(resolvedPath, entry.name);
      try {
        const info = await stat(fullPath);
        const suffix = entry.isDirectory() ? '/' : '';
        lines.push(`${entry.name}${suffix} (${info.size} bytes)`);
      } catch {
        lines.push(`${entry.name}${entry.isDirectory() ? '/' : ''}`);
      }
    }

    return {
      content: lines.join('\n') || '(пустая директория)',
      metadata: { path: resolvedPath, count: entries.length },
    };
  },
};

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Returns matching file paths sorted by modification time.',
  parameters: z.object({
    pattern: z.string().describe('Glob pattern to match files against (e.g., "src/**/*.ts")'),
    path: z.string().optional().describe('Directory to search in (absolute or relative to the working directory; defaults to working directory)'),
  }),
  capabilities: [ToolCapability.FILE_READ, ToolCapability.SEARCH],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { pattern: string; path?: string };
    if (params.path !== undefined) validateInputPath(params.path, 'path');
    const searchDir = resolvePath(params.path, ctx.workingDir);

    const { glob } = await import('node:fs/promises');
    const { relative: rel } = await import('node:path');

    try {
      const files = [];
      const basePattern = join(searchDir, params.pattern);
      for await (const file of glob(basePattern, { withFileTypes: false })) {
        const relPath = rel(searchDir, file as string);
        files.push(relPath);
      }

      return {
        content: files.length > 0 ? files.join('\n') : '(файлы не найдены)',
        metadata: { pattern: params.pattern, count: files.length },
      };
    } catch {
      return {
        content: '(ошибка поиска файлов)',
        isError: true,
        metadata: { pattern: params.pattern },
      };
    }
  },
};
