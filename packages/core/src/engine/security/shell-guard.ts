/**
 * Shell-guard: лёгкая защита execute_shell по образцу hermes-agent
 * (file_safety.py) и opencode (tool/shell.ts), без tree-sitter.
 *
 * Ограничения дизайна:
 * - Токенизация shlex-подобная (кавычки, экранирование) — БЕЗ резолва
 *   динамики: `$()`, `${...}`, другие переменные, glob считаются
 *   «не удалось проверить» (source: 'unknown') и денлистом не матчатся.
 * - Ручной резолв только известных паттернов: `~`, `$HOME`, `$PWD`.
 *
 * Политика: системный дефолт `definitions/shell-policy.json` (публикуется
 * в npm, копируется в `dist/definitions/` при сборке) + пользовательский
 * override `{dataDir}/context/shell-policy.json`, полностью заменяющий
 * системный (аналогично loadSystemAgentDefinitions / контекстным файлам).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { globMatch } from '@itphx/synth-shared';
import { t as sm } from '../system-messages.js';

/** Политика безопасности execute_shell. */
export interface ShellPolicy {
  /** Точные пути, которые запрещено трогать (резолвятся с `~`). */
  deniedPaths: string[];
  /** Префиксы директорий, внутри которых всё запрещено. */
  deniedPrefixes: string[];
  /** Пути, которые разрешены только через подтверждение (ask). */
  approvalPaths: string[];
  /** Префиксы команд, запрещённые целиком (например "rm -rf /"). */
  deniedCommandPrefixes: string[];
}

