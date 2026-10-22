export { AgentRegistry } from './registry.js';
export { isModeApplicable } from './mode.js';

/**
 * Агент по умолчанию при первом развёртывании: стартовый агент новой сессии
 * (если `settings.agentRole` не задан) и fallback для `default_agent` в ответах
 * /agents. Настраивается в рантайме через `/api/v2/settings/default-agent`
 * (раздел админки «Агенты»); значение из `settings.json` приоритетнее.
 */
export const DEFAULT_AGENT_ID = 'assistant';

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickLocalized } from '@itphx/synth-shared';
import type { AgentDefinition, ReasoningLevel, ToolCapability } from '@itphx/synth-shared';
import { AgentRegistry } from './registry.js';
import type { ToolRegistry } from '../tools/registry.js';

const DEFINITIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'definitions');

import { normalizeAgentModes } from './normalize.js';
export { normalizeAgentModes };

interface AgentDefFile {
  id: string;
  displayName: Record<string, string>;
  description: Record<string, string>;
  capabilities: string[];
  icon: string;
  color: string;
  contextFile: string;
  agentMode?: string | string[];
  subagentPrompt?: string;
  maxSteps?: number;
  reasoningLevel?: ReasoningLevel;
}

export function loadSystemAgentDefinitions(): AgentDefinition[] {
  const files = readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith('.json'));
  const agents: AgentDefinition[] = [];

  for (const file of files) {
    const path = join(DEFINITIONS_DIR, file);
    const def = JSON.parse(readFileSync(path, 'utf-8')) as AgentDefFile;

    agents.push({
      id: def.id,
      displayName: pickLocalized(def.displayName, 'ru') || def.id,
      description: pickLocalized(def.description, 'ru') || '',
      capabilities: def.capabilities as ToolCapability[],
      icon: def.icon,
      color: def.color,
      contextFile: def.contextFile,
      enabled: true,
      isOverridden: false,
      agentMode: normalizeAgentModes(def.agentMode),
      subagentPrompt: def.subagentPrompt,
      maxSteps: def.maxSteps,
      reasoningLevel: def.reasoningLevel,
    });
  }

  return agents;
}

export function createAgentRegistry(
  toolRegistry?: ToolRegistry,
  overridesDir?: string,
): AgentRegistry {
  const registry = new AgentRegistry(toolRegistry);
  const systemAgents = loadSystemAgentDefinitions();
  const systemIds = new Set(systemAgents.map((a) => a.id));

  const merged = systemAgents.map((sysAgent) => {
    if (!overridesDir) return sysAgent;
    const overridePath = join(overridesDir, `${sysAgent.id}.json`);
    if (!existsSync(overridePath)) return sysAgent;
    try {
      const override = JSON.parse(readFileSync(overridePath, 'utf-8')) as AgentDefinition;
      const merged = { ...sysAgent, ...override };
      merged.agentMode = normalizeAgentModes(merged.agentMode);
      return merged;
    } catch {
      return sysAgent;
    }
  });

  registry.registerAll(merged);

  // Регистрируем custom-агентов (id вне системных дефиниций) из overridesDir.
  // Системных не перетираем: файлы с id системного агента уже покрыты merge выше.
  if (overridesDir && existsSync(overridesDir)) {
    const files = readdirSync(overridesDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const def = JSON.parse(readFileSync(join(overridesDir, file), 'utf-8')) as AgentDefinition;
        if (def.id && !systemIds.has(def.id)) {
          registry.register({ ...def, isOverridden: true });
        }
      } catch {
        // невалидный JSON — пропускаем
      }
    }
  }

  return registry;
}

/**
 * Регистрация агентов из **стора** (порт `DocumentRepository<AgentDefinition>`,
 * ADR-096) в реестр — семантика merge та же, что в `GET /api/v2/agents`
 * (`server/routes/agents.ts`, `resolveAgents`):
 *
 * - запись с id встроенного агента **перекрывает** встроенное определение
 *   (поля, которых нет в записи, у встроенного сохраняются);
 * - custom-агент (id вне встроенных) регистрируется как есть;
 * - в обоих случаях `isOverridden: true`.
 *
 * Зачем: `createAgentRegistry` читает **только файловый каталог** `overridesDir`
 * (`{dataDir}/agents/*.json`), а стор агентов при `storage.backend=postgres`
 * (ADR-096) — это **БД**, а не файлы. Поэтому агент, поставленный
 * пакетом расширения (ADR-086 §5, `POST /api/v2/packs`), после рестарта
 * процесса не попадал в реестр: Router не резолвил `agentTemplate`
 * (`resolveAgentTemplate` → `null`), и сессия не создавалась.
 *
 * Идемпотентна и безопасна при файловом хранилище: там каталог и стор — одно
 * и то же, merge поверх уже смерженного определения даёт тот же результат
 * (повторная регистрация ничего не меняет).
 *
 * Edge-случаи: запись без `id` (или с не-строковым `id`) — пропускается;
 * не-объект/битая запись — пропускается; пустой список — no-op; повторный
 * вызов с тем же списком — без изменений.
 */
export function registerStoredAgents(
  registry: AgentRegistry,
  agents: readonly AgentDefinition[],
): void {
  if (!Array.isArray(agents)) return;
  for (const stored of agents) {
    if (!stored || typeof stored !== 'object') continue;
    const id = (stored as AgentDefinition).id;
    if (typeof id !== 'string' || !id) continue; // запись без id — не агент
    const current = registry.get(id);
    // Встроенный агент: stored перекрывает текущее (уже смерженное) определение.
    // Custom-агент: current отсутствует — регистрируем как есть.
    const merged: AgentDefinition = current
      ? { ...current, ...stored, id, isOverridden: true }
      : { ...stored, id, isOverridden: true };
    registry.register(merged);
  }
}
