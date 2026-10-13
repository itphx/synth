import { z } from 'zod';
import {
  MessageRole,
  GlobalRole,
  ProjectRole,
  StatusMessageType,
  PROJECT_ICON_KEYS,
  PROJECT_COLOR_KEYS,
  isKnownScope,
  isWebhookEventPattern,
} from '../types/index.js';
import type { GitRepoConfig, ProjectIconKey, ProjectColorKey } from '../types/index.js';
import { ToolCapability } from '../types/tools.js';

export const messageRoleSchema = z.nativeEnum(MessageRole);
export const globalRoleSchema = z.nativeEnum(GlobalRole);
export const projectRoleSchema = z.nativeEnum(ProjectRole);
export const statusMessageTypeSchema = z.nativeEnum(StatusMessageType);

/** Zod-схемы канонических ключей иконок/цветов (единые для project и session). */
export const projectIconKeySchema = z.enum(PROJECT_ICON_KEYS);
export const projectColorKeySchema = z.enum(PROJECT_COLOR_KEYS);

/** true, если значение — канонический ключ иконки (для записи и чтения). */
export function isProjectIconKey(value: unknown): value is ProjectIconKey {
  return typeof value === 'string' && (PROJECT_ICON_KEYS as readonly string[]).includes(value);
}

/** true, если значение — канонический ключ цвета (без алиасов; для записи и чтения). */
export function isProjectColorKey(value: unknown): value is ProjectColorKey {
  return typeof value === 'string' && (PROJECT_COLOR_KEYS as readonly string[]).includes(value);
}

/**
 * Нормализация иконки при ЧТЕНИИ. Канонический ключ → как есть; всё прочее
 * (эмодзи/произвольные строки) → `undefined`.
 */
export function normalizeIconKey(value: unknown): ProjectIconKey | undefined {
  return isProjectIconKey(value) ? value : undefined;
}

/**
 * Нормализация цвета при ЧТЕНИИ: канонический ключ палитры → как есть; всё
 * прочее (включая legacy-алиасы) → `undefined`.
 */
export function normalizeColorKey(value: unknown): ProjectColorKey | undefined {
  return isProjectColorKey(value) ? value : undefined;
}

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
});

export const sessionSettingsSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningLevel: z.enum(['default', 'none', 'low', 'medium', 'high']).optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(200000).default(4096),
  systemPrompt: z.string().optional(),
  debugEnabled: z.boolean().default(true),
  streamEnabled: z.boolean().default(true),
  agentRole: z.string().optional(),
  // AD-071 §2.4: сессионный скоуп MCP (явно включённые / opt-out).
  mcpServers: z.array(z.string()).optional(),
  mcpDisabledServers: z.array(z.string()).optional(),
  contextOptimization: z.enum(['none', 'sliding_window', 'summarization', 'sticky_notes']).default('none'),
  slidingWindowMode: z.enum(['messages', 'tokens']).default('messages'),
  slidingWindowMessageLimit: z.number().int().min(1).default(10),
  slidingWindowTokenThreshold: z.number().int().min(10).max(100).default(80),
  summarizationEnabled: z.boolean().default(false),
  summarizationTriggerMode: z.enum(['messages', 'tokens']).default('messages'),
  summarizeAfterN: z.number().int().min(1).default(10),
  summarizeTokenThreshold: z.number().int().min(10).max(100).default(50),
  summarizationHeadMessages: z.number().int().min(1).default(2),
  summarizationTailMessages: z.number().int().min(1).default(3),
  showInterview: z.boolean().default(true),
  websocketEnabled: z.boolean().default(true),
  language: z.string().optional(),
  // === Plan/Act (AD-025) ===
  planMode: z.enum(['auto', 'strict', 'off']).optional(),
  // === Скиллы (AD-046 §4.5) ===
  skills: z.array(z.string()).optional(),
  skillsDisabled: z.array(z.string()).optional(),
  // === Микро-слой (AD-035/AD-084) ===
  /** AD-084: per-session гейт decision-уровня микро-каскада (undefined → config.decision.enabled). */
  decisionFirst: z.boolean().optional(),
});

export const sessionCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  icon: projectIconKeySchema.optional().nullable(),
  color: projectColorKeySchema.optional().nullable(),
  projectId: z.string().optional(),
  engine: z.enum(['synth', 'opencode', 'cline']).default('synth'),
  settings: sessionSettingsSchema.optional(),
});

