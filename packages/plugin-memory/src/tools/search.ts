/**
 * М1 + М2: тул `memory_search` — поиск по памяти плагина (точка `tools`).
 *
 * Источники выдачи:
 * - **факты** памяти — keyword-скоринг (порог `minScore` — настройка recall:
 *   явный поиск агента отдаём шире, иначе модель получала бы «ничего не
 *   найдено» там, где совпадение есть);
 * - **индекс проекта** (если он готов или устарел) — гибридный поиск по
 *   корпусу: keyword + вектор + RRF (`engine/search.ts`).
 *
 * Списки сливаются **RRF** (docs/MEMORY.md §2.3): один порядок выдачи для
 * фактов и фрагментов корпуса. Каждый результат несёт **evidence** (источник,
 * строки/поколение, score) — модель видит, откуда взялось утверждение.
 *
 * Индекса нет → поведение М1 (поиск только по фактам).
 */
import type { PluginToolDefinition } from '@itphx/synth-core';
import type { z } from 'zod';

import { reciprocalRankFusion, type SearchItem } from '../engine/search.js';
import {
  formatFactLineWithMeta,
  MemoryUnavailableError,
  type MemoryProviderLite,
} from '../provider.js';
import { enumOf, number, object, optional, string } from '../schema.js';
import { keywordScore } from '../scoring.js';

/** Локальное имя тула (в реестре — с namespace'ом, его составляет хост). */
export const MEMORY_SEARCH_TOOL_NAME = 'memory_search';

/**
 * Схема параметров — по ней хост валидирует аргументы.
 *
 * Валидатор — собственный (`schema.ts`): бандл плагина не должен тянуть
 * сторонние зависимости (иначе скан помечает его как `caution`).
 */
export const memorySearchParameters = object({
  query: string({ min: 1, max: 500 }),
  limit: optional(number({ int: true, min: 1, max: 20 })),
  kind: optional(string({ min: 1 })),
  status: optional(enumOf(['active', 'candidate', 'all'])),
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
      description: 'Сколько результатов вернуть (по умолчанию 5)',
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

/** Сколько результатов отдавать по умолчанию. */
const DEFAULT_LIMIT = 5;

/** Строка найденного фрагмента корпуса (evidence). */
export function formatChunkLine(item: SearchItem): string {
  const metadata = item.metadata ?? {};
  const path = typeof metadata.path === 'string' ? metadata.path : undefined;
  const factId = typeof metadata.factId === 'string' ? metadata.factId : undefined;
  const source = path ?? factId ?? item.documentId;
  const startLine = typeof metadata.startLine === 'number' ? metadata.startLine : undefined;
  const endLine = typeof metadata.endLine === 'number' ? metadata.endLine : undefined;
  const range =
    startLine !== undefined && endLine !== undefined ? `, ${startLine}-${endLine}` : '';
  return `- ${item.text} (src: ${source}${range}, score ${item.score.toFixed(2)})`;
}

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
      'Ищет факты и фрагменты корпуса в памяти по тексту запроса. Возвращает совпавшие утверждения с источником, id и уверенностью.',
    // `PluginToolDefinition.parameters` типизирован хостом как `z.ZodTypeAny`
    // (ADR-090), а валидатор плагина — свой (без zod в бандле). Контракт
    // совпадает: хост зовёт `safeParse` и читает `error.issues`, поэтому
    // кастуем через `unknown` — типовой разрыв между двумя реализациями
    // одного контракта.
    parameters: memorySearchParameters as unknown as z.ZodTypeAny,
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
        const factEntries = facts
          .map((fact) => ({ fact, score: keywordScore(query, fact.text) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.fact.confidence !== a.fact.confidence) return b.fact.confidence - a.fact.confidence;
            const byUpdated = Date.parse(b.fact.updatedAt) - Date.parse(a.fact.updatedAt);
            if (!Number.isNaN(byUpdated) && byUpdated !== 0) return byUpdated;
            return a.fact.id.localeCompare(b.fact.id);
          });

        // Фрагменты корпуса — если индекс проекта готов (или устарел).
        const index = await provider.projectIndex(ctx.projectId);
        const chunkItems: SearchItem[] =
          index && (index.state === 'ready' || index.state === 'stale')
            ? (await provider.searchIndex(index.index.id, query, { topK: limit * 3 })).items
            : [];

        if (factEntries.length === 0 && chunkItems.length === 0) {
          return { content: 'Ничего не найдено.' };
        }

        const fused = reciprocalRankFusion([
          factEntries.map((entry) => ({ key: `fact:${entry.fact.id}`, score: entry.score })),
          chunkItems.map((item) => ({ key: `chunk:${item.chunkId}`, score: item.score })),
        ]);
        const factsById = new Map(factEntries.map((entry) => [entry.fact.id, entry.fact]));
        const chunksById = new Map(chunkItems.map((item) => [item.chunkId, item]));

        const lines: string[] = [];
        const evidence: Array<Record<string, unknown>> = [];
        for (const entry of fused.slice(0, limit)) {
          if (entry.key.startsWith('fact:')) {
            const fact = factsById.get(entry.key.slice('fact:'.length));
            if (!fact) continue;
            lines.push(formatFactLineWithMeta(fact));
            evidence.push({ kind: 'fact', factId: fact.id, source: fact.provenance.sourceKind });
            continue;
          }
          const item = chunksById.get(entry.key.slice('chunk:'.length));
          if (!item) continue;
          lines.push(formatChunkLine(item));
          evidence.push({
            kind: 'chunk',
            indexId: item.indexId,
            generation: item.generation,
            chunkId: item.chunkId,
            path: item.metadata?.path,
            startLine: item.metadata?.startLine,
            endLine: item.metadata?.endLine,
          });
        }

        return { content: lines.join('\n'), metadata: { results: evidence } };
      } catch (err) {
        if (err instanceof MemoryUnavailableError) {
          return { content: err.message, isError: true };
        }
        throw err;
      }
    },
  };
}
