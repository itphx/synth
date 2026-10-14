/**
 * AD-069 §4: lazy-догрузка вложенных проектных инструкций.
 *
 * Инструкции ближайшего каталога подклеиваются **в результат file/shell-тула**
 * (не в system prompt — сохраняем prompt-cache), с пометкой
 * `[Subdirectory context discovered: ./packages/core/AGENTS.md]`.
 *
 * Правила:
 * - триггер — успешные `read_file`/`grep_files`/`glob`/`list_directory`/
 *   `write_file`/`edit_file`/`delete_file`/`create_directory`/`execute_shell`;
 * - вверх от каталога файла не более `lazy.maxAncestors` (5), только внутри
 *   `project.workspace`, с исключением `lazy.excludeDirs`;
 * - trust-гейт как у system-chain (AD-069 §3.5/R1): недоверенный workspace
 *   (`untrusted`) инструкции не догружает;
 * - на каталог — приоритет файлов как в резолвере
 *   (`AGENTS.override.md` > `AGENTS.md` > `agents.md`; `CLAUDE.md` при
 *   `claudeCompat`);
 * - дедуп: реестр `loaded` (пути, уже загруженные в system prompt и прошлые
 *   lazy-догрузки) + sha256 по содержимому;
 * - один раз на assistant-сообщение (`claims` по сообщению);
 * - кап блока `lazy.maxChars` (8000), head/tail-обрезка с маркером пути;
 * - threat-scan (AD-036) до вставки; `block` — файл не грузится.
 *
 * Резолвер stateless; состояние (`loaded`/`claims`) — per-session в оркестраторе.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { InstructionsLazyConfig } from '@itphx/synth-shared';
import {
  displayPathFor,
  isInsideDir,
  resolveInstructionsTrusted,
  selectInstructionFile,
  truncateHeadTail,
  waterFillAllocate,
} from './instructions.js';
import {
  applyPolicy,
  buildWarnLine,
  detectPromptInjection,
  type InjectionPolicy,
} from '../security/prompt-injection.js';
import type { DictionaryStore } from '../router/dictionary-store.js';

/** Пометка lazy-блока в tool result (AD-069 §4.3.6). */
export const LAZY_INSTRUCTIONS_PREFIX = '[Subdirectory context discovered:';

/** Тулы-триггеры lazy-догрузки (AD-069 §4.2). */
export const LAZY_TRIGGER_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'grep_files',
  'glob',
  'list_directory',
  'write_file',
  'edit_file',
  'delete_file',
  'create_directory',
  'execute_shell',
]);

/** Тулы, где `file_path` — файл (каталог-цель = dirname). */
const FILE_PATH_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
]);

/** Информация о lazy-загруженном файле (для события `context.instructions_loaded`). */
export interface LazyInstructionsFileInfo {
  /** Путь, относительный к workspace (`./packages/core/AGENTS.md`). */
  path: string;
  /** Длина загруженного контента (после обрезки/санитайза). */
  chars: number;
  truncated: boolean;
  scanned: boolean;
  blocked: boolean;
}

export interface LazyInstructionsDiagnostic {
  path?: string;
  status: 'loaded' | 'truncated' | 'blocked' | 'dedup' | 'empty' | 'untrusted';
  reason?: string;
}

export interface LazyInstructionsResult {
  /** Готовый блок для вставки в tool result ('' — нечего добавлять). */
  block: string;
  files: LazyInstructionsFileInfo[];
  diagnostics: LazyInstructionsDiagnostic[];
}

export interface LazyInstructionsDeps {
  /** Секция `instructions.lazy`. */
  config: InstructionsLazyConfig;
  /** `instructions.claudeCompat` — читать `CLAUDE.md` как fallback. */
  claudeCompat: boolean;
  /** `instructions.contextCompat` — deprecated `CONTEXT.md`. */
  contextCompat: boolean;
  /** Доли head/tail при обрезке (из `instructions`). */
  headRatio: number;
  tailRatio: number;
  /** AD-069 §3.5/R1: `config.skills.trustedProjectDirs` — project-trust гейт. */
  trustedProjectDirs?: readonly string[];
  /** AD-069 R3: `storage.workspacesRoot` — авто-trust workspace внутри него. */
  workspacesRoot?: string;
  /** Словарь threat-scan (AD-036). */
  dictionaryStore?: DictionaryStore | null;
}

