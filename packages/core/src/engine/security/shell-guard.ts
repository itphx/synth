/**
 * Shell-guard: **минимальная** защита `execute_shell` — только явные правила,
 * без эвристик разбора команд (решение владельца, ADR-029/ADR-136).
 *
 * Проверки — те же, что у файловых тулов, применённые к **явным** путям:
 * `protected-paths.json` (deny/ask, тот же файл), `external_directory` (путь вне
 * периметра `workingDir` + `allowedRoots`) и `deniedCommandPrefixes`. Кандидат-
 * путь — токен, который после резолва известных префиксов (`~`, `$HOME`,
 * `${HOME}`, `$PWD`, `$SYNTH_DATA_DIR`) существует на ФС или разрешается в
 * защищённый путь; цель редиректа (всегда путь); не-флаговый операнд
 * команды-писателя (`cp mv ln install mkdir rmdir touch rm chmod chown tee
 * truncate shred dd`); glob с существующим литеральным каталогом (совпадения
 * проверяются по отдельности); цель `cd`/`pushd` (меняет cwd для следующих
 * сегментов). Приоритет: deny > protected ask > external ask > allow.
 *
 * **НЕ проверяется** (принятые риски, ADR-029 аддендум 2026-11-13): `$VAR`
 * (кроме известных), `$(...)`, backticks, awk/sed/find-программы, heredoc,
 * обёртки `sh -c`/`sudo`/`env`/`nohup`, интерпретаторы, `for`/присваивания,
 * `xargs`, `git -c`, `tar --to-command`, `rsync -e` и т.п. Shell — произвольный
 * код: guardrail — UX/defense-in-depth, а граница безопасности — изоляция
 * исполнителя (ADR-137), аудит исполнений и внешний чекер команд (ADR-136).
 */
