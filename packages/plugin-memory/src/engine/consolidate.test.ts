/**
 * М4a: тесты движка консолидации фактов памяти.
 *
 * Проверяются: слияние похожих фактов (канон по правилам приоритета),
 * отсутствие слияния для разных фактов, пробный прогон (`dryRun`), пустой
 * отчёт при недостатке фактов, пробрасывание ошибки эмбеддингов (без
 * частичных записей) и воспроизводимость прогона.
 *
 * Хранилище — настоящее in-memory (`createTestStorage()`), эмбеддинги —
 * детерминированная заглушка по n-граммам (`fakeNgramEmbed`): одинаковые
 * утверждения дают косинус ~0.99, разные — ~0.2.
 */
import type { StorageContext } from '@itphx/synth-core';
import { describe, expect, it } from 'vitest';

import { MemoryProviderLite } from '../provider.js';
import {
  createTestFacade,
  createTestStorage,
  fakeNgramEmbed,
  TEST_PLUGIN_NAME,
} from '../test-support.js';
import { consolidateFacts } from './consolidate.js';

/** Namespace памяти плагина (навязывает хост, ADR-107). */
const NAMESPACE = `plugin:${TEST_PLUGIN_NAME}`;

/** Параметры факта, который тест кладёт в порт. */
interface SeedFact {
  /** id факта. */
  id: string;
  /** Текст утверждения. */
  text: string;
  /** Уверенность (по умолчанию — 0.7). */
  confidence?: number;
  /** Момент последней записи (по умолчанию — фиксированный). */
  updatedAt?: string;
  /** Проект-владелец факта. */
  projectId?: string;
}

/** Положить активный факт в порт памяти плагина. */
async function seedFact(storage: StorageContext, fact: SeedFact): Promise<void> {
  await storage.memoryFacts.save({
    id: fact.id,
    namespace: NAMESPACE,
    version: 1,
    text: fact.text,
    kind: 'observation',
    ...(fact.projectId ? { projectId: fact.projectId } : {}),
    provenance: { sourceKind: 'agent', sourceId: 's1', capturedAt: '2026-10-24T10:00:00.000Z' },
    confidence: fact.confidence ?? 0.7,
    status: 'active',
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: fact.updatedAt ?? '2026-10-24T10:00:00.000Z',
  });
}

/** Провайдер над настоящим in-memory хранилищем + фейковые эмбеддинги. */
function makeMemory(embed?: (texts: readonly string[]) => Promise<number[][]>) {
  const storage = createTestStorage();
  const { facade } = createTestFacade({
    storage,
    ...(embed ? { embed } : {}),
  });
  return { storage, facade, provider: new MemoryProviderLite(facade) };
}

/** Статус факта в порту (для проверок). */
async function statusOf(storage: StorageContext, id: string): Promise<string | undefined> {
  return (await storage.memoryFacts.get(id))?.status;
}

