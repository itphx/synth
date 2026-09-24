/**
 * AD-069 Фаза 1: резолвер проектных инструкций (`AGENTS.md` и совместимые).
 *
 * Собирает **merged chain** `git root → … → workspace` (глубже = позже =
 * приоритетнее), на каждый каталог ровно один кандидат
 * (`AGENTS.override.md` > `AGENTS.md` > `agents.md` > `CLAUDE.md` (opt-in) >
 * `CONTEXT.md` (deprecated, opt-in)), дедуп по sha256 контента, threat-scan
 * (AD-036), обрезку head/tail с маркером и общий кап на цепочку.
 *
 * Фаза 1: только merged chain. Дополнительные `config.sources`/trust/
 * install-tree/lazy — Фаза 2 (схема уже заведена в shared config).
 * Глобальные файлы (`~/.config`, `~/.claude`) намеренно не читаются.
 */

import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { InstructionsConfig } from '@itphx/synth-shared';
import { runGit } from '../tools/git.js';
import {
  applyPolicy,
  buildWarnLine,
  detectPromptInjection,
  type InjectionPolicy,
} from '../security/prompt-injection.js';
import type { DictionaryStore } from '../router/dictionary-store.js';

/** Fallback-окно модели, если оно неизвестно (AD-069 §5.1: разумный дефолт). */
export const DEFAULT_INSTRUCTIONS_CONTEXT_WINDOW = 128_000;

/** Обёртка блока проектных инструкций в system prompt. */
export const INSTRUCTIONS_BLOCK_START = '[PROJECT INSTRUCTIONS]';
export const INSTRUCTIONS_BLOCK_END = '[END PROJECT INSTRUCTIONS]';

/** Кандидаты основного семейства, по приоритету на каталог. */
const PRIMARY_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'agents.md'] as const;

export type InstructionsDiagnosticStatus =
  | 'loaded'
  | 'truncated'
  | 'blocked'
  | 'dedup'
  | 'skipped';

export interface InstructionsFileInfo {
  /** Путь, относительный к workspace (`./AGENTS.md`, `../AGENTS.md`). */
  path: string;
  /** Длина фактически загруженного контента (после обрезки/санитайза). */
  chars: number;
  truncated: boolean;
  blocked: boolean;
  scanned: boolean;
}

export interface InstructionsDiagnostic {
  path?: string;
  status: InstructionsDiagnosticStatus;
  reason?: string;
  /** Совпадения threat-scan (до 5). */
  matches?: string[];
}

export interface ProjectInstructionsResult {
  /** Готовый блок `[PROJECT INSTRUCTIONS] … [END PROJECT INSTRUCTIONS]` ('' — не грузилось). */
  content: string;
  files: InstructionsFileInfo[];
  diagnostics: InstructionsDiagnostic[];
}

export interface ProjectInstructionsResolveArgs {
  /** Абсолютный рабочий каталог (уже резолвнутый `project.workspace`). */
  workspace: string;
  /** Окно модели; неизвестно/0 → `DEFAULT_INSTRUCTIONS_CONTEXT_WINDOW`. */
  contextWindow?: number;
  language?: string;
  /** projectId — для `excludeProjects`. */
  projectId?: string;
  signal?: AbortSignal;
  /** Политика threat-scan (как у tool-контента, AD-036). */
  injection?: { enabled: boolean; mode: InjectionPolicy };
}

