/**
 * Доменный сервис журнала проекта (PROP-054).
 *
 * Единая точка правки `project.log`: её зовут **и** инструменты
 * (`project_log_write`/`project_log_update`/`project_log_delete`),
 * **и** HTTP-роуты (`/api/v2/projects/:id/log*`).
 *
 * Правила:
 * - запись — **только** через `ProjectRepository.mutate` (атомарный
 *   read-modify-write; `load` + `save` теряют параллельную правку);
 * - `log` — **append-only** по умолчанию: новая запись дописывается в конец,
 *   правка меняет текст существующей (аддитивные `updatedAt`/`updatedBy`),
 *   удаление убирает запись;
 * - порядок чтения — **новые сверху** (массив хранится хронологически);
 * - лимит Markdown-текста записи (`MARKDOWN_LIMITS.journalEntry`) — здесь.
 */
import { randomUUID } from 'node:crypto';
import { nowISO, MARKDOWN_LIMITS } from '@itphx/synth-shared';
import type { Project, ProjectLogEntry } from '@itphx/synth-shared';

/** Минимальный порт хранилища проектов, нужный сервису журнала. */
export interface ProjectWorkStore {
  load(id: string): Promise<Project | null>;
  mutate(id: string, mutator: (project: Project) => void): Promise<Project | null>;
}

/** Проект не найден (HTTP 404). */
export class ProjectLogProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project "${projectId}" not found`);
    this.name = 'ProjectLogProjectNotFoundError';
  }
}

/** Запись журнала не найдена (HTTP 404). */
export class ProjectLogEntryNotFoundError extends Error {
  constructor(readonly entryId: string) {
    super(`Project log entry "${entryId}" not found`);
    this.name = 'ProjectLogEntryNotFoundError';
  }
}

/** Некорректные данные правки (HTTP 400 `VALIDATION_ERROR`). */
export class ProjectLogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectLogValidationError';
  }
}

/** Превышен лимит Markdown-текста записи (HTTP 400 `VALIDATION_ERROR`). */
export class ProjectLogLimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`Log entry exceeds the limit of ${limit} bytes (${actual})`);
    this.name = 'ProjectLogLimitExceededError';
  }
}

/** Проверка лимита Markdown-текста записи журнала. */
export function assertJournalTextLimit(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > MARKDOWN_LIMITS.journalEntry) {
    throw new ProjectLogLimitExceededError(MARKDOWN_LIMITS.journalEntry, bytes);
  }
}

/** Ввод: новая запись журнала. */
export interface ProjectLogAppendInput {
  text: string;
  /** Автор: `userId` пользователя или роль агента. */
  author?: string;
  /** Сессия, из которой запись создана (для пользовательских записей — id). */
  sessionId?: string;
}

/**
 * Доменный сервис журнала проекта.
 */
export class ProjectLogService {
  constructor(private readonly store: ProjectWorkStore) {}

  /** Записи журнала, **новые сверху** (массив хранится хронологически). */
  async list(projectId: string): Promise<ProjectLogEntry[]> {
    const project = await this.store.load(projectId);
    if (!project) throw new ProjectLogProjectNotFoundError(projectId);
    return [...(project.log ?? [])].reverse();
  }

  /** Добавить запись в конец журнала. */
  async append(projectId: string, input: ProjectLogAppendInput): Promise<ProjectLogEntry> {
    if (!input.text?.trim()) throw new ProjectLogValidationError('Log entry text is required');
    assertJournalTextLimit(input.text);
    const entry: ProjectLogEntry = {
      id: randomUUID(),
      text: input.text,
      createdAt: nowISO(),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.author !== undefined ? { author: input.author } : {}),
    };
    let created: ProjectLogEntry | null = null;
    const project = await this.store.mutate(projectId, (target) => {
      target.log = [...(target.log ?? []), entry];
      target.updatedAt = nowISO();
      created = entry;
    });
    if (!project || !created) throw new ProjectLogProjectNotFoundError(projectId);
    return created;
  }

  /** Изменить текст записи (аддитивные `updatedAt`/`updatedBy`). */
  async update(
    projectId: string,
    entryId: string,
    input: { text: string; updatedBy?: string },
  ): Promise<ProjectLogEntry> {
    if (!input.text?.trim()) throw new ProjectLogValidationError('Log entry text is required');
    assertJournalTextLimit(input.text);
    let updated: ProjectLogEntry | null = null;
    const project = await this.store.mutate(projectId, (target) => {
      const entry = (target.log ?? []).find((e) => e.id === entryId);
      if (!entry) throw new ProjectLogEntryNotFoundError(entryId);
      entry.text = input.text;
      entry.updatedAt = nowISO();
      if (input.updatedBy !== undefined) entry.updatedBy = input.updatedBy;
      target.updatedAt = nowISO();
      updated = entry;
    });
    if (!project || !updated) throw new ProjectLogProjectNotFoundError(projectId);
    return updated;
  }

  /** Удалить запись журнала (возвращает число оставшихся записей). */
  async remove(projectId: string, entryId: string): Promise<number> {
    let remaining = 0;
    const project = await this.store.mutate(projectId, (target) => {
      const log = target.log ?? [];
      const next = log.filter((e) => e.id !== entryId);
      if (next.length === log.length) throw new ProjectLogEntryNotFoundError(entryId);
      target.log = next;
      target.updatedAt = nowISO();
      remaining = next.length;
    });
    if (!project) throw new ProjectLogProjectNotFoundError(projectId);
    return remaining;
  }
}