export const sessionUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  icon: projectIconKeySchema.optional().nullable(),
  color: projectColorKeySchema.optional().nullable(),
  projectId: z.string().optional(),
  engine: z.enum(['synth', 'opencode', 'cline']).optional(),
  // passthrough: настройки сессии содержат поля вне sessionSettingsSchema
  // (mcpServers, routing*, microFirst, embedding*, permission, mcpToolSettings, llmGateway),
  // их нельзя терять при PATCH — известные поля валидируются, неизвестные пропускаются.
  settings: sessionSettingsSchema.partial().passthrough().optional(),
});

/**
 * AD-076: запись реестра git-репозиториев. `path` обязателен, остальные поля
 * опциональны; старые формы (`string` / `{ path }`) принимаются через
 * `normalizeGitRepoConfig` и union в `repos`.
 */
export const gitRepoConfigSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  type: z.enum(['https', 'ssh']).optional(),
  path: z.string().min(1),
  defaultBranch: z.string().optional(),
  sshKeyId: z.string().optional(),
  lastFetch: z.string().optional(),
});

/**
 * AD-076: нормализация legacy-значения `repos` к `GitRepoConfig`.
 * `string` → `{ path }`; объект → прогон через `gitRepoConfigSchema`
 * (невалидный → `null`). Всё прочее → `null`.
 */
export function normalizeGitRepoConfig(raw: unknown): GitRepoConfig | null {
  if (typeof raw === 'string') {
    return raw.length > 0 ? { path: raw } : null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const parsed = gitRepoConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().default(''),
  icon: projectIconKeySchema.optional().nullable(),
  color: projectColorKeySchema.optional().nullable(),
  workspace: z.string().optional(),
  repos: z.array(z.union([z.string(), gitRepoConfigSchema])).optional(),
});

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  currentTask: z.string().optional(),
  invariants: z.string().optional(),
  icon: projectIconKeySchema.optional().nullable(),
  color: projectColorKeySchema.optional().nullable(),
  workspace: z.string().optional(),
  repos: z.array(z.union([z.string(), gitRepoConfigSchema])).optional(),
});

/** AD-076: тело создания SSH-ключа (`POST /api/v2/ssh-keys`). */
export const sshKeyCreateSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().optional(),
  privateKey: z.string().min(1),
  passphrase: z.string().optional(),
  agentIds: z.array(z.string()).optional(),
});

/** AD-076: тело обновления SSH-ключа (без id/createdAt). */
export const sshKeyUpdateSchema = sshKeyCreateSchema.partial();

/**
 * AD-071 §2.4: проектный скоуп MCP (ссылки на реестр по имени).
 * PUT-семантика: `undefined` ≠ `[]` — отсутствующее поле сохраняет текущее
 * значение, поэтому `.default([])` здесь недопустим.
 */
export const projectMcpUpdateSchema = z.object({
  enabled: z.array(z.string()).optional(),
  defaultOn: z.array(z.string()).optional(),
});

/**
 * AD-075: тело `PUT /api/v2/settings/workspace-policy` — политика для
 * абсолютного workspace вне `workspacesRoot`.
 */
export const workspacePolicySchema = z.object({
  outsideRoot: z.enum(['confirm', 'deny']),
});

export type WorkspacePolicyRequest = z.infer<typeof workspacePolicySchema>;

export const promptRequestSchema = z.object({
  messageId: z.string().optional(),
  content: z.string().min(1),
  stream: z.boolean().default(true),
  model: z.string().optional(),
  provider: z.string().optional(),
  agent: z.string().optional(),
  system: z.string().optional(),
});

export const spaLoginSchema = z.object({
  apiKey: z.string().min(1),
  username: z.string().optional(),
});

// --- File System schemas ---
export const fsListQuerySchema = z.object({
  project_id: z.string().min(1),
  path: z.string().default(''),
  maxDepth: z.coerce.number().int().min(1).max(10).optional(),
  includeHidden: z.coerce.boolean().optional(),
});

export const fsReadQuerySchema = z.object({
  project_id: z.string().min(1),
  path: z.string().min(1),
});

export const fsWriteBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
});

export const fsDeleteQuerySchema = z.object({
  project_id: z.string().min(1),
  path: z.string().min(1),
});

export const fsMkdirBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
});

export const fsDownloadQuerySchema = z.object({
  project_id: z.string().min(1),
  path: z.string().min(1),
});

/**
 * AD-075: запрос навигации по корню workspace (`GET /fs/workspace-root/browse`,
 * `GET /fs/workspace-root`). `includeHidden` принимает строковые `true`/`false`
 * (query-параметры) — `z.coerce.boolean()` не подходит, т.к. `'false'` → `true`.
 */
