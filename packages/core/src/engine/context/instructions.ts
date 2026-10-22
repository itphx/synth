/**
 * ADR-069: резолвер проектных инструкций (`AGENTS.md` и совместимые).
 *
 * Фаза 1: merged chain `git root → … → workspace` (глубже = позже =
 * приоритетнее), на каждый каталог ровно один кандидат
 * (`AGENTS.override.md` > `AGENTS.md` > `agents.md` > `CLAUDE.md` (opt-in) >
 * `CONTEXT.md` (deprecated, opt-in)), дедуп по sha256 контента, threat-scan
 * (ADR-036), обрезку head/tail с маркером и общий кап на цепочку.
 *
 * Фаза 2a: дополнительные `config.instructions.sources` (`before` → chain →
 * `after`), URL-fetch с TTL-кэшем `{dataDir}/instructions-cache/<sha1(url)>`
 * (атомарная запись tmp→rename, ADR-005), project-trust гейт (`skills.trustedProjectDirs`)
 * с авто-trust для workspace внутри `workspacesRoot` (R1/R3), install-tree guard
 * и `excludeProjects`.
 *
 * Глобальные файлы (`~/.config`, `~/.claude`) намеренно не читаются.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { atomicWrite, globMatch, type InstructionSourceConfig, type InstructionsConfig } from '@itphx/synth-shared';
import { dirsSignature, filesSignature, type FileSignatureEntry } from '../file-signature.js';
import { runGit } from '../tools/git.js';
import {
  applyPolicy,
  buildWarnLine,
  detectPromptInjection,
  type InjectionPolicy,
} from '../security/prompt-injection.js';
import { expandHome, isProjectTrusted } from '../skills/trust.js';
import { fetchText, validateRemoteUrl, type FetchLike } from '../net/fetch.js';
import { resolveToolsEgressPolicy } from '../net/egress-runtime.js';
import { egressFetch } from '../../security/tls.js';
import type { HostResolver } from '../mcp/network-policy.js';
import type { DictionaryRepository } from '../../storage/ports/dictionary-repository.js';
import type { ExecutionPort } from '../../execution/ports/index.js';

/** Fallback-окно модели, если оно неизвестно (ADR-069 §5.1: разумный дефолт). */
export const DEFAULT_INSTRUCTIONS_CONTEXT_WINDOW = 128_000;

/** Обёртка блока проектных инструкций в system prompt. */
export const INSTRUCTIONS_BLOCK_START = '[PROJECT INSTRUCTIONS]';
export const INSTRUCTIONS_BLOCK_END = '[END PROJECT INSTRUCTIONS]';

/** Максимум редиректов при загрузке URL-источника. */
export const INSTRUCTIONS_MAX_REDIRECTS = 5;

/** Максимум обхода дерева при glob-резолве (защита от гигантских репозиториев). */
const GLOB_MAX_DEPTH = 12;
const GLOB_MAX_ENTRIES = 20_000;

/** Кандидаты основного семейства, по приоритету на каталог. */
const PRIMARY_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'agents.md'] as const;

export type InstructionsDiagnosticStatus =
  | 'loaded'
  | 'truncated'
  | 'blocked'
  | 'dedup'
  | 'skipped'
  | 'untrusted'
  | 'skipped-install-tree'
  | 'excluded'
  | 'fetch-error';

/** Источник кандидата: merged chain, `config.sources` path или URL. */
export type InstructionsSourceKind = 'chain' | 'path' | 'url';

export interface InstructionsFileInfo {
  /** Путь, относительный к workspace (`./AGENTS.md`, `../AGENTS.md`) или URL. */
  path: string;
  /** Длина фактически загруженного контента (после обрезки/санитайза). */
  chars: number;
  truncated: boolean;
  blocked: boolean;
  scanned: boolean;
  /** ADR-069 Фаза 2a: откуда пришёл файл. */
  kind: InstructionsSourceKind;
  label?: string;
  url?: string;
}

export interface InstructionsDiagnostic {
  path?: string;
  status: InstructionsDiagnosticStatus;
  reason?: string;
  kind?: InstructionsSourceKind;
  label?: string;
  url?: string;
  /** Совпадения threat-scan (до 5). */
  matches?: string[];
}

export interface ProjectInstructionsResult {
  /** Готовый блок `[PROJECT INSTRUCTIONS] … [END PROJECT INSTRUCTIONS]` ('' — не грузилось). */
  content: string;
  files: InstructionsFileInfo[];
  diagnostics: InstructionsDiagnostic[];
}

/** ADR-069 §9.3: уровень диагностики прозрачности (аналогично `SkillDiagnostic`). */
export type InstructionsReportLevel = 'info' | 'warning' | 'error';

/** Файл инструкций в снимке прозрачности: резолвер-поля + сводный статус/scan. */
export interface InstructionsReportFile {
  path: string;
  kind: InstructionsSourceKind;
  label?: string;
  url?: string;
  chars: number;
  truncated: boolean;
  status: InstructionsDiagnosticStatus;
  scan?: {
    scanned: boolean;
    blocked: boolean;
    suspicious: boolean;
    matches: string[];
  };
}