export interface ProjectInstructionsDeps {
  config: InstructionsConfig;
  dictionaryStore?: DictionaryStore | null;
  /** Подменяемый git-раннер (тесты). */
  runGitFn?: (args: string[], cwd: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
}

interface ChainEntry {
  fileName: string;
  absPath: string;
  displayPath: string;
  content: string;
  scanned: boolean;
}

interface ScannedEntry extends ChainEntry {
  suspicious: boolean;
  warnLine: string;
}

/** sha256 в hex (дедуп контента). */
function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `true`, если файл существует (обычный файл). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Динамический кап на merged-цепочку (AD-069 §5.1):
 * `maxChars` override либо `clamp(windowRatio * window, minChars, maxCharsCeiling)`.
 */
export function resolveInstructionsCap(config: InstructionsConfig, contextWindow?: number): number {
  if (typeof config.maxChars === 'number' && config.maxChars > 0) return config.maxChars;
  const window =
    typeof contextWindow === 'number' && contextWindow > 0
      ? contextWindow
      : DEFAULT_INSTRUCTIONS_CONTEXT_WINDOW;
  const byWindow = Math.round(config.windowRatio * window);
  return Math.min(Math.max(byWindow, config.minChars), config.maxCharsCeiling);
}

/**
 * Water-filling распределение общего бюджета между файлами: файлы, которые
 * целиком влезают в честную долю, не обрезаются, их остаток перераспределяется
 * на крупные. Гарантирует `sum(alloc) <= budget`.
 */
export function waterFillAllocate(sizes: number[], budget: number): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budget) return [...sizes];

  const fixed = new Array<boolean>(n).fill(false);
  let changed = true;
  while (changed) {
    changed = false;
    let fixedSum = 0;
    let open = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) fixedSum += sizes[i]!;
      else open += 1;
    }
    const share = open > 0 ? Math.max(0, (budget - fixedSum) / open) : 0;
    for (let i = 0; i < n; i++) {
      if (!fixed[i] && sizes[i]! <= share) {
        fixed[i] = true;
        changed = true;
      }
    }
  }

  let fixedSum = 0;
  let open = 0;
  for (let i = 0; i < n; i++) {
    if (fixed[i]) fixedSum += sizes[i]!;
    else open += 1;
  }
  const share = open > 0 ? Math.max(0, (budget - fixedSum) / open) : 0;

  return sizes.map((size, i) =>
    fixed[i] ? size! : Math.max(0, Math.min(size!, Math.floor(share))),
  );
}

/** Число строк (по `\n`; минимум 1 для непустой строки). */
function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

/** Маркер обрезки с точным путём/offset/limit для `read_file` (AD-069 §5.1). */
export function buildTruncationMarker(displayPath: string, offset: number, limit: number): string {
  return `\n\n[TRUNCATED: see ${displayPath} — read_file(path: "${displayPath}", offset: ${offset}, limit: ${limit})]\n\n`;
}

/**
 * Обрезка head/tail: оставляем ~`headRatio` головы и ~`tailRatio` хвоста,
 * середину заменяем маркером. Итог не длиннее `budget`.
 */
export function truncateHeadTail(
  content: string,
  budget: number,
  headRatio: number,
  tailRatio: number,
  displayPath: string,
): { content: string; truncated: boolean } {
  if (budget <= 0) return { content: '', truncated: content.length > 0 };
  if (content.length <= budget) return { content, truncated: false };

  const totalLines = countLines(content);
  let headLen = Math.max(0, Math.floor(budget * headRatio));
  const tailLen = Math.max(0, Math.floor(budget * tailRatio));
  // Если ratio не заданы/нулевые — весь бюджет в голову.
  if (headLen + tailLen === 0) headLen = budget;

  let head = content.slice(0, headLen);
  let tail = tailLen > 0 ? content.slice(content.length - tailLen) : '';

  let headLines = countLines(head);
  let droppedLines = Math.max(1, totalLines - headLines - countLines(tail));
  let marker = buildTruncationMarker(displayPath, headLines, droppedLines);

  let over = head.length + marker.length + tail.length - budget;
  if (over > 0) {
    head = head.slice(0, Math.max(0, head.length - over));
    headLines = countLines(head);
    droppedLines = Math.max(1, totalLines - headLines - countLines(tail));
    marker = buildTruncationMarker(displayPath, headLines, droppedLines);
    over = head.length + marker.length + tail.length - budget;
    if (over > 0) {
      tail = tail.slice(0, Math.max(0, tail.length - over));
    }
  }

  return { content: `${head}${marker}${tail}`, truncated: true };
}

/** Provenance-заголовок блока файла (AD-069 §3.3). */
export function buildProvenanceHeader(displayPath: string, chars: number, truncated: boolean): string {
  return `--- from ${displayPath} (${chars} chars${truncated ? ', truncated' : ''}) ---`;
}

/** Путь файла относительно workspace, с префиксом `./` для локальных. */
function displayPathFor(workspace: string, absPath: string): string {
  const rel = relative(workspace, absPath);
  if (!rel) return './';
  return rel.startsWith('..') || isAbsolute(rel) ? rel : `./${rel}`;
}

/**
 * Резолвер проектных инструкций. Stateless; состояние prompt-cache/generation
 * живёт в оркестраторе (AD-070 §2.4).
 */
export class ProjectInstructionsResolver {
  private readonly _config: InstructionsConfig;
  private readonly _dictionaryStore: DictionaryStore | null;
  private readonly _runGit: NonNullable<ProjectInstructionsDeps['runGitFn']>;

