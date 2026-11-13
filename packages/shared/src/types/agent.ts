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
  /**
   * PROP-135 Ф6a: профиль исполнения агента (`execution.remote.profiles`).
   * Приоритет выбора профиля: сессия → агент → проект → `defaultProfile`.
   * Не задан — профиль берётся у проекта/инстанса.
   */
  executorProfile?: string;
  /**
   * PROP-135 Ф6a: **потолок** профилей исполнения агента: если массив задан,
   * агент не может исполняться на профиле вне списка (нарушение — fail-closed:
   * запрещённый профиль не выбирается, инстанс-дефолт — **не исключение**,
   * вне списка профилей нет вовсе). Пустой массив — «профилей нет»; массив не
   * задан (`undefined`) — потолок области не задан (ограничения нет).
   */
  allowedProfiles?: string[];
  /**
   * PROP-135 (браузерный контур): профиль браузерного пула агента
   * (`execution.remote.browserProfiles`). Приоритет выбора: сессия → агент →
   * проект → инстанс-дефолт (`execution.remote.browserProfile`). Не задан —
   * наследуется. Отдельный контур: имя проверяется по браузерному каталогу, а
   * не по exec-каталогу (`allowedProfiles`).
   */
  browserProfile?: string;
  /**
   * PROP-135 (браузерный контур): **потолок** браузерных профилей агента.
   * Заданный список — профиль обязан в него входить (пустой — «профилей
   * нет»); не задан — потолок не задан.
   */
  allowedBrowserProfiles?: string[];
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