export const fsWorkspaceBrowseQuerySchema = z.object({
  path: z.string().default(''),
  includeHidden: z
    .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional())
    .default(false),
});

/** AD-075: тело `POST /fs/workspace-root/mkdir` — создание каталога в корне workspace. */
export const fsWorkspaceMkdirBodySchema = z.object({
  path: z.string().min(1),
  /** `confirm`-политика: явное подтверждение создания каталога вне `workspacesRoot`. */
  confirmOutsideRoot: z.boolean().optional(),
});

// --- Git schemas ---
export const gitScanBodySchema = z.object({
  projectId: z.string().min(1),
});

export const gitInitBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string(),
  defaultBranch: z.string().optional(),
  name: z.string().optional(),
  sshKeyId: z.string().optional(),
});

export const gitCloneBodySchema = z.object({
  projectId: z.string().min(1),
  url: z.string().min(1),
  path: z.string().optional(),
  branch: z.string().optional(),
  name: z.string().optional(),
  sshKeyId: z.string().optional(),
});

/**
 * AD-076: тело `POST /api/v2/git/repos/register` — upsert записи реестра
 * (идемпотентно по `path`). Используется UI для добавления уже существующего
 * локально репозитория.
 */
export const gitReposRegisterBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  name: z.string().optional(),
  url: z.string().optional(),
  type: z.enum(['https', 'ssh']).optional(),
  defaultBranch: z.string().optional(),
  sshKeyId: z.string().optional(),
});

/**
 * AD-076: тело `POST /api/v2/git/repos/remove` — удаление записи реестра;
 * обязателен `id` либо `path`. `deleteLocal` — удалить каталог репозитория.
 */
export const gitReposRemoveBodySchema = z
  .object({
    projectId: z.string().min(1),
    id: z.string().optional(),
    path: z.string().optional(),
    deleteLocal: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.id || v.path), { message: 'Требуется id или path' });

/** AD-076: тело `POST /api/v2/git/repos/fetch` — обязателен `id` либо `path`. */
export const gitReposFetchBodySchema = z
  .object({
    projectId: z.string().min(1),
    id: z.string().optional(),
    path: z.string().optional(),
  })
  .refine((v) => Boolean(v.id || v.path), { message: 'Требуется id или path' });

export const gitLogQuerySchema = z.object({
  project_id: z.string().min(1),
  repo_path: z.string().default(''),
  max_count: z.coerce.number().int().min(1).max(100).optional(),
});

export const gitCommitQuerySchema = z.object({
  project_id: z.string().min(1),
  repo_path: z.string().default(''),
  hash: z.string().min(1),
});

const toolCapabilityValues = Object.values(ToolCapability) as [string, ...string[]];

/**
 * AD-071 §2.6: фабрика схемы `tools.disabled` (единый источник значений
 * на базе `ToolCapability`).
 *
 * - `strictCapabilities: true` (API, `PUT /settings/tools-disabled`) — закрытый
 *   набор capability: опечатка отклоняется, а не молча ничего не отключает;
 * - `strictCapabilities: false` (config.yaml) — permissive: значения — строки
 *   (конфиг может опережать версию ядра).
 */
export function createToolsDisabledSchema(strictCapabilities: boolean) {
  return z.object({
    capabilities: (strictCapabilities
      ? z.array(z.enum(toolCapabilityValues))
      : z.array(z.string())
    ).default([]),
    tools: (strictCapabilities
      ? z.array(z.string().min(1))
      : z.array(z.string())
    ).default([]),
  });
}

/**
 * AD-071 §2.6: тело `PUT /api/v2/settings/tools-disabled`. Неизвестная
 * capability — ошибка (закрытый набор: опечатка молча ничего не отключит).
 * Имена инструментов принимаются как строки (реестр динамический — MCP-тулы
 * регистрируются лениво); непустые.
 */
export const toolsDisabledSchema = createToolsDisabledSchema(true);

/**
 * AD-071 §2.4: базовый контракт MCP-скоупа сессии (ссылки на реестр по имени).
 * `undefined` ≠ `[]`: отсутствующее поле сохраняет текущее значение.
 */
export const sessionMcpScopeSchema = z
  .object({
    mcpServers: z.array(z.string()).optional(),
    mcpDisabledServers: z.array(z.string()).optional(),
  })
  .refine(
    (v) => v.mcpServers !== undefined || v.mcpDisabledServers !== undefined,
    { message: 'Требуется mcpServers или mcpDisabledServers' },
  );

/**
 * AD-071 §2.4: тело `PUT /api/v2/sessions/:id/mcp`: точечный toggle
 * (`{ name, enabled }`, в т.ч. opt-out системного сервера) или полная/частичная
 * замена (`{ mcpServers?, mcpDisabledServers? }`).
 */