import { existsSync, opendirSync, statSync, type Dir } from 'node:fs';
import { join, dirname, resolve, normalize, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { globMatch, type PermissionRule } from '@itphx/synth-shared';
import { resolveRealPath, isLexicallyInside } from '../tools/path-utils.js';
import { t as sm } from '../system-messages.js';
import { tokenizeCommand, splitShellSegments } from './shell-lexer.js';

/** Политика безопасности execute_shell (структурно = ProtectedPathsPolicy). */
export interface ShellPolicy {
  /** Точные пути, которые запрещено трогать (резолвятся с `~`). */
  deniedPaths: string[];
  /** Префиксы директорий, внутри которых всё запрещено. */
  deniedPrefixes: string[];
  /** Пути, которые разрешены только через подтверждение (ask). */
  approvalPaths: string[];
  /** Префиксы команд, запрещённые целиком (например "rm -rf /"). */
  deniedCommandPrefixes: string[];
  /** dataDir инстанса: резолв `$SYNTH_DATA_DIR` и `{dataDir}/secrets` в префиксах. */
  dataDir?: string;
}

/** Путь, извлечённый из аргументов команды. */
export interface ExtractedPath {
  path: string;
  source: 'literal' | 'unknown';
}

/** Значения известных переменных окружения для резолва токенов (`$VAR`/`${VAR}`). */
export interface PathResolveEnv {
  vars?: Record<string, string | undefined>;
}

/** Результат checkShellCommand. */
export interface ShellCheckResult {
  action: 'allow' | 'deny' | 'ask';
  reason: string;
  matchedRule?: string;
  deniedPath?: string;
  /** Идентификатор локализованного сообщения (deny-command и т.д.). */
  messageId?: string;
  /** Параметры подстановки в сообщение ({{path}}, {{dir}}, {{command}}). */
  params?: Record<string, string>;
  /**
   * Причина `ask`: `dynamic` — glob не раскрыт (грант каталога, `askPaths`);
   * `external` — доступ вне периметра (`external_directory`);
   * `protected`/`mutation`/`cwd` — жёсткий слой (два последних — для типов).
   */
  askKind?: 'dynamic' | 'protected' | 'mutation' | 'cwd' | 'external';
  /** Абсолютные пути: совпадения glob (`dynamic`) или внешние пути (`external`). */
  askPaths?: string[];
}

/** Пустая политика — fallback, если файлы не найдены или невалидны. */
export const DEFAULT_POLICY: ShellPolicy = {
  deniedPaths: [],
  deniedPrefixes: [],
  approvalPaths: [],
  deniedCommandPrefixes: [],
};

const HOME = os.homedir();

/** Резолвит `~`/`~/...` в абсолютный путь (для записей политики). */
export function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

/** Схлопывает повторяющиеся пробелы (для сравнения строк команд). */
function normalizeSpace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

// Лексер вынесен в `shell-lexer.ts`; здесь — реэкспорт, публичный API не меняется.
export { tokenizeCommand, splitShellSegments } from './shell-lexer.js';

/** Имя команды по basename (`/bin/sh` → `sh`). */
function shellBasename(cmd: string): string {
  const slash = cmd.lastIndexOf('/');
  return slash >= 0 ? cmd.slice(slash + 1) : cmd;
}

// Резолв токенов в пути

/** Есть ли в токене динамика, которую мы не умеем резолвить. */
function hasUnresolvedDynamic(text: string): boolean {
  // `)` — часть `$(...)`: подстановка не режется, скобка остаётся в токене.
  return /[$*?[`()]/.test(text);
}

/** Известное значение переменной для резолва пути: HOME/PWD + `env.vars`. */
function knownVarValue(name: string, cwd: string, env?: PathResolveEnv): string | null {
  if (name === 'HOME') return HOME;
  if (name === 'PWD') return cwd;
  const value = env?.vars?.[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Пытается зарезолвить токен в абсолютный путь. */
export function tryResolvePath(token: string, cwd: string, env?: PathResolveEnv): ExtractedPath | null {
  if (token === '') return null;

  // `/proc/<pid|self>/root|/cwd/<path>` — тот же файл, что `<path>`; остаток
  // проверяем ДО лексической нормализации (иначе `root/..` съедается как `/proc`).
  const procAlias = /^\/proc\/(?:\d+|self)\/(?:root|cwd)(\/.+)$/.exec(token);
  if (procAlias) {
    const inner = procAlias[1]!;
    return { path: normalize(inner), source: hasUnresolvedDynamic(inner) ? 'unknown' : 'literal' };
  }

  let base = '';
  let rest = token;

  // Ручной резолв известных паттернов в начале токена: ~, $HOME, $PWD,
  // $SYNTH_DATA_DIR (и любая переменная из env.vars).
  const homeMatch = /^~(?:\/|$)/.exec(token);
  if (homeMatch) {
    base = HOME;
    rest = token.slice(1);
    if (rest.startsWith('/')) rest = rest.slice(1);
  } else {
    const dollar = /^(\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))(?:\/|$)/.exec(token);
    if (dollar) {
      const value = knownVarValue(dollar[2] ?? dollar[3]!, cwd, env);
      if (value !== null) {
        base = value;
        rest = token.slice(dollar[1]!.length);
        if (rest.startsWith('/')) rest = rest.slice(1);
      }
    }
  }

  if (base === '') {
    return { path: resolve(cwd, token), source: hasUnresolvedDynamic(token) ? 'unknown' : 'literal' };
  }
  if (rest === '') return { path: base, source: 'literal' };
  if (hasUnresolvedDynamic(rest)) return { path: resolve(base, rest), source: 'unknown' };
  return { path: resolve(base, rest), source: 'literal' };
}

/** Brace-expansion `{a,b}` (без вложенности); `null` — форма не поддерживается. */
function expandBraces(token: string): string[] | 'literal' | null {
  // `{{…}}`/`}}` — не brace-expansion (docker/kubectl-форматы, jsonpath).
  if (token.includes('{{') || token.includes('}}')) return 'literal';
  const open = token.indexOf('{');
  if (open === -1) return 'literal';
  const close = token.indexOf('}', open + 1);
  if (close === -1) return 'literal';
  const body = token.slice(open + 1, close);
  if (body.includes('{') || body.includes('}') || body.includes('..')) return null;
  const parts = body.split(',');
  if (parts.length === 1) return 'literal';
  const prefix = token.slice(0, open);
  const suffix = token.slice(close + 1);
  const out: string[] = [];
  for (const part of parts) {
    const expanded = expandBraces(prefix + part + suffix);
    if (expanded === null) return null;
    for (const variant of expanded === 'literal' ? [prefix + part + suffix] : expanded) {
      out.push(variant);
      if (out.length > 64) return null;
    }
  }
  return out;
}

/** Пути из аргументов команды (флаги пропущены, `--` включает операнды). */
export function extractCommandPaths(tokens: string[], cwd: string, env?: PathResolveEnv): ExtractedPath[] {
  if (tokens.length === 0) return [];
  const result: ExtractedPath[] = [];
  let afterDoubleDash = false;

  const push = (token: string): void => {
    const variants = expandBraces(token);
    if (variants === null) {
      result.push({ path: resolve(cwd, token), source: 'unknown' });
      return;
    }
    for (const variant of variants === 'literal' ? [token] : variants) {
      const extracted = tryResolvePath(variant, cwd, env);
      if (extracted) result.push(extracted);
    }
  };

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && token.startsWith('-') && token.length > 1) continue;
    push(token);
  }

  // Слитные перенаправления (`>/etc/shadow`, `2>/etc/passwd`, `&>…`): цель — путь.
  for (const token of tokens) {
    const target = parseRedirectToken(token);
    if (target === null) continue;
    if (/^\d+$/.test(target) || target === '-' || target === '&-') continue; // fd
    push(target);
  }
  return result;
}

/** Разбирает слитный оператор перенаправления (`>&`, `>|`, `<>`, `2>`, `&>>`…) и цель. */
function parseRedirectToken(token: string): string | null {
  const m = /^[0-9]*(?:&>>|&>|>>|>&|<&|<>|>\||>|<)(.+)$/.exec(token);
  return m ? m[1]! : null;
}

/** Операторы перенаправления (лексер выделяет их отдельными токенами). */
const REDIRECT_OPERATORS: ReadonlySet<string> = new Set(['&>>', '>>', '>&', '>|', '<>', '<&', '&>', '>', '<']);

// Маркеры защищённых путей (fail-closed для protected-paths) и мутации

/** Минимальный источник денлиста: ShellPolicy и ProtectedPathsPolicy подходят. */
export interface DeniedPathsSource {
  deniedPaths: readonly string[];
  deniedPrefixes: readonly string[];
}

/** Базовое имя записи политики (`~/.ssh` → `.ssh`, `/etc/shadow` → `shadow`). */
function policyBasename(entry: string): string {
  const trimmed = entry.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Символы динамики — разделители при выделении литеральных фрагментов токена. */
const DYNAMIC_CHARS_RE = /[$*?[\](){}`]+/;

/** «Маркеры» защищённых путей политики — basename'ы deniedPaths/deniedPrefixes. */
export function sensitivePathMarkers(policy: DeniedPathsSource): string[] {
  const markers = new Set<string>();
  for (const entry of [...(policy.deniedPaths ?? []), ...(policy.deniedPrefixes ?? [])]) {
    if (entry.includes('$') || entry.includes('{')) continue; // динамика в самой записи
    const base = policyBasename(expandHome(entry)).toLowerCase();
    if (base === '' || base === '.' || base === '..' || base === '/') continue;
    markers.add(base);
  }
  return [...markers];
}

/** Токен с динамикой упирается литеральным фрагментом в защищённый путь. */
export function tokenTouchesProtectedMarker(token: string, policy: DeniedPathsSource): boolean {
  const markers = sensitivePathMarkers(policy);
  if (markers.length === 0) return false;
  for (const fragment of token.toLowerCase().split(DYNAMIC_CHARS_RE)) {
    if (!fragment.includes('/') && !fragment.includes('\\') && !fragment.startsWith('~')) continue;
    for (const segment of fragment.split(/[\\/]+/)) {
      if (segment !== '' && markers.includes(segment)) return true;
    }
  }
  return false;
}

/** Простые мутирующие команды (изменяют состояние файловой системы/системы). */
const MUTATING_SIMPLE = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'chgrp',
  'ln', 'dd', 'tee', 'install', 'truncate', 'shred', 'systemctl', 'service',
  'kill', 'pkill', 'killall', 'docker', 'apt', 'apt-get', 'yum', 'dnf',
  'pacman', 'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'pipx',
]);

