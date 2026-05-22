import type { DebugCollector } from '../debug.js';

const VALID_STATES = new Set(['planning', 'execution', 'validation', 'done']);

const STATUS_INDICATOR_KEYS = new Set([
  'task_name', 'state', 'progress', 'project', 'updated_project_info',
  'current_task_info', 'approved_plan', 'already_doing', 'currently_doing',
  'invariants', 'subtasks',
]);

export interface ParsedStatus {
  taskName?: string;
  state?: string;
  progress?: number;
  project?: string;
  currentTaskInfo?: string;
  updatedProjectInfo?: string;
  approvedPlan?: string;
  alreadyDone?: string;
  currentlyDoing?: string;
  subtasks: Array<{
    id: string;
    name: string;
    prompt: string;
    status: string;
  }>;
  invariants?: Record<string, unknown>;
}

export class StatusParser {
  private readonly _debug?: DebugCollector;

  constructor(debugCollector?: DebugCollector) {
    this._debug = debugCollector;
  }

  parse(content: string): { parsed: ParsedStatus | null; cleaned: string } {
    if (!content) return { parsed: null, cleaned: content };

    const extractResult = this._extractJson(content);
    if (!extractResult) return { parsed: null, cleaned: content };

    const { jsonStr, cleaned: cleanedContent } = extractResult;
    const parsed = this._parseJson(jsonStr);
    if (!parsed) return { parsed: null, cleaned: cleanedContent };

    this._debugAdd('status_parser', {
      input_length: content.length,
      parsed: true,
      state: parsed.state,
      task_name: parsed.taskName,
      subtasks_count: parsed.subtasks.length,
    });

    return { parsed, cleaned: cleanedContent };
  }

  private _extractJson(content: string): { jsonStr: string; cleaned: string } | null {
    // Strategy 1 — markdown code block
    const mdMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
    if (mdMatch) {
      const jsonStr = mdMatch[1]!.trim();
      const cleaned = (content.slice(0, mdMatch.index) + content.slice(mdMatch.index! + mdMatch[0].length)).trim();
      return { jsonStr, cleaned };
    }

    // Strategy 2 — search for {"status": key
    const statusMatch = content.match(/\{[\t\r\n ]*['"]?status['"]?[\t\r\n ]*:/i);
    if (statusMatch) {
      const start = statusMatch.index!;
      const result = this._findMatchingBraces(content, start);
      if (result) {
        const [jsonStr, end] = result;
        const cleaned = (content.slice(0, start) + content.slice(end + 1)).trim();
        return { jsonStr, cleaned };
      }
    }

    // Strategy 3 — brute force all braces
    for (const start of this._findBracePositions(content)) {
      const result = this._findMatchingBraces(content, start);
      if (result) {
        const [jsonStr] = result;
        try {
          const potential = JSON.parse(jsonStr);
          if (this._isStatusObject(potential)) {
            const cleaned = (content.slice(0, start) + content.slice(result[1] + 1)).trim();
            return { jsonStr, cleaned };
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  private _findBracePositions(content: string): number[] {
    const positions: number[] = [];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '{') {
        const before = content.slice(0, i).trimEnd();
        if (!before || before.endsWith('\n') || before.endsWith(';')) {
          positions.push(i);
        }
      }
    }
    return positions;
  }

  private _findMatchingBraces(content: string, start: number): [string, number] | null {
    let count = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = start; i < content.length; i++) {
      const ch = content[i]!;

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (ch === '\\') {
        escapeNext = true;
        continue;
      }

      if (ch === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') {
        count++;
      } else if (ch === '}') {
        count--;
        if (count === 0) {
          return [content.slice(start, i + 1), i];
        }
      }
    }

    return null;
  }

  private _isStatusObject(obj: Record<string, unknown>): boolean {
    if (typeof obj !== 'object' || obj === null) return false;
    if ('status' in obj && typeof obj.status === 'object' && obj.status !== null) return true;
    return Object.keys(obj).some((k) => STATUS_INDICATOR_KEYS.has(k));
  }

  private _parseJson(jsonStr: string): ParsedStatus | null {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      return null;
    }

    // Unwrap {status: {...}}
    if (typeof data.status === 'object' && data.status !== null) {
      data = data.status as Record<string, unknown>;
    }

    if (!this._isStatusObject(data)) return null;

    const parsed: ParsedStatus = { subtasks: [] };

    if (typeof data.task_name === 'string') parsed.taskName = data.task_name;
    if (typeof data.state === 'string' && VALID_STATES.has(data.state)) parsed.state = data.state;
    if (typeof data.progress === 'number') parsed.progress = data.progress;
    if (typeof data.project === 'string') parsed.project = data.project;
    if (typeof data.current_task_info === 'string') parsed.currentTaskInfo = data.current_task_info;
    if (typeof data.updated_project_info === 'string') parsed.updatedProjectInfo = data.updated_project_info;
    if (typeof data.approved_plan === 'string') parsed.approvedPlan = data.approved_plan;
    if (typeof data.already_done === 'string') parsed.alreadyDone = data.already_done;
    if (typeof data.currently_doing === 'string') parsed.currentlyDoing = data.currently_doing;

    if (Array.isArray(data.subtasks)) {
      parsed.subtasks = data.subtasks
        .filter((st): st is Record<string, unknown> => typeof st === 'object' && st !== null)
        .map((st) => ({
          id: String(st.id ?? ''),
          name: String(st.name ?? ''),
          prompt: String(st.prompt ?? ''),
          status: String(st.status ?? 'pending'),
        }));
    }

    if (typeof data.invariants === 'object' && data.invariants !== null) {
      parsed.invariants = data.invariants as Record<string, unknown>;
    }

    return parsed;
  }

  private _debugAdd(key: string, data: Record<string, unknown>): void {
    this._debug?.addContext(key, data);
  }
}
