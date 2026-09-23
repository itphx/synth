import type { ToolDefinition } from '@itphx/synth-shared';
import { ToolRegistry } from './registry.js';
import { readFileTool, listDirectoryTool, globTool } from './fs-read.js';
import { writeFileTool, editFileTool, createDirectoryTool, deleteFileTool } from './fs-write.js';
import { executeShellTool } from './shell.js';
import { grepFilesTool } from './search.js';
import { webFetchTool, webSearchTool } from './web.js';
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitPushTool,
  gitPullTool,
  gitCheckoutTool,
  gitBranchListTool,
  gitShowTool,
  gitBlameTool,
  gitStashTool,
} from './git.js';
import { taskTool } from './task.js';
import { skillTool } from './skill.js';
import { classifyConversationTool } from './classify-conversation.js';
import { readSessionReferenceTool } from './read-reference.js';
import { getProjectInfoTool, listReposTool } from './project-context.js';
import { planEnterTool, planExitTool, planReadTool, planListTool, planWriteTool } from './plan.js';
import { todoWriteTool, todoListTool, todoAddTool, todoUpdateTool, todoDeleteTool } from './todo.js';
import { projectCreateTool, projectAttachTool, projectLogWriteTool, projectLogReadTool, projectInvariantsReadTool, projectInvariantsWriteTool } from './project-manage.js';

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
  gitPushTool,
  gitPullTool,
  gitCheckoutTool,
  gitBranchListTool,
  gitShowTool,
  gitBlameTool,
  gitStashTool,
  getProjectInfoTool,
  listReposTool,
  taskTool,
  skillTool,
  classifyConversationTool,
  readSessionReferenceTool,
  planEnterTool,
  planExitTool,
  planReadTool,
  planListTool,
  planWriteTool,
  todoWriteTool,
  todoListTool,
  todoAddTool,
  todoUpdateTool,
  todoDeleteTool,
  projectCreateTool,
  projectAttachTool,
  projectLogWriteTool,
  projectLogReadTool,
  projectInvariantsReadTool,
  projectInvariantsWriteTool,
];

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_BUILTIN_TOOLS);
  return registry;
}