describe('консолидация: слияние похожих фактов', () => {
  it('два почти одинаковых факта → один заменён, канон — с большей уверенностью', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.8,
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.6,
    });

    const report = await consolidateFacts({ provider });

    expect(report.clusters).toBe(1);
    expect(report.superseded).toBe(1);
    expect(report.kept).toBe(1);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.keptId).toBe('mem_a');
    expect(report.items[0]!.supersededIds).toEqual(['mem_b']);
    expect(report.items[0]!.similarity).toBeGreaterThanOrEqual(0.9);

    // Порт: дубликат помечен заменённым и связан с каноном.
    expect(await statusOf(storage, 'mem_b')).toBe('superseded');
    expect((await storage.memoryFacts.get('mem_b'))!.supersededBy).toBe('mem_a');
    expect(await statusOf(storage, 'mem_a')).toBe('active');
  });

  it('текст и версия канона не меняются, в metadata — список слитых фактов', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
    });

    await consolidateFacts({ provider });

    const canon = await storage.memoryFacts.get('mem_a');
    expect(canon!.text).toBe('Деплой в test идёт через Fleet');
    expect(canon!.version).toBe(1);
    expect(canon!.metadata?.consolidatedFrom).toEqual(['mem_b']);
  });

  it('при равной уверенности канон — более длинный текст', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, { id: 'mem_a', text: 'Деплой идёт через Fleet', confidence: 0.7 });
    await seedFact(storage, { id: 'mem_b', text: 'Деплой идёт через Fleet!', confidence: 0.7 });

    const report = await consolidateFacts({ provider });
    expect(report.items[0]!.keptId).toBe('mem_b');
  });

  it('при равной уверенности и длине канон — свежий факт', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    // Порт проставляет `updatedAt = now` при записи, поэтому «свежесть»
    // задаём будущими метками — иначе оба факта получили бы одну метку.
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой идёт через Fleet',
      confidence: 0.7,
      updatedAt: '2098-01-01T10:00:00.000Z',
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой идёт через Fleet',
      confidence: 0.7,
      updatedAt: '2099-01-01T10:00:00.000Z',
    });

    const report = await consolidateFacts({ provider });
    expect(report.items[0]!.keptId).toBe('mem_b');
  });

  it('при полном равенстве канон — факт с меньшим id', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, { id: 'mem_b', text: 'Деплой идёт через Fleet', confidence: 0.7 });
    await seedFact(storage, { id: 'mem_a', text: 'Деплой идёт через Fleet', confidence: 0.7 });

    const report = await consolidateFacts({ provider });
    expect(report.items[0]!.keptId).toBe('mem_a');
    expect(report.items[0]!.supersededIds).toEqual(['mem_b']);
  });

  it('порог вне допустимых границ приводится к границе (fail-soft)', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, { id: 'mem_a', text: 'Деплой в test идёт через Fleet' });
    await seedFact(storage, { id: 'mem_b', text: 'Котлета на завтрак из яблок' });

    // Порог 0.1 снаружи диапазона → приводится к 0.5: разные утверждения
    // (косинус ~0.2) не сливаются.
    const report = await consolidateFacts({ provider }, { threshold: 0.1 });
    expect(report.clusters).toBe(0);
    expect(await statusOf(storage, 'mem_b')).toBe('active');
  });

  it('разные факты не объединяются', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, { id: 'mem_a', text: 'Деплой в test идёт через Fleet' });
    await seedFact(storage, { id: 'mem_b', text: 'Котлета на завтрак из яблок' });

    const report = await consolidateFacts({ provider });

    expect(report.clusters).toBe(0);
    expect(report.superseded).toBe(0);
    expect(report.kept).toBe(2);
    expect(report.items).toEqual([]);
    expect(await statusOf(storage, 'mem_a')).toBe('active');
    expect(await statusOf(storage, 'mem_b')).toBe('active');
  });

  it('порог из настроек: при низком пороге сливаются, при дефолтном — нет', async () => {
    const { storage, facade } = makeMemory(fakeNgramEmbed);
    const provider = new MemoryProviderLite(facade);
    await seedFact(storage, { id: 'mem_a', text: 'Деплой в test идёт через Fleet' });
    await seedFact(storage, { id: 'mem_b', text: 'Деплой в test идёт через kubectl' });

    // Дефолт настройки — 0.9: похожести (~0.8) не хватает.
    const strict = await consolidateFacts({ provider });
    expect(strict.clusters).toBe(0);

    // Порог из аргумента — ниже: факты сливаются.
    const loose = await consolidateFacts({ provider }, { threshold: 0.5 });
    expect(loose.clusters).toBe(1);
    expect(loose.superseded).toBe(1);
  });
});

