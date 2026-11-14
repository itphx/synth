import type {
  Project,
  GitRepoConfig,
  ProjectMcpSettings,
  ProjectRole,
  ProjectSkillSettings,
  ProjectViewer,
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
  /**
   * PROP-133: пользовательские гранты (userId → роль). Роль владельца всегда
   * `owner` — понизить её нельзя (понижение автора — только передача владения).
   */
  members?: Record<string, ProjectRole>;
  /**
   * PROP-133: гранты группам (имя группы → роль).
   */
  groupMembers?: Record<string, ProjectRole>;
  /**
   * PROP-133: роль для всех пользователей инстанса; `null`/`undefined` — проект
   * не опубликован.
   */
  everyoneRole?: ProjectRole | null;
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
   * Проекты, доступные пользователю; без `viewer` — **все** проекты (для
   * `ADMIN`/`LEAD` и внутренних задач).
   *
   * С `viewer` — только те, где `resolveProjectAccess(project, viewer).read ===
   * true` (владелец, участник, грант по группе, режим «всем пользователям»).
   * Ролей инстанса у `viewer` нет: сквозной обзор (`ADMIN`/`LEAD`) реализуется
   * вызовом без аргумента.
   */
  list(viewer?: ProjectViewer): Promise<Project[]>;
  create(name: string, ownerId: string, data?: CreateProjectData): Project;
}
