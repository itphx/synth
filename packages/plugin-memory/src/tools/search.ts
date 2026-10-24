/**
 * М1: тул `memory_search` — поиск по памяти плагина (точка `tools`).
 *
 * Ищет факты по тексту запроса тем же keyword-скорингом, что и блок recall
 * (М2 добавит векторный поиск через `facade.embed`, ADR-107). Порог
 * `minScore` — настройка **recall**: явный поиск агента отдаём шире (достаточно
 * совпадения одного токена), иначе модель получала бы «ничего не найдено» там,
 * где совпадение есть.
 */
import type { PluginToolDefinition } from '@itphx/synth-core';
import { z } from 'zod';

import {
  formatFactLineWithMeta,
  MemoryUnavailableError,
  type MemoryProviderLite,
} from '../provider.js';
import { keywordScore } from '../scoring.js';

/** Локальное имя тула (в реестре — с namespace'ом, его составляет хост). */
export const MEMORY_SEARCH_TOOL_NAME = 'memory_search';

/** Схема параметров (zod) — по ней хост валидирует аргументы. */
export const memorySearchParameters = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional(),
  kind: z.string().min(1).optional(),
  status: z.enum(['active', 'candidate', 'all']).optional(),
});

/**
 * Явная JSON-схема параметров — то, что видит модель.
 *
 * Задаётся руками: копия zod в бандле плагина может отличаться от хоста, а
 * модель должна видеть стабильный контракт (ADR-090, §4.3).
 */
export const memorySearchJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500, description: 'Что ищем в памяти' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      description: 'Сколько фактов вернуть (по умолчанию 5)',
    },
    kind: {
      type: 'string',
      description: 'Вид факта: decision | constraint | reference | preference | observation',
    },
    status: {
      type: 'string',
      enum: ['active', 'candidate', 'all'],
      description: 'Статус фактов: active (по умолчанию), candidate или all',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

/** Сколько фактов отдавать по умолчанию. */
const DEFAULT_LIMIT = 5;

/**
 * Тул поиска по памяти.
 *
 * Хранилище недоступно (`facade.memory === undefined`) → понятная ошибка
 * (`isError`), а не падение хода.
 */
export function createMemorySearchTool(provider: MemoryProviderLite): PluginToolDefinition {
  return {
    name: MEMORY_SEARCH_TOOL_NAME,
    description:
      'Ищет факты в памяти по тексту запроса. Возвращает совпавшие утверждения с источником, id и уверенностью.',
    parameters: memorySearchParameters,
    jsonSchema: memorySearchJsonSchema,
    capabilities: ['memory'],
    async execute(params, ctx) {
      const parsed = memorySearchParameters.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Некорректные аргументы поиска по памяти: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'query'} — ${issue.message}`)
            .join('; ')}`,
          isError: true,
        };
      }
      const { query, limit = DEFAULT_LIMIT, kind, status = 'active' } = parsed.data;

      try {
        const facts = await provider.listFacts({
          status,
          ...(kind ? { kind } : {}),
          // Скоуп сессии: проект хода (`ctx.projectId`) — тот же, что у блоков
          // промпта (ADR-107: хост прокидывает проект в суженный контекст).
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        });
        const scored = facts
          .map((fact) => ({ fact, score: keywordScore(query, fact.text) }))
          .filter((entry) => entry.score > 0);
        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.fact.confidence !== a.fact.confidence) return b.fact.confidence - a.fact.confidence;
          const byUpdated = Date.parse(b.fact.updatedAt) - Date.parse(a.fact.updatedAt);
          if (!Number.isNaN(byUpdated) && byUpdated !== 0) return byUpdated;
          return a.fact.id.localeCompare(b.fact.id);
        });
        const top = scored.slice(0, limit);
        if (top.length === 0) {
          return { content: 'Ничего не найдено.' };
        }
        return { content: top.map((entry) => formatFactLineWithMeta(entry.fact)).join('\n') };
      } catch (err) {
        if (err instanceof MemoryUnavailableError) {
          return { content: err.message, isError: true };
        }
        throw err;
      }
    },
  };
}
