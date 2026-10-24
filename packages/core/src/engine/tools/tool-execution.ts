/**
 * Общие хелперы исполнения tool-вызовов и формирования deny-результатов.
 *
 * Вынесены из оркестратора и саб-агента (`task.ts`), чтобы одинаковые блоки
 * `safeParse → execute → catch` и deny-`toolResult` не дублировались и вели
 * себя единообразно.
 */

import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import { stripNullBytes, stripNullBytesDeep } from '@itphx/synth-shared';
import { i18n as i18nMeta, t as sm } from '../system-messages.js';

/** Структурный источник локализованных security-сообщений (ContextConfig). */
export interface SecurityMessageSource {
  getSecurityMessage(
    messageId: string,
    language?: string,
    params?: Record<string, string>,
  ): string | null;
}

export interface BuildDenyResultParams {
  /** Причина отказа (для `metadata.permission.reason`). */
  reason: string;
  /** Сработавшее permission-правило. */
  matchedRule?: string;
  /** id security-сообщения (для локализации и i18n-ключа). */
  messageId?: string;
  /** Параметры подстановки security-сообщения. */
  params?: Record<string, string>;
  /** Явный текст результата; если не задан — security-сообщение/`Permission denied: <reason>`. */
  content?: string;
  /** Источник локализованных security-сообщений (ContextConfig). */
  contextConfig?: SecurityMessageSource | null;
  /** Язык security-сообщения (по умолчанию `en` — как было в task.ts). */
  language?: string;
  /** Суффикс к тексту (например, причина отказа ask: ` (${why})`). */
  contentSuffix?: string;
  /** Эмитить i18n `tool.permission_denied_default`, если `messageId` нет (по умолчанию true). */
  defaultI18n?: boolean;
}

/**
 * Формирует deny-`toolResult`: текст (явный/локализованный/fallback), i18n-ключ
 * и блок `permission` в metadata. Единая точка для оркестратора и task.ts.
 */
export function buildDenyResult(p: BuildDenyResultParams): ToolResult {
  let content = p.content;
  if (content == null) {
    const localized = p.messageId && p.contextConfig
      ? p.contextConfig.getSecurityMessage(p.messageId, p.language ?? 'en', p.params)
      : null;
    content = localized ?? `Permission denied: ${p.reason}`;
  }
  if (p.contentSuffix) content = `${content}${p.contentSuffix}`;

  const i18n = p.messageId
    ? i18nMeta(`security.${p.messageId.replaceAll('-', '_')}`, p.params)
    : (p.defaultI18n ?? true
      ? i18nMeta('tool.permission_denied_default')
      : undefined);

  return {
    content,
    isError: true,
    metadata: {
      ...(i18n ? { i18n } : {}),
      permission: {
        action: 'deny',
        reason: p.reason,
        matched_rule: p.matchedRule,
      },
    },
  };
}

/**
 * ADR-090: сужение контекста тула для инструментов плагинов.
 *
 * `inline`-плагин исполняется **в процессе ядра**, поэтому контекст тула нельзя
 * отдавать ему целиком: `ctx.extra` — внутреннее состояние ядра (`sessionManager`,
 * `projectStore`, `eventBus`, сторы, порт исполнения, конфиг безопасности…),
 * `ctx.dataDir` — корень данных инстанса. По проводу (`out-of-process`) плагин
 * получает только сериализуемый DTO (`sessionId`/`messageId`/`workingDir`),
 * поэтому inline-режим должен видеть тот же минимум — иначе плагин де-факто
 * читает всё, что читает ядро, в обход разрешений и API.
 *
 * Правило живёт в **одном chokepoint'е** — `executeToolDef`: через него идут
 * все вызовы тулов (оркестратор, саб-агент `task`, шаги пайплайна). Встроенные
 * (`builtin`) и MCP-тулы получают контекст **без изменений**.
 *
 * @param toolDef — определение тула (источник — `ToolDefinition.source`).
 * @param context — полный контекст вызова (как у встроенных тулов).
 * @returns суженный контекст для плагинного тула; исходный — для остальных.
 */
export function narrowToolContext(
  toolDef: ToolDefinition,
  context: ToolContext,
): ToolContext {
  if ((toolDef.source ?? 'builtin') !== 'plugin') return context;
  return {
    sessionId: context.sessionId,
    messageId: context.messageId,
    workingDir: context.workingDir,
    ...(context.agentRole !== undefined ? { agentRole: context.agentRole } : {}),
    // ADR-107: проект сессии — метаданные хода, а не internals ядра: плагинному
    // тулу нужны, чтобы ограничить поиск данными своего проекта.
    ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
    ...(context.abortSignal !== undefined ? { abortSignal: context.abortSignal } : {}),
  };
}

/**
 * Единое исполнение тула: `safeParse` → `execute` → `catch`.
 * Ошибки валидации/исполнения оформляются как `isError`-результаты с i18n-ключом
 * (как в оркестраторе). Не бросает.
 *
 * ADR-090: плагинному тулу (`source: 'plugin'`) уходит **суженный** контекст
 * (см. `narrowToolContext`) — internals ядра наружу не отдаются.
 */
export async function executeToolDef(
  toolDef: ToolDefinition,
  toolArgs: Record<string, unknown>,
  context: ToolContext,
  toolName: string,
): Promise<ToolResult> {
  const parsed = toolDef.parameters.safeParse(toolArgs);
  if (!parsed.success) {
    return {
      content: sm('tool.args_error', {
        tool: toolName,
        issues: parsed.error.issues
          .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
          .join('; '),
      }),
      isError: true,
      metadata: { i18n: i18nMeta('tool.args_error', { tool: toolName }) },
    };
  }

  try {
    const result = await toolDef.execute(parsed.data, narrowToolContext(toolDef, context));
    // Единая точка санитизации вывода тулов (web_fetch/shell/read_file/…):
    // U+0000 из внешнего мира не должен попадать в историю/`jsonb`.
    return {
      ...result,
      content: typeof result.content === 'string' ? stripNullBytes(result.content) : result.content,
      ...(result.metadata ? { metadata: stripNullBytesDeep(result.metadata) } : {}),
    };
  } catch (execError) {
    return {
      content: sm('tool.exec_error', { tool: toolName, error: String(execError) }),
      isError: true,
      metadata: { i18n: i18nMeta('tool.exec_error', { tool: toolName }) },
    };
  }
}