export const sessionMcpUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    mcpServers: z.array(z.string()).optional(),
    mcpDisabledServers: z.array(z.string()).optional(),
  })
  .refine(
    (v) => v.name !== undefined
      || v.mcpServers !== undefined
      || v.mcpDisabledServers !== undefined,
    { message: 'Требуется name, mcpServers или mcpDisabledServers' },
  );

export type SessionMcpScopeRequest = z.infer<typeof sessionMcpScopeSchema>;
export type SessionMcpUpdateRequest = z.infer<typeof sessionMcpUpdateSchema>;
export type ProjectMcpUpdateRequest = z.infer<typeof projectMcpUpdateSchema>;
export type SessionCreateRequest = z.infer<typeof sessionCreateSchema>;
export type SessionUpdateRequest = z.infer<typeof sessionUpdateSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateRequest = z.infer<typeof projectUpdateSchema>;
export type SSHKeyCreateRequest = z.infer<typeof sshKeyCreateSchema>;
export type SSHKeyUpdateRequest = z.infer<typeof sshKeyUpdateSchema>;
export type PromptRequest = z.infer<typeof promptRequestSchema>;
export type SpaLoginRequest = z.infer<typeof spaLoginSchema>;
export type FsListQuery = z.infer<typeof fsListQuerySchema>;
export type FsReadQuery = z.infer<typeof fsReadQuerySchema>;
export type FsWriteBody = z.infer<typeof fsWriteBodySchema>;
export type FsDeleteQuery = z.infer<typeof fsDeleteQuerySchema>;
export type FsMkdirBody = z.infer<typeof fsMkdirBodySchema>;
export type FsDownloadQuery = z.infer<typeof fsDownloadQuerySchema>;
export type FsWorkspaceBrowseQuery = z.infer<typeof fsWorkspaceBrowseQuerySchema>;
export type FsWorkspaceMkdirBody = z.infer<typeof fsWorkspaceMkdirBodySchema>;
export type GitScanBody = z.infer<typeof gitScanBodySchema>;
export type GitInitBody = z.infer<typeof gitInitBodySchema>;
export type GitCloneBody = z.infer<typeof gitCloneBodySchema>;
export type GitReposRegisterBody = z.infer<typeof gitReposRegisterBodySchema>;
export type GitReposRemoveBody = z.infer<typeof gitReposRemoveBodySchema>;
export type GitReposFetchBody = z.infer<typeof gitReposFetchBodySchema>;
export type GitLogQuery = z.infer<typeof gitLogQuerySchema>;
export type GitCommitQuery = z.infer<typeof gitCommitQuerySchema>;

// --- Скиллы (AD-046) ---

/** AD-046 §3.2: имя скилла — 1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`. */
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MIN = 1;
export const SKILL_NAME_MAX = 64;
/** AD-046 §3.2: длина `description`. */
export const SKILL_DESCRIPTION_MIN = 1;
export const SKILL_DESCRIPTION_MAX = 1024;

export const skillNameSchema = z
  .string()
  .min(SKILL_NAME_MIN)
  .max(SKILL_NAME_MAX)
  .regex(SKILL_NAME_REGEX, 'имя скилла: строчные латинские буквы/цифры, разделитель — дефис');

export const skillCreateSchema = z.object({
  name: skillNameSchema,
  description: z.string().min(SKILL_DESCRIPTION_MIN).max(SKILL_DESCRIPTION_MAX),
  /** Тело Markdown (без frontmatter). */
  body: z.string().optional(),
  /** Дополнительные supporting-файлы (относительный путь → содержимое). */
  files: z.record(z.string().min(1), z.string()).optional(),
});