/** Путь, извлечённый из аргументов команды. */
export interface ExtractedPath {
  path: string;
  source: 'literal' | 'unknown';
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

/**
 * Лёгкий shlex-токенизатор (POSIX-подобный).
 * - одинарные кавычки `'...'` — всё литерально;
 * - двойные кавычки `"..."` — кавычки снимаются, `\` экранирует следующий символ;
 * - `\` вне кавычек экранирует следующий символ;
 * - незакрытые кавычки дочитываются до конца строки (не бросаем ошибку).
 * Кавычки из токенов удаляются (как shlex.split).
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if ((ch === ' ' || ch === '\t' || ch === '\n') && !inSingle && !inDouble) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Односимвольные разделители команд POSIX-шелла. Двухсимвольные `&&`/`||`
 * обрабатываются отдельно (до односимвольных), чтобы не разбить на `&`/`|`.
 */
const SHELL_SEPARATORS = new Set([';', '&', '|', '\n']);

/**
 * Разбивает команду на сегменты по разделителям: `;`, `&&`, `||`, `&`, `|`
 * и переводу строки. Разделители ВНУТРИ кавычек (`'...'`, `"..."`) и внутри
 * подстановок `$(...)` НЕ разбивают команду — shell не выполняет их как
 * операторы. Каждый сегмент возвращается без ведущих/хвостовых пробелов.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let substitutionDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble && substitutionDepth === 0) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle && substitutionDepth === 0) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      // Подстановка $(...) — содержимое не анализируем (динамика), но и не
      // разбиваем по разделителям внутри.
      if (ch === '$' && command[i + 1] === '(') {
        substitutionDepth++;
        current += '$(';
        i++;
        continue;
      }
      if (ch === ')' && substitutionDepth > 0) {
        substitutionDepth--;
        current += ch;
        continue;
      }
    }
    if (substitutionDepth === 0 && !inSingle && !inDouble) {
      if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
        if (current.trim() !== '') segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (SHELL_SEPARATORS.has(ch)) {
        if (current.trim() !== '') segments.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim() !== '') segments.push(current.trim());
  return segments;
}

/**
 * Извлекает вложенную команду из обёрток, исполняющих строку как shell-код:
 * `sh -c <cmd>`, `bash -c <cmd>`, `zsh -c <cmd>`, `eval <cmd>`, `sudo <cmd>`.
 * Возвращает null, если команда не является обёрткой.
 */
export function extractWrappedCommand(segment: string, tokens: string[]): string | null {
  const cmd = tokens[0] ?? '';
  if ((cmd === 'sh' || cmd === 'bash' || cmd === 'zsh') && tokens[1] === '-c') {
    const rest = tokens.slice(2).join(' ');
    if (rest.trim() !== '') return rest;
    // fallback: токенизатор мог потерять кавычки — берём сырой остаток строки.
    const m = /(?:^|\s)-c\s+([\s\S]*)$/.exec(segment);
    return m ? m[1]! : null;
  }
  if (cmd === 'eval' || cmd === 'sudo') {
    const rest = tokens.slice(1).join(' ');
    if (rest.trim() !== '') return rest;
    const m = new RegExp(`^${cmd}\\s+([\\s\\S]*)$`).exec(segment);
    return m ? m[1]! : null;
  }
  return null;
}

/** Есть ли в токене динамика, которую мы не умеем резолвить. */
function hasUnresolvedDynamic(text: string): boolean {
  return /[$*?[(`]/.test(text);
}

/** Пытается зарезолвить токен в абсолютный путь. */
export function tryResolvePath(token: string, cwd: string): ExtractedPath | null {
  if (token === '') return null;

  let base = '';
  let rest = token;

  // Ручной резолв известных паттернов в начале токена: ~, $HOME, $PWD.
  const homeMatch = /^~(?:\/|$)/.exec(token);
  if (homeMatch) {
    base = HOME;
    rest = token.slice(1);
    if (rest.startsWith('/')) rest = rest.slice(1);
  } else {
    const dollar = /^(\$(?:HOME|PWD)|\$\{(?:HOME|PWD)\})(?:\/|$)/.exec(token);
    if (dollar) {
      const varName = dollar[1]!.includes('PWD') ? 'PWD' : 'HOME';
      base = varName === 'HOME' ? HOME : cwd;
      rest = token.slice(dollar[1]!.length);
      if (rest.startsWith('/')) rest = rest.slice(1);
    }
  }

  // Если в остатке ещё есть динамика — не смогли проверить.
  if (base === '') {
    if (hasUnresolvedDynamic(token)) {
      return { path: resolve(cwd, token), source: 'unknown' };
    }
    return { path: resolve(cwd, token), source: 'literal' };
  }

  if (rest === '') {
    return { path: base, source: 'literal' };
  }
  if (hasUnresolvedDynamic(rest)) {
    return { path: resolve(base, rest), source: 'unknown' };
  }
  return { path: resolve(base, rest), source: 'literal' };
}

/**
 * Извлекает пути из аргументов команды (первый токен — сама команда).
 * Флаги (`-` префикс) пропускаются; после `--` всё считается аргументами.
 * Токены с динамикой ($, *, ?, [, (, `) помечаются source: 'unknown'.
 */
export function extractCommandPaths(tokens: string[], cwd: string): ExtractedPath[] {
  if (tokens.length === 0) return [];
  const args = tokens.slice(1);
  const result: ExtractedPath[] = [];
  let afterDoubleDash = false;

  for (const token of args) {
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true;
      continue;
    }
    // Флаги пропускаем; "-" (stdin) и "--" уже обработаны.
    if (!afterDoubleDash && token.startsWith('-') && token.length > 1) continue;

    const extracted = tryResolvePath(token, cwd);
    if (extracted) result.push(extracted);
  }
  return result;
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

function isMutatingSegment(tokens: string[]): boolean {
  if (tokens.length === 0) return false;

  // sudo <cmd> — анализируем вложенную команду (снимаем все префиксы sudo).
  let effectiveTokens = tokens;
  while (effectiveTokens[0] === 'sudo') effectiveTokens = effectiveTokens.slice(1);
  const cmd = effectiveTokens[0] ?? '';

  if (MUTATING_SIMPLE.has(cmd)) return true;

  if (cmd === 'git') {
    const sub = effectiveTokens[1] ?? '';
    return MUTATING_GIT.has(sub);
  }

  const subcommands = MUTATING_SUBCOMMAND[cmd];
  if (subcommands) {
    return subcommands.has(effectiveTokens[1] ?? '');
  }

  if (cmd === 'curl' || cmd === 'wget') {
    const flags = cmd === 'curl' ? CURL_WRITE_FLAGS : WGET_WRITE_FLAGS;
    return effectiveTokens.some((t) => flags.has(t));
  }

  // sed по умолчанию мутирующий; read-only только с -n (печать в stdout).
  if (cmd === 'sed') {
    return !effectiveTokens.includes('-n');
  }

  // find изменяет состояние только с -delete/-exec/-execdir (read-only поиск — нет).
  if (cmd === 'find') {
    return effectiveTokens.includes('-delete')
      || effectiveTokens.includes('-exec')
      || effectiveTokens.includes('-execdir');
  }

  return false;
}

/**
 * Является ли отдельный сегмент (одна команда без разделителей) мутирующим.
 * Учитывает перенаправления, обёртки (sh -c / eval / sudo) — вложенная команда
 * анализируется рекурсивно.
 */
function isSegmentMutating(segment: string): boolean {
  const segTokens = tokenizeCommand(segment);
  if (segTokens.length === 0) return false;
  // Перенаправления пишут в файл независимо от команды.
  if (segTokens.some((t) => t === '>' || t === '>>')) return true;
  if (isMutatingSegment(segTokens)) return true;

  // Обёртки (sh -c / bash -c / zsh -c / eval / sudo): рекурсивно проверяем
  // вложенную команду (B4).
  const inner = extractWrappedCommand(segment, segTokens);
  if (inner !== null) {
    return splitShellSegments(inner).some(isSegmentMutating);
  }
  return false;
}

/**
 * Является ли команда изменяющей состояние (для plan-режима и денлиста).
 * Команда разбивается на сегменты по ВСЕМ разделителям (`;`, `&&`, `||`, `&`,
 * `|`, `\n` вне кавычек/`$()`); если ЛЮБОЙ сегмент мутирующий — deny (B1).
 * Read-only: ls, cat, pwd, echo, grep, find без -delete/-exec, git
 * status/diff/log/show/blame/branch, head, tail, wc, sort, uniq, sed -n, awk,
 * which, type, env, printenv, date, whoami, curl без write-флагов, wget без
 * write-флагов.
 */
export function isMutatingCommand(tokens: string[], command: string): boolean {
  if (tokens.length === 0 && command.trim() === '') return false;
  return splitShellSegments(command).some(isSegmentMutating);
}

// ---------------------------------------------------------------------------
// Загрузка политики (системный дефолт + пользовательский override)
// ---------------------------------------------------------------------------

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

/** Поиск корня пакета @itphx/synth-core по package.json вверх (как в context/config.ts). */
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

/**
 * Каталог системных definitions: {root}/definitions (источник, публикуется
 * в npm через files) с fallback на {root}/dist/definitions (Docker: рядом с
 * package.json только dist/).
 */
export function resolveSystemDefinitionsDir(): string {
  const root = findPackageRoot(CURRENT_DIR);
  const candidates = [join(root, 'definitions'), join(root, 'dist', 'definitions')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export interface ShellPolicyOptions {
  /** Каталог системных definitions (по умолчанию резолвится от пакета). */
  systemDir?: string;
  /** Пользовательский override: {dataDir}/context/shell-policy.json. */
  overridePath?: string;
}

/** Кэш политик по ключу «systemDir|overridePath». */
const policyCache = new Map<string, ShellPolicy>();

/** Сброс кэша (для тестов). */
export function clearShellPolicyCache(): void {
  policyCache.clear();
}

function readPolicyFile(path: string): ShellPolicy | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ShellPolicy>;
    return {
      deniedPaths: Array.isArray(parsed.deniedPaths) ? parsed.deniedPaths : [],
      deniedPrefixes: Array.isArray(parsed.deniedPrefixes) ? parsed.deniedPrefixes : [],
      approvalPaths: Array.isArray(parsed.approvalPaths) ? parsed.approvalPaths : [],
      deniedCommandPrefixes: Array.isArray(parsed.deniedCommandPrefixes) ? parsed.deniedCommandPrefixes : [],
    };
  } catch {
    return null;
  }
}

/**
 * Загружает политику: системный дефолт definitions/shell-policy.json +
 * override {dataDir}/context/shell-policy.json (если существует — полностью
 * заменяет системный). Некорректные файлы игнорируются; результат кэшируется.
 */
export function loadShellPolicy(options: ShellPolicyOptions = {}): ShellPolicy {
  const systemDir = options.systemDir ?? resolveSystemDefinitionsDir();
  const overridePath = options.overridePath ?? '';
  const key = `${systemDir}|${overridePath}`;

  const cached = policyCache.get(key);
  if (cached) return cached;

  let policy = DEFAULT_POLICY;
  const systemPolicy = readPolicyFile(join(systemDir, 'shell-policy.json'));
  if (systemPolicy) policy = systemPolicy;

  if (overridePath) {
    const overridePolicy = readPolicyFile(overridePath);
    if (overridePolicy) policy = overridePolicy;
  }

  policyCache.set(key, policy);
  return policy;
}

// ---------------------------------------------------------------------------
// Проверка команды
// ---------------------------------------------------------------------------

/**
 * Проверяет команду по политике. Команда разбивается на сегменты по всем
 * разделителям (`;`, `&&`, `||`, `&`, `|`, `\n`); если ЛЮБОЙ сегмент нарушает
 * политику — deny/ask (B1/B2). Обёртки `sh -c`/`bash -c`/`zsh -c`/`eval`/`sudo`
 * анализируются рекурсивно по вложенной команде (B4).
 *
 * Порядок внутри сегмента (deny-приоритет сверху вниз):
 *   1. deniedCommandPrefixes — префиксы команд (по токенам сегмента);
 *   2. deniedPaths — точные запрещённые пути;
 *   3. approvalPaths — пути под подтверждение (ask);
 *   4. deniedPrefixes — запрещённые префиксы директорий.
 * ApprovalPaths проверяются ДО deniedPrefixes, чтобы ~/.ssh/config не
 * «проглатывался» префиксом ~/.ssh (как в hermes file_safety.py).
 */
export function checkShellCommand(command: string, cwd: string, policy: ShellPolicy): ShellCheckResult {
  // Точное совпадение всей команды (например форк-бомба с разделителями внутри).
  for (const prefix of policy.deniedCommandPrefixes) {
    if (normalizeSpace(prefix) === normalizeSpace(command)) {
      return deniedByPrefix(prefix);
    }
  }

  const segments = splitShellSegments(command);
  if (segments.length === 0) {
    return { action: 'allow', reason: sm('shellguard.allow_default') };
  }

  const deniedPaths = policy.deniedPaths.map(expandHome);
  const approvalPaths = policy.approvalPaths.map(expandHome);
  const deniedPrefixes = policy.deniedPrefixes.map(expandHome);

  for (const segment of segments) {
    const result = checkShellSegment(segment, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes);
    if (result) return result;
  }

  return { action: 'allow', reason: sm('shellguard.allow_default') };
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

/** Проверяет один сегмент команды; null — сегмент не нарушает политику. */
function checkShellSegment(
  segment: string,
  cwd: string,
  policy: ShellPolicy,
  deniedPaths: string[],
  approvalPaths: string[],
  deniedPrefixes: string[],
): ShellCheckResult | null {
  const tokens = tokenizeCommand(segment);
  if (tokens.length === 0) return null;

  // 1. Запрещённые префиксы команд — матчатся в ЛЮБОМ сегменте (B2).
  for (const prefix of policy.deniedCommandPrefixes) {
    const prefixTokens = tokenizeCommand(prefix);
    if (prefixTokens.length > 0 && tokens.length >= prefixTokens.length
      && prefixTokens.every((t, i) => tokens[i] === t)) {
      return deniedByPrefix(prefix);
    }
    if (normalizeSpace(prefix) === normalizeSpace(segment)) {
      return deniedByPrefix(prefix);
    }
  }

  // 1b. Обёртки: sh -c / bash -c / zsh -c / eval / sudo — рекурсивно проверяем
  // вложенную команду (B4).
  const inner = extractWrappedCommand(segment, tokens);
  if (inner !== null) {
    const innerSegments = splitShellSegments(inner);
    for (const s of innerSegments) {
      const r = checkShellSegment(s, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes);
      if (r) return r;
    }
  }

  const extracted = extractCommandPaths(tokens, cwd);

  // 2. Точные запрещённые пути.
  for (const { path, source } of extracted) {
    if (source !== 'literal') continue;
    const norm = normalize(path);
    const hit = deniedPaths.find((p) => normalize(p) === norm);
    if (hit) {
      return {
        action: 'deny',
        reason: sm('shellguard.deny_path', { path: hit }),
        matchedRule: 'shell-policy.deny',
        deniedPath: hit,
        messageId: 'deny-protected-path',
        params: { path: normalize(hit) },
      };
    }
  }

  // 3. Пути под подтверждение (ask).
  for (const { path, source } of extracted) {
    if (source !== 'literal') continue;
    const norm = normalize(path);
    const hit = approvalPaths.find((p) => normalize(p) === norm);
    if (hit) {
      return {
        action: 'ask',
        reason: sm('shellguard.ask_path', { path: hit }),
        matchedRule: 'shell-policy.approve',
        deniedPath: hit,
        messageId: 'ask-protected-path',
        params: { path: normalize(hit) },
      };
    }
  }

  // 4. Запрещённые префиксы директорий.
  for (const { path, source } of extracted) {
    if (source !== 'literal') continue;
    const norm = normalize(path);
    const hit = deniedPrefixes.find((p) => {
      const prefix = normalize(p);
      return norm === prefix || norm.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
    });
    if (hit) {
      return {
        action: 'deny',
        reason: sm('shellguard.deny_dir', { path: norm, dir: hit }),
        matchedRule: 'shell-policy.deny',
        deniedPath: hit,
        messageId: 'deny-protected-dir',
        params: { path: norm, dir: normalize(hit) },
      };
    }
  }

  return null;
}

/**
 * Матчит паттерн командного правила (permission.rules.shell) к команде.
 * - `*` — любая команда;
 * - `git commit *` / `npm install *` — префиксный матч по токенам;
 * - без glob-символов — точное совпадение команды;
 * - иначе — fallback на globMatch (редкие случаи).
 */
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
