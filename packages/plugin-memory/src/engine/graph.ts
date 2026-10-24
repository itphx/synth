/**
 * М5: граф сущностей памяти — извлечение `[[сущность]]` **без LLM**.
 *
 * Идея: в тексте факта сущности помечаются двойными скобками — `[[Synth]]`
 * или `[[Synth|используется в]]`. Из этих пометок строится граф памяти:
 * узлы — сущности (`kind: 'entity'`) и факты (`kind: 'fact'`), рёбра —
 * «факт → сущность» (с меткой связи, если она указана) и «сущность ↔ сущность»
 * (со-встречаемость в одном факте, `relation: 'co_occurs'`).
 *
 * **Без LLM — намеренно.** Извлечение детерминированное: один и тот же корпус
 * даёт один и тот же граф (воспроизводимость важнее полноты) и не тратит
 * токены — вызова модели здесь нет вовсе (инвариант 3: любой вызов LLM идёт
 * через шлюз; граф — чистая функция от текста фактов).
 *
 * **Правила разбора.**
 * - `[[сущность]]` — сущность без связи; `[[сущность|связь]]` — с меткой
 *   связи (метка необязательная);
 * - пробелы по краям обрезаются; для **сравнения** внутренние пробелы
 *   схлопываются (ключ сущности), в выдаче остаётся исходное написание
 *   первого вхождения;
 * - пустые имена (`[[]]`, `[[ ]]`, `[[|связь]]`) отбрасываются;
 * - регистр сохраняется: `[[A]]` и `[[a]]` — разные сущности;
 * - дубли одной сущности в пределах факта схлопываются (метка связи — первая
 *   непустая).
 *
 * **Детерминизм.** Порядок узлов и рёбер фиксирован: сущности — по
 * нормализованному имени, факты — по id, рёбра — по (`from`, `to`, `relation`).
 * Один вход → один выход (в этом же смысле, что и у блоков промпта).
 */
import type { MemoryFactRecord } from '@itphx/synth-core';

/** Потолок фактов, просматриваемых при построении графа (потолок порта памяти). */
export const GRAPH_FACT_LIMIT = 1000;

/** Дефолтный лимит узлов и рёбер графа. */
export const DEFAULT_GRAPH_LIMIT = 200;
/** Минимальный лимит узлов и рёбер. */
export const MIN_GRAPH_LIMIT = 1;
/** Максимальный лимит узлов и рёбер. */
export const MAX_GRAPH_LIMIT = 200;

/** Дефолтная глубина окрестности (1 — факты, упоминающие сущность). */
export const DEFAULT_GRAPH_DEPTH = 1;
/** Минимальная глубина окрестности. */
export const MIN_GRAPH_DEPTH = 1;
/** Максимальная глубина окрестности. */
export const MAX_GRAPH_DEPTH = 3;

/** Связь «факт → сущность» без явной метки. */
export const MENTIONS_RELATION = 'mentions';
/** Связь «сущность ↔ сущность» (со-встречаемость в одном факте). */
export const CO_OCCURS_RELATION = 'co_occurs';

/** Предел длины текста факта в узле графа (символы). */
export const GRAPH_TEXT_LIMIT = 200;

/** Префикс id узла-сущности. */
export const ENTITY_NODE_PREFIX = 'entity:';
/** Префикс id узла-факта. */
export const FACT_NODE_PREFIX = 'fact:';

/** Вид узла графа. */
export type GraphNodeKind = 'entity' | 'fact';

/** Узел графа памяти. */
export interface GraphNode {
  /** Идентификатор узла (`entity:<ключ>` либо `fact:<id>`). */
  id: string;
  /** Вид узла. */
  kind: GraphNodeKind;
  /** Имя сущности в исходном написании — только для узлов-сущностей. */
  name?: string;
  /** id факта — только для узлов-фактов. */
  factId?: string;
  /** Текст факта (обрезан до {@link GRAPH_TEXT_LIMIT}) — только для узлов-фактов. */
  text?: string;
  /** Нормализованный ключ сущности — только для узлов-сущностей. */
  entity?: string;
}