/** Мутирующие подкоманды git (read-only: status/diff/log/show/blame/branch). */
const MUTATING_GIT = new Set([
  'commit', 'push', 'pull', 'checkout', 'reset', 'stash', 'merge', 'rebase', 'clean', 'switch',
]);

/** Подкоманды менеджеров, пишущие в окружение. */
const MUTATING_SUBCOMMAND: Record<string, Set<string>> = {
  cargo: new Set(['install']),
  go: new Set(['install']),
  brew: new Set(['install']),
};

/** Флаги curl/wget, сохраняющие вывод в файл. */
const CURL_WRITE_FLAGS = new Set(['-o', '--output', '--output-dir', '-O']);
const WGET_WRITE_FLAGS = new Set(['-O', '-o']);

/** Оболочки/eval исполняют произвольный код — в plan-режиме считаем мутацией. */
const SHELL_LIKE = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval', 'source']);

function isMutatingSegment(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  let effectiveTokens = tokens;
  while (effectiveTokens[0] === 'sudo') effectiveTokens = effectiveTokens.slice(1);
  const cmd = effectiveTokens[0] ?? '';
  const base = shellBasename(cmd);

  if (SHELL_LIKE.has(base) || MUTATING_SIMPLE.has(base)) return true;
  if (base === 'git') return MUTATING_GIT.has(effectiveTokens[1] ?? '');

  const subcommands = MUTATING_SUBCOMMAND[base];
  if (subcommands) return subcommands.has(effectiveTokens[1] ?? '');

  if (base === 'curl' || base === 'wget') {
    const flags = base === 'curl' ? CURL_WRITE_FLAGS : WGET_WRITE_FLAGS;
    return effectiveTokens.some((t) => flags.has(t));
  }
  // sed по умолчанию мутирующий; read-only только с -n (печать в stdout).
  if (base === 'sed') return !effectiveTokens.includes('-n');
  // find изменяет состояние только с -delete/-exec/-execdir.
  if (base === 'find') {
    return effectiveTokens.includes('-delete')
      || effectiveTokens.includes('-exec')
      || effectiveTokens.includes('-execdir');
  }
  return false;
}

/** Мутирующий ли сегмент: перенаправления `>`/`>>` пишут в файл. */
function isSegmentMutating(segment: string): boolean {
  const segTokens = stripShellPrefixWords(tokenizeCommand(segment));
  if (segTokens.length === 0) return false;
  if (segTokens.some((t) => t === '>' || t === '>>')) return true;
  return isMutatingSegment(segTokens);
}

/** Мутирующая ли команда (plan-режим, ADR-028); оболочки/eval — всегда да. */
export function isMutatingCommand(tokens: string[], command: string): boolean {
  if (tokens.length === 0 && command.trim() === '') return false;
  return splitShellSegments(command).some(isSegmentMutating);
}

// Каталог системных definitions (общий с protected-paths)

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

