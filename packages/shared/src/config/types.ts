import { z } from 'zod';
import { permissionConfigSchema } from '../types/permission.js';

// --- SynthConfig: единый конфиг для всех компонентов ---

export const serverConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(5000),
  corsOrigin: z.string().default('http://localhost:5002'),
  allowedOrigins: z.array(z.string()).default([]),
});

export const storageConfigSchema = z.object({
  dataDir: z.string().default('/var/synth/data'),
  workspacesRoot: z.string().default(''),
  /** Рабочий каталог по умолчанию для сессий без проекта. Резолвится от dataDir: {dataDir}/workspaces/default. */
  defaultWorkspace: z.string().default(''),
});

export const authConfigSchema = z.object({
  debugMode: z.boolean().default(false),
  apiKey: z.string().optional(),
  testUsers: z
    .array(
      z.object({
        username: z.string(),
        apiKey: z.string(),
        roles: z.array(z.string()),
        displayName: z.string(),
      }),
    )
    .optional(),
  sessionMaxAgeMinutes: z.number().int().min(1).default(1440),
  oidc: z
    .object({
      enabled: z.boolean().default(false),
      issuer: z.string().default(''),
      clientId: z.string().default(''),
      clientSecret: z.string().default(''),
      redirectUri: z.string().default('http://localhost:5002/auth/callback'),
      /** Public client_id для локального CLI/core (ROPC/device flow). Не секрет. */
      cliClientId: z.string().default('synth-cli'),
    })
    .optional(),
});

export const llmConfigSchema = z.object({
  defaultProvider: z.string().default(''),
  defaultModel: z.string().default(''),
  maxRetries: z.number().int().min(0).default(3),
  timeout: z.number().int().min(1).default(60),
  /** AD-070 §2.2: политика prompt-cache — auto (ставить маркеры) | none (отключить). */
  cache: z.enum(['auto', 'none']).default('auto'),
});

export const coreConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4300),
  apiKey: z.string().default(''),
});

export const runnerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(5200),
  backendUrl: z.string().default('http://localhost:5000'),
  enginePorts: z.object({
    opencode: z.number().int().default(4100),
    cline: z.number().int().default(4200),
    synth: z.number().int().default(4300),
  }).default({}),
  proxyPort: z.number().int().min(1).max(65535).default(9090),
});

export const uiConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(5002),
  backendUrl: z.string().default('http://localhost:5000'),
  theme: z.string().default('flexoki'),
  themeMode: z.enum(['system', 'light', 'dark']).default('system'),
  locale: z.string().default('ru'),
});

export const i18nConfigSchema = z.object({
  defaultLanguage: z.string().default('ru'),
  supportedLanguages: z.array(z.string()).default(['ru', 'en']),
});

export const loggingConfigSchema = z.object({
  groups: z.record(z.string(), z.string()).default({}),
});

export const tsmConfigSchema = z.object({
  maxIterations: z.number().int().min(1).default(50),
  validationTimeout: z.number().int().min(1).default(30),
});

// --- Session (AD-025 / AD-028): настройки по умолчанию для сессий ---

export const sessionConfigSchema = z.object({
  /** Строгость цикла Plan→Build по умолчанию для новых сессий: auto | strict | off. */
  planMode: z.enum(['auto', 'strict', 'off']).default('auto'),
});

export const contextConfigSchema = z.object({
  enabledFiles: z.array(z.string()).default(['SOUL.md', 'COMPANY.md', 'ABOUT.md']),
});

export const summarizationConfigSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.3),
  promptFile: z.string().default('SUMMARIZER'),
});

export const mcpServerConfigSchema = z.object({
  type: z.enum(['stdio', 'sse']),
  /** AD-071 §2.2: человекочитаемое описание сервера (попадает в блок `mcp.servers`). */
  description: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  enabledByDefault: z.boolean().optional(),
  timeout: z.number().int().min(1).optional(),
  connectTimeout: z.number().int().min(1).optional(),
});

export const mcpConfigSchema = z.object({
  servers: z.record(z.string(), mcpServerConfigSchema).default({}),
});

// --- Security (IPI protection) ---

export const promptInjectionConfigSchema = z.object({
  /** Глобальный выключатель защиты от Indirect Prompt Injection. */
  enabled: z.boolean().default(true),
  /** Оборачивать tool-контент в [CONTENT | SOURCE: ... | trust: ...] маркеры. */
  wrapContent: z.boolean().default(true),
  /** Режим детекции подозрительных паттернов: flag (пометить), sanitize (заменить), block (заблокировать). */
  mode: z.enum(['flag', 'sanitize', 'block']).default('flag'),
});

export const protectedPathsConfigSchema = z.object({
  /** Глобальный выключатель защиты защищённых путей (сквозная проверка файловых тулов). */
  enabled: z.boolean().default(true),
});

export const securityConfigSchema = z.object({
  promptInjection: promptInjectionConfigSchema.default({}),
  protectedPaths: protectedPathsConfigSchema.default({}),
});

// --- LLM Gateway (AD-036) ---

export const llmGatewayRateLimitConfigSchema = z.object({
  userPerMinute: z.number().int().min(1).default(60),
  providerPerMinute: z.number().int().min(1).default(120),
});

export const llmGatewayAuditConfigSchema = z.object({
  enabled: z.boolean().default(true),
  logPath: z.string().default(''), // по умолчанию {dataDir}/audit/llm-gateway.jsonl
});

