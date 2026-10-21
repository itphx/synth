/**
 * ADR-101 (Pipeline Engine): исполнители видов шага.
 *
 * - `tool` — вызов зарегистрированного инструмента через `executeToolDef`;
 * - `script` — исполнение команды через shell-тул `execute_shell` (не голый
 *   `child_process`);
 * - `human` — HITL-гейт: пауза прогона и ожидание решения оператора;
 * - `agent` — LLM-шаг: системный промпт (ADR-070) + один вызов через
 *   `GatewayProvider` (ADR-036) + локальная история шага (Tool-Use-цикл —
 *   Э4.3b).
 */
export {
  createToolStepExecutor,
  executeToolStep,
} from './tool-step.js';
export type { ToolStepExecutorOptions } from './tool-step.js';

export {
  buildShellCommand,
  createScriptStepExecutor,
  executeScriptStep,
  SHELL_TOOL_NAME,
} from './script-step.js';
export type { ScriptStepExecutorOptions } from './script-step.js';

export {
  createHumanStepExecutor,
  humanStepExecutor,
} from './human-step.js';

export {
  buildStepUserMessage,
  createAgentStepExecutor,
  executeAgentStep,
} from './agent-step.js';
export type { AgentStepExecutorOptions, AgentStepState } from './agent-step.js';

export {
  buildToolContext,
  findTool,
  stepWorkingDir,
} from './common.js';
export type { PipelineToolLookup } from './common.js';
