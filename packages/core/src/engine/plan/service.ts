/**
 * Доменный сервис плана проекта (ADR-039, PROP-054).
 *
 * Единая точка правки `project.plan`: её зовут **и** инструменты (`plan_write`),
 * **и** HTTP-роуты (`/api/v2/projects/:id/plan*`) — логика не дублируется, а
 * поведение (нормализация `order`, версия, лимиты Markdown) одинаково.
 *
 * Правила (PROP-054, дополнение 2026-11-07):
 * - запись — **только** через `ProjectRepository.mutate` (атомарный
 *   read-modify-write; `load` + `save` теряют параллельную правку);
 * - `plan.version` — оптимистичная блокировка для `move`, удаления колонки и
 *   порядка колонок: несовпадение → `PlanVersionConflictError` (HTTP 409
 *   `PLAN_VERSION_CONFLICT`, в теле — актуальный план);
 * - одиночные правки полей версии не требуют (применяются к текущему пункту
 *   под локом хранилища);
 * - после `move`/`order` порядок нормализуется в `0..n-1`;
 * - лимиты Markdown (`MARKDOWN_LIMITS`) проверяются здесь — и HTTP, и
 *   инструменты берут одну и ту же проверку.
 */
import { randomUUID } from 'node:crypto';
import { nowISO, MARKDOWN_LIMITS } from '@itphx/synth-shared';
import type {
  Project,
  ProjectPlan,
  PlanColumn,
  PlanItem,
  PlanDependency,
} from '@itphx/synth-shared';
import { t as sm } from '../system-messages.js';

/** Минимальный порт хранилища проектов, нужный сервису плана. */
export interface PlanStore {
  load(id: string): Promise<Project | null>;
  mutate(id: string, mutator: (project: Project) => void): Promise<Project | null>;
}

/** Пункт плана не найден (HTTP 404). */
export class PlanItemNotFoundError extends Error {
  constructor(readonly itemId: string) {
    super(`Plan item "${itemId}" not found`);
    this.name = 'PlanItemNotFoundError';
  }
}

/** Колонка плана не найдена (HTTP 404). */
export class PlanColumnNotFoundError extends Error {
  constructor(readonly columnId: string) {
    super(`Plan column "${columnId}" not found`);
    this.name = 'PlanColumnNotFoundError';
  }
}

