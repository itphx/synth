/**
 * Контракт отказа «невалидные аргументы тула» (`tool.args_error`, ADR-041).
 *
 * Текст и `metadata.i18n` строятся **вместе**: `content` — полный текст для
 * модели, `metadata.i18n` — шаблон и параметры для UI. Если параметр `issues`
 * не передан, UI подставлял бы в шаблон сырое `{issues}` вместо списка ошибок
 * (ADR-041: content — полный текст, metadata — источник локализации).
 */
import type { ZodIssue } from 'zod';
import type { ToolResult } from '@itphx/synth-shared';
import { i18n as i18nMeta, t as sm } from '../system-messages.js';

/** `path: message; path2: message2` — единый формат `issues` для `tool.args_error`. */
export function formatIssues(issues: readonly ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ');
}

/**
 * Отказ «невалидные аргументы» — один контракт content+metadata (ADR-041).
 * `issues` строкой — для проверок, которые не Zod (`name: either "name" or ...`).
 */
export function argErrorResult(tool: string, issues: string | readonly ZodIssue[]): ToolResult {
  const text = typeof issues === 'string' ? issues : formatIssues(issues);
  return {
    content: sm('tool.args_error', { tool, issues: text }),
    isError: true,
    metadata: { i18n: i18nMeta('tool.args_error', { tool, issues: text }) },
  };
}