  constructor(deps: ProjectInstructionsDeps) {
    this._config = deps.config;
    this._dictionaryStore = deps.dictionaryStore ?? null;
    this._runGit = deps.runGitFn ?? runGit;
  }

  /** Резолвит merged chain и собирает блок system prompt (Фаза 1). */
  async resolve(args: ProjectInstructionsResolveArgs): Promise<ProjectInstructionsResult> {
    const config = this._config;
    if (!config.enabled) {
      return this._empty({ status: 'skipped', reason: 'disabled' });
    }
    if (args.projectId && config.excludeProjects.includes(args.projectId)) {
      return this._empty({ status: 'skipped', reason: 'excludeProjects' });
    }

    const workspace = normalize(args.workspace);
    if (!workspace) return this._empty();

    const chain = await this._buildChain(workspace, args.signal);
    const diagnostics: InstructionsDiagnostic[] = [];
    const files: InstructionsFileInfo[] = [];

    // 1. Сбор кандидатов и чтение (одного на каталог).
    const read = await this._collectChain(chain, workspace);
    diagnostics.push(...read.diagnostics);

    // 2. Дедуп + threat-scan.
    const seen = new Set<string>();
    const scanned: ScannedEntry[] = [];
    for (const entry of read.entries) {
      const hash = hashContent(entry.content);
      if (seen.has(hash)) {
        diagnostics.push({ path: entry.displayPath, status: 'dedup' });
        continue;
      }
      seen.add(hash);

      const scan = this._scan(entry, args);
      if (scan.blocked) {
        diagnostics.push({ path: entry.displayPath, status: 'blocked', reason: 'injection', matches: scan.matches });
        files.push({ path: entry.displayPath, chars: 0, truncated: false, blocked: true, scanned: scan.scanned });
        continue;
      }
      scanned.push({
        ...entry,
        content: scan.content,
        scanned: scan.scanned,
        suspicious: scan.suspicious,
        warnLine: scan.warnLine,
      });
    }

    if (scanned.length === 0) {
      return { content: '', files, diagnostics };
    }

    // 3. Общий кап на merged-цепочку: head/tail-обрезка с water-filling.
    const cap = resolveInstructionsCap(config, args.contextWindow);
    const wrapperOverhead = INSTRUCTIONS_BLOCK_START.length + INSTRUCTIONS_BLOCK_END.length + 8;
    const headerReserve =
      scanned.reduce((sum, entry) => sum + entry.displayPath.length + 48, 0) + scanned.length * 3;
    const contentBudget = Math.max(0, cap - wrapperOverhead - headerReserve);
    const allocations = waterFillAllocate(
      scanned.map((entry) => entry.content.length),
      contentBudget,
    );

    const blocks: string[] = [];
    for (let i = 0; i < scanned.length; i++) {
      const entry = scanned[i]!;
      const budget = allocations[i]!;
      const truncatedResult = truncateHeadTail(
        entry.content,
        budget,
        config.headRatio,
        config.tailRatio,
        entry.displayPath,
      );
      const finalContent = truncatedResult.truncated
        ? truncatedResult.content
        : entry.content;
      const header = buildProvenanceHeader(entry.displayPath, finalContent.length, truncatedResult.truncated);
      const warn = entry.warnLine ? `${entry.warnLine}\n` : '';
      blocks.push(`${header}\n${warn}${finalContent}`);
      files.push({
        path: entry.displayPath,
        chars: finalContent.length,
        truncated: truncatedResult.truncated,
        blocked: false,
        scanned: entry.scanned,
      });
      diagnostics.push({
        path: entry.displayPath,
        status: truncatedResult.truncated ? 'truncated' : 'loaded',
        ...(entry.suspicious ? { reason: 'injection-flagged' } : {}),
      });
    }

    let content = [INSTRUCTIONS_BLOCK_START, ...blocks, INSTRUCTIONS_BLOCK_END].join('\n');
    // Жёсткая страховка: assembled не должен превышать кап.
    if (content.length > cap && cap > INSTRUCTIONS_BLOCK_START.length + INSTRUCTIONS_BLOCK_END.length + 2) {
      content = `${content.slice(0, cap - INSTRUCTIONS_BLOCK_END.length - 1)}\n${INSTRUCTIONS_BLOCK_END}`;
    }

    return { content, files, diagnostics };
  }

