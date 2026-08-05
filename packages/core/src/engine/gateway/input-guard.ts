/**
 * Input Guard (AD-036): обфускация или блокировка секретов во входящем запросе
 * (messages + systemPrompt + tools) перед отправкой в LLM.
 */

import { nowISO, type LLMGatewayConfig } from '@synth/shared';

import type { LLMMessage } from '../../providers/base.js';
import { detectSecrets, maskSecret } from './secret-detector.js';
import { obfuscateSecrets } from './obfuscator.js';
import type { AuditLogger } from './audit-logger.js';
import type { SecretPattern } from './secret-pattern-store.js';

export interface InputGuardResult {
  /** true — можно отправлять в LLM. */
  ok: boolean;
  /** Обфусцированные сообщения. */
  messages: LLMMessage[];
  systemPrompt?: string;
  tools?: Record<string, unknown>[];
  /** Обновлённая карта обфускации. */
  map: Record<string, string>;
  secretsFound: string[];
  /** Заполняется в режиме block при найденных секретах. */
  blocked?: { reason: string; message: string };
}

export interface InputGuardMeta {
  sessionId: string;
  userId: string;
  provider: string;
  model: string;
}

/**
 * Прогоняет секреты по content всех сообщений, systemPrompt и JSON-сериализованным tools.
 * - Режим obfuscate: секреты заменяются на плейсхолдеры, карта обновляется.
 * - Режим block: ok=false, секреты в LLM не уходят; reason — замаскированный префикс.
 * В аудит секреты пишутся только в замаскированном виде.
 */
export async function runInputGuard(
  config: LLMGatewayConfig,
  messages: LLMMessage[],
  systemPrompt: string | undefined,
  tools: Record<string, unknown>[] | undefined,
  map: Record<string, string>,
  audit: AuditLogger,
  meta: InputGuardMeta,
  patterns?: SecretPattern[],
): Promise<InputGuardResult> {
  if (!config.enabled) {
    return { ok: true, messages, systemPrompt, tools, map, secretsFound: [] };
  }

  const allFound: string[] = [];
  const collect = (text: string): void => {
    for (const secret of detectSecrets(text, patterns)) {
      if (!allFound.includes(secret)) allFound.push(secret);
    }
  };

  for (const message of messages) collect(message.content);
  if (systemPrompt) collect(systemPrompt);
  if (tools?.length) collect(JSON.stringify(tools));

  if (allFound.length === 0) {
    return { ok: true, messages, systemPrompt, tools, map, secretsFound: [] };
  }

  if (config.inputMode === 'block') {
    const reason = maskSecret(allFound[0]!);
    await audit.append({
      ts: nowISO(),
      type: 'blocked',
      sessionId: meta.sessionId,
      userId: meta.userId,
      provider: meta.provider,
      model: meta.model,
      secretsFound: allFound.map(maskSecret),
      reason,
    });
    return {
      ok: false,
      messages,
      systemPrompt,
      tools,
      map,
      secretsFound: allFound,
      blocked: {
        reason,
        message: `Обнаружены секреты в запросе (${reason}). Запрос заблокирован LLM Gateway.`,
      },
    };
  }

  let currentMap = map;
  const newPlaceholders: string[] = [];

  const obfuscatedMessages = messages.map((message) => {
    const result = obfuscateSecrets(message.content, currentMap, patterns);
    currentMap = result.map;
    for (const key of Object.keys(currentMap)) {
      if (!(key in map) && !newPlaceholders.includes(key)) newPlaceholders.push(key);
    }
    return result.text === message.content ? message : { ...message, content: result.text };
  });

  let obfuscatedSystem = systemPrompt;
  if (systemPrompt) {
    const result = obfuscateSecrets(systemPrompt, currentMap, patterns);
    currentMap = result.map;
    for (const key of Object.keys(currentMap)) {
      if (!(key in map) && !newPlaceholders.includes(key)) newPlaceholders.push(key);
    }
    obfuscatedSystem = result.text;
  }

  let obfuscatedTools = tools;
  if (tools?.length) {
    const result = obfuscateSecrets(JSON.stringify(tools), currentMap, patterns);
    currentMap = result.map;
    for (const key of Object.keys(currentMap)) {
      if (!(key in map) && !newPlaceholders.includes(key)) newPlaceholders.push(key);
    }
    obfuscatedTools = JSON.parse(result.text) as Record<string, unknown>[];
  }

  await audit.append({
    ts: nowISO(),
    type: 'obfuscated',
    sessionId: meta.sessionId,
    userId: meta.userId,
    provider: meta.provider,
    model: meta.model,
    secretsFound: allFound.map(maskSecret),
    placeholders: newPlaceholders,
  });

  return {
    ok: true,
    messages: obfuscatedMessages,
    systemPrompt: obfuscatedSystem,
    tools: obfuscatedTools,
    map: currentMap,
    secretsFound: allFound,
  };
}