export interface LazyResolveArgs {
  sessionId: string;
  /** ID assistant-сообщения (streamId хода) — «один раз на сообщение». */
  messageId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** `metadata` результата тула — уточняет абсолютный путь (`metadata.path`). */
  toolResultMetadata?: Record<string, unknown>;
  /** Абсолютный `project.workspace` — граница lazy-догрузки. */
  workspace: string;
  language?: string;
  /** Политика threat-scan (как у tool-контента, AD-036). */
  injection?: { enabled: boolean; mode: InjectionPolicy };
}

/**
 * Best-effort извлечение каталога-цели из аргументов тула.
 * Возвращает путь как есть (относительный/абсолютный) либо null.
 */
export function extractLazyTargetDir(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (!LAZY_TRIGGER_TOOLS.has(toolName)) return null;

  if (toolName === 'execute_shell') {
    const cwd = typeof args.cwd === 'string' ? args.cwd.trim() : '';
    if (cwd) return cwd;
    const command = typeof args.command === 'string' ? args.command : '';
    return command ? extractShellDir(command) : null;
  }

  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
  const dirPath = typeof args.path === 'string' ? args.path.trim() : '';

  if (FILE_PATH_TOOLS.has(toolName)) {
    const raw = filePath || dirPath;
    return raw ? dirname(raw) : null;
  }

  // Каталог-цель: `path` (list_directory/glob/grep_files/create_directory);
  // без пути тул работает от рабочего каталога.
  return dirPath || '.';
}

/** Best-effort путь из shell-команды: `cd <dir>` либо файловые команды. */
export function extractShellDir(command: string): string | null {
  const cd = command.match(
    /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/,
  );
  if (cd) return cd[1] ?? cd[2] ?? cd[3] ?? null;

  const fileOp = command.match(
    /\b(?:cat|less|more|head|tail|bat|nano|vim|vi|code)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/,
  );
  if (fileOp) {
    const p = fileOp[1] ?? fileOp[2] ?? fileOp[3];
    return p ? dirname(p) : null;
  }
  return null;
}

interface LazyCandidate {
  displayPath: string;
  content: string;
  scanned: boolean;
  warnLine: string;
  shaKey: string;
  pathKey: string;
}

/** Реестр/дедуп-ключ пути (нормализуем разделители). */
function pathKeyFor(displayPath: string): string {
  return `path:${displayPath.replace(/\\/g, '/')}`;
}

/**
 * Lazy-загрузчик вложенных инструкций. Держит per-session состояние
 * (`loaded` — уже загруженные пути/хеши, `claims` — сообщение, где lazy уже
 * сработал). Один экземпляр на оркестратор.
 */
export class LazyInstructionsLoader {
  private readonly _deps: LazyInstructionsDeps;
  private readonly _loaded = new Map<string, Set<string>>();
  private readonly _claims = new Map<string, string>();

  constructor(deps: LazyInstructionsDeps) {
    this._deps = deps;
  }

  /**
   * Помечает пути, уже попавшие в system prompt (merged chain), как
   * загруженные — чтобы lazy не дублировал их в tool result.
   */
  seed(sessionId: string, filePaths: readonly string[]): void {
    if (filePaths.length === 0) return;
    const loaded = this._loadedSet(sessionId);
    for (const path of filePaths) {
      if (path) loaded.add(pathKeyFor(path));
    }
  }

  /** Сброс состояния сессии (завершение/удаление). */
  reset(sessionId: string): void {
    this._loaded.delete(sessionId);
    this._claims.delete(sessionId);
  }

