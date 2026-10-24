/**
 * М5: тул `memory_graph` — граф сущностей памяти (точка `tools`).
 *
 * Показывает, какие сущности упоминаются в фактах памяти и как они связаны:
 * либо весь граф скоупа, либо окрестность одной сущности (факты → соседние
 * сущности → их факты).
 *
 * **Скоуп — проект сессии** (`ctx.projectId`): в граф попадают факты проекта
 * сессии и общие (без проекта); чужие проекты не видны. То же правило, что у
 * остальных тулов памяти (ADR-107, docs/MEMORY.md §3).
 *
 * **Без LLM.** Граф строится движком `engine/graph.ts` — чистая функция от
 * текста фактов: извлечение `[[сущность]]` детерминированное и бесплатное.
 */
import type { PluginToolDefinition } from '@itphx/synth-core';
import type { z } from 'zod';

import {
  buildGraph,
  CO_OCCURS_RELATION,
  entityNodeId,
  FACT_NODE_PREFIX,
  GRAPH_FACT_LIMIT,
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_LIMIT,
  MIN_GRAPH_DEPTH,
  MIN_GRAPH_LIMIT,
  normalizeEntityName,
  type MemoryGraph,
} from '../engine/graph.js';
import { MemoryUnavailableError, type MemoryProviderLite } from '../provider.js';
import { number, object, optional, string } from '../schema.js';

/** Локальное имя тула (в реестре — с namespace'ом, его составляет хост). */
export const MEMORY_GRAPH_TOOL_NAME = 'memory_graph';

/** Сколько сущностей перечислять в сводке по всему графу. */
export const GRAPH_TOP_ENTITIES = 10;

/**
 * Схема параметров — по ней хост валидирует аргументы.
 *
 * Валидатор — собственный (`schema.ts`): бандл плагина не должен тянуть
 * сторонние зависимости (иначе скан помечает его как `caution`).
 */
export const memoryGraphParameters = object({
  entity: optional(string({ min: 1, max: 200 })),
  depth: optional(number({ min: MIN_GRAPH_DEPTH, max: MAX_GRAPH_DEPTH, int: true })),
  limit: optional(number({ min: MIN_GRAPH_LIMIT, max: MAX_GRAPH_LIMIT, int: true })),
});

/** Явная JSON-схема параметров — то, что видит модель (ADR-090, §4.3). */
export const memoryGraphJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    entity: {
      type: 'string',
      description:
        'Сущность вокруг которой строится окрестность (как в фактах: [[Сущность]]). Без неё — весь граф скоупа.',
    },
    depth: {
      type: 'number',
      minimum: MIN_GRAPH_DEPTH,
      maximum: MAX_GRAPH_DEPTH,
      description:
        'Глубина окрестности: 1 — факты сущности, 2 — плюс со-встречаемые сущности, 3 — плюс их факты (по умолчанию 1).',
    },
    limit: {
      type: 'number',
      minimum: MIN_GRAPH_LIMIT,
      maximum: MAX_GRAPH_LIMIT,
      description: 'Потолок узлов и связей графа (по умолчанию 200).',
    },
  },
  additionalProperties: false,
};

/** Формы слова «факт» (1, 2-4, 5+). */
const FACT_FORMS = ['факт', 'факта', 'фактов'] as const;
/** Формы слова «связь». */
const LINK_FORMS = ['связь', 'связи', 'связей'] as const;

/** Русская форма существительного по числу. */
function plural(count: number, forms: readonly [string, string, string]): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  const mod10 = count % 10;
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/** Число фактов, упоминающих каждую сущность (по рёбрам «факт → сущность»). */
function entityFactCounts(graph: MemoryGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.relation === CO_OCCURS_RELATION) continue;
    if (!edge.to.startsWith('entity:')) continue;
    const key = edge.to.slice('entity:'.length);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Узел сущности по нормализованному ключу. */
function findEntityNode(graph: MemoryGraph, key: string) {
  return graph.nodes.find((node) => node.kind === 'entity' && node.entity === key);
}

/**
 * Текст сводки по всему графу: счётчики + топ-сущности по числу фактов.
 */
