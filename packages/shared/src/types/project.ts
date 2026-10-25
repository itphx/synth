import type { GitRepoConfig } from './git.js';

// --- Project role ---

export enum ProjectRole {
  OWNER = 'owner',
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

export enum StatusMessageType {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  STREAM = 'stream',
}

// --- Project ---
export interface StatusMessage {
  id: string;
  text: string;
  type: StatusMessageType;
  timestamp: string;
}

export interface ProjectLogEntry {
  id: string;
  text: string;
  createdAt: string;
  sessionId?: string;
  author?: string;
}

/**
 * ADR-071 §2.4/§2.5: проектный скоуп MCP — ссылки на записи единого реестра по
 * имени.
 * - `enabled` — hard-gate: серверы, разрешённые проекту. Не разрешённый сервер
 *   недоступен ни в одной сессии проекта (в т.ч. старой). Пустой массив — «всё
 *   выключено» (opt-in); отсутствие `project.mcp` — гейт не задан (legacy).
 * - `defaultOn` — сид «по умолчанию для новых сессий»: снапшот `mcpDefaultOn`
 *   при создании сессии. Изменение не влияет на ранее созданные сессии.
 */
export interface ProjectMcpSettings {
  enabled: string[];
  defaultOn: string[];
}

/**
 * ADR-046 §4.5: проектный скоуп скиллов (owner/lead) — аналог `ProjectMcpSettings`.
 * - `enabled` — hard-gate: доступные проекту скиллы. Пустой массив — «всё
 *   выключено» (opt-in); отсутствие `project.skills` — гейт не задан (legacy).
 * - `defaultOn` — сид «по умолчанию для новых сессий»: снапшот
 *   `skillsDefaultOn` при создании сессии.
 */
export interface ProjectSkillSettings {
  enabled: string[];
  defaultOn: string[];
}

/**
 * ADR-107: память проекта (undefined — наследует политику инстанса/включена).
 */
export interface ProjectMemorySettings {
  /** false — блоки памяти и тулы памяти выключены для проекта; данные сохраняются. */
  enabled?: boolean;
}

/**
 * ADR-075: политика для абсолютного `project.workspace` вне `workspacesRoot`.
 * - `confirm` — путь разрешён только с явным подтверждением (`confirmOutsideRoot`);
 * - `deny` — путь запрещён (managed-развёртывание: жёстко).
 *
 * Значение `''` (пустая строка) в конфиге означает «не задано» — эффективной
 * политикой тогда считается `confirm` (резолвер `resolveWorkspaceOutsideRootPolicy`).
 */
export type WorkspaceOutsideRootPolicy = 'confirm' | 'deny';

/**
 * ADR-075: ответ `GET /api/v2/settings/workspace-policy`.
 * `readOnly` (additive) — managed-развёртывание: политика задаётся развёртыванием,
 * `PUT`/`DELETE` возвращают 403 `WORKSPACE_POLICY_READ_ONLY`.
 */
export interface WorkspacePolicyInfo {
  outsideRoot: WorkspaceOutsideRootPolicy;
  isOverridden: boolean;
  defaults: WorkspaceOutsideRootPolicy;
  readOnly?: boolean;
}

export interface Project {
  id: string;
  name: string;
  ownerId: string;
  members: Record<string, ProjectRole>;
  description: string;
  currentTask: string;
  invariants: string;
  icon?: string;
  color?: string;
  workspace?: string;
  repos?: GitRepoConfig[];
  /** ADR-071 §2.4: проектный скоуп MCP (owner/lead). */
  mcp?: ProjectMcpSettings;
  /** ADR-046 §4.5: проектный скоуп скиллов (owner/lead). */
  skills?: ProjectSkillSettings;
  /** ADR-107: память проекта (undefined — наследует политику инстанса/включена). */
  memory?: ProjectMemorySettings;
  statusMessages: StatusMessage[];
  /** Kanban-план проекта (ADR-039). Владеет проектом, а не сессией. */
  plan?: ProjectPlan;
  /** Лог работ проекта (ведётся моделью через project_log_write). */
  log?: ProjectLogEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Канонические ключи иконок проектов и сессий (единый список для server и UI).
 * Значения — только ключи реестра (загружаемые картинки не поддерживаются).
 */
export const PROJECT_ICON_KEYS = [
  'code',
  'terminal',
  'rocket',
  'flask',
  'gamepad',
  'briefcase',
  'home',
  'globe',
  'leaf',
  'shield',
  'palette',
  'server',
  'phone',
  'database',
  'lightbulb',
  'music',
  'camera',
  'book',
  'heart',
  'folder',
  'chat',
  'cpu',
  'file',
  'file-code',
  'docs',
  'task',
  'todo',
  'bug',
  'robot',
  'brain',
  'git',
  'repo',
  'test',
  'chart',
  'star',
  'image',
  'calendar',
] as const;

export type ProjectIconKey = (typeof PROJECT_ICON_KEYS)[number];

/**
 * Канонические ключи цветов проектов и сессий — 16 цветов палитры темы
 * (`palette.colors[].key` в `a1..a16`; единый список для server и UI).
 */
export const PROJECT_COLOR_KEYS = [
  'a1', 'a2', 'a3', 'a4',
  'a5', 'a6', 'a7', 'a8',
  'a9', 'a10', 'a11', 'a12',
  'a13', 'a14', 'a15', 'a16',
] as const;

export type ProjectColorKey = (typeof PROJECT_COLOR_KEYS)[number];

// --- Plan (ADR-039) ---
export interface PlanColumn {
  id: string;
  name: string;
  order: number;
  wipLimit?: number;
}

export interface PlanDependency {
  projectId?: string;       // пусто = тот же проект
  itemId: string;           // пункт, от которого зависит текущий
  relation: 'blocked_by' | 'blocks' | 'relates_to';
}

export interface PlanItem {
  id: string;
  title: string;
  description?: string;
  columnId: string;         // статус = колонка
  priority: 'high' | 'medium' | 'low';
  order: number;
  dependsOn: PlanDependency[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPlan {
  version: number;
  updatedAt: string;
  columns: PlanColumn[];
  items: PlanItem[];
}
