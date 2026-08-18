export { AgentRegistry } from './registry.js';
export { isModeApplicable } from './mode.js';

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickLocalized } from '@itphx/shared';
import type { AgentDefinition, ToolCapability } from '@itphx/shared';
import { AgentRegistry } from './registry.js';
import type { ToolRegistry } from '../tools/registry.js';

const DEFINITIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'definitions');

interface AgentDefFile {
  id: string;
  displayName: Record<string, string>;
  description: Record<string, string>;
  capabilities: string[];
  icon: string;
  color: string;
  contextFile: string;
  hidden?: boolean;
  agentMode?: 'primary' | 'subagent' | 'all';
  subagentPrompt?: string;
  maxSteps?: number;
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
      hidden: def.hidden ?? false,
      sshKeys: [],
      isOverridden: false,
      agentMode: def.agentMode,
      subagentPrompt: def.subagentPrompt,
      maxSteps: def.maxSteps,
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
      return { ...sysAgent, ...override };
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
