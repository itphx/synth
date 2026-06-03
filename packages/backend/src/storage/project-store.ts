import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Project, GitRepoConfig } from '@synth/shared';
import { ProjectRole, generateId, nowISO, AsyncLock, atomicWrite } from '@synth/shared';

export interface ProjectStoreConfig {
  dataDir: string;
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
      return JSON.parse(data) as Project;
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

  create(name: string, ownerId: string, data?: { description?: string; icon?: string; color?: string; workspace?: string; repos?: GitRepoConfig[] }): Project {
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
      statusMessages: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    return project;
  }

  async stats(_projectId: string): Promise<{ totalSessions: number; totalInputTokens: number; totalOutputTokens: number; totalTokens: number; totalMessages: number }> {
    return { totalSessions: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, totalMessages: 0 };
  }
}