export const skillUpdateSchema = z
  .object({
    description: z.string().min(SKILL_DESCRIPTION_MIN).max(SKILL_DESCRIPTION_MAX).optional(),
    body: z.string().optional(),
    /** Толерантный контейнер (неизвестные ключи сохраняются). */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (v) => v.description !== undefined || v.body !== undefined || v.metadata !== undefined,
    { message: 'Требуется description, body или metadata' },
  );

export const skillFileWriteSchema = z.object({
  content: z.string(),
});

/**
 * AD-046 §4.5: per-session enable/disable скиллов (по образцу MCP-скоупа).
 * `undefined` ≠ `[]`: отсутствующее поле сохраняет текущее значение.
 */
export const skillSessionOverrideSchema = z.object({
  skills: z.array(z.string()).optional(),
  skillsDisabled: z.array(z.string()).optional(),
});

export type SkillCreateRequest = z.infer<typeof skillCreateSchema>;
export type SkillUpdateRequest = z.infer<typeof skillUpdateSchema>;
export type SkillFileWriteRequest = z.infer<typeof skillFileWriteSchema>;
export type SkillSessionOverrideRequest = z.infer<typeof skillSessionOverrideSchema>;

// --- Slash-команды и bundles (AD-046 §7) ---

/** AD-046 §7.3: тело `POST/PATCH /api/v2/skill-bundles` (YAML-группа скиллов). */
export const skillBundleSchema = z.object({
  name: skillNameSchema,
  description: z.string().min(SKILL_DESCRIPTION_MIN).max(SKILL_DESCRIPTION_MAX),
  skills: z.array(skillNameSchema).min(1),
  instruction: z.string().optional(),
});

export type SkillBundleRequest = z.infer<typeof skillBundleSchema>;

/** AD-046 §7.4: тело `PUT /api/v2/settings/skills-disabled` (группы/имена). */
export const skillsDisabledSchema = z.object({
  categories: z.array(z.string()).default([]),
  groups: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

export type SkillsDisabledRequest = z.infer<typeof skillsDisabledSchema>;

/**
 * AD-046 §4.5: тело `PUT /api/v2/settings/skills` — системные настройки:
 * - `disabled` — hard-gate: скиллы, недоступные НИГДЕ;
 * - `disabledForNewProjects` — сид для НОВЫХ проектов (снимок при создании);
 * - `policy` — политика доступности (строкой, валидируется роутом).
 */
export const skillsSystemSettingsSchema = z.object({
  disabled: skillsDisabledSchema.optional(),
  disabledForNewProjects: skillsDisabledSchema.optional(),
  policy: z.string().optional(),
});

export type SkillsSystemSettingsRequest = z.infer<typeof skillsSystemSettingsSchema>;

/**
 * AD-046 §4.5: тело `PUT /api/v2/sessions/:id/skills`: точечный toggle
 * (`{ name, enabled }`) или полная/частичная замена (`{ skills?, skillsDisabled? }`).
 */
export const sessionSkillUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    skillsDisabled: z.array(z.string()).optional(),
  })
  .refine(
    (v) => v.name !== undefined
      || v.skills !== undefined
      || v.skillsDisabled !== undefined,
    { message: 'Требуется name, skills или skillsDisabled' },
  );

/** AD-046 §4.5: тело `PUT /api/v2/projects/:id/skills`. */
export const projectSkillUpdateSchema = z.object({
  enabled: z.array(z.string()).optional(),
  defaultOn: z.array(z.string()).optional(),
});

export type SessionSkillUpdateRequest = z.infer<typeof sessionSkillUpdateSchema>;
export type ProjectSkillUpdateRequest = z.infer<typeof projectSkillUpdateSchema>;

// --- Внешние события (AD-089) ---

/** AD-089: схема идентичности отправителя внешнего события. */
export const eventIdentitySchema = z.object({
  principalId: z.string().optional(),
  chatKey: z.string().optional(),
  threadKey: z.string().optional(),
  roles: z.array(z.string()).optional(),
});

/** AD-089: схема нормализованного внешнего события (`payload` не типизируется). */
export const synthEventSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  identity: eventIdentitySchema.default({}),
  dedupKey: z.string().min(1),
  ts: z.string().min(1),
});

/** AD-089: режимы доставки `EventBinding` (без `drop`). */
const eventDeliveryModeSchema = z.enum(['bound', 'ephemeral', 'queue']);

/** AD-089: схема устойчивой привязки внешнего адреса к сессии/шаблону. */
export const eventBindingSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  chatKey: z.string().optional(),
  threadKey: z.string().optional(),
  sessionId: z.string().optional(),
  mode: eventDeliveryModeSchema,
  agentTemplate: z.string().optional(),
  project: z.string().optional(),
});

/** AD-089: схема запроса создания/привязки сессии — единый funnel. */
export const sessionRequestSchema = z.object({
  initiator: z.enum(['user', 'agent', 'external', 'system']),
  intent: z.enum(['explicit', 'event']),
  projectId: z.string().optional(),
  parentId: z.string().optional(),
  agentTemplate: z.string().optional(),
  mode: eventDeliveryModeSchema.optional(),
  ttl: z.string().optional(),
  title: z.string().optional(),
  icon: projectIconKeySchema.optional(),
  color: projectColorKeySchema.optional(),
  engine: z.enum(['synth', 'opencode', 'cline']).optional(),
  sessionOrigin: z.enum(['user', 'fork', 'subagent']).optional(),
  // Настройки сессии валидируются собственной схемой при создании; здесь —
  // толерантный контейнер, чтобы не дублировать SessionSettings.
  settings: z.unknown().optional(),
  sourceEventId: z.string().optional(),
  dedupKey: z.string().optional(),
});