export const llmGatewayConfigSchema = z.object({
  /** Глобальный выключатель LLM Gateway. */
  enabled: z.boolean().default(false),
  /** Режим Input Guard: obfuscate (замена на плейсхолдер) | block (запрос блокируется). */
  inputMode: z.enum(['obfuscate', 'block']).default('obfuscate'),
  /** Полное логирование запросов и ответов LLM (после обфускации) в JSONL. */
  logPayloads: z.boolean().default(false),
  /** Путь к JSONL полного лога; по умолчанию {dataDir}/audit/llm-payloads.jsonl. */
  payloadLogPath: z.string().default(''),
  rateLimit: llmGatewayRateLimitConfigSchema.default({}),
  audit: llmGatewayAuditConfigSchema.default({}),
});

// --- Router (AD-034) ---

export const routerContentConfigSchema = z.object({
  coding: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}),
  chat: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}),
  research: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}),
});

export const routerEscalationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  fallbackProvider: z.string().default(''),
  fallbackModel: z.string().default(''),
  maxRetries: z.number().int().min(0).max(3).default(1),
  checks: z.array(z.enum(['min_length', 'constraint', 'self_check'])).default(['min_length', 'constraint']),
  minLength: z.number().int().min(1).default(10),
});

export const routerCostConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cheapProvider: z.string().default(''),
  cheapModel: z.string().default(''),
  expensiveProvider: z.string().default(''),
  expensiveModel: z.string().default(''),
  maxCheapTokens: z.number().int().min(1).default(500),
});

export const routerSubagentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default(''),
  provider: z.string().default(''),
});

// --- Micro-first (AD-035) ---

export const microFirstConfigSchema = z.object({
  enabled: z.boolean().default(false),
  confidenceThreshold: z.number().min(0).max(1).default(0.8),
  microLlmProvider: z.string().default(''),
  microLlmModel: z.string().default(''),
  rulesEnabled: z.boolean().default(true),
  embeddingEnabled: z.boolean().default(false),
  embedProvider: z.string().default('ollama'),
  embedModel: z.string().default('local.nomic-embed-text:latest'),
  microLlmEnabled: z.boolean().default(false),
});

export const routerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  strategy: z.enum(['content', 'cost', 'content+cost', 'auto']).default('auto'),
  content: routerContentConfigSchema.default({}),
  escalation: routerEscalationConfigSchema.default({}),
  cost: routerCostConfigSchema.default({}),
  subagent: routerSubagentConfigSchema.default({}),
});

// --- Remote (гибридный режим) ---

export const remoteConfigSchema = z.object({
  /** Включён ли гибридный режим: локальный core подключается к удалённому backend. */
  enabled: z.boolean().default(false),
  /** Базовый URL удалённого backend (например https://synth.k3s.itphx.loc). */
  backendUrl: z.string().default(''),
  auth: z
    .object({
      type: z.enum(['device', 'api_key']).default('device'),
      apiKey: z.string().default(''),
      /** OIDC issuer (Keycloak realm), напр. https://keycloak.itphx.loc/realms/synth. Для device flow. */
      issuer: z.string().default(''),
      /** OIDC client_id (public client). Для device flow. */
      clientId: z.string().default(''),
    })
    .default({}),
  /** Куда идут LLM-запросы локальных сессий: server (централизация) | local. По умолчанию server. */
  llm: z.enum(['server', 'local']).default('server'),
  worlds: z
    .object({
      local: z.boolean().default(true),
      remote: z.boolean().default(true),
    })
    .default({}),
  /** Путь к файлу credentials (пусто → ~/.config/synth/credentials.json). */
  credentialsPath: z.string().default(''),
  timeoutMs: z.number().int().min(1).default(15000),
});

export const synthConfigSchema = z.object({
  server: serverConfigSchema.default({}),
  storage: storageConfigSchema.default({}),
  auth: authConfigSchema.default({}),
  llm: llmConfigSchema.default({}),
  core: coreConfigSchema.default({}),
  runner: runnerConfigSchema.default({}),
  ui: uiConfigSchema.default({}),
  i18n: i18nConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  tsm: tsmConfigSchema.default({}),
  session: sessionConfigSchema.default({}),
  context: contextConfigSchema.default({}),
  summarization: summarizationConfigSchema.default({}),
  mcp: mcpConfigSchema.default({}),
  router: routerConfigSchema.default({}),
  remote: remoteConfigSchema.default({}),
  microFirst: microFirstConfigSchema.default({}),
  llmGateway: llmGatewayConfigSchema.default({}),
  permission: permissionConfigSchema.default({}),
  security: securityConfigSchema.default({}),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type LLMConfig = z.infer<typeof llmConfigSchema>;
export type CoreConfig = z.infer<typeof coreConfigSchema>;
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;
export type UIConfig = z.infer<typeof uiConfigSchema>;
export type I18nConfig = z.infer<typeof i18nConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type TsmConfig = z.infer<typeof tsmConfigSchema>;
export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type ContextConfigSchema = z.infer<typeof contextConfigSchema>;
export type SummarizationConfig = z.infer<typeof summarizationConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type RouterContentConfig = z.infer<typeof routerContentConfigSchema>;
export type RouterEscalationConfig = z.infer<typeof routerEscalationConfigSchema>;
export type RouterCostConfig = z.infer<typeof routerCostConfigSchema>;
export type RouterSubagentConfig = z.infer<typeof routerSubagentConfigSchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export type MicroFirstConfig = z.infer<typeof microFirstConfigSchema>;
export type SynthConfig = z.infer<typeof synthConfigSchema>;
export type PermissionConfig = z.infer<typeof permissionConfigSchema>;
export type PromptInjectionConfig = z.infer<typeof promptInjectionConfigSchema>;
export type ProtectedPathsConfig = z.infer<typeof protectedPathsConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type LLMGatewayRateLimitConfig = z.infer<typeof llmGatewayRateLimitConfigSchema>;
export type LLMGatewayAuditConfig = z.infer<typeof llmGatewayAuditConfigSchema>;
export type LLMGatewayConfig = z.infer<typeof llmGatewayConfigSchema>;
