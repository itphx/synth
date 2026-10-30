import type { ToolCapability } from './tools.js';
import type { ReasoningLevel } from './session.js';
// ADR-117: тир усилия агента (`xhigh`/`max` — только явным значением).
import type { EffortLevel } from './llm.js';

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
  /**
   * ADR-117: явный тир усилия (effort) агента — `low|medium|high|xhigh|max`.
   * Приоритетнее `session.settings.effort` и уровня размышлений; единственный
   * способ задать `xhigh`/`max` из настроек. Параметр уходит провайдеру только
   * при `compatibility.supportsEffortUpdates` у модели.
   */
  effort?: EffortLevel;
  agentMode?: AgentMode | AgentMode[];
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
