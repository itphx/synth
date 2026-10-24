/**
 * М5: тесты движка графа сущностей памяти.
 *
 * Проверяются: разбор `[[сущность]]` / `[[сущность|связь]]` (пустые имена,
 * дубли, регистр, пробелы), построение графа по корпусу (детерминированный
 * порядок, со-встречаемость, окрестность глубины 1/2/3, лимит) и пустой
 * корпус.
 */
import type { MemoryFactRecord } from '@itphx/synth-core';
import { describe, expect, it } from 'vitest';

import {
  buildGraph,
  CO_OCCURS_RELATION,
  extractEntities,
  MENTIONS_RELATION,
  normalizeEntityName,
} from './graph.js';

/** Факт памяти для графа. */
function fact(id: string, text: string): MemoryFactRecord {
  return {
    id,
    namespace: 'plugin:synth-plugin-memory',
    version: 1,
    text,
    kind: 'observation',
    provenance: { sourceKind: 'agent', sourceId: 's1', capturedAt: '2026-10-24T10:00:00.000Z' },
    confidence: 0.7,
    status: 'active',
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
  };
}

/** Корпус из трёх фактов: Fleet/GitVerse в одном, itphx — в другом. */
function corpus(): MemoryFactRecord[] {
  return [
    fact('f1', 'Деплой идёт через [[Fleet]] и [[GitVerse]]'),
    fact('f2', 'Провайдер [[itphx]] — основной для dev'),
    fact('f3', 'Релизы [[GitVerse]] собираются вручную'),
  ];
}

describe('извлечение сущностей', () => {
  it('разбирает [[сущность]] без связи', () => {
    expect(extractEntities('Проект [[Synth]] живёт')).toEqual([
      { name: 'Synth', key: 'Synth' },
    ]);
  });

  it('разбирает [[сущность|связь]] с меткой связи', () => {
    expect(extractEntities('[[Synth|используется в]] — ядро')).toEqual([
      { name: 'Synth', key: 'Synth', relation: 'используется в' },
    ]);
  });

  it('пустые скобки и пустые имена отбрасываются', () => {
    const mentions = extractEntities('[[]] [[ ]] [[|связь]] [[A]]');
    expect(mentions).toEqual([{ name: 'A', key: 'A' }]);
  });

  it('дубли в пределах факта схлопываются, метка — первая непустая', () => {
    const mentions = extractEntities('[[A]] [[A]] [[A|связь]]');
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toEqual({ name: 'A', key: 'A', relation: 'связь' });
  });

  it('регистр сохраняется: [[A]] и [[a]] — разные сущности', () => {
    const mentions = extractEntities('[[A]] и [[a]]');
    expect(mentions.map((mention) => mention.key)).toEqual(['A', 'a']);
  });

  it('пробелы обрезаются, ключ схлопывает внутренние пробелы', () => {
    const mentions = extractEntities('[[  Post   gre ]]');
    expect(mentions[0]?.name).toBe('Post   gre');
    expect(mentions[0]?.key).toBe('Post gre');
    expect(normalizeEntityName('  a   b  ')).toBe('a b');
  });
});

describe('построение графа памяти', () => {
  it('без entity — весь граф в детерминированном порядке', () => {
    const graph = buildGraph(corpus());

    expect(graph.nodes.map((node) => node.id)).toEqual([
      'entity:Fleet',
      'entity:GitVerse',
      'entity:itphx',
      'fact:f1',
      'fact:f2',
      'fact:f3',
    ]);
    expect(graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.relation}`)).toEqual([
      'entity:Fleet->entity:GitVerse:co_occurs',
      'fact:f1->entity:Fleet:mentions',
      'fact:f1->entity:GitVerse:mentions',
      'fact:f2->entity:itphx:mentions',
      'fact:f3->entity:GitVerse:mentions',
    ]);
    expect(graph.stats).toEqual({ entities: 3, facts: 3, edges: 5 });
  });

  it('со-встречаемость в одном факте даёт ребро co_occurs', () => {
    const graph = buildGraph([fact('f1', '[[A]] и [[B]] рядом')]);
    const coOccurs = graph.edges.filter((edge) => edge.relation === CO_OCCURS_RELATION);
    expect(coOccurs).toHaveLength(1);
    expect(coOccurs[0]?.from).toBe('entity:A');
    expect(coOccurs[0]?.to).toBe('entity:B');
    expect(graph.edges.filter((edge) => edge.relation === MENTIONS_RELATION)).toHaveLength(2);
  });

  it('с entity и depth 1 — сущность и её факты', () => {
    const graph = buildGraph(corpus(), { entity: 'Fleet', depth: 1 });
    expect(graph.nodes.map((node) => node.id)).toEqual(['entity:Fleet', 'fact:f1']);
    expect(graph.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'fact:f1->entity:Fleet',
    ]);
    expect(graph.stats).toEqual({ entities: 1, facts: 1, edges: 1 });
  });

  it('с entity и depth 2 — плюс со-встречаемые сущности', () => {
    const graph = buildGraph(corpus(), { entity: 'Fleet', depth: 2 });
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'entity:Fleet',
      'entity:GitVerse',
      'fact:f1',
    ]);
    expect(graph.stats).toEqual({ entities: 2, facts: 1, edges: 3 });
  });

  it('с entity и depth 3 — плюс факты соседних сущностей', () => {
    const graph = buildGraph(corpus(), { entity: 'Fleet', depth: 3 });
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'entity:Fleet',
      'entity:GitVerse',
      'fact:f1',
      'fact:f3',
    ]);
    expect(graph.stats).toEqual({ entities: 2, facts: 2, edges: 4 });
  });

  it('пустой корпус — пустые массивы, не ошибка', () => {
    const graph = buildGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.stats).toEqual({ entities: 0, facts: 0, edges: 0 });
  });

  it('факты без сущностей в граф не попадают', () => {
    const graph = buildGraph([fact('f1', 'Утверждение без пометок')]);
    expect(graph.nodes).toEqual([]);
    expect(graph.stats.facts).toBe(0);
  });

  it('неизвестная сущность — пустой граф, не ошибка', () => {
    const graph = buildGraph(corpus(), { entity: 'Неизвестно' });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('пустое имя сущности — пустой граф, а не весь граф', () => {
    const graph = buildGraph(corpus(), { entity: '   ' });
    expect(graph.nodes).toEqual([]);
    expect(graph.stats.entities).toBe(0);
  });

  it('лимит режет узлы и рёбра', () => {
    const graph = buildGraph(corpus(), { limit: 2 });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.every((node) => node.kind === 'entity')).toBe(true);
    expect(graph.edges.length).toBeLessThanOrEqual(2);
    expect(graph.stats.entities).toBe(2);
  });

  it('текст факта в узле обрезан', () => {
    const long = 'x'.repeat(500);
    const graph = buildGraph([fact('f1', `[[A]] ${long}`)]);
    const factNode = graph.nodes.find((node) => node.kind === 'fact');
    expect(factNode?.text?.length).toBe(200);
    expect(factNode?.text?.endsWith('…')).toBe(true);
  });
});