/** Проект не найден (HTTP 404). */
export class PlanProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project "${projectId}" not found`);
    this.name = 'PlanProjectNotFoundError';
  }
}

/**
 * Конфликт версии плана (HTTP 409 `PLAN_VERSION_CONFLICT`).
 * `plan` — актуальный план, его клиент кладёт в тело ответа и перечитывает.
 */
export class PlanVersionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly plan: ProjectPlan,
  ) {
    super(`Plan version conflict: expected ${expected}, actual ${actual}`);
    this.name = 'PlanVersionConflictError';
  }
}

/** Некорректные данные правки (HTTP 400 `VALIDATION_ERROR`). */
export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

/** Превышен лимит Markdown-поля (HTTP 400 `VALIDATION_ERROR`). */
export class PlanLimitExceededError extends Error {
  constructor(
    readonly field: string,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`"${field}" exceeds the limit of ${limit} bytes (${actual})`);
    this.name = 'PlanLimitExceededError';
  }
}

/** Предел длины заголовка пункта плана. */
export const PLAN_ITEM_TITLE_MAX = 500;
/** Предел длины имени колонки. */
export const PLAN_COLUMN_NAME_MAX = 100;

/** Ввод: создание пункта плана. */
export interface PlanItemCreateInput {
  title: string;
  description?: string;
  columnId?: string;
  priority?: 'high' | 'medium' | 'low';
  dependsOn?: PlanDependency[];
  tags?: string[];
}

/** Ввод: точечная правка пункта плана. */
export interface PlanItemUpdateInput {
  title?: string;
  description?: string;
  priority?: 'high' | 'medium' | 'low';
  tags?: string[];
  dependsOn?: PlanDependency[];
}

/** Ввод: перемещение пункта плана. */
export interface PlanItemMoveInput {
  columnId: string;
  beforeItemId?: string;
  afterItemId?: string;
  /** Позиция в колонке (0-based) — используется, если не заданы соседи. */
  order?: number;
  version?: number;
}

/** Ввод: создание колонки. */
export interface PlanColumnCreateInput {
  name: string;
  wipLimit?: number;
}

/** Ввод: правка колонки. */
export interface PlanColumnUpdateInput {
  name?: string;
  wipLimit?: number;
}

/** Ввод: удаление колонки. */
export interface PlanColumnDeleteInput {
  /** Куда переносятся пункты колонки; `null` — удалить вместе с колонкой. */
  moveItemsTo: string | null;
  /**
   * Ожидаемая версия плана (оптимистичная блокировка). Не задана — проверка
   * пропускается (правка агента всегда «свежая»).
   */
  version?: number;
}

/** Ввод: порядок колонок. */
export interface PlanColumnsOrderInput {
  order: string[];
  /** Ожидаемая версия плана (оптимистичная блокировка); не задана — без проверки. */
  version?: number;
}

/** Колонки плана по умолчанию (для проекта без плана). */
function defaultColumns(): PlanColumn[] {
  return [
    { id: 'backlog', name: sm('plan.default_column_backlog'), order: 0 },
    { id: 'todo', name: sm('plan.default_column_todo'), order: 1 },
    { id: 'in_progress', name: sm('plan.default_column_in_progress'), order: 2 },
    { id: 'done', name: sm('plan.default_column_done'), order: 3 },
  ];
}

/** Дефолтный план (для проекта, у которого `plan` ещё не задан). */
export function defaultPlan(): ProjectPlan {
  return {
    version: 1,
    updatedAt: nowISO(),
    columns: defaultColumns(),
    items: [],
  };
}

/**
 * План проекта; если `plan` отсутствует — создаётся дефолтная структура
 * (как в прежнем `plan_write`).
 */
export function getPlan(project: Project): ProjectPlan {
  if (!project.plan) project.plan = defaultPlan();
  return project.plan;
}

/** Колонки плана в порядке `order`. */
export function sortedColumns(plan: ProjectPlan): PlanColumn[] {
  return [...plan.columns].sort((a, b) => a.order - b.order);
}

/** Пункты колонки в порядке `order`. */
export function sortedItems(plan: ProjectPlan, columnId: string): PlanItem[] {
  return plan.items.filter((i) => i.columnId === columnId).sort((a, b) => a.order - b.order);
}

/**
 * Нормализация порядка: колонки и пункты каждой колонки получают
 * `order = 0..n-1` (после move/order порядок не должен «провисать»).
 */
export function normalizePlanOrder(plan: ProjectPlan): void {
  const columns = sortedColumns(plan);
  columns.forEach((column, index) => {
    column.order = index;
  });
  const columnIds = new Set(plan.columns.map((c) => c.id));
  for (const columnId of columnIds) {
    sortedItems(plan, columnId).forEach((item, index) => {
      item.order = index;
    });
  }
}

/** Проверка лимита Markdown-поля. */
export function assertMarkdownLimit(field: string, value: string, limit: number): void {
  const bytes = Buffer.byteLength(value, 'utf-8');
  if (bytes > limit) throw new PlanLimitExceededError(field, limit, bytes);
}

/**
 * Доменный сервис плана проекта.
 */
export class PlanService {
  constructor(private readonly store: PlanStore) {}

  /** План проекта (`null` — у проекта плана нет; проект отсутствует → 404). */
  async read(projectId: string): Promise<ProjectPlan | null> {
    const project = await this.store.load(projectId);
    if (!project) throw new PlanProjectNotFoundError(projectId);
    return project.plan ?? null;
  }

  /** Создать пункт плана. */
  async createItem(projectId: string, input: PlanItemCreateInput): Promise<ProjectPlan> {
    if (!input.title?.trim()) throw new PlanValidationError('Item title is required');
    if (input.title.length > PLAN_ITEM_TITLE_MAX) {
      throw new PlanValidationError(`Item title exceeds ${PLAN_ITEM_TITLE_MAX} characters`);
    }
    if (input.description !== undefined) {
      assertMarkdownLimit('description', input.description, MARKDOWN_LIMITS.planDescription);
    }
    return this._mutate(projectId, (plan) => {
      const column = this._resolveColumn(plan, input.columnId);
      const now = nowISO();
      const item: PlanItem = {
        id: randomUUID(),
        title: input.title.trim(),
        ...(input.description !== undefined ? { description: input.description } : {}),
        columnId: column.id,
        priority: input.priority ?? 'medium',
        order: sortedItems(plan, column.id).length,
        dependsOn: input.dependsOn ?? [],
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        createdAt: now,
        updatedAt: now,
      };
      plan.items.push(item);
    });
  }

  /** Точечная правка полей пункта плана (версия не требуется). */
  async updateItem(
    projectId: string,
    itemId: string,
    patch: PlanItemUpdateInput,
  ): Promise<ProjectPlan> {
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new PlanValidationError('Item title is required');
      if (patch.title.length > PLAN_ITEM_TITLE_MAX) {
        throw new PlanValidationError(`Item title exceeds ${PLAN_ITEM_TITLE_MAX} characters`);
      }
    }
    if (patch.description !== undefined) {
      assertMarkdownLimit('description', patch.description, MARKDOWN_LIMITS.planDescription);
    }
    return this._mutate(projectId, (plan) => {
      const item = plan.items.find((i) => i.id === itemId);
      if (!item) throw new PlanItemNotFoundError(itemId);
      if (patch.title !== undefined) item.title = patch.title.trim();
      if (patch.description !== undefined) item.description = patch.description;
      if (patch.priority !== undefined) item.priority = patch.priority;
      if (patch.tags !== undefined) item.tags = patch.tags;
      if (patch.dependsOn !== undefined) item.dependsOn = patch.dependsOn;
      item.updatedAt = nowISO();
    });
  }

  /**
   * Переместить пункт (колонка + позиция). Позиция задаётся соседями
   * (`beforeItemId`/`afterItemId`) — ручной `order` не нужен.
   */
  async moveItem(
    projectId: string,
    itemId: string,
    input: PlanItemMoveInput,
  ): Promise<ProjectPlan> {
    return this._mutate(projectId, (plan) => {
      if (input.version !== undefined) this._checkVersion(plan, input.version);
      const item = plan.items.find((i) => i.id === itemId);
      if (!item) throw new PlanItemNotFoundError(itemId);
      const column = plan.columns.find((c) => c.id === input.columnId);
      if (!column) throw new PlanColumnNotFoundError(input.columnId);

      const sourceColumnId = item.columnId;
      item.columnId = column.id;
      item.updatedAt = nowISO();

      // Пункты целевой колонки без самого перемещаемого — основа порядка.
      const target = sortedItems(plan, column.id).filter((i) => i.id !== itemId);
      let index = target.length;
      if (input.beforeItemId) {
        const at = target.findIndex((i) => i.id === input.beforeItemId);
        if (at >= 0) index = at;
      } else if (input.afterItemId) {
        const at = target.findIndex((i) => i.id === input.afterItemId);
        if (at >= 0) index = at + 1;
      } else if (input.order !== undefined) {
        index = Math.max(0, Math.min(target.length, Math.trunc(input.order)));
      }
      target.splice(index, 0, item);
      target.forEach((i, i2) => {
        i.order = i2;
      });
      // Нормализуем и колонку, из которой пункт ушёл.
      if (sourceColumnId !== column.id) {
        sortedItems(plan, sourceColumnId).forEach((i, i2) => {
          i.order = i2;
        });
      }
    });
  }

  /** Удалить пункт плана. */
  async deleteItem(projectId: string, itemId: string): Promise<ProjectPlan> {
    return this._mutate(projectId, (plan) => {
      const index = plan.items.findIndex((i) => i.id === itemId);
      if (index < 0) throw new PlanItemNotFoundError(itemId);
      const [removed] = plan.items.splice(index, 1);
      sortedItems(plan, removed!.columnId).forEach((i, i2) => {
        i.order = i2;
      });
    });
  }

  /** Создать колонку плана. */
  async addColumn(projectId: string, input: PlanColumnCreateInput): Promise<ProjectPlan> {
    const name = input.name?.trim();
    if (!name) throw new PlanValidationError('Column name is required');
    if (name.length > PLAN_COLUMN_NAME_MAX) {
      throw new PlanValidationError(`Column name exceeds ${PLAN_COLUMN_NAME_MAX} characters`);
    }
    return this._mutate(projectId, (plan) => {
      const column: PlanColumn = {
        id: randomUUID(),
        name,
        order: plan.columns.length,
        ...(input.wipLimit !== undefined ? { wipLimit: input.wipLimit } : {}),
      };
      plan.columns.push(column);
    });
  }

  /** Переименовать колонку / изменить WIP-лимит. */
  async updateColumn(
    projectId: string,
    columnId: string,
    patch: PlanColumnUpdateInput,
  ): Promise<ProjectPlan> {
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new PlanValidationError('Column name is required');
      if (patch.name.length > PLAN_COLUMN_NAME_MAX) {
        throw new PlanValidationError(`Column name exceeds ${PLAN_COLUMN_NAME_MAX} characters`);
      }
    }
    return this._mutate(projectId, (plan) => {
      const column = plan.columns.find((c) => c.id === columnId);
      if (!column) throw new PlanColumnNotFoundError(columnId);
      if (patch.name !== undefined) column.name = patch.name.trim();
      if (patch.wipLimit !== undefined) column.wipLimit = patch.wipLimit;
    });
  }

  /**
   * Удалить колонку. Пункты переносятся в `moveItemsTo` либо удаляются
   * вместе с колонкой (`moveItemsTo: null`).
   */
  async deleteColumn(
    projectId: string,
    columnId: string,
    input: PlanColumnDeleteInput,
  ): Promise<ProjectPlan> {
    return this._mutate(projectId, (plan) => {
      this._checkVersion(plan, input.version);
      const index = plan.columns.findIndex((c) => c.id === columnId);
      if (index < 0) throw new PlanColumnNotFoundError(columnId);
      if (input.moveItemsTo !== null) {
        const target = plan.columns.find((c) => c.id === input.moveItemsTo);
        if (!target) throw new PlanColumnNotFoundError(input.moveItemsTo);
        if (target.id === columnId) {
          throw new PlanValidationError('Items cannot be moved into the column being deleted');
        }
        const moved = plan.items.filter((i) => i.columnId === columnId);
        for (const item of moved) item.columnId = target.id;
        sortedItems(plan, target.id).forEach((i, i2) => {
          i.order = i2;
        });
      } else {
        plan.items = plan.items.filter((i) => i.columnId !== columnId);
      }
      plan.columns.splice(index, 1);
    });
  }

  /** Новый порядок колонок (полный список id). */
  async reorderColumns(
    projectId: string,
    input: PlanColumnsOrderInput,
  ): Promise<ProjectPlan> {
    return this._mutate(projectId, (plan) => {
      this._checkVersion(plan, input.version);
      const known = new Set(plan.columns.map((c) => c.id));
      const seen = new Set<string>();
      for (const id of input.order) {
        if (!known.has(id)) throw new PlanColumnNotFoundError(id);
        if (seen.has(id)) throw new PlanValidationError(`Duplicate column id "${id}"`);
        seen.add(id);
      }
      // Колонки, не попавшие в список, остаются в конце (порядок прежний).
      const rest = sortedColumns(plan).filter((c) => !seen.has(c.id));
      const ordered = [
        ...input.order.map((id) => plan.columns.find((c) => c.id === id)!),
        ...rest,
      ];
      // Порядок проставляем **до** нормализации — иначе сортировка по прежним
      // `order` вернула бы исходный порядок колонок.
      ordered.forEach((column, index) => {
        column.order = index;
      });
      plan.columns = ordered;
    });
  }

  /** Колонка по id; `columnId` не задан — `backlog`, иначе первая по `order`. */
  private _resolveColumn(plan: ProjectPlan, columnId?: string): PlanColumn {
    if (columnId) {
      const column = plan.columns.find((c) => c.id === columnId);
      if (!column) throw new PlanColumnNotFoundError(columnId);
      return column;
    }
    const backlog = plan.columns.find((c) => c.id === 'backlog');
    if (backlog) return backlog;
    const first = sortedColumns(plan)[0];
    if (!first) throw new PlanColumnNotFoundError('backlog');
    return first;
  }

  /** Проверка версии плана (оптимистичная блокировка). Версия не задана — проверки нет. */
  private _checkVersion(plan: ProjectPlan, expected?: number): void {
    if (expected === undefined) return;
    if (plan.version !== expected) {
      throw new PlanVersionConflictError(expected, plan.version, plan);
    }
  }

  /**
   * Общая обёртка мутации: план читается/создаётся, правится и сохраняется
   * **атомарно** (`ProjectRepository.mutate`); версия растёт на 1, `updatedAt`
   * обновляется, порядок нормализуется.
   */
  private _mutate(projectId: string, mutate: (plan: ProjectPlan) => void): Promise<ProjectPlan> {
    let result: ProjectPlan | null = null;
    return this.store
      .mutate(projectId, (project) => {
        const plan = getPlan(project);
        mutate(plan);
        normalizePlanOrder(plan);
        plan.version += 1;
        plan.updatedAt = nowISO();
        project.plan = plan;
        project.updatedAt = nowISO();
        result = plan;
      })
      .then((project) => {
        if (!project || !result) throw new PlanProjectNotFoundError(projectId);
        return result;
      });
  }
}
