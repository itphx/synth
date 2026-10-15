import type { ToolCapability } from './tools.js';
import type { ReasoningLevel } from './session.js';

// --- Agent ---
export type AgentMode = 'primary' | 'subagent' | 'system';

export interface AgentDefinition {
  id: string;
  displayName: string;
  contextFile?: string;
  capabilities: ToolCapability[];
  enabled: boolean;
  provider?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Уровень размышлений агента. Не задано — используется session.settings.reasoningLevel. */
  reasoningLevel?: ReasoningLevel;
  agentMode?: AgentMode | AgentMode[];
  subagentPrompt?: string;
  maxSteps?: number; // 0 = без ограничений, undefined = default (0 для primary, 15 для subagent)
  isOverridden: boolean;
  icon?: string;
  color?: string;
  description?: string;
  /**
   * ADR-046 §6.2: группы агентов для привязки скиллов
   * (`metadata.synth.groups`). Пусто/не задано — скилл с непустым `groups`
   * не привязан к агенту.
   */
  groups?: string[];
}