/** Поиск корня пакета @itphx/synth-core по package.json вверх. */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/** Каталог definitions: {root}/definitions с fallback на {root}/dist/definitions. */
export function resolveSystemDefinitionsDir(): string {
  const root = findPackageRoot(CURRENT_DIR);
  const candidates = [join(root, 'definitions'), join(root, 'dist', 'definitions')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

// Проверка команды

/** Контекст проверки одного сегмента/команды. */
interface CheckContext {
  cwd: string;
  policy: ShellPolicy;
  deniedPaths: readonly string[];
  approvalPaths: readonly string[];
  deniedPrefixes: readonly string[];
  env?: PathResolveEnv;
  roots: readonly string[];
}

/** Проверяет команду по сегментам; `cd`/`pushd` меняет cwd для следующих. */
export function checkShellCommand(
  command: string,
  cwd: string,
  policy: ShellPolicy,
  options?: { allowedRoots?: readonly string[] },
): ShellCheckResult {
  resetShellCheckCaches();

  // Точное совпадение всей команды (например форк-бомба с разделителями внутри).
  for (const prefix of policy.deniedCommandPrefixes) {
    if (normalizeSpace(prefix) === normalizeSpace(command)) return deniedByPrefix(prefix);
  }

  const segments = splitShellSegments(stripHeredocBodies(command));
  if (segments.length === 0) return { action: 'allow', reason: sm('shellguard.allow_default') };

  const env = resolveEnv(policy);
  const ctx: CheckContext = {
    cwd,
    policy,
    deniedPaths: policy.deniedPaths.map(expandHome),
    approvalPaths: policy.approvalPaths.map(expandHome),
    deniedPrefixes: policy.deniedPrefixes.map(expandHome),
    env,
    roots: [cwd, ...(options?.allowedRoots ?? [])],
  };

  let ask: ShellCheckResult | null = null;
  const external: string[] = [];
  let currentCwd = cwd;

  for (const segment of segments) {
    // `cd`/`pushd`: цель — реальный доступ, cwd меняется для следующих сегментов.
    const target = cdTarget(segment, currentCwd, env);
    if (target !== null) {
      const access = classifyAccess(normalize(target), { ...ctx, cwd: currentCwd });
      if (access.kind === 'deny') return access.result;
      if (access.kind === 'ask') ask ??= access.result;
      else if (access.kind === 'external') external.push(access.path);
      currentCwd = target;
      continue;
    }

    const result = checkShellSegment(segment, { ...ctx, cwd: currentCwd });
    if (result?.action === 'deny') return result;
    if (result?.action === 'ask') {
      if (result.askKind === 'external' && result.askPaths) external.push(...result.askPaths);
      else ask ??= result;
    }
  }

  if (ask) return ask;
  if (external.length > 0) return askForExternal([...new Set(external)]);
  return { action: 'allow', reason: sm('shellguard.allow_default') };
}

/** Значения переменных для резолва токенов: `$SYNTH_DATA_DIR` → dataDir инстанса. */
function resolveEnv(policy: ShellPolicy): PathResolveEnv | undefined {
  return policy.dataDir ? { vars: { SYNTH_DATA_DIR: policy.dataDir } } : undefined;
}

/** Проверяет сегмент; `null` — не нарушает политику. */
function checkShellSegment(segment: string, ctx: CheckContext): ShellCheckResult | null {
  const tokens = stripShellPrefixWords(tokenizeCommand(segment));
  if (tokens.length === 0) return null;

  // 1. Запрещённые префиксы команд — матчатся в ЛЮБОМ сегменте.
  for (const prefix of ctx.policy.deniedCommandPrefixes) {
    const prefixTokens = tokenizeCommand(prefix);
    if (prefixTokens.length > 0 && tokens.length >= prefixTokens.length
      && prefixTokens.every((t, i) => tokens[i] === t)) {
      return deniedByPrefix(prefix);
    }
  }

  const cmdIdx = commandIndex(tokens);
  const cmd = cmdIdx < 0 ? '' : shellBasename(tokens[cmdIdx]!);
  const writer = WRITER_COMMANDS.has(cmd);
  const asks: ShellCheckResult[] = [];
  const external: string[] = [];

  const consider = (token: string, forced: boolean): ShellCheckResult | null => {
    const outcome = classifyCandidate(token, ctx, forced);
    if (outcome === null) return null;
    if (outcome.kind === 'deny') return outcome.result;
    if (outcome.kind === 'ask') asks.push(outcome.result);
    else external.push(...outcome.paths);
    return null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    // 2. Цель редиректа — всегда путь (файл может ещё не существовать).
    if (REDIRECT_OPERATORS.has(token)) {
      const target = tokens[i + 1];
      if (target !== undefined && !REDIRECT_OPERATORS.has(target)) {
        const denied = consider(target, true);
        if (denied) return denied;
      }
      continue;
    }
    const glued = parseRedirectToken(token);
    if (glued !== null) {
      if (/^\d+$/.test(glued) || glued === '-' || glued === '&-') continue; // fd
      const denied = consider(glued, true);
      if (denied) return denied;
      continue;
    }

    if (token === '' || (token.startsWith('-') && token.length > 1)) continue;

    // 3. Операнд команды-писателя — путь, даже если файла ещё нет.
    const denied = consider(token, writer && (cmdIdx < 0 || i > cmdIdx));
    if (denied) return denied;
  }

  if (asks.length > 0) return asks[0]!;
  if (external.length > 0) return askForExternal([...new Set(external)]);
  return null;
}

/** Команды, у которых не-флаговый операнд — создаваемый/меняемый путь. */
const WRITER_COMMANDS: ReadonlySet<string> = new Set([
  'cp', 'mv', 'ln', 'install', 'mkdir', 'rmdir', 'touch', 'rm',
  'chmod', 'chown', 'tee', 'truncate', 'shred', 'dd',
]);

/** Результат классификации кандидата-пути. */
type CandidateClassification =
  | { kind: 'deny'; result: ShellCheckResult }
  | { kind: 'ask'; result: ShellCheckResult }
  | { kind: 'external'; paths: string[] };

/** Классифицирует токен-кандидат (с brace-expansion). `null` — проверять нечего. */
function classifyCandidate(
  token: string,
  ctx: CheckContext,
  forced: boolean,
): CandidateClassification | null {
  const variants = expandBraces(token);
  if (variants === null) return null;

  let ask: ShellCheckResult | null = null;
  const external: string[] = [];
  for (const variant of variants === 'literal' ? [token] : variants) {
    const outcome = classifyCandidateVariant(variant, ctx, forced);
    if (outcome === null) continue;
    if (outcome.kind === 'deny') return outcome;
    if (outcome.kind === 'ask') ask ??= outcome.result;
    else external.push(...outcome.paths);
  }
  if (ask) return { kind: 'ask', result: ask };
  if (external.length > 0) return { kind: 'external', paths: external };
  return null;
}

function classifyCandidateVariant(
  token: string,
  ctx: CheckContext,
  forced: boolean,
): CandidateClassification | null {
  if (token === '' || token === '-' || isUrlToken(token)) return null;
  if (hasGlobChars(token)) return classifyGlobToken(token, ctx);

  const resolved = tryResolvePath(token, ctx.cwd, ctx.env);
  if (!resolved || resolved.source !== 'literal') return null;
  const norm = normalize(resolved.path);

  // Защищённые пути политики — независимо от существования файла.
  const classified = classifyResolvedPath(norm, ctx);
  if (classified) return classified;

  // Дальше — только реально существующий путь или явный операнд/цель.
  if (!forced && !existsSync(norm)) return null;

  const access = classifyAccess(norm, ctx);
  if (access.kind === 'deny' || access.kind === 'ask') return access;
  if (access.kind === 'external') return { kind: 'external', paths: [access.path] };
  return null;
}

/** URL (`scheme://…`) — не файловый путь: внешние адреса не подтверждаем. */
function isUrlToken(token: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(token);
}

/** Glob-метасимволы (`(`/`)` сюда НЕ входят: это подстановка/текст, не шаблон файлов). */
const GLOB_CHARS_RE = /[*?[\]{}]/;

/** Есть ли glob-символы вне `${VAR}` (скобки переменной — не шаблон). */
function hasGlobChars(token: string): boolean {
  return GLOB_CHARS_RE.test(token.replace(/\$\{[^}]*\}/g, ''));
}

/** Glob по литеральному каталогу: каталог политики → deny/ask, иначе совпадения. */
function classifyGlobToken(token: string, ctx: CheckContext): CandidateClassification | null {
  const lastSlash = token.lastIndexOf('/');
  const bare = lastSlash === -1;
  let dir: string;
  let pattern: string;
  if (bare) {
    dir = ctx.cwd;
    pattern = token;
  } else {
    const dirToken = lastSlash === 0 ? '/' : token.slice(0, lastSlash);
    const resolved = tryResolvePath(dirToken, ctx.cwd, ctx.env);
    if (!resolved || resolved.source !== 'literal') return null;
    dir = resolved.path;
    pattern = token.slice(lastSlash + 1);
  }
  if (pattern === '' || !hasGlobChars(pattern)) return null;

  const dirNorm = normalize(dir);
  const dirClassified = classifyResolvedPath(dirNorm, ctx);
  if (dirClassified) return dirClassified;
  if (!existsSync(dirNorm)) return null;

  const names = readDirLimited(dirNorm, GLOB_READDIR_LIMIT);
  if (names === 'too-many' || names === null) {
    return { kind: 'ask', result: askForDynamic(token) };
  }

  const matches = names.filter((name) => globMatch(pattern, name));
  if (matches.length === 0) return null;

  let ask: ShellCheckResult | null = null;
  const external: string[] = [];
  for (const name of matches) {
    const access = classifyAccess(normalize(join(dirNorm, name)), ctx);
    if (access.kind === 'deny') return access;
    if (access.kind === 'ask') ask ??= access.result;
    else if (access.kind === 'external') external.push(access.path);
  }
  if (ask) return { kind: 'ask', result: ask };
  if (external.length > 0) return { kind: 'external', paths: [...new Set(external)] };
  return null;
}

// Периметр и классификация путей

/** Исключения периметра — псевдофайлы (потоки/дескрипторы), не реальный доступ. */
const PERIMETER_EXEMPT_EXACT: ReadonlySet<string> = new Set([
  '/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty',
]);
const PERIMETER_EXEMPT_PATTERNS: readonly RegExp[] = [
  /^\/dev\/fd\/\d+$/,
  /^\/proc\/self\/fd\/\d+$/,
];

/** Является ли нормализованный путь исключением периметра (см. выше). */
export function isPerimeterExempt(path: string): boolean {
  const norm = normalize(path);
  if (PERIMETER_EXEMPT_EXACT.has(norm)) return true;
  return PERIMETER_EXEMPT_PATTERNS.some((re) => re.test(norm));
}

/** Кэш `realpath`/`readdir` на **один** вызов `checkShellCommand`. */
let realPathCache: Map<string, string | null> = new Map();
let readDirCache: Map<string, string[] | 'too-many' | null> = new Map();

function resetShellCheckCaches(): void {
  realPathCache = new Map();
  readDirCache = new Map();
}

/** `resolveRealPath` с кэшем на вызов проверки. */
function cachedRealPath(path: string): string | null {
  if (realPathCache.has(path)) return realPathCache.get(path)!;
  const value = resolveRealPath(path);
  realPathCache.set(path, value);
  return value;
}

/** Результат классификации доступа к пути. */
type AccessClassification =
  | { kind: 'deny'; result: ShellCheckResult }
  | { kind: 'ask'; result: ShellCheckResult }
  | { kind: 'external'; path: string }
  | { kind: 'safe' };

/** Классификация доступа: protected → исключения → периметр → external. */
function classifyAccess(norm: string, ctx: CheckContext): AccessClassification {
  const classified = classifyResolvedPath(norm, ctx);
  if (classified) return classified;
  if (isPerimeterExempt(norm)) return { kind: 'safe' };
  if (isInsideRoots(norm, ctx.roots)) return { kind: 'safe' };
  return { kind: 'external', path: norm };
}

/** Результат классификации разрешённого пути. */
type PathClassification =
  | { kind: 'deny'; result: ShellCheckResult }
  | { kind: 'ask'; result: ShellCheckResult };

/** deniedPaths → deny; approvalPaths → ask; deniedPrefixes → deny. */
function classifyResolvedPath(norm: string, ctx: CheckContext): PathClassification | null {
  const variants = pathVariants(norm);
  const pathHit = ctx.deniedPaths.find((p) => variants.includes(normalize(p)));
  if (pathHit) return { kind: 'deny', result: deniedByPath(pathHit) };
  const approved = ctx.approvalPaths.find((p) => variants.includes(normalize(p)));
  if (approved) return { kind: 'ask', result: askByPath(approved) };
  for (const variant of variants) {
    const dirHit = ctx.deniedPrefixes.find((p) => isUnderDeniedPrefix(variant, p));
    if (dirHit) return { kind: 'deny', result: deniedByDir(variant, dirHit) };
  }
  return null;
}

/** Находится ли нормализованный путь внутри запрещённого префикса. */
function isUnderDeniedPrefix(norm: string, prefixEntry: string): boolean {
  const prefix = normalize(prefixEntry);
  return norm === prefix || norm.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}

/** Лексический и разыменованный (realpath) варианты пути + `/proc`-алиас. */
function pathVariants(norm: string): string[] {
  const variants: string[] = [];
  const real = cachedRealPath(norm);
  if (real !== null && real !== norm) variants.push(norm, real);
  else variants.push(norm);
  const procRoot = /^\/proc\/(?:\d+|self)\/(?:root|cwd)(\/.+)$/.exec(norm);
  if (procRoot) variants.push(normalize(procRoot[1]!));
  return variants;
}

/** Лимит записей при чтении каталога для glob (защита event loop). */
const GLOB_READDIR_LIMIT = 2000;

/** Чтение имён каталога с лимитом: больше `limit` — `'too-many'`, ошибка — `null`. */
function readDirLimited(dir: string, limit: number): string[] | 'too-many' | null {
  const key = `${limit}\0${dir}`;
  const cached = readDirCache.get(key);
  if (cached !== undefined) return cached;
  let result: string[] | 'too-many' | null;
  let handle: Dir | undefined;
  try {
    handle = opendirSync(dir);
    const names: string[] = [];
    result = names;
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > limit) {
        result = 'too-many';
        break;
      }
    }
  } catch {
    result = null;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // каталог уже закрыт/недоступен — не влияет на вердикт
    }
  }
  readDirCache.set(key, result);
  return result;
}