/** Диагностика прозрачности: `level`/`code`/`message` + путь/источник. */
export interface InstructionsReportDiagnostic {
  level: InstructionsReportLevel;
  code: string;
  message: string;
  path?: string;
  kind?: InstructionsSourceKind;
}

/** Снимок проектных инструкций для `GET /api/v2/context/instructions` (ADR-069 §9.3). */
export interface InstructionsInfo {
  enabled: boolean;
  cap: { chars: number; source: 'dynamic' | 'override'; contextWindow: number };
  files: InstructionsReportFile[];
  diagnostics: InstructionsReportDiagnostic[];
}

/** Метаданные запроса снимка (окно модели и projectId для `excludeProjects`). */
export interface InstructionsInfoQuery {
  /** Абсолютный workspace; не задан — проектные инструкции недоступны (ADR-040). */
  workspace?: string;
  contextWindow?: number;
  language?: string;
  projectId?: string;
  signal?: AbortSignal;
  injection?: { enabled: boolean; mode: InjectionPolicy };
}

/** Резолвер снимка прозрачности: `ProjectInstructionsResolver` + маппинг в API-форму. */
export type InstructionsInfoResolver = (query: InstructionsInfoQuery) => Promise<InstructionsInfo>;

export interface ProjectInstructionsResolveArgs {
  /** Абсолютный рабочий каталог (уже резолвнутый `project.workspace`). */
  workspace: string;
  /** Окно модели; неизвестно/0 → `DEFAULT_INSTRUCTIONS_CONTEXT_WINDOW`. */
  contextWindow?: number;
  language?: string;
  /** projectId — для `excludeProjects`. */
  projectId?: string;
  signal?: AbortSignal;
  /** Политика threat-scan (как у tool-контента, ADR-036). */
  injection?: { enabled: boolean; mode: InjectionPolicy };
}

