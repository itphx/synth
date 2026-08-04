import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@synth/shared';
import type { ToolDefinition } from '@synth/shared';
import { resolvePath, validateInputPath } from './path-utils.js';

function generateUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: string[] = [];

  result.push(`--- a/${filePath}`);
  result.push(`+++ b/${filePath}`);

  const eq = longestCommonSubsequence(oldLines, newLines);
  let oi = 0; let ni = 0;
  for (let i = 0; i < eq.length; i++) {
    const entry = eq[i]!;
    const targetOld = entry[0];
    const targetNew = entry[1];
    if (oi < targetOld || ni < targetNew) {
      result.push(`@@ -${oi + 1},${targetOld - oi} +${ni + 1},${targetNew - ni} @@`);
      for (let j = oi; j < targetOld; j++) result.push(`-${oldLines[j]}`);
      for (let j = ni; j < targetNew; j++) result.push(`+${newLines[j]}`);
    }
    result.push(` ${oldLines[targetOld]}`);
    oi = targetOld + 1;
    ni = targetNew + 1;
  }
  if (oi < oldLines.length || ni < newLines.length) {
    result.push(`@@ -${oi + 1},${oldLines.length - oi} +${ni + 1},${newLines.length - ni} @@`);
    for (let j = oi; j < oldLines.length; j++) result.push(`-${oldLines[j]}`);
    for (let j = ni; j < newLines.length; j++) result.push(`+${newLines[j]}`);
  }

  return result.join('\n');
}

function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
  const m = a.length; const n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    const row = dp[i]!;
    const prevRow = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1] ? (prevRow[j - 1] ?? 0) + 1 : Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
    }
  }

  const result: [number, number][] = [];
  let i = m; let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.unshift([i - 1, j - 1]); i--; j--; }
    else if ((dp[i - 1]![j] ?? 0) > (dp[i]![j - 1] ?? 0)) i--;
    else j--;
  }
  return result;
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Write content to a file. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically.',
  parameters: z.object({
    file_path: z.string().describe('Path to the file to write (absolute or relative to the working directory)'),
    content: z.string().describe('Content to write to the file'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { file_path: string; content: string };
    validateInputPath(params.file_path, 'file_path');
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);

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
    file_path: z.string().describe('Path to the file to modify (absolute or relative to the working directory)'),
    old_string: z.string().describe('Text to replace (must be unique in file)'),
    new_string: z.string().describe('Text to replace it with'),
    replace_all: z.boolean().optional().default(false).describe('Replace all occurrences (default: false)'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { file_path: string; old_string: string; new_string: string; replace_all?: boolean };
    validateInputPath(params.file_path, 'file_path');
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(resolvedPath, 'utf-8');

    if (params.replace_all) {
      const count = content.split(params.old_string).length - 1;
      if (count === 0) {
        return { content: `Ошибка: строка для замены не найдена в файле "${params.file_path}"`, isError: true };
      }
      const newContent = content.replaceAll(params.old_string, params.new_string);
      await writeFile(resolvedPath, newContent, 'utf-8');

      const diff = generateUnifiedDiff(content, newContent, params.file_path);
      return {
        content: `Файл изменён: ${params.file_path} (${count} замен)`,
        metadata: { path: resolvedPath, replacements: count, diff },
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

    const diff = generateUnifiedDiff(content, newContent, params.file_path);
    return {
      content: `Файл изменён: ${params.file_path} (1 замена)`,
      metadata: { path: resolvedPath, replacements: 1, diff },
    };
  },
};

export const createDirectoryTool: ToolDefinition = {
  name: 'create_directory',
  description: 'Create a new directory. Creates parent directories as needed.',
  parameters: z.object({
    path: z.string().describe('Path to the directory to create (absolute or relative to the working directory)'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path: string };
    validateInputPath(params.path, 'path');
    const resolvedPath = resolvePath(params.path, ctx.workingDir);

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
    file_path: z.string().describe('Path to the file to delete (absolute or relative to the working directory)'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { file_path: string };
    validateInputPath(params.file_path, 'file_path');
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);

    await rm(resolvedPath, { force: false });
    return {
      content: `Файл удалён: ${params.file_path}`,
      metadata: { path: resolvedPath },
    };
  },
};