export function formatGraphSummary(graph: MemoryGraph): string {
  const lines = [
    `Сущностей: ${graph.stats.entities}, фактов: ${graph.stats.facts}, связей: ${graph.stats.edges}`,
  ];
  const counts = entityFactCounts(graph);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, GRAPH_TOP_ENTITIES);
  if (top.length === 0) {
    lines.push('В памяти скоупа нет фактов с сущностями «[[…]]».');
    return lines.join('\n');
  }
  lines.push('Топ-сущности (по числу фактов):');
  for (const [key, count] of top) {
    const node = findEntityNode(graph, key);
    lines.push(`- ${node?.name ?? key} — ${count} ${plural(count, FACT_FORMS)}`);
  }
  return lines.join('\n');
}

/**
 * Текст сводки по сущности: её факты и со-встречаемые сущности.
 */
export function formatEntitySummary(graph: MemoryGraph, entity: string): string {
  const key = normalizeEntityName(entity);
  const node = findEntityNode(graph, key);
  if (!node) {
    return `Сущность «${key}» не найдена в памяти скоупа — в фактах нет упоминаний «[[${key}]]».`;
  }
  const rootId = entityNodeId(key);
  const factEdges = graph.edges.filter(
    (edge) => edge.to === rootId && edge.from.startsWith(FACT_NODE_PREFIX),
  );
  const neighbourEdges = graph.edges.filter(
    (edge) =>
      edge.relation === CO_OCCURS_RELATION && (edge.from === rootId || edge.to === rootId),
  );
  const links = factEdges.length + neighbourEdges.length;
  const lines = [
    `Сущность «${node.name ?? key}»: ${factEdges.length} ${plural(factEdges.length, FACT_FORMS)}, ${links} ${plural(links, LINK_FORMS)}`,
  ];
  if (factEdges.length > 0) {
    lines.push('Факты:');
    for (const edge of factEdges) {
      const factId = edge.from.slice(FACT_NODE_PREFIX.length);
      const factNode = graph.nodes.find((item) => item.id === edge.from);
      lines.push(`- ${factId} — ${factNode?.text ?? ''} (связь: ${edge.relation})`);
    }
  }
  if (neighbourEdges.length > 0) {
    lines.push('Соседние сущности:');
    for (const edge of neighbourEdges) {
      const otherId = edge.from === rootId ? edge.to : edge.from;
      const other = graph.nodes.find((item) => item.id === otherId);
      lines.push(`- ${other?.name ?? otherId}`);
    }
  }
  return lines.join('\n');
}

/**
 * Тул графа памяти.
 *
 * Хранилище недоступно (`facade.memory === undefined`) → понятная ошибка
 * (`isError`), а не падение хода.
 */
export function createMemoryGraphTool(provider: MemoryProviderLite): PluginToolDefinition {
  return {
    name: MEMORY_GRAPH_TOOL_NAME,
    description:
      'Показывает граф сущностей памяти: какие сущности упоминаются в фактах и как они связаны. Без параметров — весь граф проекта (сущности, факты, связи), с entity — окрестность этой сущности (факты → соседние сущности → их факты). Сущности помечаются в фактах как [[Сущность]] или [[Сущность|связь]].',
    // `PluginToolDefinition.parameters` типизирован хостом как `z.ZodTypeAny`
    // (ADR-090), а валидатор плагина — свой (без zod в бандле). Контракт
    // совпадает: хост зовёт `safeParse` и читает `error.issues`, поэтому
    // кастуем через `unknown` — типовой разрыв между двумя реализациями
    // одного контракта.
    parameters: memoryGraphParameters as unknown as z.ZodTypeAny,
    jsonSchema: memoryGraphJsonSchema,
    capabilities: ['memory'],
    async execute(params, ctx) {
      const parsed = memoryGraphParameters.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Некорректные аргументы графа памяти: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'entity'} — ${issue.message}`)
            .join('; ')}`,
          isError: true,
        };
      }
      const { entity, depth, limit } = parsed.data;

      try {
        // Скоуп сессии важнее аргумента модели (то же правило, что у `memory_write`).
        const scopeProjectId = ctx.projectId?.trim() ? ctx.projectId : undefined;
        const facts = await provider.listFacts({
          status: 'active',
          limit: GRAPH_FACT_LIMIT,
          ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
        });

        const graph = buildGraph(facts, {
          ...(entity !== undefined ? { entity } : {}),
          ...(depth !== undefined ? { depth } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });

        return {
          content: entity
            ? formatEntitySummary(graph, entity)
            : formatGraphSummary(graph),
          metadata: {
            nodes: graph.nodes,
            edges: graph.edges,
            stats: graph.stats,
          },
        };
      } catch (err) {
        if (err instanceof MemoryUnavailableError) {
          return { content: err.message, isError: true };
        }
        throw err;
      }
    },
  };
}