  /** Уже загружен ли файл (по пути) — тесты/диагностика. */
  isLoaded(sessionId: string, displayPath: string): boolean {
    return this._loaded.get(sessionId)?.has(pathKeyFor(displayPath)) ?? false;
  }

  async resolve(args: LazyResolveArgs): Promise<LazyInstructionsResult> {
    const empty: LazyInstructionsResult = { block: '', files: [], diagnostics: [] };
    const cfg = this._deps.config;
    if (!cfg.enabled || !LAZY_TRIGGER_TOOLS.has(args.toolName)) return empty;
    // Один раз на assistant-сообщение.
    if (this._claims.get(args.sessionId) === args.messageId) return empty;

    const workspace = normalize(args.workspace);
    if (!workspace) return empty;

    const targetDir = this._resolveTargetDir(args, workspace);
    if (!targetDir) return empty;
    // Граница: только внутри project.workspace (AD-069 §4.3.3).
    if (!isInsideDir(workspace, targetDir)) return empty;

    // AD-069 §3.5/R1: общий с project-chain trust-гейт — вложенные инструкции
    // недоверенного workspace не грузятся (причина `untrusted`).
    if (
      !resolveInstructionsTrusted(workspace, {
        trustedProjectDirs: this._deps.trustedProjectDirs,
        workspacesRoot: this._deps.workspacesRoot,
      })
    ) {
      return {
        block: '',
        files: [],
        diagnostics: [{ status: 'untrusted', reason: 'untrusted-project' }],
      };
    }

    const maxAncestors = Math.max(0, cfg.maxAncestors);
    if (maxAncestors === 0) return empty;

    // Каталоги от цели вверх (не более maxAncestors), только внутри workspace.
    const dirs: string[] = [];
    let current = targetDir;
    for (let i = 0; i < maxAncestors; i++) {
      dirs.push(current);
      if (current === workspace) break;
      const parent = dirname(current);
      if (parent === current || !isInsideDir(workspace, parent)) break;
      current = parent;
    }

    const loaded = this._loadedSet(args.sessionId);
    const files: LazyInstructionsFileInfo[] = [];
    const diagnostics: LazyInstructionsDiagnostic[] = [];
    const candidates: LazyCandidate[] = [];
    const claimedInCall = new Set<string>();

    for (const dir of dirs) {
      // Исключённые каталоги не становятся источником инструкций.
      if (cfg.excludeDirs.includes(basename(dir))) continue;
      const selected = await selectInstructionFile(dir, this._deps.claudeCompat, this._deps.contextCompat);
      if (!selected) continue;

      const abs = join(dir, selected.fileName);
      const displayPath = displayPathFor(workspace, abs);
      const pathKey = pathKeyFor(displayPath);
      // Дедуп: уже загружен (system prompt / прошлая lazy-догрузка / этот вызов).
      if (loaded.has(pathKey) || claimedInCall.has(pathKey)) {
        diagnostics.push({ path: displayPath, status: 'dedup', reason: 'already-loaded' });
        continue;
      }

      let content: string;
      try {
        content = await readFile(abs, 'utf-8');
      } catch {
        diagnostics.push({ path: displayPath, status: 'empty', reason: 'read-error' });
        continue;
      }
      if (!content.trim()) {
        diagnostics.push({ path: displayPath, status: 'empty' });
        continue;
      }

      const shaKey = `sha:${createHash('sha256').update(content).digest('hex')}`;
      if (loaded.has(shaKey) || claimedInCall.has(shaKey)) {
        diagnostics.push({ path: displayPath, status: 'dedup', reason: 'sha256' });
        continue;
      }

      const scan = this._scan(content, args);
      if (scan.blocked) {
        // Threat-scan block — контент не грузится, но виден в диагностике/файлах.
        diagnostics.push({ path: displayPath, status: 'blocked', reason: 'injection' });
        files.push({ path: displayPath, chars: 0, truncated: false, scanned: scan.scanned, blocked: true });
        continue;
      }

      claimedInCall.add(pathKey);
      claimedInCall.add(shaKey);
      candidates.push({
        displayPath,
        content: scan.content,
        scanned: scan.scanned,
        warnLine: scan.warnLine,
        shaKey,
        pathKey,
      });
    }

    if (candidates.length === 0) {
      return { block: '', files, diagnostics };
    }

    // Обрезка + сборка блока. Собираем от ближайшего предка (dirs — ближе к
    // цели вперёд), затем разворачиваем: дальний предок раньше (как в chain).
    const maxChars = Math.max(1, cfg.maxChars);
    const overhead = candidates.reduce(
      (sum, c) => sum + LAZY_INSTRUCTIONS_PREFIX.length + c.displayPath.length + 8,
      0,
    );
    const contentBudget = Math.max(0, maxChars - overhead);
    const allocations = waterFillAllocate(
      candidates.map((c) => c.content.length),
      contentBudget,
    );

    const blocks: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const truncatedResult = truncateHeadTail(
        candidate.content,
        allocations[i]!,
        this._deps.headRatio,
        this._deps.tailRatio,
        candidate.displayPath,
      );
      const finalContent = truncatedResult.truncated ? truncatedResult.content : candidate.content;
      const warn = candidate.warnLine ? `${candidate.warnLine}\n` : '';
      blocks.push(
        `${LAZY_INSTRUCTIONS_PREFIX} ${candidate.displayPath}]\n${warn}${finalContent}`,
      );
      files.push({
        path: candidate.displayPath,
        chars: finalContent.length,
        truncated: truncatedResult.truncated,
        scanned: candidate.scanned,
        blocked: false,
      });
      diagnostics.push({
        path: candidate.displayPath,
        status: truncatedResult.truncated ? 'truncated' : 'loaded',
      });
      loaded.add(candidate.pathKey);
      loaded.add(candidate.shaKey);
    }

