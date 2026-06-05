import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { relative } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@synth/shared';
import type { ToolDefinition } from '@synth/shared';

function resolvePath(requestedPath: string, workingDir: string): string {
  return resolve(workingDir, requestedPath);
}

function validatePath(resolvedPath: string, workingDir: string): void {
  const rel = relative(workingDir, resolvedPath);
  if (rel.startsWith('..')) {
    throw new Error(`Доступ запрещён: путь "${resolvedPath}" выходит за пределы рабочей директории`);
  }
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Write content to a file. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically.',
  parameters: z.object({
    file_path: z.string().describe('Absolute path to the file to write'),
    content: z.string().describe('Content to write to the file'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    const params = args as { file_path: string; content: string };
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);
    validatePath(resolvedPath, ctx.workingDir);

    const dir = dirname(resolvedPath);
    await mkdir(dir, { recursive: true });
    await writeFile(resolvedPath, params.content, 'utf-8');

    const lines = params.content.split('\n');
    return {
      content: `Файл записан: ${params.file_path} (${lines.length} строк, ${params.content.length} байт)`,
      metadata: { path: resolvedPath, lines: lines.length, bytes: params.content.length },
    };
  },
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Make exact string replacements in a file. The edit will FAIL if old_string is not unique in the file. Provide enough context to make the match unique.',
  parameters: z.object({
    file_path: z.string().describe('Absolute path to the file to modify'),
    old_string: z.string().describe('Text to replace (must be unique in file)'),
    new_string: z.string().describe('Text to replace it with'),
    replace_all: z.boolean().optional().default(false).describe('Replace all occurrences (default: false)'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    const params = args as { file_path: string; old_string: string; new_string: string; replace_all?: boolean };
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);
    validatePath(resolvedPath, ctx.workingDir);

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(resolvedPath, 'utf-8');

    if (params.replace_all) {
      const count = content.split(params.old_string).length - 1;
      if (count === 0) {
        return { content: `Ошибка: строка для замены не найдена в файле "${params.file_path}"`, isError: true };
      }
      const newContent = content.replaceAll(params.old_string, params.new_string);
      await writeFile(resolvedPath, newContent, 'utf-8');
      return {
        content: `Файл изменён: ${params.file_path} (${count} замен)`,
        metadata: { path: resolvedPath, replacements: count },
      };
    }

    const occurrences = content.split(params.old_string).length - 1;
    if (occurrences === 0) {
      return { content: `Ошибка: строка для замены не найдена в файле "${params.file_path}"`, isError: true };
    }
    if (occurrences > 1) {
      return {
        content: `Ошибка: найдено ${occurrences} совпадений строки для замены. Укажите больше контекста для уникального совпадения.`,
        isError: true,
      };
    }

    const newContent = content.replace(params.old_string, params.new_string);
    await writeFile(resolvedPath, newContent, 'utf-8');
    return {
      content: `Файл изменён: ${params.file_path} (1 замена)`,
      metadata: { path: resolvedPath, replacements: 1 },
    };
  },
};

export const createDirectoryTool: ToolDefinition = {
  name: 'create_directory',
  description: 'Create a new directory. Creates parent directories as needed.',
  parameters: z.object({
    path: z.string().describe('Absolute path to the directory to create'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    const params = args as { path: string };
    const resolvedPath = resolvePath(params.path, ctx.workingDir);
    validatePath(resolvedPath, ctx.workingDir);

    await mkdir(resolvedPath, { recursive: true });
    return {
      content: `Директория создана: ${params.path}`,
      metadata: { path: resolvedPath },
    };
  },
};

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Delete a file at the specified path.',
  parameters: z.object({
    file_path: z.string().describe('Absolute path to the file to delete'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    const params = args as { file_path: string };
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);
    validatePath(resolvedPath, ctx.workingDir);

    await rm(resolvedPath, { force: false });
    return {
      content: `Файл удалён: ${params.file_path}`,
      metadata: { path: resolvedPath },
    };
  },
};
