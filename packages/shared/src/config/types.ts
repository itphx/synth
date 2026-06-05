import { z } from 'zod';

// --- SynthConfig: единый конфиг для всех компонентов ---

export const serverConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(5000),
  corsOrigin: z.string().default('http://localhost:5002'),
});

export const storageConfigSchema = z.object({
  dataDir: z.string().default('/var/synth/data'),
  workspacesRoot: z.string().default(''),
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
    })
    .optional(),
});

export const llmConfigSchema = z.object({
  defaultProvider: z.string().default(''),
  defaultModel: z.string().default(''),
  maxRetries: z.number().int().min(0).default(3),
  timeout: z.number().int().min(1).default(60),
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

export const contextConfigSchema = z.object({
  enabledFiles: z.array(z.string()).default(['SOUL.md', 'COMPANY.md', 'ABOUT.md']),
});

export const summarizationConfigSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.3),
  promptFile: z.string().default('SUMMARIZER'),
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
  context: contextConfigSchema.default({}),
  summarization: summarizationConfigSchema.default({}),
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
export type ContextConfigSchema = z.infer<typeof contextConfigSchema>;
export type SummarizationConfig = z.infer<typeof summarizationConfigSchema>;
export type SynthConfig = z.infer<typeof synthConfigSchema>;
