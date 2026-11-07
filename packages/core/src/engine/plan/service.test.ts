import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKDOWN_LIMITS } from '@itphx/synth-shared';
import { ProjectStore } from '../../storage/project-store.js';
import {
  PlanService,
  PlanColumnNotFoundError,
  PlanItemNotFoundError,
  PlanLimitExceededError,
  PlanValidationError,
  PlanVersionConflictError,
} from './service.js';

/**
 * Доменный сервис плана (PROP-054): атомарная запись, нормализация порядка,
 * версия (оптимистичная блокировка) и лимиты Markdown.
 */
describe('PlanService', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let service: PlanService;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-plan-service-'));
    store = new ProjectStore({ dataDir: tmpDir });
    service = new PlanService(store);
    const project = store.create('План', 'local');
    projectId = project.id;
    await store.save(project);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('создаёт пункт в колонке backlog и поднимает версию', async () => {
    const plan = await service.createItem(projectId, { title: 'Шаг 1', priority: 'high' });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.columnId).toBe('backlog');
    expect(plan.items[0]!.priority).toBe('high');
    expect(plan.version).toBe(2);

    const stored = (await store.load(projectId))!;
    expect(stored.plan!.items).toHaveLength(1);
  });

  it('без columnId берёт первую колонку по order, если backlog отсутствует', async () => {
    await store.mutate(projectId, (project) => {
      project.plan = {
        version: 1,
        updatedAt: 'now',
        columns: [{ id: 'other', name: 'Другая', order: 0 }],
        items: [],
      };
    });
    const plan = await service.createItem(projectId, { title: 'Шаг' });
    expect(plan.items[0]!.columnId).toBe('other');
  });

  it('неизвестная колонка — PlanColumnNotFoundError', async () => {
    await expect(service.createItem(projectId, { title: 'x', columnId: 'nope' }))
      .rejects.toBeInstanceOf(PlanColumnNotFoundError);
  });

  it('move_item ставит пункт перед соседом и нормализует order', async () => {
    const plan = await service.createItem(projectId, { title: 'A' });
    const a = plan.items[0]!.id;
    const second = await service.createItem(projectId, { title: 'B' });
    const b = second.items.find((i) => i.title === 'B')!.id;

    const moved = await service.moveItem(projectId, b, { columnId: 'backlog', beforeItemId: a });
    const items = moved.items.filter((i) => i.columnId === 'backlog').sort((x, y) => x.order - y.order);
    expect(items.map((i) => i.id)).toEqual([b, a]);
    expect(items.map((i) => i.order)).toEqual([0, 1]);
  });

  it('move_item в другую колонку переносит пункт и чинит order исходной', async () => {
    await service.createItem(projectId, { title: 'A' });
    const plan = await service.createItem(projectId, { title: 'B' });
    const b = plan.items.find((i) => i.title === 'B')!.id;

    const moved = await service.moveItem(projectId, b, { columnId: 'done' });
    expect(moved.items.find((i) => i.id === b)!.columnId).toBe('done');
    const backlog = moved.items.filter((i) => i.columnId === 'backlog');
    expect(backlog.map((i) => i.order)).toEqual([0]);
  });

  it('устаревшая версия плана — PlanVersionConflictError с актуальным планом', async () => {
    const plan = await service.createItem(projectId, { title: 'A' });
    const stale = plan.version - 1;

    await expect(service.reorderColumns(projectId, { order: ['backlog'], version: stale }))
      .rejects.toBeInstanceOf(PlanVersionConflictError);

    try {
      await service.reorderColumns(projectId, { order: ['backlog'], version: stale });
    } catch (err) {
      const conflict = err as PlanVersionConflictError;
      expect(conflict.expected).toBe(stale);
      expect(conflict.actual).toBe(plan.version);
      expect(conflict.plan.version).toBe(plan.version);
    }
  });

  it('удаление колонки переносит пункты в moveItemsTo', async () => {
    const plan = await service.createItem(projectId, { title: 'A' });
    const itemId = plan.items[0]!.id;
    await service.addColumn(projectId, { name: 'Архив' });
    const current = (await store.load(projectId))!.plan!;
    const archive = current.columns.find((c) => c.name === 'Архив')!.id;

    const after = await service.deleteColumn(projectId, 'backlog', { moveItemsTo: archive, version: current.version });
    expect(after.columns.find((c) => c.id === 'backlog')).toBeUndefined();
    expect(after.items.find((i) => i.id === itemId)!.columnId).toBe(archive);
  });

  it('удаление колонки с moveItemsTo=null убирает её пункты', async () => {
    const plan = await service.createItem(projectId, { title: 'A' });
    const after = await service.deleteColumn(projectId, 'backlog', {
      moveItemsTo: null,
      version: plan.version,
    });
    expect(after.items).toHaveLength(0);
    expect(after.columns.find((c) => c.id === 'backlog')).toBeUndefined();
  });

  it('неизвестный пункт — PlanItemNotFoundError', async () => {
    await expect(service.updateItem(projectId, 'nope', { title: 'x' }))
      .rejects.toBeInstanceOf(PlanItemNotFoundError);
  });

  it('описание длиннее лимита Markdown — PlanLimitExceededError', async () => {
    const long = 'x'.repeat(MARKDOWN_LIMITS.planDescription + 1);
    await expect(service.createItem(projectId, { title: 'A', description: long }))
      .rejects.toBeInstanceOf(PlanLimitExceededError);
  });

  it('пустой заголовок — PlanValidationError', async () => {
    await expect(service.createItem(projectId, { title: '  ' }))
      .rejects.toBeInstanceOf(PlanValidationError);
  });

  it('reorder_columns переставляет колонки и сохраняет прочие в конце', async () => {
    const plan = await service.createItem(projectId, { title: 'A' });
    const ids = plan.columns.map((c) => c.id);
    const after = await service.reorderColumns(projectId, {
      order: [ids[1]!, ids[0]!],
      version: plan.version,
    });
    const sorted = [...after.columns].sort((a, b) => a.order - b.order);
    expect(sorted[0]!.id).toBe(ids[1]);
    expect(sorted.map((c) => c.order)).toEqual([0, 1, 2, 3]);
  });
});
