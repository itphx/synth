/**
 * ADR-101 (Pipeline Engine): исполнители видов шага.
 *
 * - `tool` — вызов зарегистрированного инструмента через `executeToolDef`;
 * - `script` — исполнение команды через shell-тул `execute_shell` (не голый
 *   `child_process`);
 * - `human` — HITL-гейт: пауза прогона и ожидание решения оператора.
 *
 * Исполнитель вида `agent` — Э4.3 (свой Tool-Use-цикл в движке).
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
  buildToolContext,
  findTool,
  stepWorkingDir,
} from './common.js';
export type { PipelineToolLookup } from './common.js';
