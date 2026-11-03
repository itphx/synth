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
  /**
   * Атомарный read-modify-write: `load` → `mutator` → запись **под локом
   * хранилища** (файловая реализация — `AsyncLock`, PostgreSQL — транзакция с
   * блокировкой строки `projects`).
   *
   * Зачем: `load` + правка в памяти + `save` теряют параллельную правку другого
   * вызывающего (lost update) — `save` берёт лок только на запись, а прочитанное
   * до неё состояние уже устарело. Все правки проектных данных (план, лог,
   * инварианты, workspace, реестр репозиториев) идут через `mutate`.
   *
   * Семантика:
   * - `mutator` **синхронный** — асинхронные операции (создание каталога, git,
   *   сеть) выполняются **до** вызова, внутрь передаётся только правка объекта;
   * - проекта нет → `null`, `mutator` не вызывается;
   * - `mutator` бросил → запись **не выполняется**, ошибка пробрасывается наружу;
   * - возвращается сохранённый проект.
   */
  mutate(id: string, mutator: (project: Project) => void): Promise<Project | null>;
  delete(id: string): Promise<void>;
  /**
   * Проекты, доступные пользователю (владелец или участник); без `userId` — все.
   * @future-backend — фильтр owner/member в SQL; файловая реализация сканирует.
   */
  list(userId?: string): Promise<Project[]>;
  create(name: string, ownerId: string, data?: CreateProjectData): Project;
}