  /** `[git root, …, workspace]`; без git/вне корня — только workspace. */
  private async _buildChain(workspace: string, signal?: AbortSignal): Promise<string[]> {
    let gitRoot = workspace;
    try {
      const { stdout } = await this._runGit(['rev-parse', '--show-toplevel'], workspace, signal);
      const root = stdout.trim();
      if (root) gitRoot = normalize(isAbsolute(root) ? root : resolve(workspace, root));
    } catch {
      // не git-репозиторий — только сам workspace
    }

    const rel = relative(gitRoot, workspace);
    if (rel && (rel.startsWith('..') || isAbsolute(rel))) return [workspace];

    const dirs: string[] = [];
    let current = workspace;
    // Предохранитель от зацикливания/бесконечного подъёма.
    for (let guard = 0; guard < 1024; guard++) {
      dirs.push(current);
      if (current === gitRoot) break;
      const parent = dirname(current);
      if (parent === current) break;
      const parentRel = relative(gitRoot, parent);
      if (parentRel.startsWith('..') || isAbsolute(parentRel)) break;
      current = parent;
    }
    return dirs.reverse();
  }

  /** По каждому каталогу цепочки выбирает ровно одного кандидата и читает его. */
  private async _collectChain(
    chain: string[],
    workspace: string,
  ): Promise<{ entries: ChainEntry[]; diagnostics: InstructionsDiagnostic[] }> {
    const entries: ChainEntry[] = [];
    const diagnostics: InstructionsDiagnostic[] = [];

    for (const dir of chain) {
      const selected = await this._selectCandidate(dir);
      if (!selected) continue;

      const absPath = join(dir, selected.fileName);
      const displayPath = displayPathFor(workspace, absPath);

      try {
        const content = await readFile(absPath, 'utf-8');
        if (!content.trim()) {
          diagnostics.push({ path: displayPath, status: 'skipped', reason: 'empty' });
          continue;
        }
        entries.push({
          fileName: selected.fileName,
          absPath,
          displayPath,
          content,
          scanned: false,
        });
        if (selected.compat === 'context') {
          diagnostics.push({ path: displayPath, status: 'loaded', reason: 'deprecated-context-md' });
        }
      } catch {
        diagnostics.push({ path: displayPath, status: 'skipped', reason: 'read-error' });
      }
    }

    return { entries, diagnostics };
  }

  /** Приоритет на каталог: override > AGENTS.md > agents.md > CLAUDE.md > CONTEXT.md. */
  private async _selectCandidate(
    dir: string,
  ): Promise<{ fileName: string; main: boolean; compat?: 'claude' | 'context' } | null> {
    for (const name of PRIMARY_CANDIDATES) {
      if (await fileExists(join(dir, name))) {
        return { fileName: name, main: true };
      }
    }
    if (this._config.claudeCompat && (await fileExists(join(dir, 'CLAUDE.md')))) {
      return { fileName: 'CLAUDE.md', main: false, compat: 'claude' };
    }
    if (this._config.contextCompat && (await fileExists(join(dir, 'CONTEXT.md')))) {
      return { fileName: 'CONTEXT.md', main: false, compat: 'context' };
    }
    return null;
  }

  /** Threat-scan (AD-036): flag/sanitize/block на контенте инструкций. */
  private _scan(
    entry: ChainEntry,
    args: ProjectInstructionsResolveArgs,
  ): { content: string; suspicious: boolean; blocked: boolean; matches: string[]; scanned: boolean; warnLine: string } {
    const injection = args.injection;
    if (!injection?.enabled || !this._dictionaryStore) {
      return { content: entry.content, suspicious: false, blocked: false, matches: [], scanned: false, warnLine: '' };
    }
    const detection = detectPromptInjection(
      entry.content,
      this._dictionaryStore,
      args.language || 'ru',
    );
    if (!detection.suspicious) {
      return { content: entry.content, suspicious: false, blocked: false, matches: [], scanned: true, warnLine: '' };
    }
    const applied = applyPolicy(entry.content, injection.mode, detection);
    if (applied.blocked) {
      return { content: entry.content, suspicious: true, blocked: true, matches: applied.detail, scanned: true, warnLine: '' };
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

  private _empty(diagnostic?: InstructionsDiagnostic): ProjectInstructionsResult {
    return {
      content: '',
      files: [],
      diagnostics: diagnostic ? [diagnostic] : [],
    };
  }
}
