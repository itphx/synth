import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Project, GitRepoConfig, ProjectMcpSettings, ProjectSkillSettings } from '@itphx/synth-shared';
import { ProjectRole, generateId, nowISO, AsyncLock, atomicWrite, normalizeIconKey, normalizeColorKey } from '@itphx/synth-shared';

export interface ProjectStoreConfig {
  dataDir: string;
}

/**
 * Структурный контракт хранилища проектов. Нужен, чтобы core-фабрики роутов можно
 * было переиспользовать в backend с его собственным `ProjectStore` (у классов есть
 * приватные поля, поэтому напрямую типы не совместимы, а публичный API — общий).
 */
export interface ProjectStoreLike {
  load(id: string): Promise<Project | null>;
}

export class ProjectStore {
  private _lock = new AsyncLock();

  constructor(private config: ProjectStoreConfig) {}

  private _projectPath(id: string): string {
    return join(this.config.dataDir, 'projects', `${id}.json`);
  }

  private _projectsDir(): string {
    return join(this.config.dataDir, 'projects');
  }

  async load(id: string): Promise<Project | null> {
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

  async save(project: Project): Promise<void> {
    const path = this._projectPath(project.id);
    await this._lock.acquire();
    try {
      await mkdir(dirname(path), { recursive: true });
      const data = JSON.stringify(project, null, 2);
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        data,
      );
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

  create(name: string, ownerId: string, data?: { description?: string; icon?: string; color?: string; workspace?: string; repos?: GitRepoConfig[]; mcp?: ProjectMcpSettings; skills?: ProjectSkillSettings }): Project {
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
      // AD-071 §2.4 / AD-046 §4.5: сид скоупа новых проектов (снимок системных дефолтов).
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
 * Не привязан к классу (у него приватные поля), совместим с реализациями других пакетов.
 */
export type ProjectStoreContract = Pick<ProjectStore, 'load' | 'save' | 'create' | 'list'>;