/** Ребро графа памяти. */
export interface GraphEdge {
  /** id узла-источника. */
  from: string;
  /** id узла-приёмника. */
  to: string;
  /** Метка связи (`mentions` / `co_occurs` / метка из `[[сущность|связь]]`). */
  relation: string;
}

/** Счётчики графа. */
export interface GraphStats {
  /** Число узлов-сущностей. */
  entities: number;
  /** Число узлов-фактов. */
  facts: number;
  /** Число рёбер. */
  edges: number;
}

/** Граф памяти. */
export interface MemoryGraph {
  /** Узлы (сущности, затем факты). */
  nodes: GraphNode[];
  /** Рёбра. */
  edges: GraphEdge[];
  /** Счётчики по выданному графу. */
  stats: GraphStats;
}

/** Упоминание сущности в тексте факта. */
export interface EntityMention {
  /** Имя в исходном написании (обрезанное по краям). */
  name: string;
  /** Нормализованный ключ (по нему сущности сравниваются). */
  key: string;
  /** Метка связи (`[[сущность|связь]]`), если была указана. */
  relation?: string;
}

/** Опции построения графа. */
export interface BuildGraphOptions {
  /** Сущность, вокруг которой строится окрестность (не задана — весь граф). */
  entity?: string;
  /** Глубина окрестности (1..3, дефолт 1). */
  depth?: number;
  /** Потолок узлов и рёбер (1..200, дефолт 200). */
  limit?: number;
}

/** Нормализовать имя сущности для сравнения: trim + схлопывание пробелов. */
export function normalizeEntityName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** id узла-сущности. */
export function entityNodeId(key: string): string {
  return `${ENTITY_NODE_PREFIX}${key}`;
}

/** id узла-факта. */
export function factNodeId(factId: string): string {
  return `${FACT_NODE_PREFIX}${factId}`;
}

/** Ключ сущности из id узла (обратно к {@link entityNodeId}). */
export function entityKeyOfNodeId(nodeId: string): string | undefined {
  return nodeId.startsWith(ENTITY_NODE_PREFIX) ? nodeId.slice(ENTITY_NODE_PREFIX.length) : undefined;
}

/** Сравнение строк по кодовым единицам — без зависимости от локали. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Привести число к диапазону; нечисловое значение — запасной вариант. */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Извлечь сущности из текста факта.
 *
 * Разбор шаблонный: `[[имя]]` и `[[имя|метка]]`. Пустые имена отбрасываются,
 * дубли одной сущности в пределах текста схлопываются (метка связи — первая
 * непустая), регистр сохраняется.
 */
export function extractEntities(text: string): EntityMention[] {
  const mentions = new Map<string, EntityMention>();
  // Регулярное выражение создаётся внутри функции: у глобальногоregex состояние
  // `lastIndex` переживает вызовы и ломает разбор (та же осторожность, что в
  // `schema.ts`).
  const pattern = /\[\[([^[\]|]*)(?:\|([^[\]]*))?\]\]/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const name = (match[1] ?? '').trim();
    const key = normalizeEntityName(name);
    if (key) {
      const relation = (match[2] ?? '').trim();
      const existing = mentions.get(key);
      if (existing) {
        // Дубль в пределах факта: сущность уже есть — дополняем меткой связи,
        // если она ещё не задана (первая непустая побеждает).
        if (!existing.relation && relation) existing.relation = relation;
      } else {
        mentions.set(key, {
          name,
          key,
          ...(relation ? { relation } : {}),
        });
      }
    }
    match = pattern.exec(text);
  }
  return [...mentions.values()];
}

