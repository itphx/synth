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
import { reasoningBlocksOfMessage, toLlmReasoningBlocks } from '../../reasoning-blocks.js';
import { resolveAgentRoleAlias } from '../../agents/index.js';
import { isRuntimeDepAvailable, RUNTIME_DEP_BINARY, TOOL_RUNTIME_DEP, type RuntimeDeps } from '../runtime-deps.js';

/**
 * Промпт саб-агента по языку сессии — **только файлы**:
 * `prompts/subagents/{type}.{lang}.md` → `{type}.md` →
 * `prompts/roles/{TYPE}.{lang}.md` → `{TYPE}.md`.
 *
 * Второй уровень (`roles/`) — не дублирование текстов: ролевые агенты
 * (`fixer`/`tester`/`researcher`/`security-auditor`) имеют **один** промпт в
 * `prompts/roles/`, он же используется основной сессией (`ContextConfig.getRolePrompt`).
 * Фоллбека из определения агента (легаси-поле в definitions JSON) больше нет:
 * промпт саб-агента задаётся исключительно файлами. Нет ни одного файла — пустая строка
 * (роль без инструкции; у встроенных агентов файлы обязательны — это проверяет
 * `engine/agents/definitions.test.ts`).
 * Каталог промптов — systemPromptsDir из ContextConfig (резолв prompts/ или dist/prompts).
 */
export function resolveSubagentPrompt(
  subagentType: string,
  language: string | undefined,
  systemPromptsDir: string | undefined,
): string {
  if (!systemPromptsDir) return '';
  const lang = language === 'en' ? 'en' : 'ru';
  const roleType = subagentType.toUpperCase();
  const candidates = [
    join(systemPromptsDir, 'subagents', `${subagentType}.${lang}.md`),
    join(systemPromptsDir, 'subagents', `${subagentType}.md`),
    join(systemPromptsDir, 'roles', `${roleType}.${lang}.md`),
    join(systemPromptsDir, 'roles', `${roleType}.md`),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf-8');
      if (content) return content;
    } catch {
      /* пробуем следующий кандидат */
    }
  }
  return '';
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
    if (workspaceReady === false && !seen.has(name) && isWorkspaceDependentTool(capabilitiesOf?.(name), name)) {
      unavailable.push({ name, reason: 'workspace' });
      seen.add(name);
    }
  }
  return renderUnavailableTools(unavailable, language);
}

export function messageToLLMMessage(msg: Message, currentAgentRole?: string): LLMMessage {
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
    // Anthropic thinking (ADR-117): блоки размышлений со своими подписями —
    // история дочерней сессии при resume/наследовании контекста обязана
    // вернуть их, иначе API отвергает продолжение tool-loop («thinking не
    // возвращён в историю»). Источник — части сообщения (`metadata`), fallback —
    // legacy-поля `reasoning`+`reasoningSignature`/`reasoningRedacted`
    // (`reasoningBlocksOfMessage`). Остальные провайдеры поле не читают.
    //
    // Чужой агент — как в `_sessionMessagesToLlm`: его размышления не
    // прокидываются (при `context_mode: inherit` история родителя попадает в
    // дочерний прогон, а модель у ребёнка может быть другая — подпись чужого
    // провайдера/модели API не примет).
    reasoningBlocks: isOwnAgentMessage(msg.agentRole, currentAgentRole)
      ? toLlmReasoningBlocks(reasoningBlocksOfMessage(msg))
      : undefined,
  };
}

/**
 * «Своё» ли assistant-сообщение для текущего агента: пустая метка или метка
 * текущего агента (роли прежнего набора сравниваются по алиасу — `pm` ≡ `leader`).
 * `undefined` в `currentAgentRole` — ограничения нет (вызывающему роль неизвестна).
 */
function isOwnAgentMessage(messageRole: string | undefined, currentAgentRole: string | undefined): boolean {
  if (currentAgentRole === undefined) return true;
  if (messageRole === undefined || messageRole === currentAgentRole) return true;
  return (resolveAgentRoleAlias(messageRole) ?? messageRole)
    === (resolveAgentRoleAlias(currentAgentRole) ?? currentAgentRole);
}
