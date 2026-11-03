import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Project } from '@itphx/synth-shared';
import { ProjectRole, generateId, nowISO, AsyncLock, atomicWrite, normalizeIconKey, normalizeColorKey } from '@itphx/synth-shared';
import type { CreateProjectData, ProjectRepository } from './ports/project-repository.js';

export interface ProjectStoreConfig {
  dataDir: string;
}

/**
 * Структурный контракт хранилища проектов. Нужен, чтобы core-фабрики роутов можно
 * было переиспользовать в backend с его собственным `ProjectStore` (у классов есть
 * приватные поля, поэтому напрямую типы не совместимы, а публичный API — общий).
 * Алиас на доменный порт: только операция загрузки.
 */
export type ProjectStoreLike = Pick<ProjectRepository, 'load'>;

export class ProjectStore implements ProjectRepository {
  private _lock = new AsyncLock();

  constructor(private config: ProjectStoreConfig) {}

  private _projectPath(id: string): string {
    return join(this.config.dataDir, 'projects', `${id}.json`);
  }

  private _projectsDir(): string {
    return join(this.config.dataDir, 'projects');
  }

  /**
   * Чтение без лока — вызывается публичным `load` и `mutate` (последний уже
   * держит лок: `AsyncLock` не реентрантный, повторный `load` внутри него
   * привёл бы к дедлоку).
   */
  private async _loadUnlocked(id: string): Promise<Project | null> {
    const path = this._projectPath(id);
    try {
      const data = await readFile(path, 'utf-8');
      const project = JSON.parse(data) as Project;
      // Нормализация метаданных при чтении (legacy → undefined/канонический ключ),
      // чтобы в памяти всегда были канонические значения (AD-иконки/цвета проектов).
      project.icon = normalizeIconKey(project.icon);
      project.color = normalizeColorKey(project.color);
      return project;
    } catch {
      return null;
    }
  }

  /** Запись без лока — вызывается публичным `save` и `mutate` (лок у вызывающего). */
  private async _persistUnlocked(project: Project): Promise<void> {
    const path = this._projectPath(project.id);
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(project, null, 2);
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  async load(id: string): Promise<Project | null> {
    return this._loadUnlocked(id);
  }

  async save(project: Project): Promise<void> {
    await this._lock.acquire();
    try {
      await this._persistUnlocked(project);
    } finally {
      this._lock.release();
    }
  }

  /**
   * Атомарный read-modify-write (порт `ProjectRepository.mutate`): чтение,
   * правка и запись — под одним `AsyncLock`, поэтому параллельные мутации
   * одного проекта не теряют друг друга.
   */
  async mutate(id: string, mutator: (project: Project) => void): Promise<Project | null> {
    await this._lock.acquire();
    try {
      const project = await this._loadUnlocked(id);
      if (!project) return null;
      mutator(project);
      await this._persistUnlocked(project);
      return project;
    } finally {
      this._lock.release();
    }
  }

  async delete(id: string): Promise<void> {
    const path = this._projectPath(id);
    await this._lock.acquire();
    try {
      await unlink(path).catch(() => {});
    } finally {
      this._lock.release();
    }
  }

  async list(userId?: string): Promise<Project[]> {
    const dir = this._projectsDir();
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const projects: Project[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const project = await this.load(file.replace('.json', ''));
      if (!project) continue;
      if (userId) {
        const isOwner = project.ownerId === userId;
        const isMember = userId in (project.members || {});
        if (!isOwner && !isMember) continue;
      }
      projects.push(project);
    }
    return projects.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  create(name: string, ownerId: string, data?: CreateProjectData): Project {
    const project: Project = {
      id: generateId(),
      name,
      ownerId,
      members: { [ownerId]: 'owner' as ProjectRole },
      description: data?.description || '',
      currentTask: '',
      invariants: '',
      icon: data?.icon,
      color: data?.color,
      workspace: data?.workspace,
      repos: data?.repos,
      // ADR-071 §2.4 / ADR-046 §4.5: сид скоупа новых проектов (снимок системных дефолтов).
      ...(data?.mcp ? { mcp: data.mcp } : {}),
      ...(data?.skills ? { skills: data.skills } : {}),
      statusMessages: [],
      plan: {
        version: 1,
        updatedAt: nowISO(),
        columns: [
          { id: 'backlog', name: 'Бэклог', order: 0 },
          { id: 'todo', name: 'К выполнению', order: 1 },
          { id: 'in_progress', name: 'В работе', order: 2 },
          { id: 'done', name: 'Готово', order: 3 },
        ],
        items: [],
      },
      log: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    return project;
  }
}

/**
 * Структурный контракт полного хранилища проектов (чтение + запись) — для тулов
 * и provisioning, которым нужны `save`/`create`/`list`, а не только `load`.
 * Алиас на доменный порт (без `delete`): правки проектных данных идут через
 * атомарный `mutate` (lost update при `load` + `save`).
 */
export type ProjectStoreContract = Pick<
  ProjectRepository,
  'load' | 'save' | 'mutate' | 'create' | 'list'
>;