/**
 * AD-089: вход приёма внешнего события (`POST /api/v2/events`). `id`/`dedupKey`/`ts`
 * нормализуются `EventIngress`, поэтому здесь опциональны.
 */
export const eventIngestSchema = z.object({
  source: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown().optional(),
  identity: eventIdentitySchema.optional(),
  dedupKey: z.string().optional(),
  ts: z.string().optional(),
});

export type EventIngestRequest = z.infer<typeof eventIngestSchema>;

/** AD-089: вход upsert биндинга (`POST /api/v2/events/bindings`) — без `id`. */
export const eventBindingInputSchema = z.object({
  source: z.string().min(1),
  chatKey: z.string().optional(),
  threadKey: z.string().optional(),
  sessionId: z.string().optional(),
  mode: eventDeliveryModeSchema,
  agentTemplate: z.string().optional(),
  project: z.string().optional(),
});

export type EventBindingInputRequest = z.infer<typeof eventBindingInputSchema>;

/**
 * AD-089/AD-052: метаданные API-ключа привязки для приёма событий.
 * Секрет (`key`) и его хеш здесь отсутствуют — наружу не отдаются.
 */
export const eventBindingApiKeySchema = z.object({
  id: z.string().min(1),
  bindingId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  rateLimitPerMinute: z.number().int().min(0).optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().optional(),
  prefix: z.string().min(1),
  // AD-052 (задел): срок действия / отзыв ключа.
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
});

export type EventBindingApiKeyMeta = z.infer<typeof eventBindingApiKeySchema>;

/** AD-089/AD-052: тело создания API-ключа привязки — обязательная уникальная `label`. */
export const eventBindingApiKeyCreateSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  expiresAt: z.string().optional(),
  rateLimitPerMinute: z.number().int().min(0).optional(),
});

export type EventBindingApiKeyCreateRequest = z.infer<typeof eventBindingApiKeyCreateSchema>;

/**
 * AD-089/AD-052: тело обновления API-ключа привязки. Все поля опциональны;
 * `null` для `description`/`expiresAt`/`rateLimitPerMinute` — сброс значения.
 */
export const eventBindingApiKeyUpdateSchema = z.object({
  label: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  rateLimitPerMinute: z.number().int().min(0).nullable().optional(),
});

export type EventBindingApiKeyUpdateRequest = z.infer<typeof eventBindingApiKeyUpdateSchema>;

/** AD-089: ответ создания ключа — метаданные + plaintext-секрет (единожды). */
export const eventBindingApiKeyCreatedSchema = eventBindingApiKeySchema.extend({
  key: z.string().min(1),
});

export type EventBindingApiKeyCreatedRequest = z.infer<typeof eventBindingApiKeyCreatedSchema>;

/**
 * AD-089: вход `POST /events` при аутентификации API-ключом привязки. Как
 * `eventIngestSchema`, но `source` опционален — источник берётся из привязки.
 */
export const eventKeyIngestSchema = eventIngestSchema.partial({ source: true });

export type EventKeyIngestRequest = z.infer<typeof eventKeyIngestSchema>;

// --- Service-key (AD-052, этап I) ---

/**
 * AD-052: каталог скоупов service-key + wildcard-семейства. Глобальный `*` не
 * принимается (`isKnownScope`).
 */
export const serviceScopeSchema = z
  .string()
  .min(1)
  .refine((value) => isKnownScope(value), { message: 'Неизвестный scope' });

const serviceScopesSchema = z.array(serviceScopeSchema).min(1);

/**
 * AD-052: метаданные service-key (ответы API). Секрет (`key`) и его хеш здесь
 * отсутствуют — наружу не отдаются (в списке — `prefix`).
 */
export const serviceApiKeySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  roles: z.array(globalRoleSchema),
  scopes: z.array(z.string().min(1)),
  allowedProjects: z.array(z.string().min(1)).optional(),
  rateLimitPerMinute: z.number().int().min(0).optional(),
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().optional(),
  prefix: z.string().min(1),
});

export type ServiceApiKeyMeta = z.infer<typeof serviceApiKeySchema>;