/** Вхождение в периметр: realpath — если путь существует, иначе лексически. */
function isInsideRoots(path: string, roots: readonly string[]): boolean {
  const real = cachedRealPath(path);
  return roots.some((root) => {
    if (!isLexicallyInside(root, path)) return false;
    if (real === null) return true;
    const realRoot = cachedRealPath(root);
    return realRoot !== null && isLexicallyInside(realRoot, real);
  });
}

// Результаты проверки (фабрики сообщений)

/** deny: точный запрещённый путь. */
function deniedByPath(hit: string): ShellCheckResult {
  return {
    action: 'deny',
    reason: sm('shellguard.deny_path', { path: hit }),
    matchedRule: 'shell-policy.deny',
    deniedPath: hit,
    messageId: 'deny-protected-path',
    params: { path: normalize(hit) },
  };
}

/** ask: путь из approvalPaths требует подтверждения. */
function askByPath(hit: string): ShellCheckResult {
  return {
    action: 'ask',
    reason: sm('shellguard.ask_path', { path: hit }),
    matchedRule: 'shell-policy.approve',
    deniedPath: hit,
    messageId: 'ask-protected-path',
    params: { path: normalize(hit) },
    askKind: 'protected',
  };
}

/** deny: путь внутри запрещённого префикса директории. */
function deniedByDir(path: string, hit: string): ShellCheckResult {
  return {
    action: 'deny',
    reason: sm('shellguard.deny_dir', { path, dir: hit }),
    matchedRule: 'shell-policy.deny',
    deniedPath: hit,
    messageId: 'deny-protected-dir',
    params: { path, dir: normalize(hit) },
  };
}

