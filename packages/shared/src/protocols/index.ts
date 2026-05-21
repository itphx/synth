// WebSocket протокол — клиент ↔ сервер (чат)

export interface WSClientMessage {
  type: 'send_message' | 'cancel' | 'ping';
  content?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  agentRole?: string;
  streamId?: string;
}

export interface WSServerMessage {
  type: string;
  sessionId?: string;
  clientId?: string;
  engine?: string;
  data?: Record<string, unknown>;
  content?: string;
  isFinal?: boolean;
  position?: number;
  message?: string;
  pendingCount?: number;
  streamId?: string;
  agentRole?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  reasoning?: string;
  debugInfo?: Record<string, unknown>;
  messageIndex?: number;
  error?: string;
  errorType?: string;
  retryCount?: number;
  canRetry?: boolean;
  changes?: Record<string, unknown>;
}

// Runner Protocol — бэкенд ↔ раннер (WebSocket)

export interface RunnerRegisterMessage {
  type: 'register';
  engines: string[];
  capabilities: RunnerCapabilities;
  labels?: Record<string, string>;
}

export interface RunnerCapabilities {
  cwd: string;
  home: string;
  env: Record<string, string>;
  platform: string;
}

export interface TaskAssignMessage {
  type: 'task.assign';
  taskId: string;
  sessionId: string;
  engine: string;
  message: { role: string; content: string };
  model: string;
  provider: string;
}

export interface TaskCancelMessage {
  type: 'task.cancel';
  sessionId: string;
}

export interface SessionCloseMessage {
  type: 'session.close';
  sessionId: string;
}

export type ServerToRunnerMessage = TaskAssignMessage | TaskCancelMessage | SessionCloseMessage;

export interface StreamChunkMessage {
  type: 'stream.chunk';
  sessionId: string;
  content: string;
  reasoning?: string;
  isFinal: boolean;
}

export interface StreamDoneMessage {
  type: 'stream.done';
  sessionId: string;
  content: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface StreamErrorMessage {
  type: 'stream.error';
  sessionId: string;
  error: string;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
}

export type RunnerToServerMessage =
  | RunnerRegisterMessage
  | StreamChunkMessage
  | StreamDoneMessage
  | StreamErrorMessage
  | HeartbeatMessage;

// Engine HTTP API — раннер ↔ движок

export interface EngineMessageRequest {
  messages: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

export interface EngineMessageResponse {
  content: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}