export interface ProjectInstructionsDeps {
  config: InstructionsConfig;
  dictionaryStore?: DictionaryRepository | null;
  /** Подменяемый git-раннер (тесты). */
  runGitFn?: (args: string[], cwd: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
  /**
   * ADR-077: порт исполнения для `git rev-parse --show-toplevel` (поиск корня
   * репозитория для merged chain). Не задан — inline-исполнение в процессе
   * (прежнее поведение); задан — вызов уходит в исполнителя (split-режим).
   */
  execution?: ExecutionPort;
  /** ADR-069 §3.5: `config.skills.trustedProjectDirs` — project-trust гейт. */
  trustedProjectDirs?: readonly string[];
  /** ADR-069 R3: `storage.workspacesRoot` — авто-trust workspace внутри него. */
  workspacesRoot?: string;
  /** Корень данных для URL-кэша `{dataDir}/instructions-cache`. */
  dataDir?: string;
  /** Подменяемый fetch (тесты). */
  fetchImpl?: FetchLike;
  /** Инъекция DNS-резолвера SSRF-проверки URL-источников (тесты). */
  resolveHost?: HostResolver;
  /** Домашний каталог (тесты/раскрытие `~`). */
  home?: string;
  /** Часы (тесты TTL). */
  nowFn?: () => number;
}

interface Candidate {
  kind: InstructionsSourceKind;
  /** Provenance-заголовок: относительный путь (chain/path) либо URL без query (url). */
  displayPath: string;
  label?: string;
  url?: string;
  content: string;
  scanned: boolean;
  /** Относится ли кандидат к проектному каталогу (под trust/install-tree гейтами). */
  projectBound: boolean;
}

interface ScannedEntry extends Candidate {
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
 * Выбирает ровно одного кандидата на каталог по приоритету
 * (`AGENTS.override.md` > `AGENTS.md` > `agents.md`; `CLAUDE.md` — opt-in
 * fallback; `CONTEXT.md` — deprecated opt-in). Общий для merged chain и
 * lazy-догрузки подкаталогов (ADR-069 §3.1/§4.3).
 */
export async function selectInstructionFile(
  dir: string,
  claudeCompat: boolean,
  contextCompat: boolean,
): Promise<{ fileName: string; main: boolean; compat?: 'claude' | 'context' } | null> {
  for (const name of PRIMARY_CANDIDATES) {
    if (await fileExists(join(dir, name))) {
      return { fileName: name, main: true };
    }
  }
  if (claudeCompat && (await fileExists(join(dir, 'CLAUDE.md')))) {
    return { fileName: 'CLAUDE.md', main: false, compat: 'claude' };
  }
  if (contextCompat && (await fileExists(join(dir, 'CONTEXT.md')))) {
    return { fileName: 'CONTEXT.md', main: false, compat: 'context' };
  }
  return null;
}

/** `true`, если `child` лежит внутри `parent` (или равен ему). */
export function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Контекст trust-гейта проектных инструкций (ADR-069 §3.5/R1/R3). */
export interface InstructionsTrustOptions {
  /** ADR-046 project-trust: явный список доверенных проектных каталогов. */
  trustedProjectDirs?: readonly string[];
  /** ADR-069 R3: workspace внутри `workspacesRoot` доверяется автоматически. */
  workspacesRoot?: string;
  /** Домашний каталог для раскрытия `~` в `trustedProjectDirs`. */
  home?: string;
}

/**
 * ADR-069 §3.5/R1/R3: единый trust-гейт проектных инструкций — общий для
 * merged-chain (`ProjectInstructionsResolver`) и lazy-догрузки
 * (`LazyInstructionsLoader`).
 *
 * Доверено, если каталог явно в `trustedProjectDirs` (project-trust ADR-046)
 * ИЛИ лежит внутри `workspacesRoot` (рабочие каталоги Synth получают
 * авто-trust — инструкции там не несут риска чужого клона).
 *
 * На project-trust скиллов (`isProjectTrusted`) не влияет.
 */
export function resolveInstructionsTrusted(
  workspace: string,
  opts: InstructionsTrustOptions,
): boolean {
  if (isProjectTrusted(workspace, opts.trustedProjectDirs ?? [], opts.home)) return true;
  const root = opts.workspacesRoot?.trim();
  if (root && isInsideDir(root, workspace)) return true;
  return false;
}

/** `true`, если в строке есть glob-метасимволы. */
function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

/**
 * Первое совпадение пути/glob. База — workspace / home / корень ФС; для glob
 * обход начинается от литерального префикса и идёт детерминированно (сортировка).
 */
async function findFirstMatch(
  base: string,
  pattern: string,
  skipDirs: readonly string[],
): Promise<string | null> {
  if (!hasGlob(pattern)) {
    const abs = isAbsolute(pattern) ? normalize(pattern) : resolve(base, pattern);
    return (await fileExists(abs)) ? abs : null;
  }

  const isAbsolutePattern = isAbsolute(pattern);
  const literal: string[] = [];
  for (const seg of pattern.split(/[\\/]+/)) {
    if (!seg) continue;
    if (hasGlob(seg)) break;
    literal.push(seg);
  }
  const walkRoot = isAbsolutePattern ? resolve('/', ...literal) : resolve(base, ...literal);

  const files = await walkFiles(walkRoot, skipDirs);
  for (const file of files) {
    const value = isAbsolutePattern ? file : relative(base, file);
    if (globMatch(pattern, value)) return file;
  }
  return null;
}

/** Детерминированный (сортированный) обход файлов с лимитами. */
async function walkFiles(root: string, skipDirs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  let visited = 0;

  async function rec(dir: string, depth: number): Promise<void> {
    if (depth > GLOB_MAX_DEPTH || visited > GLOB_MAX_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > GLOB_MAX_ENTRIES) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        await rec(abs, depth + 1);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }

  await rec(root, 0);
  return out;
}

/**
 * Динамический кап на merged-цепочку (ADR-069 §5.1):
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

/** Маркер обрезки с точным путём/offset/limit для `read_file` (ADR-069 §5.1). */
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

/**
 * Provenance-заголовок блока (ADR-069 §3.3/§3.4).
 * `label` добавляет читаемое имя: `--- from <label> (<path|url>) … ---`.
 */
export function buildProvenanceHeader(
  displayPath: string,
  chars: number,
  truncated: boolean,
  label?: string,
): string {
  const ref = label ? `${label} (${displayPath})` : displayPath;
  return `--- from ${ref} (${chars} chars${truncated ? ', truncated' : ''}) ---`;
}

/** Путь файла относительно workspace, с префиксом `./` для локальных. */
export function displayPathFor(workspace: string, absPath: string): string {
  const rel = relative(workspace, absPath);
  if (!rel) return './';
  return rel.startsWith('..') || isAbsolute(rel) ? rel : `./${rel}`;
}

/**
 * Provenance-путь для `config.sources` path: внутри workspace — относительный,
 * под home — `~/…`, иначе — абсолютный. Домашний путь не утекает целиком.
 */
function displayPathForSource(workspace: string, absPath: string, home: string): string {
  if (isInsideDir(workspace, absPath)) return displayPathFor(workspace, absPath);
  const relHome = relative(home, absPath);
  if (relHome && !relHome.startsWith('..') && !isAbsolute(relHome)) return `~/${relHome}`;
  return absPath;
}

/** URL для provenance без query/hash (query может содержать секреты). */
export function sanitizeUrlForDisplay(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw;
  }
}

interface GuardContext {
  trusted: boolean;
  installTree: boolean;
  allowInstallTree: boolean;
}

interface CacheEntry {
  fetchedAt: number;
  content: string;
}

/**
 * Резолвер проектных инструкций. Stateless; состояние prompt-cache/generation
 * живёт в оркестраторе (ADR-070 §2.4).
 */
export class ProjectInstructionsResolver {
  private readonly _config: InstructionsConfig;
  private readonly _dictionaryStore: DictionaryRepository | null;
  private readonly _runGit: NonNullable<ProjectInstructionsDeps['runGitFn']>;
  private readonly _trustedProjectDirs: readonly string[];
  private readonly _workspacesRoot: string;
  private readonly _dataDir: string | null;
  private readonly _fetchImpl: FetchLike;
  private readonly _resolveHost: HostResolver | undefined;
  private readonly _home: string;
  private readonly _now: () => number;
  /**
   * ADR-069 §3.5/R5: результатный кэш по подписи кандидатов (mtime:size).
   * Ключ — все входы, влияющие на результат; значение — объект результата
   * (read-only на стороне вызовов).
   */
  private readonly _resultCache = new Map<string, { signature: string; result: ProjectInstructionsResult }>();
  /** Ограничение размера кэша (простая FIFO-эвикция). */
  private static readonly MAX_RESULT_CACHE = 64;