    blocks.reverse();
    files.reverse();

    // Claim: один раз на assistant-сообщение.
    this._claims.set(args.sessionId, args.messageId);

    return { block: blocks.join('\n\n'), files, diagnostics };
  }

  /** Абсолютный каталог-цель из аргументов / metadata результата. */
  private _resolveTargetDir(args: LazyResolveArgs, workspace: string): string | null {
    let candidate = extractLazyTargetDir(args.toolName, args.toolArgs);
    if (!candidate) {
      const metaPath = typeof args.toolResultMetadata?.path === 'string'
        ? args.toolResultMetadata.path
        : '';
      if (metaPath) {
        candidate = FILE_PATH_TOOLS.has(args.toolName) ? dirname(metaPath) : metaPath;
      }
    }
    if (!candidate) return null;
    return isAbsolute(candidate) ? normalize(candidate) : resolve(workspace, candidate);
  }

  private _loadedSet(sessionId: string): Set<string> {
    let set = this._loaded.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this._loaded.set(sessionId, set);
    }
    return set;
  }

  /** Threat-scan (AD-036): flag/sanitize/block на контенте lazy-инструкций. */
  private _scan(
    content: string,
    args: LazyResolveArgs,
  ): { content: string; suspicious: boolean; blocked: boolean; matches: string[]; scanned: boolean; warnLine: string } {
    const injection = args.injection;
    if (!injection?.enabled || !this._deps.dictionaryStore) {
      return { content, suspicious: false, blocked: false, matches: [], scanned: false, warnLine: '' };
    }
    const detection = detectPromptInjection(content, this._deps.dictionaryStore, args.language || 'ru');
    if (!detection.suspicious) {
      return { content, suspicious: false, blocked: false, matches: [], scanned: true, warnLine: '' };
    }
    const applied = applyPolicy(content, injection.mode, detection);
    if (applied.blocked) {
      return { content, suspicious: true, blocked: true, matches: applied.detail, scanned: true, warnLine: '' };
    }
    const warnLine = injection.mode === 'flag' ? buildWarnLine(applied.detail) : '';
    return {
      content: applied.content,
      suspicious: true,
      blocked: false,
      matches: applied.detail,
      scanned: true,
      warnLine,
    };
  }
}
