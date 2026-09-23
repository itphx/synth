import { z } from 'zod';
import { MessageRole, GlobalRole, ProjectRole, StatusMessageType } from '../types/index.js';
import { ToolCapability } from '../types/tools.js';

export const messageRoleSchema = z.nativeEnum(MessageRole);
export const globalRoleSchema = z.nativeEnum(GlobalRole);
export const projectRoleSchema = z.nativeEnum(ProjectRole);
export const statusMessageTypeSchema = z.nativeEnum(StatusMessageType);

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
});

export const sessionCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  projectId: z.string().optional(),
  engine: z.enum(['synth', 'opencode', 'cline']).default('synth'),
  settings: sessionSettingsSchema.optional(),
});

export const sessionUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  projectId: z.string().optional(),
  engine: z.enum(['synth', 'opencode', 'cline']).optional(),
  // passthrough: настройки сессии содержат поля вне sessionSettingsSchema
  // (mcpServers, routing*, microFirst, embedding*, permission, mcpToolSettings, llmGateway),
  // их нельзя терять при PATCH — известные поля валидируются, неизвестные пропускаются.
  settings: sessionSettingsSchema.partial().passthrough().optional(),
});

export const gitRepoConfigSchema = z.object({
  path: z.string().min(1),
  defaultBranch: z.string().optional(),
});

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().default(''),
  icon: z.string().optional(),
  color: z.string().optional(),
  workspace: z.string().optional(),
  repos: z.array(gitRepoConfigSchema).optional(),
});

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  currentTask: z.string().optional(),
  invariants: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  workspace: z.string().optional(),
  repos: z.array(gitRepoConfigSchema).optional(),
});

/**
 * AD-071 §2.4: проектный скоуп MCP (ссылки на реестр по имени).
 * PUT-семантика: `undefined` ≠ `[]` — отсутствующее поле сохраняет текущее
 * значение, поэтому `.default([])` здесь недопустим.
 */
export const projectMcpUpdateSchema = z.object({
  enabled: z.array(z.string()).optional(),
  defaultOn: z.array(z.string()).optional(),
});

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

// --- Git schemas ---
export const gitScanBodySchema = z.object({
  projectId: z.string().min(1),
});

export const gitInitBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string(),
  defaultBranch: z.string().optional(),
});

export const gitCloneBodySchema = z.object({
  projectId: z.string().min(1),
  url: z.string().min(1),
  path: z.string().optional(),
  branch: z.string().optional(),
});

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
export type PromptRequest = z.infer<typeof promptRequestSchema>;
export type SpaLoginRequest = z.infer<typeof spaLoginSchema>;
export type FsListQuery = z.infer<typeof fsListQuerySchema>;
export type FsReadQuery = z.infer<typeof fsReadQuerySchema>;
export type FsWriteBody = z.infer<typeof fsWriteBodySchema>;
export type FsDeleteQuery = z.infer<typeof fsDeleteQuerySchema>;
export type FsMkdirBody = z.infer<typeof fsMkdirBodySchema>;
export type FsDownloadQuery = z.infer<typeof fsDownloadQuerySchema>;
export type GitScanBody = z.infer<typeof gitScanBodySchema>;
export type GitInitBody = z.infer<typeof gitInitBodySchema>;
export type GitCloneBody = z.infer<typeof gitCloneBodySchema>;
export type GitLogQuery = z.infer<typeof gitLogQuerySchema>;
export type GitCommitQuery = z.infer<typeof gitCommitQuerySchema>;