/** AD-052: тело создания service-key. `roles` не заданы — дефолт хранилища. */
export const serviceApiKeyCreateSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  roles: z.array(globalRoleSchema).optional(),
  scopes: serviceScopesSchema,
  allowedProjects: z.array(z.string().min(1)).optional(),
  rateLimitPerMinute: z.number().int().min(0).optional(),
  expiresAt: z.string().optional(),
});

export type ServiceApiKeyCreateRequest = z.infer<typeof serviceApiKeyCreateSchema>;

/**
 * AD-052: тело обновления service-key. Все поля опциональны; `null` для
 * `description`/`allowedProjects`/`rateLimitPerMinute`/`expiresAt` — сброс.
 */
export const serviceApiKeyUpdateSchema = z.object({
  label: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  roles: z.array(globalRoleSchema).optional(),
  scopes: serviceScopesSchema.optional(),
  allowedProjects: z.array(z.string().min(1)).nullable().optional(),
  rateLimitPerMinute: z.number().int().min(0).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

export type ServiceApiKeyUpdateRequest = z.infer<typeof serviceApiKeyUpdateSchema>;

/** AD-052: ответ создания service-key — метаданные + plaintext-секрет (единожды). */
export const serviceApiKeyCreatedSchema = serviceApiKeySchema.extend({
  key: z.string().min(1),
});

export type ServiceApiKeyCreatedRequest = z.infer<typeof serviceApiKeyCreatedSchema>;

// --- Webhooks (AD-052, этап II) ---

/** AD-052 (этап II): паттерн события подписки — exact либо `prefix.*`. */
export const webhookEventPatternSchema = z
  .string()
  .min(1)
  .refine((value) => isWebhookEventPattern(value), { message: 'Некорректный паттерн события' });

/** AD-052 (этап II): целевой URL — только http/https (SSRF-политика — в core). */
export const webhookUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'URL должен быть http(s)' });

/**
 * AD-052 (этап II): метаданные подписки (ответы API). Секрет (`secret`) и его
 * хеш здесь отсутствуют — наружу не отдаются (в списке — `secretPrefix`).
 */
export const webhookSubscriptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  url: webhookUrlSchema,
  events: z.array(webhookEventPatternSchema),
  enabled: z.boolean(),
  secretPrefix: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
  lastDeliveryAt: z.string().optional(),
  lastStatus: z.enum(['ok', 'failed']).optional(),
  disabledAt: z.string().optional(),
});

export type WebhookSubscriptionMeta = z.infer<typeof webhookSubscriptionSchema>;

/** AD-052 (этап II): тело создания подписки. `enabled` не задан — активна. */
export const webhookSubscriptionCreateSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  url: webhookUrlSchema,
  events: z.array(webhookEventPatternSchema).optional(),
  enabled: z.boolean().optional(),
});

export type WebhookSubscriptionCreateRequest = z.infer<typeof webhookSubscriptionCreateSchema>;

/**
 * AD-052 (этап II): тело обновления подписки. Все поля опциональны; `null` для
 * `description` — сброс.
 */
export const webhookSubscriptionUpdateSchema = z.object({
  label: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  url: webhookUrlSchema.optional(),
  events: z.array(webhookEventPatternSchema).optional(),
  enabled: z.boolean().optional(),
});

export type WebhookSubscriptionUpdateRequest = z.infer<typeof webhookSubscriptionUpdateSchema>;

/** AD-052 (этап II): ответ создания/ротации подписки — метаданные + секрет (единожды). */
export const webhookSubscriptionCreatedSchema = webhookSubscriptionSchema.extend({
  secret: z.string().min(1),
});

export type WebhookSubscriptionCreatedRequest = z.infer<typeof webhookSubscriptionCreatedSchema>;

/** AD-052 (этап II): запись журнала доставки. */
export const webhookDeliverySchema = z.object({
  id: z.string().min(1),
  subscriptionId: z.string().min(1),
  eventType: z.string().min(1),
  status: z.enum(['ok', 'failed', 'pending']),
  attempts: z.number().int().min(0),
  responseStatus: z.number().int().optional(),
  error: z.string().optional(),
  createdAt: z.string().min(1),
  completedAt: z.string().optional(),
});

export type WebhookDeliveryMeta = z.infer<typeof webhookDeliverySchema>;

/** AD-051/AD-089: цель расписания (дискриминированный союз по `mode`). */
export const scheduleTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('bound'), sessionId: z.string().min(1) }),
  z.object({
    mode: z.literal('ephemeral'),
    agentTemplate: z.string().optional(),
    project: z.string().optional(),
    ttl: z.string().optional(),
  }),
  z.object({ mode: z.literal('queue'), sessionId: z.string().min(1) }),
]);