describe('консолидация: пробный прогон и пустой отчёт', () => {
  it('dryRun — порт не изменён', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
    });

    const report = await consolidateFacts({ provider }, { dryRun: true });

    // План посчитан — как при обычном прогоне.
    expect(report.clusters).toBe(1);
    expect(report.superseded).toBe(1);
    expect(report.items[0]!.keptId).toBe('mem_a');

    // Но память не тронута.
    expect(await statusOf(storage, 'mem_a')).toBe('active');
    expect(await statusOf(storage, 'mem_b')).toBe('active');
    expect((await storage.memoryFacts.get('mem_a'))!.metadata?.consolidatedFrom).toBeUndefined();
  });

  it('фактов нет — пустой отчёт (не ошибка)', async () => {
    const { provider } = makeMemory(fakeNgramEmbed);
    const report = await consolidateFacts({ provider });
    expect(report).toEqual({ clusters: 0, superseded: 0, kept: 0, items: [] });
  });

  it('факт один — пустой отчёт (не ошибка)', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, { id: 'mem_a', text: 'Деплой в test идёт через Fleet' });

    const report = await consolidateFacts({ provider });
    expect(report.clusters).toBe(0);
    expect(report.superseded).toBe(0);
    expect(report.items).toEqual([]);
    expect(await statusOf(storage, 'mem_a')).toBe('active');
  });
});

describe('консолидация: ошибки и воспроизводимость', () => {
  it('ошибка эмбеддингов → исключение, порт не изменён', async () => {
    const { storage, provider } = makeMemory(() =>
      Promise.reject(new Error('Эмбеддинги недоступны')),
    );
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
    });

    await expect(consolidateFacts({ provider })).rejects.toThrow('Эмбеддинги недоступны');

    // Частичных записей нет.
    expect(await statusOf(storage, 'mem_a')).toBe('active');
    expect(await statusOf(storage, 'mem_b')).toBe('active');
  });

  it('детерминизм: два прогона на одном входе дают одинаковый отчёт', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
    });
    await seedFact(storage, { id: 'mem_c', text: 'Котлета на завтрак из яблок' });

    const first = await consolidateFacts({ provider }, { dryRun: true });
    const second = await consolidateFacts({ provider }, { dryRun: true });
    expect(second).toEqual(first);
  });

  it('детерминизм: одинаковый вход в разных хранилищах даёт одинаковый отчёт', async () => {
    const seed = async (storage: StorageContext): Promise<void> => {
      await seedFact(storage, {
        id: 'mem_a',
        text: 'Деплой в test идёт через Fleet',
        confidence: 0.9,
      });
      await seedFact(storage, {
        id: 'mem_b',
        text: 'Деплой в test идёт через Fleet.',
        confidence: 0.5,
      });
      await seedFact(storage, { id: 'mem_c', text: 'Котлета на завтрак из яблок' });
    };

    const first = makeMemory(fakeNgramEmbed);
    await seed(first.storage);
    const second = makeMemory(fakeNgramEmbed);
    await seed(second.storage);

    const reportA = await consolidateFacts({ provider: first.provider }, { dryRun: true });
    const reportB = await consolidateFacts({ provider: second.provider }, { dryRun: true });
    expect(reportB).toEqual(reportA);
  });
});

describe('консолидация: скоуп по проекту', () => {
  it('консолидируются только факты проекта (и общие)', async () => {
    const { storage, provider } = makeMemory(fakeNgramEmbed);
    await seedFact(storage, {
      id: 'mem_p1',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
      projectId: 'p1',
    });
    await seedFact(storage, {
      id: 'mem_p1_dup',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
      projectId: 'p1',
    });
    await seedFact(storage, {
      id: 'mem_p2',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
      projectId: 'p2',
    });

    const report = await consolidateFacts({ provider }, { projectId: 'p1' });

    expect(report.clusters).toBe(1);
    expect(report.items[0]!.keptId).toBe('mem_p1');
    expect(report.items[0]!.supersededIds).toEqual(['mem_p1_dup']);

    // Факт чужого проекта не тронут.
    expect(await statusOf(storage, 'mem_p2')).toBe('active');
  });
});
