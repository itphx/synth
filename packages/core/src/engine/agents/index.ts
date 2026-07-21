export { AgentRegistry } from './registry.js';

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickLocalized } from '@synth/shared';
import type { AgentDefinition, ToolCapability } from '@synth/shared';
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
  return registry;
}