/**
 * AD-089: цель правила маршрутизации — дискриминированный союз по `mode`
 * (семантика та же, что у `scheduleTargetSchema`).
 */
export const eventRouteTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('bound'), sessionId: z.string().min(1) }),
  z.object({
    mode: z.literal('ephemeral'),
    agentTemplate: z.string().optional(),
    project: z.string().optional(),
    ttl: z.string().optional(),
  }),
  z.object({ mode: z.literal('queue'), sessionId: z.string().min(1) }),
  // AD-089 (auto-bind): цель закрепляет внешний адрес за сессией (binding создаёт Router).
  z.object({
    mode: z.literal('bind'),
    agentTemplate: z.string().optional(),
    project: z.string().optional(),
  }),
]);

/** AD-089: условие срабатывания правила (AND по заполненным полям). */
export const eventRouteMatchSchema = z.object({
  source: z.string().optional(),
  type: z.string().optional(),
  chatKey: z.string().optional(),
  threadKey: z.string().optional(),
  principalId: z.string().optional(),
  label: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

/** AD-089: полная сущность правила маршрутизации событий (ответы API). */
export const eventRouteRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  match: eventRouteMatchSchema,
  target: eventRouteTargetSchema,
});

/** AD-089: вход создания/обновления правила (`upsert`) — без `id`. */
export const eventRouteRuleInputSchema = z.object({
  name: z.string().optional(),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  match: eventRouteMatchSchema,
  target: eventRouteTargetSchema,
});

/**
 * AD-089: тело upsert-запроса правила — вход + необязательный `id` (обновление
 * существующего правила; отсутствие — создание нового `rule_<uuid>`).
 */
export const eventRouteRuleUpsertSchema = eventRouteRuleInputSchema.extend({
  id: z.string().optional(),
});

export type EventRouteTargetRequest = z.infer<typeof eventRouteTargetSchema>;
export type EventRouteRuleInputRequest = z.infer<typeof eventRouteRuleInputSchema>;
export type EventRouteRuleUpsertRequest = z.infer<typeof eventRouteRuleUpsertSchema>;

/**
 * AD-051/AD-089: ровно одно из `cron` / `every` задано. Пустые строки
 * трактуются как отсутствие поля.
 */
function refineScheduleTrigger(
  val: { cron?: string; every?: string },
  ctx: z.RefinementCtx,
): void {
  const hasCron = typeof val.cron === 'string' && val.cron.trim().length > 0;
  const hasEvery = typeof val.every === 'string' && val.every.trim().length > 0;
  if (hasCron === hasEvery) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Ровно одно из полей cron/every должно быть задано',
      path: ['cron'],
    });
  }
}

/** AD-051/AD-089: вход создания/обновления расписания (`ScheduleInput`). */
export const scheduleInputSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    cron: z.string().optional(),
    every: z.string().optional(),
    target: scheduleTargetSchema,
    prompt: z.string().optional(),
    payload: z.record(z.unknown()).optional(),
    ownerId: z.string().optional(),
    catchUp: z.enum(['skip', 'once']).optional(),
  })
  .superRefine(refineScheduleTrigger);

/** AD-051/AD-089: полная сущность расписания (ответы API). */
export const scheduleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    cron: z.string().optional(),
    every: z.string().optional(),
    target: scheduleTargetSchema,
    prompt: z.string().optional(),
    payload: z.record(z.unknown()).optional(),
    ownerId: z.string().optional(),
    catchUp: z.enum(['skip', 'once']).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    lastRunAt: z.string().optional(),
    nextRunAt: z.string().optional(),
    lastStatus: z.enum(['ok', 'error', 'skipped']).optional(),
    lastError: z.string().optional(),
  })
  .superRefine(refineScheduleTrigger);

export type ScheduleInputRequest = z.infer<typeof scheduleInputSchema>;
export type ScheduleRequest = z.infer<typeof scheduleSchema>;

/** AD-051: триггер срабатывания расписания в Job-истории. */
export const scheduleJobTriggerSchema = z.enum(['cron', 'manual', 'catchup']);

/** AD-051: запись Job-истории (ответы `GET /api/v2/schedules/:id/jobs`). */
export const scheduleJobSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  scheduleName: z.string(),
  trigger: scheduleJobTriggerSchema,
  status: z.enum(['ok', 'error', 'skipped']),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number(),
  target: scheduleTargetSchema,
  dedupKey: z.string().optional(),
  decision: z.enum(['bound', 'queue', 'ephemeral', 'bind', 'drop']).optional(),
  reason: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
});

export type ScheduleJobRequest = z.infer<typeof scheduleJobSchema>;
