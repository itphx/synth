import type {
  Project,
  GitRepoConfig,
  ProjectMcpSettings,
  ProjectSkillSettings,
} from '@itphx/synth-shared';

/** Опциональные данные создания проекта (сигнатура `ProjectStore.create`). */
export interface CreateProjectData {
  description?: string;
  icon?: string;
  color?: string;
  workspace?: string;
  repos?: GitRepoConfig[];
  mcp?: ProjectMcpSettings;
  skills?: ProjectSkillSettings;
}

/**
 * Порт хранилища проектов (реализация — `ProjectStore`).
 */
export interface ProjectRepository {
  load(id: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Проекты, доступные пользователю (владелец или участник); без `userId` — все.
   * @future-backend — фильтр owner/member в SQL; файловая реализация сканирует.
   */
  list(userId?: string): Promise<Project[]>;
  create(name: string, ownerId: string, data?: CreateProjectData): Project;
}
