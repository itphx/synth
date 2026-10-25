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
import { profileUpdateTool } from './profile-update.js';
import { projectCreateTool, projectAttachTool, projectUpdateTool, projectWorkspaceSetTool, projectLogWriteTool, projectLogReadTool, projectInvariantsReadTool, projectInvariantsWriteTool } from './project-manage.js';
import { projectRepoCloneTool, projectRepoInitTool, projectRepoAddTool, projectRepoFetchTool, projectRepoRemoveTool } from './project-repos.js';
// ADR-101: пайплайны проекта — чтение и авторство (спецификация, версии).
import {
  pipelineListTool,
  pipelineGetTool,
  pipelineSaveTool,
  pipelinePublishTool,
  pipelineDeleteTool,
} from './pipeline-authoring.js';
// ADR-101: прогоны пайплайнов — запуск, статус, список, HITL-решение, отмена.
import {
  pipelineRunTool,
  pipelineRunStatusTool,
  pipelineRunListTool,
  pipelineRunResumeTool,
  pipelineRunCancelTool,
} from './pipeline-runs.js';
// ADR-101: шаблоны пайплайнов — список шаблонов инстанца и инстанцирование.
import { pipelineTemplatesTool, pipelineInstantiateTool } from './pipeline-templates.js';
// ADR-051: расписания планировщика — чтение, авторство, запуск, журнал.
import {
  scheduleListTool,
  scheduleGetTool,
  scheduleSaveTool,
  scheduleDeleteTool,
  scheduleRunTool,
  scheduleJobsTool,
} from './schedules.js';

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
  profileUpdateTool,
  projectCreateTool,
  projectAttachTool,
  projectUpdateTool,
  projectWorkspaceSetTool,
  projectRepoCloneTool,
  projectRepoInitTool,
  projectRepoAddTool,
  projectRepoFetchTool,
  projectRepoRemoveTool,
  projectLogWriteTool,
  projectLogReadTool,
  projectInvariantsReadTool,
  projectInvariantsWriteTool,
  // ADR-101: пайплайны проекта
  pipelineListTool,
  pipelineGetTool,
  pipelineSaveTool,
  pipelinePublishTool,
  pipelineDeleteTool,
  // ADR-101: прогоны пайплайнов
  pipelineRunTool,
  pipelineRunStatusTool,
  pipelineRunListTool,
  pipelineRunResumeTool,
  pipelineRunCancelTool,
  // ADR-101: шаблоны пайплайнов
  pipelineTemplatesTool,
  pipelineInstantiateTool,
  // ADR-051: расписания
  scheduleListTool,
  scheduleGetTool,
  scheduleSaveTool,
  scheduleDeleteTool,
  scheduleRunTool,
  scheduleJobsTool,
];

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_BUILTIN_TOOLS);
  return registry;
}
