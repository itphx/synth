const API_KEY_MASK = '***';

const MASKED_HEADERS = new Set(['authorization', 'x-api-key', 'api-key']);

export class DebugCollector {
  private _enabled: boolean;
  private _apiRequest: Record<string, unknown> | null = null;
  private _apiResponse: Record<string, unknown> | null = null;
  private _rawModelResponse: string | null = null;
  private _reasoning: string | null = null;
  private _sessionInfo: Record<string, unknown> | null = null;
  private _subagents: Array<Record<string, unknown>> = [];
  private _mcpCalls: Array<Record<string, unknown>> = [];
  private _ragInfo: Record<string, unknown> | null = null;
  private _contextFiles: Array<Record<string, unknown>> = [];
  private _systemPromptParts: Record<string, unknown> | null = null;
  private _extraContext: Record<string, Record<string, unknown>> = {};

  constructor(enabled = false) {
    this._enabled = enabled;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  enable(): void {
    this._enabled = true;
  }

  disable(): void {
    this._enabled = false;
  }

  captureApiRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): void {
    if (!this._enabled) return;
    const maskedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      maskedHeaders[k] = MASKED_HEADERS.has(k.toLowerCase()) ? API_KEY_MASK : v;
    }
    this._apiRequest = { url, method, headers: maskedHeaders, body };
  }

  captureApiResponse(response: Record<string, unknown>): void {
    if (!this._enabled) return;
    this._apiResponse = response;
  }

  captureRawModelResponse(content: string): void {
    if (!this._enabled) return;
    this._rawModelResponse = content;
  }

  captureReasoning(reasoning: string | undefined): void {
    if (!this._enabled || !reasoning) return;
    this._reasoning = reasoning;
  }

  captureSessionInfo(
    sessionId: string,
    model: string,
    provider: string,
    extras?: Record<string, unknown>,
  ): void {
    if (!this._enabled) return;
    this._sessionInfo = { session_id: sessionId, model, provider, ...extras };
  }

  captureSubagentStart(name: string, prompt: string): number {
    if (!this._enabled) return -1;
    const index = this._subagents.length;
    this._subagents.push({ name, prompt, messages: [], response: null });
    return index;
  }

  captureSubagentMessage(index: number, role: string, content: string): void {
    if (!this._enabled || index < 0) return;
    if (index < this._subagents.length) {
      const entry = this._subagents[index]!;
      const msgs = entry.messages as Array<Record<string, unknown>>;
      msgs.push({ role, content });
    }
  }

  captureSubagentResponse(index: number, response: string): void {
    if (!this._enabled || index < 0) return;
    if (index < this._subagents.length) {
      this._subagents[index]!.response = response;
    }
  }

  captureMcpCall(
    tool: string,
    args: Record<string, unknown>,
    result: string,
    isError = false,
  ): void {
    if (!this._enabled) return;
    this._mcpCalls.push({ tool, arguments: args, result, is_error: isError });
  }

  captureRagInfo(
    query: string,
    indexName: string,
    topK: number,
    results: Array<Record<string, unknown>>,
    contextAdded: string,
  ): void {
    if (!this._enabled) return;
    this._ragInfo = {
      query,
      index_name: indexName,
      top_k: topK,
      results_count: results.length,
      results: results.map((r) => ({
        chunk_id: r.id,
        content: String(r.content ?? '').slice(0, 500),
        source: (r.metadata as Record<string, unknown>)?.source ?? 'unknown',
        section: (r.metadata as Record<string, unknown>)?.section ?? '',
        distance: r.distance,
        similarity: r.similarity,
      })),
      context_added: contextAdded.slice(0, 2000),
      context_length: contextAdded.length,
    };
  }

  captureContextFiles(files: Array<Record<string, unknown>>): void {
    if (!this._enabled) return;
    this._contextFiles = files;
  }

  captureSystemPromptParts(parts: Record<string, unknown>): void {
    if (!this._enabled) return;
    this._systemPromptParts = parts;
  }

  addContext(key: string, data: Record<string, unknown>): void {
    if (!this._enabled) return;
    this._extraContext[key] = data;
  }

  getDebugInfo(): Record<string, unknown> | null {
    if (!this._enabled) return null;
    const result: Record<string, unknown> = {};
    if (this._apiRequest) result.api_request = this._apiRequest;
    if (this._apiResponse) result.api_response = this._apiResponse;
    if (this._rawModelResponse) result.raw_model_response = this._rawModelResponse;
    if (this._reasoning) result.reasoning = this._reasoning;
    if (this._sessionInfo) result.session = this._sessionInfo;
    if (this._subagents.length) result.subagents = this._subagents;
    if (this._mcpCalls.length) result.mcp_calls = this._mcpCalls;
    if (this._ragInfo) result.rag_info = this._ragInfo;
    if (this._contextFiles.length) result.context_files = this._contextFiles;
    if (this._systemPromptParts) result.system_prompt_parts = this._systemPromptParts;
    if (Object.keys(this._extraContext).length) result.extra_context = this._extraContext;
    return Object.keys(result).length ? result : null;
  }

  clear(): void {
    this._apiRequest = null;
    this._apiResponse = null;
    this._rawModelResponse = null;
    this._reasoning = null;
    this._sessionInfo = null;
    this._subagents = [];
    this._mcpCalls = [];
    this._ragInfo = null;
    this._contextFiles = [];
    this._systemPromptParts = null;
    this._extraContext = {};
  }
}