  constructor(deps: ProjectInstructionsDeps) {
    this._config = deps.config;
    this._dictionaryStore = deps.dictionaryStore ?? null;
    // ADR-077: git-исполнение — через порт (`deps.execution`), иначе inline.
    this._runGit =
      deps.runGitFn ?? ((args, cwd, signal) => runGit(args, cwd, signal, undefined, deps.execution));
    this._trustedProjectDirs = deps.trustedProjectDirs ?? [];
    this._workspacesRoot = deps.workspacesRoot ?? '';
    this._dataDir = deps.dataDir ?? null;
    // ADR-099: транспорт URL-источников по умолчанию — `egressFetch` (единое доверие TLS/CA).
    this._fetchImpl = deps.fetchImpl ?? egressFetch;
    this._resolveHost = deps.resolveHost;
    this._home = deps.home ?? expandHome('~');
    this._now = deps.nowFn ?? (() => Date.now());
  }

  /** Резолвит merged chain + `config.sources` и собирает блок system prompt. */
  async resolve(args: ProjectInstructionsResolveArgs): Promise<ProjectInstructionsResult> {
    const config = this._config;
    if (!config.enabled) {
      return this._empty({ status: 'skipped', reason: 'disabled' });
    }

    const workspace = normalize(args.workspace);
    if (!workspace) return this._empty();

    if (this._isExcluded(workspace, args.projectId)) {
      return this._empty({ status: 'excluded', reason: 'excludeProjects', path: workspace });
    }

    // ADR-069 §3.5/R5: дешёвая подпись кандидатов (stat без readFile/scan) и
    // результатный кэш — повторный resolve с той же подписью не перечитывает
    // диск. Кэшируются в т.ч. пустые/untrusted-результаты.
    const { signature, cacheable, chain } = await this._signature(workspace, args);
    const key = this._resultKey(workspace, args);
    if (cacheable) {
      const cached = this._resultCache.get(key);
      if (cached && cached.signature === signature) return cached.result;
    }

    const result = await this._resolveUncached(workspace, args, chain);
    if (cacheable) this._storeResult(key, signature, result);
    return result;
  }

