import type { ToolDefinition } from '@itphx/synth-shared';
import { ToolRegistry } from './registry.js';
import { readFileTool, listDirectoryTool, globTool } from './fs-read.js';
import { writeFileTool, editFileTool, createDirectoryTool, deleteFileTool } from './fs-write.js';
// Атомарная мультифайловая правка в формате JSON-правок (всё-или-ничего).
import { patchTool } from './patch.js';
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
import {
  todoWriteTool, todoListTool, todoAddTool, todoUpdateTool, todoDeleteTool,
  todoReorderTool, todoClearTool,
} from './todo.js';
import { profileUpdateTool } from './profile-update.js';
// Этап 1 roadmap 0.13 (блок 3): вопрос пользователю посреди хода.
import { questionTool } from './question.js';
import {
  projectCreateTool, projectAttachTool, projectUpdateTool, projectWorkspaceSetTool,
  projectLogWriteTool, projectLogUpdateTool, projectLogDeleteTool, projectLogReadTool,
  projectInvariantsReadTool, projectInvariantsWriteTool,
} from './project-manage.js';
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
// Этап 1 roadmap 0.13 (блок 16): реестр фоновых прогонов — список/лог/управление.
import {
  processListTool,
  processLogsTool,
  processStopTool,
  processDeleteTool,
} from './processes.js';
// ADR-114: инвентарь git-worktree'ов проекта (per-session рабочий каталог).
import {
  gitWorktreeListTool,
  gitWorktreeCreateTool,
  gitWorktreeRemoveTool,
  gitWorktreePruneTool,
} from './worktree.js';
// ADR-115: повторная привязка файла из workspace — вложение в диалог.
import { attachWorkspaceFileTool } from './attach-workspace-file.js';
// ADR-115: выгрузка доставленного вложения сессии в рабочий каталог.
import { saveAttachmentTool } from './save-attachment.js';
// ADR-115: отправка файла из workspace в ответе (вложение финального сообщения).
import { sendAttachmentTool } from './send-attachment.js';
// ADR-115: каталог моделей инстанса для агента (модальности, текущая пара,
// назначения aux-моделей).
import { listModelsTool } from './list-models.js';
// ADR-076: метаданные SSH-ключей инстанса (id для `sshKeyId` сетевых git-тулов).
import { sshKeysListTool } from './ssh-keys.js';
// PROP-124 §4: адресный ssh-тул — выполнение команды на удалённом хосте.
import { sshExecTool } from './ssh-exec.js';
// PROP-124 §4b: адресный ssh-тул — передача файлов на удалённый хост.
import { sshCopyTool } from './ssh-copy.js';
// PROP-124 §4c: адресный ssh-тул — проброс порта через удалённый хост.
import { sshTunnelTool } from './ssh-tunnel.js';

export { ToolRegistry } from './registry.js';
export { zodToJsonSchema } from './json-schema.js';

export const ALL_BUILTIN_TOOLS: ToolDefinition[] = [
  readFileTool,
  // ADR-115: файл из workspace → вложение диалога (медиа-часть следующего хода)
  attachWorkspaceFileTool,
  // ADR-115: доставленное вложение сессии → файл в рабочем каталоге
  saveAttachmentTool,
  // ADR-115: файл из workspace → вложение ответа (шлюзу — `stream.done.attachments`)
  sendAttachmentTool,
  // ADR-115: каталог моделей — модальности, текущая пара, назначения aux-моделей
  listModelsTool,
  listDirectoryTool,
  globTool,
  writeFileTool,
  editFileTool,
  // Атомарная мультифайловая правка: JSON-правки, всё-или-ничего
  patchTool,
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
  // ADR-076: какие ключи доступны для `sshKeyId` (метаданные, без секретов)
  sshKeysListTool,
  // PROP-124 §4: адресный ssh-тул (режим инстанса `tools`)
  sshExecTool,
  // PROP-124 §4b: адресный ssh-тул — передача файлов (режим инстанса `tools`)
  sshCopyTool,
  // PROP-124 §4c: адресный ssh-тул — проброс порта (режим инстанса `tools`)
  sshTunnelTool,
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
  todoReorderTool,
  todoClearTool,
  profileUpdateTool,
  // Этап 1 roadmap 0.13 (блок 3): вопрос пользователю
  questionTool,
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
  projectLogUpdateTool,
  projectLogDeleteTool,
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
  // Этап 1 roadmap 0.13 (блок 16): реестр фоновых прогонов
  processListTool,
  processLogsTool,
  processStopTool,
  processDeleteTool,
  // ADR-114: git worktrees
  gitWorktreeListTool,
  gitWorktreeCreateTool,
  gitWorktreeRemoveTool,
  gitWorktreePruneTool,
];

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_BUILTIN_TOOLS);
  return registry;
}
