import { z } from 'zod';
import { MessageRole, TsmState, GlobalRole, ProjectRole, StatusMessageType } from '../types/index.js';

export const messageRoleSchema = z.nativeEnum(MessageRole);
export const tsmStateSchema = z.nativeEnum(TsmState);
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
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(200000).default(4096),
  systemPrompt: z.string().optional(),
  debugEnabled: z.boolean().default(true),
  streamEnabled: z.boolean().default(true),
  tsmMode: z.enum(['simple', 'orchestrator']).default('simple'),
  agentRole: z.string().optional(),
  contextOptimization: z.enum(['none', 'sliding_window', 'summarization', 'sticky_notes']).default('none'),
  slidingWindowType: z.enum(['messages', 'tokens']).default('messages'),
  slidingWindowLimit: z.number().int().min(1).default(10),
  summarizationEnabled: z.boolean().default(false),
  summarizeAfterN: z.number().int().min(1).default(10),
  summarizeAfterMinutes: z.number().int().min(1).default(5),
  summarizeContextPercent: z.number().min(1).max(100).default(50),
  stickyNotesLimit: z.number().int().min(1).default(6),
  showInterview: z.boolean().default(true),
  websocketEnabled: z.boolean().default(true),
  language: z.string().optional(),
});

export const tsmStatusSchema = z.object({
  state: tsmStateSchema,
  iteration: z.number().int().min(0).default(0),
  validationAttempts: z.number().int().min(0).default(0),
  lastError: z.string().optional(),
  project: z.string().optional(),
  taskName: z.string().default(''),
  progress: z.number().min(0).max(1).optional(),
  approvedPlan: z.string().optional(),
  alreadyDone: z.string().optional(),
  currentlyDoing: z.string().optional(),
  currentTaskInfo: z.string().optional(),
  updatedProjectInfo: z.string().optional(),
  blocked: z.string().optional(),
  blockedAt: z.string().optional(),
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
  settings: sessionSettingsSchema.partial().optional(),
});

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().default(''),
  icon: z.string().optional(),
  color: z.string().optional(),
});

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  currentTask: z.string().optional(),
  invariants: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
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

export type SessionCreateRequest = z.infer<typeof sessionCreateSchema>;
export type SessionUpdateRequest = z.infer<typeof sessionUpdateSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateRequest = z.infer<typeof projectUpdateSchema>;
export type PromptRequest = z.infer<typeof promptRequestSchema>;
export type SpaLoginRequest = z.infer<typeof spaLoginSchema>;
