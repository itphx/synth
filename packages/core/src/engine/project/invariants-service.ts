/**
 * Доменный сервис инвариантов проекта (PROP-054).
 *
 * Единая точка правки `project.invariants`: её зовут **и** инструмент
 * `project_invariants_write`, **и** HTTP-роут
 * (`GET/PUT /api/v2/projects/:id/invariants`).
 *
 * Правила:
 * - запись — **только** через `ProjectRepository.mutate` (атомарно);
 * - текст — Markdown, лимит `MARKDOWN_LIMITS.invariants` (64 КиБ): инварианты
 *   попадают в системный промпт на каждом ходе;
 * - конфликт правок — **last-write-wins** (отдельный version-контракт не
 *   вводим); ответ отдаёт `updatedAt`, чтобы UI показал актуальное время.
 */
import { nowISO, MARKDOWN_LIMITS } from '@itphx/synth-shared';
import type { ProjectWorkStore } from './log-service.js';

/** Проект не найден (HTTP 404). */
export class ProjectInvariantsNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project "${projectId}" not found`);
    this.name = 'ProjectInvariantsNotFoundError';
  }
}

/** Превышен лимит Markdown-текста инвариантов (HTTP 400 `VALIDATION_ERROR`). */
export class ProjectInvariantsLimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`Invariants exceed the limit of ${limit} bytes (${actual})`);
    this.name = 'ProjectInvariantsLimitExceededError';
  }
}

/** Текущие инварианты проекта и время последней записи. */
export interface ProjectInvariantsState {
  invariants: string;
  updatedAt: string;
}

/** Проверка лимита Markdown-текста инвариантов. */
export function assertInvariantsLimit(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > MARKDOWN_LIMITS.invariants) {
    throw new ProjectInvariantsLimitExceededError(MARKDOWN_LIMITS.invariants, bytes);
  }
}

/**
 * Доменный сервис инвариантов проекта.
 */
export class ProjectInvariantsService {
  constructor(private readonly store: ProjectWorkStore) {}

  /** Текст инвариантов и время последней записи проекта. */
  async get(projectId: string): Promise<ProjectInvariantsState> {
    const project = await this.store.load(projectId);
    if (!project) throw new ProjectInvariantsNotFoundError(projectId);
    return { invariants: project.invariants ?? '', updatedAt: project.updatedAt };
  }

  /** Заменить текст инвариантов целиком (last-write-wins). */
  async set(projectId: string, text: string): Promise<ProjectInvariantsState> {
    assertInvariantsLimit(text);
    const project = await this.store.mutate(projectId, (target) => {
      target.invariants = text;
      target.updatedAt = nowISO();
    });
    if (!project) throw new ProjectInvariantsNotFoundError(projectId);
    return { invariants: project.invariants ?? '', updatedAt: project.updatedAt };
  }
}
