import type { ToolDefinition } from '@synth/shared';
import { ToolRegistry } from './registry.js';
import { readFileTool, listDirectoryTool, globTool } from './fs-read.js';
import { writeFileTool, editFileTool, createDirectoryTool, deleteFileTool } from './fs-write.js';
import { executeShellTool } from './shell.js';
import { grepFilesTool } from './search.js';
import { webFetchTool, webSearchTool } from './web.js';
import { gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool } from './git.js';
import { taskTool } from './task.js';
import { readSessionReferenceTool } from './read-reference.js';

export { ToolRegistry } from './registry.js';
export { zodToJsonSchema } from './json-schema.js';

export const ALL_BUILTIN_TOOLS: ToolDefinition[] = [
  readFileTool,
  listDirectoryTool,
  globTool,
  writeFileTool,
  editFileTool,
  createDirectoryTool,
  deleteFileTool,
  executeShellTool,
  grepFilesTool,
  webFetchTool,
  webSearchTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  taskTool,
  readSessionReferenceTool,
];

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_BUILTIN_TOOLS);
  return registry;
}