/** Обрезать текст факта до предела узла графа. */
export function truncateGraphText(text: string, limit = GRAPH_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** Пустой граф (нет сущностей или сущность не найдена — не ошибка). */
function emptyGraph(): MemoryGraph {
  return { nodes: [], edges: [], stats: { entities: 0, facts: 0, edges: 0 } };
}

/**
 * Построить граф памяти по фактам.
 *
 * - без `entity` — весь граф по скоупу (факты с сущностями; факты без
 *   пометок в граф не попадают — они не связаны ни с чем);
 * - с `entity` — окрестность этой сущности: BFS по двудольному графу
 *   «сущность → факт → сущность → …», глубина считается шагами этого обхода
 *   (`depth: 1` — сущность и её факты, `depth: 2` — плюс со-встречаемые
 *   сущности, `depth: 3` — плюс их факты);
 * - лимит режет узлы (сущности по имени, затем факты по id) и рёбра; рёбра
 *   оставляются только между оставшимися узлами — «висячих» связей нет.
 */
export function buildGraph(
  facts: readonly MemoryFactRecord[],
  options: BuildGraphOptions = {},
): MemoryGraph {
  const limit = clampInt(
    options.limit ?? DEFAULT_GRAPH_LIMIT,
    MIN_GRAPH_LIMIT,
    MAX_GRAPH_LIMIT,
    DEFAULT_GRAPH_LIMIT,
  );
  const depth = clampInt(
    options.depth ?? DEFAULT_GRAPH_DEPTH,
    MIN_GRAPH_DEPTH,
    MAX_GRAPH_DEPTH,
    DEFAULT_GRAPH_DEPTH,
  );

  // Факты — в детерминированном порядке (по id): порядок выдачи порта не
  // должен влиять на граф.
  const ordered = [...facts].sort((a, b) => compareStrings(a.id, b.id));

  /** Имя сущности в исходном написании (первое вхождение по корпусу). */
  const entityNames = new Map<string, string>();
  /** id фактов, упоминающих сущность (в порядке фактов). */
  const entityFactIds = new Map<string, string[]>();
  /** Ключи сущностей факта (в порядке первого упоминания). */
  const factEntities = new Map<string, string[]>();
  /** Метки связи «факт → сущность». */
  const factRelations = new Map<string, Map<string, string>>();
  /** Записи фактов (для текста узла). */
  const factRecords = new Map<string, MemoryFactRecord>();

  for (const fact of ordered) {
    const mentions = extractEntities(fact.text);
    if (mentions.length === 0) continue;
    factRecords.set(fact.id, fact);
    const keys: string[] = [];
    const relations = new Map<string, string>();
    for (const mention of mentions) {
      if (!entityNames.has(mention.key)) entityNames.set(mention.key, mention.name);
      const factIds = entityFactIds.get(mention.key);
      if (factIds) factIds.push(fact.id);
      else entityFactIds.set(mention.key, [fact.id]);
      if (!keys.includes(mention.key)) keys.push(mention.key);
      if (mention.relation && !relations.has(mention.key)) {
        relations.set(mention.key, mention.relation);
      }
    }
    factEntities.set(fact.id, keys);
    factRelations.set(fact.id, relations);
  }

  // Рёбра: «факт → сущность» и «сущность ↔ сущность» (со-встречаемость).
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (from: string, to: string, relation: string): void => {
    const key = `${from}\u0000${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, relation });
  };

  for (const fact of ordered) {
    const keys = factEntities.get(fact.id);
    if (!keys) continue;
    const relations = factRelations.get(fact.id) ?? new Map<string, string>();
    for (const key of keys) {
      addEdge(factNodeId(fact.id), entityNodeId(key), relations.get(key) ?? MENTIONS_RELATION);
    }
    // Со-встречаемость: все пары сущностей одного факта (порядок пары — по
    // ключу, чтобы ребро было неориентированным и воспроизводимым).
    const sorted = [...keys].sort(compareStrings);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const left = sorted[i];
        const right = sorted[j];
        if (!left || !right) continue;
        addEdge(entityNodeId(left), entityNodeId(right), CO_OCCURS_RELATION);
      }
    }
  }

  // Набор узлов: весь граф или окрестность одной сущности.
  // Сущность задана (даже если из одних пробелов) — ищем окрестность: пустое
  // имя не найдётся, вернётся пустой граф (а не весь граф скоупа).
  const hasEntity = options.entity !== undefined;
  const rootKey = hasEntity ? normalizeEntityName(options.entity ?? '') : '';
  let nodeIds: Set<string>;
  if (!hasEntity) {
    nodeIds = new Set<string>();
    for (const key of entityNames.keys()) nodeIds.add(entityNodeId(key));
    for (const factId of factEntities.keys()) nodeIds.add(factNodeId(factId));
  } else {
    if (!rootKey || !entityNames.has(rootKey)) return emptyGraph();
    nodeIds = neighborhood(entityNodeId(rootKey), depth, {
      entityFactIds,
      factEntities,
    });
  }

  // Узлы: сущности (по имени; корневая — первой в окрестности), затем факты (по id).
  const entityKeys = [...entityNames.keys()]
    .filter((key) => nodeIds.has(entityNodeId(key)))
    .sort((a, b) => {
      if (rootKey && a === rootKey) return -1;
      if (rootKey && b === rootKey) return 1;
      return compareStrings(a, b);
    });
  const factIds = [...factRecords.keys()]
    .filter((factId) => nodeIds.has(factNodeId(factId)))
    .sort(compareStrings);

  const nodes: GraphNode[] = [];
  for (const key of entityKeys) {
    nodes.push({
      id: entityNodeId(key),
      kind: 'entity',
      name: entityNames.get(key),
      entity: key,
    });
  }
  for (const factId of factIds) {
    const fact = factRecords.get(factId);
    if (!fact) continue;
    nodes.push({
      id: factNodeId(factId),
      kind: 'fact',
      factId,
      text: truncateGraphText(fact.text),
    });
  }

  // Лимит узлов: сущности идут первыми — они несут смысл графа.
  const limitedNodes = nodes.slice(0, limit);
  const keptNodeIds = new Set(limitedNodes.map((node) => node.id));

  const limitedEdges = edges
    .filter((edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to))
    .sort(
      (a, b) =>
        compareStrings(a.from, b.from) ||
        compareStrings(a.to, b.to) ||
        compareStrings(a.relation, b.relation),
    )
    .slice(0, limit);

  return {
    nodes: limitedNodes,
    edges: limitedEdges,
    stats: {
      entities: limitedNodes.filter((node) => node.kind === 'entity').length,
      facts: limitedNodes.filter((node) => node.kind === 'fact').length,
      edges: limitedEdges.length,
    },
  };
}

/** Данные для обхода окрестности. */
interface NeighborhoodInput {
  /** id фактов по сущности. */
  entityFactIds: Map<string, string[]>;
  /** Ключи сущностей по факту. */
  factEntities: Map<string, string[]>;
}

/**
 * Окрестность сущности: BFS по двудольному графу «сущность → факт → сущность».
 *
 * Глубина — число шагов обхода: 1 — факты корневой сущности, 2 — сущности,
 * встречающиеся в этих фактах, 3 — их факты.
 */
function neighborhood(
  rootNodeId: string,
  depth: number,
  input: NeighborhoodInput,
): Set<string> {
  const visited = new Set<string>([rootNodeId]);
  const levels = new Map<string, number>([[rootNodeId, 0]]);
  const queue: string[] = [rootNodeId];

  const neighborsOf = (nodeId: string): string[] => {
    const entityKey = entityKeyOfNodeId(nodeId);
    if (entityKey !== undefined) {
      return (input.entityFactIds.get(entityKey) ?? []).map((factId) => factNodeId(factId));
    }
    const factId = nodeId.slice(FACT_NODE_PREFIX.length);
    return (input.factEntities.get(factId) ?? []).map((key) => entityNodeId(key));
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const level = levels.get(current) ?? 0;
    if (level >= depth) continue;
    for (const neighbor of neighborsOf(current)) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      levels.set(neighbor, level + 1);
      queue.push(neighbor);
    }
  }
  return visited;
}