  /**
   * Полный резолв без результатного кэша: guard → chain/sources → дедуп/scan →
   * сборка блока. `chain` — прекомпьют из `_signature` (без повторного git).
   */
  private async _resolveUncached(
    workspace: string,
    args: ProjectInstructionsResolveArgs,
    chain: string[],
  ): Promise<ProjectInstructionsResult> {
    const config = this._config;
    const guard: GuardContext = {
      trusted: resolveInstructionsTrusted(workspace, {
        trustedProjectDirs: this._trustedProjectDirs,
        workspacesRoot: this._workspacesRoot,
        home: this._home,
      }),
      installTree: await this._isInstallTree(workspace),
      allowInstallTree: config.allowInstallTreeFallback,
    };

    const before = config.sources.filter((source) => source.position === 'before');
    const after = config.sources.filter((source) => source.position !== 'before');

    const diagnostics: InstructionsDiagnostic[] = [];
    const files: InstructionsFileInfo[] = [];

    const beforeRes = await this._collectSources(before, workspace, guard);
    const chainRes = await this._collectChain(chain, workspace, guard);
    const afterRes = await this._collectSources(after, workspace, guard);
    diagnostics.push(
      ...beforeRes.diagnostics,
      ...chainRes.diagnostics,
      ...afterRes.diagnostics,
    );
    const ordered = [...beforeRes.candidates, ...chainRes.candidates, ...afterRes.candidates];

    // Дедуп + threat-scan.
    const seen = new Set<string>();
    const scanned: ScannedEntry[] = [];
    for (const entry of ordered) {
      const hash = hashContent(entry.content);
      if (seen.has(hash)) {
        diagnostics.push({ ...this._ref(entry), status: 'dedup' });
        continue;
      }
      seen.add(hash);

      const scan = this._scan(entry, args);
      if (scan.blocked) {
        diagnostics.push({
          ...this._ref(entry),
          status: 'blocked',
          reason: 'injection',
          matches: scan.matches,
        });
        files.push({
          path: entry.displayPath,
          chars: 0,
          truncated: false,
          blocked: true,
          scanned: scan.scanned,
          kind: entry.kind,
          ...(entry.label ? { label: entry.label } : {}),
          ...(entry.url ? { url: entry.url } : {}),
        });
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

    // Общий кап на merged-цепочку: head/tail-обрезка с water-filling.
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
      const header = buildProvenanceHeader(
        entry.displayPath,
        finalContent.length,
        truncatedResult.truncated,
        entry.label,
      );
      const warn = entry.warnLine ? `${entry.warnLine}\n` : '';
      blocks.push(`${header}\n${warn}${finalContent}`);
      files.push({
        path: entry.displayPath,
        chars: finalContent.length,
        truncated: truncatedResult.truncated,
        blocked: false,
        scanned: entry.scanned,
        kind: entry.kind,
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.url ? { url: entry.url } : {}),
      });
      diagnostics.push({
        ...this._ref(entry),
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

  /** Cross-cutting поля диагностики/файла для кандидата. */
  private _ref(entry: Candidate): Pick<InstructionsDiagnostic, 'path' | 'kind' | 'label' | 'url'> {
    return {
      path: entry.displayPath,
      kind: entry.kind,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.url ? { url: entry.url } : {}),
    };
  }

  /**
   * ADR-069 §3.5/R5: подпись всех кандидатов (chain + `config.sources`) без
   * чтения контента — только `stat`/`access`. `cacheable=false`, если
   * URL-источник не представим стабильной подписью (нет `dataDir` или TTL=0):
   * тогда fetch идёт каждый resolve, как и раньше.
   */
  private async _signature(
    workspace: string,
    args: ProjectInstructionsResolveArgs,
  ): Promise<{ signature: string; cacheable: boolean; chain: string[] }> {
    const chain = await this._buildChain(workspace, args.signal);
    // Локальные кандидаты цепочки — тот же приоритет имён, что у `_selectCandidate`.
    const chainSignature = await dirsSignature(chain, this._candidateFileNames());

    const entries: FileSignatureEntry[] = [];
    const urlParts: string[] = [];
    let cacheable = true;
    let index = 0;
    for (const source of this._config.sources) {
      const value = source.value.trim();
      index += 1;
      if (!value) continue;
      if (source.kind === 'path') {
        entries.push({ id: `source-${index}`, path: await this._resolvePathValue(value, workspace) });
      } else {
        const part = await this._urlSignaturePart(value, source);
        urlParts.push(part.part);
        if (!part.cacheable) cacheable = false;
      }
    }

    const sourceSignature = await filesSignature(entries);
    urlParts.sort();
    const signature = [chainSignature, sourceSignature, urlParts.join('|')].join('||');
    return { signature, cacheable, chain };
  }

  /** Имена-кандидаты на каталог в порядке приоритета (с учётом opt-in compat). */
  private _candidateFileNames(): string[] {
    const names: string[] = [...PRIMARY_CANDIDATES];
    if (this._config.claudeCompat) names.push('CLAUDE.md');
    if (this._config.contextCompat) names.push('CONTEXT.md');
    return names;
  }

  /**
   * Подпись URL-источника (stat-only, без чтения кэш-JSON). В подпись входит
   * TTL-слот `floor(now/ttl)`: смена слота гарантированно наступает не позже
   * реального истечения TTL (`fetchedAt` пишется в том же слоте), поэтому
   * результатный кэш никогда не отдаёт просроченный контент. Внутри слота
   * учитываются mtime/size кэш-файла — внешняя правка инвалидирует результат.
   * `cacheable=false`, если `dataDir`/TTL нет: fetch идёт каждый resolve, как раньше.
   */
  private async _urlSignaturePart(
    url: string,
    source: InstructionSourceConfig,
  ): Promise<{ part: string; cacheable: boolean }> {
    const hash = createHash('sha1').update(url).digest('hex');
    const policy = await resolveToolsEgressPolicy();
    if ('error' in (await validateRemoteUrl(url, { resolveHost: this._resolveHost, policy }))) {
      return { part: `url:${hash}:invalid`, cacheable: true };
    }

    const cachePath = this._cachePath(url);
    const ttlMs = (source.ttlSec ?? this._config.fetch.cacheTtlSec) * 1000;
    if (!cachePath || ttlMs <= 0) {
      return { part: `url:${hash}:nocache`, cacheable: false };
    }

    const slot = Math.floor(this._now() / ttlMs);
    try {
      const info = await stat(cachePath);
      return {
        part: `url:${hash}:${slot}:${Math.floor(info.mtimeMs)}:${info.size}`,
        cacheable: true,
      };
    } catch {
      return { part: `url:${hash}:${slot}:miss`, cacheable: true };
    }
  }

  /** Ключ результатного кэша — все входы, влияющие на результат. */
  private _resultKey(workspace: string, args: ProjectInstructionsResolveArgs): string {
    const injection = args.injection;
    return JSON.stringify([
      workspace,
      args.contextWindow ?? 0,
      args.language ?? '',
      args.projectId ?? '',
      injection ? `${injection.enabled ? 1 : 0}:${injection.mode}` : 'off',
    ]);
  }

  /** Запись в результатный кэш с FIFO-эвикцией (≤ `MAX_RESULT_CACHE`). */
  private _storeResult(key: string, signature: string, result: ProjectInstructionsResult): void {
    if (
      this._resultCache.size >= ProjectInstructionsResolver.MAX_RESULT_CACHE &&
      !this._resultCache.has(key)
    ) {
      const oldest = this._resultCache.keys().next().value;
      if (oldest !== undefined) this._resultCache.delete(oldest);
    }
    this._resultCache.set(key, { signature, result });
  }

  /** Сброс результатного кэша (принудительный reload, ADR-069 §3.5/R5). */
  clear(): void {
    this._resultCache.clear();
  }

  /** `excludeProjects`: по projectId либо по пути workspace. */
  private _isExcluded(workspace: string, projectId?: string): boolean {
    const entries = this._config.excludeProjects;
    if (entries.length === 0) return false;
    const target = normalize(workspace);
    return entries.some((raw) => {
      const entry = raw.trim();
      if (!entry) return false;
      if (projectId && entry === projectId) return true;
      const expanded = expandHome(entry, this._home);
      const abs = isAbsolute(expanded) ? expanded : resolve(workspace, expanded);
      return normalize(abs) === target;
    });
  }

  /** Install-tree guard: workspace внутри дерева исходников Synth. */
  private async _isInstallTree(workspace: string): Promise<boolean> {
    let dir = resolve(workspace);
    for (let guard = 0; guard < 256; guard++) {
      try {
        const raw = await readFile(join(dir, 'package.json'), 'utf-8');
        if (/@itphx\/synth(?:-|")/.test(raw)) return true;
      } catch {
        // нет package.json / не читается — продолжаем подъём
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  }

  /** Гейты проектного кандидата: install-tree → trust. */
  private _guard(projectBound: boolean, guard: GuardContext): { status: InstructionsDiagnosticStatus; reason: string } | null {
    if (!projectBound) return null;
    if (guard.installTree && !guard.allowInstallTree) {
      return { status: 'skipped-install-tree', reason: 'install-tree' };
    }
    if (!guard.trusted) return { status: 'untrusted', reason: 'untrusted-project' };
    return null;
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
    guard: GuardContext,
  ): Promise<{ candidates: Candidate[]; diagnostics: InstructionsDiagnostic[] }> {
    const candidates: Candidate[] = [];
    const diagnostics: InstructionsDiagnostic[] = [];

    for (const dir of chain) {
      const selected = await this._selectCandidate(dir);
      if (!selected) continue;

      const absPath = join(dir, selected.fileName);
      const displayPath = displayPathFor(workspace, absPath);
      const blocked = this._guard(true, guard);
      if (blocked) {
        diagnostics.push({ path: displayPath, status: blocked.status, reason: blocked.reason, kind: 'chain' });
        continue;
      }

      try {
        const content = await readFile(absPath, 'utf-8');
        if (!content.trim()) {
          diagnostics.push({ path: displayPath, status: 'skipped', reason: 'empty', kind: 'chain' });
          continue;
        }
        candidates.push({
          kind: 'chain',
          displayPath,
          content,
          scanned: false,
          projectBound: true,
        });
        if (selected.compat === 'context') {
          diagnostics.push({ path: displayPath, status: 'loaded', reason: 'deprecated-context-md', kind: 'chain' });
        }
      } catch {
        diagnostics.push({ path: displayPath, status: 'skipped', reason: 'read-error', kind: 'chain' });
      }
    }

    return { candidates, diagnostics };
  }

  /** Приоритет на каталог: override > AGENTS.md > agents.md > CLAUDE.md > CONTEXT.md. */
  private async _selectCandidate(
    dir: string,
  ): Promise<{ fileName: string; main: boolean; compat?: 'claude' | 'context' } | null> {
    return selectInstructionFile(dir, this._config.claudeCompat, this._config.contextCompat);
  }

  /** `config.sources` в порядке объявления (path/url). */
  private async _collectSources(
    sources: readonly InstructionSourceConfig[],
    workspace: string,
    guard: GuardContext,
  ): Promise<{ candidates: Candidate[]; diagnostics: InstructionsDiagnostic[] }> {
    const candidates: Candidate[] = [];
    const diagnostics: InstructionsDiagnostic[] = [];

    for (const source of sources) {
      const value = source.value.trim();
      if (!value) continue;
      const collected =
        source.kind === 'path'
          ? await this._collectPathSource(source, value, workspace, guard)
          : await this._collectUrlSource(source, value);
      candidates.push(...collected.candidates);
      diagnostics.push(...collected.diagnostics);
    }

    return { candidates, diagnostics };
  }

  /**
   * Резолвит path-источник до абсолютного пути (first-match, glob-aware);
   * `null` — не найден. Общий для резолва и подписи кандидатов.
   */
  private async _resolvePathValue(value: string, workspace: string): Promise<string | null> {
    const base = value === '~' || value.startsWith('~/') || value.startsWith('~\\')
      ? this._home
      : isAbsolute(value)
        ? '/'
        : workspace;
    const pattern = value === '~' ? '' : value.startsWith('~/') || value.startsWith('~\\') ? value.slice(2) : value;
    return pattern ? findFirstMatch(base, pattern, this._config.lazy.excludeDirs) : null;
  }

  /** Резолвит path-источник (first-match) и читает его. */
  private async _collectPathSource(
    source: InstructionSourceConfig,
    value: string,
    workspace: string,
    guard: GuardContext,
  ): Promise<{ candidates: Candidate[]; diagnostics: InstructionsDiagnostic[] }> {
    const abs = await this._resolvePathValue(value, workspace);
    if (!abs) {
      return {
        candidates: [],
        diagnostics: [{ path: value, status: 'skipped', reason: 'not-found', kind: 'path', ...(source.label ? { label: source.label } : {}) }],
      };
    }

    const displayPath = displayPathForSource(workspace, abs, this._home);
    const ref = { path: displayPath, kind: 'path' as const, ...(source.label ? { label: source.label } : {}) };
    const projectBound = isInsideDir(workspace, abs);
    const blocked = this._guard(projectBound, guard);
    if (blocked) {
      return { candidates: [], diagnostics: [{ ...ref, status: blocked.status, reason: blocked.reason }] };
    }

    try {
      const content = await readFile(abs, 'utf-8');
      if (!content.trim()) {
        return { candidates: [], diagnostics: [{ ...ref, status: 'skipped', reason: 'empty' }] };
      }
      return {
        candidates: [{ kind: 'path', displayPath, ...(source.label ? { label: source.label } : {}), content, scanned: false, projectBound }],
        diagnostics: [],
      };
    } catch {
      return { candidates: [], diagnostics: [{ ...ref, status: 'skipped', reason: 'read-error' }] };
    }
  }

  /** Резолвит URL-источник: SSRF-guard → TTL-кэш → fetch (fallback на кэш). */
  private async _collectUrlSource(
    source: InstructionSourceConfig,
    value: string,
  ): Promise<{ candidates: Candidate[]; diagnostics: InstructionsDiagnostic[] }> {
    const displayPath = sanitizeUrlForDisplay(value);
    const ref = {
      path: displayPath,
      kind: 'url' as const,
      url: value,
      ...(source.label ? { label: source.label } : {}),
    };

    const outcome = await this._fetchUrlContent(value, source);
    if ('error' in outcome) {
      return { candidates: [], diagnostics: [{ ...ref, status: 'fetch-error', reason: outcome.error }] };
    }
    if (!outcome.content.trim()) {
      return { candidates: [], diagnostics: [{ ...ref, status: 'skipped', reason: 'empty' }] };
    }

    const diagnostics: InstructionsDiagnostic[] = [];
    if (outcome.warning) {
      diagnostics.push({ ...ref, status: 'fetch-error', reason: `использован кэш: ${outcome.warning}` });
    }
    return {
      candidates: [{
        kind: 'url',
        displayPath,
        ...(source.label ? { label: source.label } : {}),
        url: value,
        content: outcome.content,
        scanned: false,
        projectBound: false,
      }],
      diagnostics,
    };
  }

  /** Путь кэш-файла URL-источника; null — кэш недоступен (`dataDir` не задан). */
  private _cachePath(url: string): string | null {
    if (!this._dataDir) return null;
    const hash = createHash('sha1').update(url).digest('hex');
    return join(this._dataDir, 'instructions-cache', hash);
  }

  private async _readCache(path: string): Promise<CacheEntry | null> {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as { fetchedAt?: unknown; content?: unknown };
      if (typeof parsed.fetchedAt === 'number' && typeof parsed.content === 'string') {
        return { fetchedAt: parsed.fetchedAt, content: parsed.content };
      }
    } catch {
      // нет/битый кэш — трактуем как отсутствие
    }
    return null;
  }

  /** Атомарная запись кэша (tmp→rename, ADR-005); ошибки записи не фатальны. */
  private async _writeCache(path: string, url: string, entry: CacheEntry): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        JSON.stringify({ url, fetchedAt: entry.fetchedAt, content: entry.content }),
      );
    } catch {
      // кэш не критичен — молча игнорируем
    }
  }

  /**
   * URL-контент с TTL-кэшем. Формула свежести: `now - fetchedAt < ttlSec*1000`
   * (ttlSec — per-source либо `fetch.cacheTtlSec`; 0 — всегда refetch).
   * Сетевая ошибка при наличии кэша → старый кэш + предупреждение.
   */
  private async _fetchUrlContent(
    url: string,
    source: InstructionSourceConfig,
  ): Promise<{ content: string; warning?: string } | { error: string }> {
    const policy = await resolveToolsEgressPolicy();
    const valid = await validateRemoteUrl(url, { resolveHost: this._resolveHost, policy });
    if ('error' in valid) return { error: valid.error };

    const fetchCfg = this._config.fetch;
    const ttlMs = (source.ttlSec ?? fetchCfg.cacheTtlSec) * 1000;
    const cachePath = this._cachePath(url);
    const cached = cachePath ? await this._readCache(cachePath) : null;
    const now = this._now();

    if (cached && ttlMs > 0 && now - cached.fetchedAt < ttlMs) {
      return { content: cached.content };
    }

    const result = await fetchText(url, {
      timeoutMs: fetchCfg.timeoutMs,
      maxBytes: fetchCfg.maxBytes,
      maxHops: INSTRUCTIONS_MAX_REDIRECTS,
      fetchImpl: this._fetchImpl,
      resolveHost: this._resolveHost,
      policy,
      scope: 'instructions',
    });
    if ('error' in result) {
      if (cached) return { content: cached.content, warning: result.error };
      return { error: result.error };
    }

    if (cachePath) await this._writeCache(cachePath, url, { fetchedAt: now, content: result.text });
    return { content: result.text };
  }

  /** Threat-scan (ADR-036): flag/sanitize/block на контенте инструкций. */
  private _scan(
    entry: Candidate,
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

/** Статус резолвера → уровень/сообщение диагностики прозрачности (ADR-069 §9.3). */
const DIAGNOSTIC_META: Record<InstructionsDiagnosticStatus, { level: InstructionsReportLevel; message: string }> = {
  loaded: { level: 'info', message: 'Инструкции загружены' },
  truncated: { level: 'warning', message: 'Инструкции обрезаны по капу' },
  blocked: { level: 'error', message: 'Контент заблокирован threat-scan' },
  dedup: { level: 'info', message: 'Пропущен дубликат контента' },
  skipped: { level: 'info', message: 'Источник пропущен' },
  untrusted: { level: 'warning', message: 'Недоверенный проект — инструкции не загружены' },
  'skipped-install-tree': { level: 'warning', message: 'Каталог внутри дерева исходников Synth — инструкции не загружены' },
  excluded: { level: 'info', message: 'Проект исключён из автозагрузки' },
  'fetch-error': { level: 'warning', message: 'Ошибка загрузки источника' },
};

/** Человекочитаемые причины резолвера (для `diagnostics[].message`). */
const REASON_MESSAGES: Record<string, string> = {
  disabled: 'автозагрузка отключена (instructions.enabled=false)',
  excludeProjects: 'проект в instructions.excludeProjects',
  'untrusted-project': 'каталог не в skills.trustedProjectDirs',
  'install-tree': 'install-tree guard',
  injection: 'сработал threat-scan',
  'injection-flagged': 'подозрительный контент помечен',
  empty: 'пустой файл',
  'read-error': 'ошибка чтения',
  'not-found': 'файл не найден',
  'deprecated-context-md': 'deprecated CONTEXT.md',
};

/** Статус per-file резолвера (в отличие от диагностик уровней проекта). */
function isFileStatus(status: InstructionsDiagnosticStatus): boolean {
  return status === 'loaded' || status === 'truncated' || status === 'blocked';
}

/**
 * Строит снимок прозрачности (ADR-069 §9.3) из результата резолвера Ф2a.
 * Файлы и диагностики переиспользуются из резолвера без повторного discovery.
 */
export function buildInstructionsInfo(
  result: ProjectInstructionsResult,
  config: InstructionsConfig,
  contextWindow?: number,
): InstructionsInfo {
  const window =
    typeof contextWindow === 'number' && contextWindow > 0
      ? contextWindow
      : DEFAULT_INSTRUCTIONS_CONTEXT_WINDOW;

  const files: InstructionsReportFile[] = result.files.map((file) => {
    const diagnostic = result.diagnostics.find(
      (d) => d.path === file.path && isFileStatus(d.status),
    );
    const status: InstructionsDiagnosticStatus =
      diagnostic?.status ?? (file.blocked ? 'blocked' : file.truncated ? 'truncated' : 'loaded');
    return {
      path: file.path,
      kind: file.kind,
      ...(file.label ? { label: file.label } : {}),
      ...(file.url ? { url: file.url } : {}),
      chars: file.chars,
      truncated: file.truncated,
      status,
      scan: {
        scanned: file.scanned,
        blocked: file.blocked,
        suspicious: status === 'blocked' || diagnostic?.reason === 'injection-flagged',
        matches: diagnostic?.matches ?? [],
      },
    };
  });

  const diagnostics: InstructionsReportDiagnostic[] = result.diagnostics.map((diagnostic) => {
    const meta = DIAGNOSTIC_META[diagnostic.status];
    const reason = diagnostic.reason ? REASON_MESSAGES[diagnostic.reason] ?? diagnostic.reason : '';
    return {
      level: meta.level,
      code: diagnostic.status,
      message: reason ? `${meta.message}: ${reason}` : meta.message,
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
      ...(diagnostic.kind ? { kind: diagnostic.kind } : {}),
    };
  });

  return {
    enabled: config.enabled,
    cap: {
      chars: resolveInstructionsCap(config, contextWindow),
      source: config.maxChars ? 'override' : 'dynamic',
      contextWindow: window,
    },
    files,
    diagnostics,
  };
}

/**
 * Оборачивает `ProjectInstructionsResolver` в резолвер снимка прозрачности.
 *
 * Сессия без проекта (`workspace` не задан, ADR-040) → пустой снимок с причиной
 * `no-project` в диагностике; иначе — резолвинг merged chain + `config.sources`.
 */
export function createInstructionsInfoResolver(
  resolver: ProjectInstructionsResolver,
  config: InstructionsConfig,
): InstructionsInfoResolver {
  return async (query: InstructionsInfoQuery): Promise<InstructionsInfo> => {
    if (!query.workspace) {
      const info = buildInstructionsInfo(
        { content: '', files: [], diagnostics: [] },
        config,
        query.contextWindow,
      );
      info.diagnostics.push({
        level: 'info',
        code: 'no-project',
        message: 'Проект не выбран — проектные инструкции недоступны',
      });
      return info;
    }

    const result = await resolver.resolve({
      workspace: query.workspace,
      contextWindow: query.contextWindow,
      language: query.language,
      projectId: query.projectId,
      signal: query.signal,
      injection: query.injection,
    });
    return buildInstructionsInfo(result, config, query.contextWindow);
  };
}