/** Формирует deny-результат для записи deniedCommandPrefixes. */
function deniedByPrefix(prefix: string): ShellCheckResult {
  return {
    action: 'deny',
    reason: sm('shellguard.deny_prefix', { prefix }),
    matchedRule: 'shell-policy.deny',
    deniedPath: prefix,
    messageId: 'deny-command',
    params: { command: prefix },
  };
}

/** ask: glob не удалось раскрыть (нечитаемый каталог/слишком много записей). */
function askForDynamic(token: string): ShellCheckResult {
  return {
    action: 'ask',
    reason: sm('shellguard.ask_path', { path: token }),
    matchedRule: 'shell-policy.approve',
    deniedPath: token,
    messageId: 'ask-protected-path',
    params: { path: token },
    askKind: 'dynamic',
  };
}

/** ask на реальный доступ вне периметра (`external_directory`-семантика). */
function askForExternal(paths: readonly string[]): ShellCheckResult {
  const first = paths[0] ?? '';
  return {
    action: 'ask',
    reason: sm('shellguard.ask_external', { path: first }),
    matchedRule: 'external_directory.default',
    deniedPath: first,
    messageId: 'ask-external-directory',
    params: { path: first },
    askKind: 'external',
    askPaths: [...paths],
  };
}

// Разбор сегмента: префиксы, команда, cd-цель, heredoc

/** Служебные слова оболочки в начале сегмента (не меняют команду). */
const SHELL_PREFIX_WORDS: ReadonlySet<string> = new Set([
  '!', 'time', '{', '(', 'then', 'do', 'else', 'elif', 'fi', 'done', 'esac', '}',
  'if', 'while', 'until', 'for', 'case', 'in',
]);

/** Снимает ведущие служебные слова оболочки (`!`, `time`, `{`, `(`, `if`, …). */
function stripShellPrefixWords(input: string[]): string[] {
  const arr = input.slice();
  for (;;) {
    if (arr.length === 0) return arr;
    const first = arr[0]!;
    if (SHELL_PREFIX_WORDS.has(first)) {
      arr.shift();
      continue;
    }
    if (first.startsWith('(') && !first.startsWith('$(')) {
      arr[0] = first.slice(1);
      if (arr[0] === '') arr.shift();
      continue;
    }
    if (first.startsWith('!') && first !== '!') {
      arr[0] = first.slice(1);
      if (arr[0] === '') arr.shift();
      continue;
    }
    return arr;
  }
}

/** Ведущее присваивание (`NAME=…`, `NAME+=…`) — не имя команды. */
function isLeadingAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(token);
}

/** Индекс имени команды сегмента (первый токен, не являющийся присваиванием). */
function commandIndex(tokens: readonly string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    if (!isLeadingAssignment(tokens[i]!)) return i;
  }
  return -1;
}

/** Литеральная цель `cd`/`pushd`; `null` — не cd или цель динамическая. */
function cdTarget(segment: string, cwd: string, env?: PathResolveEnv): string | null {
  const tokens = stripShellPrefixWords(tokenizeCommand(segment));
  const idx = commandIndex(tokens);
  if (idx < 0) return null;
  const cmd = tokens[idx]!;
  if (cmd !== 'cd' && cmd !== 'pushd') return null;
  let j = idx + 1;
  while (j < tokens.length && tokens[j]!.startsWith('-') && tokens[j] !== '-') j += 1;
  const arg = tokens[j];
  if (arg === undefined) return expandHome('~');
  if (arg === '-') return null;
  const resolved = tryResolvePath(arg, cwd, env);
  if (!resolved || resolved.source !== 'literal') return null;
  return resolved.path;
}

