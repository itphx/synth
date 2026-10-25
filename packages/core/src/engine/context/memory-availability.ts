/**
 * ADR-107: доступна ли агенту инструкция по памяти в этой сессии.
 *
 * Отдельный чистый резолвер, чтобы правило не расползалось между оркестратором,
 * composer'ом и тестами. Доступность — не «плагин установлен на инстансе», а:
 * - проект не выключил память (`project.memory.enabled !== false`);
 * - у агента есть capability `memory` (иначе тулы памяти ему не предназначены);
 * - в реестре есть хотя бы один не отключённый администратором тул плагина.
 */
import { ToolCapability } from '@itphx/synth-shared';
import type { Project } from '@itphx/synth-shared';

/** Минимальный вид тула для проверки (совместим с `ToolDefinition`). */
export interface MemoryToolLike {
  name: string;
  capabilities: readonly string[];
}

/** Входы резолвера доступности памяти для промпта. */
export interface MemoryPromptAvailabilityInput {
  /** Проект сессии (уже загруженный); `undefined`/`null` — сессия без проекта. */
  project?: Project | null;
  /** Capabilities агента (`AgentDefinition.capabilities`). */
  agentCapabilities?: readonly string[];
  /** Тулы плагина памяти из реестра. */
  tools: readonly MemoryToolLike[];
  /** Отключён ли тул администратором (ADR-071 §2.6). */
  isAdminDisabled?: (tool: MemoryToolLike) => boolean;
}

/** Нужна ли в системном промпте инструкция `prompts/system/MEMORY.{lang}.md`. */
export function isMemoryPromptAvailable(input: MemoryPromptAvailabilityInput): boolean {
  if (input.project?.memory?.enabled === false) return false;
  if (!input.agentCapabilities?.includes(ToolCapability.MEMORY)) return false;
  return input.tools.some((tool) => !(input.isAdminDisabled?.(tool) ?? false));
}
