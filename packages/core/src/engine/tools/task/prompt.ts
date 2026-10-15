/**
 * Промпт саб-агента: резолвинг текста роли, секция недоступных тулов и
 * конвертация сообщений в LLM-формат.
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageRole } from '@itphx/synth-shared';
import type { Message, ToolForLLM } from '@itphx/synth-shared';
import type { LLMMessage } from '../../../providers/base.js';
import { renderUnavailableTools, type UnavailableTool } from '../../context/state-messages.js';
import { isWorkspaceDependentTool } from '../../permission/availability.js';
import { isRuntimeDepAvailable, RUNTIME_DEP_BINARY, TOOL_RUNTIME_DEP, type RuntimeDeps } from '../runtime-deps.js';

/**
 * Промпт саб-агента по языку сессии: prompts/subagents/{type}.{lang}.md →
 * {type}.md → agentDef.subagentPrompt (definitions JSON, легаси).
 * Каталог промптов — systemPromptsDir из ContextConfig (резолв prompts/ или dist/prompts).
 */
export function resolveSubagentPrompt(
  agentDef: { subagentPrompt?: string },
  subagentType: string,
  language: string | undefined,
  systemPromptsDir: string | undefined,
): string {
  if (systemPromptsDir) {
    const lang = language === 'en' ? 'en' : 'ru';
    const localizedPath = join(systemPromptsDir, 'subagents', `${subagentType}.${lang}.md`);
    if (existsSync(localizedPath)) {
      try { return readFileSync(localizedPath, 'utf-8'); } catch { /* fallback ниже */ }
    }
    const basePath = join(systemPromptsDir, 'subagents', `${subagentType}.md`);
    if (existsSync(basePath)) {
      try { return readFileSync(basePath, 'utf-8'); } catch { /* fallback ниже */ }
    }
  }
  return agentDef.subagentPrompt || '';
}

/**
 * ADR-070 §2.9.1: секция `[НЕДОСТУПНЫЕ ТУЛЫ]` для системного промпта саб-агента.
 *
 * Набор тулов саб-агента постоянен (роль/режим enforce'ит permission-слой), а
 * недоступность по внешней зависимости (`git`/`rg`/`sh`) сообщается модели здесь —
 * тем же рендером, что и в state-сообщениях основного агента. Пусто (нет
 * недоступных) → ''.
 */
export function buildSubagentUnavailableToolsSection(
  tools: ToolForLLM[] | undefined,
  runtimeDeps: RuntimeDeps | undefined,
  language: string,
  opts?: {
    workspaceReady?: boolean;
    capabilitiesOf?: (toolName: string) => readonly string[] | undefined;
  },
): string {
  if (!tools || tools.length === 0) return '';
  const unavailable: UnavailableTool[] = [];
  const seen = new Set<string>();
  const workspaceReady = opts?.workspaceReady;
  const capabilitiesOf = opts?.capabilitiesOf;
  for (const tool of tools) {
    const name = tool.function.name;
    const dep = TOOL_RUNTIME_DEP[name];
    if (runtimeDeps && dep && !isRuntimeDepAvailable(runtimeDeps, dep)) {
      unavailable.push({
        name,
        reason: 'dependency',
        binary: RUNTIME_DEP_BINARY[dep],
      });
      seen.add(name);
      continue;
    }
    // ADR-075: без рабочего каталога проекта file/shell/git-тулы недоступны.
    // Дедупликация по имени: тул не попадает одновременно и как dependency, и как workspace.
    if (workspaceReady === false && !seen.has(name) && isWorkspaceDependentTool(capabilitiesOf?.(name))) {
      unavailable.push({ name, reason: 'workspace' });
      seen.add(name);
    }
  }
  return renderUnavailableTools(unavailable, language);
}

export function messageToLLMMessage(msg: Message): LLMMessage {
  const roleMap: Record<string, LLMMessage['role']> = {
    [MessageRole.USER]: 'user',
    [MessageRole.ASSISTANT]: 'assistant',
    [MessageRole.TOOL]: 'tool',
    [MessageRole.SYSTEM]: 'system',
    [MessageRole.SUMMARY]: 'user',
    [MessageRole.DEBUG]: 'user',
    [MessageRole.INFO]: 'user',
    [MessageRole.ERROR]: 'user',
  };

  return {
    id: msg.id,
    role: roleMap[msg.role] || 'user',
    content: msg.content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: '',
    toolCallId: msg.toolCallId,
    toolUse: msg.toolCalls,
  };
}