/** Ищет heredoc-маркер в строке (`<<`/`<<-`, не `<<<`); возвращает делимитер. */
function heredocMarker(line: string): { delimiter: string; stripTabs: boolean } | null {
  const re = /<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (line[m.index + 2] === '<') continue; // herestring `<<<`
    const delimiter = m[2] ?? m[3] ?? m[4] ?? '';
    return delimiter === '' ? null : { delimiter, stripTabs: m[1] === '-' };
  }
  return null;
}

/** Удаляет тела heredoc (stdin-данные, а не код родительского shell). */
function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;
  const lines = command.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const marker = heredocMarker(line);
    if (!marker) continue;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const candidate = marker.stripTabs ? lines[j]!.replace(/^\t+/, '') : lines[j]!;
      if (candidate === marker.delimiter) break;
    }
    i = j; // пропускаем тело и строку-делимитер
  }
  return out.join('\n');
}

/** Делимитеры heredoc в команде — закрывающая строка-делимитер не команда. */
function heredocDelimiters(command: string): Set<string> {
  const out = new Set<string>();
  for (const line of command.split('\n')) {
    const marker = heredocMarker(line);
    if (marker) out.add(marker.delimiter);
  }
  return out;
}

// Сессионные гранты (ADR-029): паттерны команд и каталоги

/** Ключевые слова-заголовки: сегмент не даёт shell-паттерн. */
const SHELL_HEADER_KEYWORDS = new Set(['for', 'while', 'until', 'if', 'case', 'elif']);
/** Команды с подкомандой (`git status *`, `kubectl get *`, `docker compose *`). */
const SUBCOMMAND_TOOLS = new Set([
  'git', 'kubectl', 'oc', 'docker', 'podman', 'nerdctl', 'helm', 'kustomize',
  'npm', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'go', 'brew', 'pip', 'pip3',
  'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'systemctl', 'service', 'terraform',
  'aws', 'gcloud', 'az', 'ansible-galaxy', 'poetry', 'composer', 'dotnet',
]);

/** Паттерн сессионного гранта для одной команды (команда + подкоманда + `*`). */
function shellPatternFor(tokens: string[], cmd: string): string {
  const base = shellBasename(cmd);
  if (SUBCOMMAND_TOOLS.has(base)) {
    const sub = tokens[1];
    if (sub !== undefined && !sub.startsWith('-') && !/[$`;|&<>]/.test(sub)) {
      return `${cmd} ${sub} *`;
    }
  }
  return `${cmd} *`;
}

/** Строка не является командой: пустая, комментарий/shebang, делимитер, метасимволы. */
function isNonCommandSegment(segment: string, delimiters: ReadonlySet<string>): boolean {
  const trimmed = segment.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('#')) return true;
  if (delimiters.has(trimmed)) return true;
  return !/[A-Za-z0-9_]/.test(trimmed);
}

/** Паттерн сегмента; `false` — имя команды нерезолвимо (паттерн не выдаётся). */
function collectShellPatterns(segment: string, out: string[]): boolean {
  const rawTokens = tokenizeCommand(segment);
  if (rawTokens.length === 0) return true;
  if (SHELL_HEADER_KEYWORDS.has(rawTokens[0]!)) return true;
  const tokens = stripShellPrefixWords(rawTokens);
  if (tokens.length === 0) return true;

  const cmdIdx = commandIndex(tokens);
  if (cmdIdx < 0) return true;
  const cmd = tokens[cmdIdx]!;
  if (cmd === '') return true;
  if (/[$`]/.test(cmd)) return false;
  out.push(shellPatternFor(tokens, cmd));
  return true;
}

/**
 * Паттерны для сессионного shell-гранта (`{ "<pattern>": "allow" }`).
 * `null` — хотя бы одна команда нерезолвима; `[]` — только заголовки.
 * Дедуп, порядок появления, ≤ 20.
 */
export function shellSavePatterns(command: string): string[] | null {
  const out: string[] = [];
  const delimiters = heredocDelimiters(command);
  for (const segment of splitShellSegments(stripHeredocBodies(command))) {
    if (isNonCommandSegment(segment, delimiters)) continue;
    if (!collectShellPatterns(segment, out)) return null;
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const pattern of out) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    unique.push(pattern);
    if (unique.length >= 20) break;
  }
  return unique;
}

/** `*`/`git commit *`/точное/globMatch — паттерн правила → команда. */
export function matchShellCommandPattern(pattern: string, command: string): boolean {
  const p = pattern.trim();
  const c = command.trim();
  if (p === '*') return true;
  if (p.endsWith(' *') || p.endsWith(' **')) {
    const prefix = p.slice(0, -2).trim();
    return c === prefix || c.startsWith(prefix + ' ');
  }
  if (!/[*?[\]{}]/.test(p)) return c === p;
  return globMatch(p, c);
}

/** Покрыт ли каждый исполняемый сегмент команды allow-паттернами гранта. */
export function isShellCommandGranted(
  command: string,
  rules: Record<string, PermissionRule>,
): boolean {
  const rule = rules.execute_shell ?? rules.shell;
  if (rule === undefined) return false;
  if (rule === 'allow') return true;
  if (typeof rule !== 'object' || rule === null) return false;
  const patterns = Object.entries(rule)
    .filter(([, action]) => action === 'allow')
    .map(([pattern]) => pattern);
  if (patterns.length === 0) return false;

  const matches = (tokens: string[], cmdIdx: number, cmd: string): boolean => {
    const effective = tokens.slice();
    effective[cmdIdx] = cmd;
    const rendered = effective.map(quoteShellToken).join(' ');
    return patterns.some((pattern) => matchShellCommandPattern(pattern, rendered));
  };

  const grantedSegment = (segment: string): boolean => {
    const rawTokens = tokenizeCommand(segment);
    if (rawTokens.length === 0) return true;
    if (SHELL_HEADER_KEYWORDS.has(rawTokens[0]!)) return true;
    const tokens = stripShellPrefixWords(rawTokens);
    if (tokens.length === 0) return true;
    const cmdIdx = commandIndex(tokens);
    if (cmdIdx < 0) return true;
    const cmd = tokens[cmdIdx]!;
    if (/[$`]/.test(cmd)) return false;
    return matches(tokens, cmdIdx, cmd);
  };

  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  const delimiters = heredocDelimiters(command);
  let checked = false;
  for (const segment of segments) {
    if (isNonCommandSegment(segment, delimiters)) continue;
    checked = true;
    if (!grantedSegment(segment)) return false;
  }
  return checked;
}

/** Экранирует токен для обратной склейки в shell-строку (границы аргументов). */
function quoteShellToken(token: string): string {
  if (token !== '' && /^[A-Za-z0-9_@%+=:,./~$^*?-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** План гранта по `ask`'у: только каталог виновника, паттернов нет (ADR-029). */
export interface ShellGrantPlan {
  /** Точные исполняемые сегменты команды — для показа человеку. */
  commands: string[];
  /** Паттерны правила `execute_shell` (только для снимаемых ask'ов). */
  patterns: string[];
  /** Каталоги для правила `external_directory` (`<dir>/*`). */
  directories: string[];
}

/** Снимает окружающие кавычки с токена-виновника. */
function stripTokenQuotes(token: string): string {
  let out = token;
  while (out.length >= 2
    && ((out.startsWith('\'') && out.endsWith('\'')) || (out.startsWith('"') && out.endsWith('"')))) {
    out = out.slice(1, -1);
  }
  return out;
}

/**
 * Каталог гранта по токену-виновнику; `null` — каталог не определить.
 * Bare-glob (`*.js`) → `cwd`; токен с `/` → его литеральная часть-каталог.
 */
function grantDirectoryForToken(token: string, cwd: string): string | null {
  const cleaned = stripTokenQuotes(token);
  if (cleaned === '' || /[$`]/.test(cleaned)) return null;
  const slash = cleaned.lastIndexOf('/');
  if (slash === -1) return normalize(cwd);
  const dirToken = slash === 0 ? '/' : cleaned.slice(0, slash);
  const resolved = tryResolvePath(dirToken, cwd);
  if (!resolved || resolved.source !== 'literal') return null;
  return normalize(resolved.path);
}

/** Каталог гранта внешнего пути: каталог → он сам, файл/нет пути → `dirname`. */
function grantDirectoryForExternalPath(path: string): string | null {
  const cleaned = stripTokenQuotes(path);
  if (cleaned === '' || /[$`]/.test(cleaned) || !isAbsolute(cleaned)) return null;
  const norm = normalize(cleaned);
  try {
    return statSync(norm).isDirectory() ? norm : dirname(norm);
  } catch {
    return dirname(norm);
  }
}

/** `commands` — все сегменты; `dynamic`/`external` → каталоги виновника. */
export function shellGrantPlan(
  command: string,
  trigger?: {
    params?: Record<string, string>;
    askKind?: 'dynamic' | 'protected' | 'mutation' | 'cwd' | 'external';
    /** Внешние пути проверки (`ShellCheckResult.askPaths`) — для `external`. */
    paths?: readonly string[];
  },
  options?: { cwd?: string },
): ShellGrantPlan {
  const delimiters = heredocDelimiters(command);
  const commands = splitShellSegments(stripHeredocBodies(command))
    .map((segment) => segment.trim())
    .filter((segment) => !isNonCommandSegment(segment, delimiters));

  if (!trigger || (trigger.askKind !== 'dynamic' && trigger.askKind !== 'external')) {
    return { commands, patterns: [], directories: [] };
  }

  // `external`: виновник известен по конкретным путям — грант каталогом.
  if (trigger.askKind === 'external') {
    const directories: string[] = [];
    const seen = new Set<string>();
    const push = (dir: string | null): void => {
      if (dir === null || seen.has(dir)) return;
      seen.add(dir);
      directories.push(dir);
    };
    for (const path of trigger.paths ?? []) push(grantDirectoryForExternalPath(path));
    if (directories.length === 0) {
      const accused = stripTokenQuotes(trigger.params?.path ?? '');
      push(grantDirectoryForExternalPath(accused));
      if (directories.length === 0) {
        push(grantDirectoryForToken(accused, options?.cwd ?? process.cwd()));
      }
    }
    return { commands, patterns: [], directories };
  }

  // Виновник ask'а — токен проверки. Сегменты-виновники — те, в токенах которых
  // он есть; не нашли — все сегменты.
  const accused = stripTokenQuotes(
    trigger.params?.path || trigger.params?.code || trigger.params?.command || '',
  );
  const accusedSet = new Set(accused === ''
    ? commands
    : commands.filter((segment) =>
        tokenizeCommand(segment).some((token) => stripTokenQuotes(token) === accused)));

  const directories: string[] = [];
  const seen = new Set<string>();
  // cwd сегментов проводим так же, как `checkShellCommand` (`cd`/`pushd`).
  let currentCwd = options?.cwd ?? process.cwd();
  for (const segment of commands) {
    if (accused !== '' && accusedSet.has(segment)) {
      const dir = grantDirectoryForToken(accused, currentCwd);
      if (dir !== null && !seen.has(dir)) {
        seen.add(dir);
        directories.push(dir);
      }
    }
    const nextCwd = cdTarget(segment, currentCwd);
    if (nextCwd !== null) currentCwd = nextCwd;
  }

  // Командный паттерн для `dynamic`-ask не выдаётся никогда (шире команды).
  return { commands, patterns: [], directories };
}
