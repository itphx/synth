/**
 * Shell-guard: лёгкая защита execute_shell по образцу hermes-agent
 * (file_safety.py) и opencode (tool/shell.ts), без tree-sitter.
 *
 * Ограничения дизайна:
 * - Токенизация shlex-подобная (кавычки, экранирование) — БЕЗ полного резолва
 *   динамики: `$()`, `${...}`, другие переменные, glob считаются
 *   «не удалось проверить» (source: 'unknown') и точным денлистом не матчатся.
 * - Ручной резолв известных паттернов: `~`, `$HOME`, `$PWD`, `$SYNTH_DATA_DIR`
 *   (при известном `policy.dataDir`).
 * - FAIL-CLOSED для неразрешимой динамики (иначе `cat $SYNTH_DATA_DIR/secrets/
 *   master.key` обходил денлист молча):
 *     1. литеральные фрагменты токена проверяются по «маркерам» политики
 *        (basename'ы deniedPaths/deniedPrefixes): попадание → deny;
 *     2. значения присваиваний `NAME=value` проверяются как пути → deny;
 *     3. остальная неоднозначная динамика-путь → ask (не пропускаем молча).
 *
 * Политика: системный дефолт `definitions/shell-policy.json` (публикуется
 * в npm, копируется в `dist/definitions/` при сборке) + пользовательский
 * override `{dataDir}/context/shell-policy.json`, полностью заменяющий
 * системный (аналогично loadSystemAgentDefinitions / контекстным файлам).
 */
import { readFileSync, existsSync, opendirSync, type Dir } from 'node:fs';
import { join, dirname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { globMatch, type PermissionRule } from '@itphx/synth-shared';
import { resolveRealPath, isLexicallyInside } from '../tools/path-utils.js';
import { t as sm } from '../system-messages.js';
import { tokenizeCommand, splitShellSegments } from './shell-lexer.js';
import { collectBindings, expandToken, type ShellBinding } from './shell-variables.js';

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
  /**
   * dataDir инстанса (ADR-005), если известен. Используется для резолва
   * `$SYNTH_DATA_DIR`/`${SYNTH_DATA_DIR}` в токенах. Политику защищённых путей
   * (`ProtectedPathsPolicy`) оркестратор передаёт как shell-policy, поэтому поле
   * приходит и сюда (для `{dataDir}/secrets` in `deniedPrefixes`).
   */
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
   * Причина `ask` (для снятия сессионным shell-грантом). Снимается только
   * `dynamic`; `protected`/`mutation`/`cwd` — никогда.
   */
  askKind?: 'dynamic' | 'protected' | 'mutation' | 'cwd';
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

// Лексер вынесен в `shell-lexer.ts` (его использует и `shell-variables.ts`);
// здесь — реэкспорт: публичный API guard'а не меняется.
export { tokenizeCommand, splitShellSegments } from './shell-lexer.js';

const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh']);
/** Имя shell по basename (`/bin/sh` → `sh`). */
function shellBasename(cmd: string): string {
  const slash = cmd.lastIndexOf('/');
  return slash >= 0 ? cmd.slice(slash + 1) : cmd;
}
const EMPTY_FLAGS: ReadonlySet<string> = new Set();
const SUDO_VALUE_FLAGS: ReadonlySet<string> = new Set(['-u', '-g', '-p', '-C', '-D', '-h', '-r', '-t', '-U', '--user', '--group', '--prompt', '--chdir', '--close-from']);
const EXEC_VALUE_FLAGS: ReadonlySet<string> = new Set(['-a']);
const STDBUF_VALUE_FLAGS: ReadonlySet<string> = new Set(['-i', '-o', '-e']);
const IONICE_VALUE_FLAGS: ReadonlySet<string> = new Set(['-c', '-n', '-p']);
const XARGS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-I', '-n', '-P', '-d', '-E', '-L', '-s', '-a',
  '--delimiter', '--max-args', '--max-procs', '--arg-file', '--max-lines',
  '--max-chars', '--eof', '--replace', '--max-procs',
]);
const SU_VALUE_FLAGS: ReadonlySet<string> = new Set(['-c', '--command', '-s', '--shell', '-g', '--group', '-G', '-u', '--user', '-w', '--whitelist-environment']);
const DOAS_VALUE_FLAGS: ReadonlySet<string> = new Set(['-C', '-u']);
const CHROOT_VALUE_FLAGS: ReadonlySet<string> = new Set(['--userspec', '--groups']);
const UNSHARE_VALUE_FLAGS: ReadonlySet<string> = new Set(['--setgroups', '--propagation', '--map-user', '--map-group', '--map-users', '--map-groups']);
const NSENTER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-t', '--target', '-S', '--setuid', '-G', '--setgid', '-r', '--root', '-w', '--wd',
  '--wdns', '--target-ns',
]);
const SYSTEMD_RUN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-p', '--property', '-u', '--unit', '-E', '--setenv', '--description', '--slice',
  '--working-directory', '--uid', '--gid', '--nice', '--on-active', '--on-boot',
  '--on-startup', '--on-unit-active', '--on-unit-inactive', '--on-calendar', '--timer-property',
]);
const SSH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-p', '-i', '-o', '-l', '-F', '-L', '-R', '-D', '-b', '-c', '-e', '-m', '-S', '-W', '-w', '-J', '-Q', '-O', '-E',
]);
const SCRIPT_VALUE_FLAGS: ReadonlySet<string> = new Set(['-c', '--command', '-I', '--log-in', '-O', '--log-out', '-E', '--log-io', '-T', '--log-timing', '--logging-format']);

/** Пропускает опции враппера (флаги со значением — парами). */
function skipWrapperOptions(
  tokens: readonly string[],
  start: number,
  valueFlags: ReadonlySet<string>,
): number {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === '--') return i + 1;
    if (valueFlags.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

/** Экранирует токен для обратной склейки в shell-строку (границы аргументов). */
function quoteShellToken(token: string): string {
  if (token !== '' && /^[A-Za-z0-9_@%+=:,./~$^*?-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Склеивает токены в строку с сохранением границ аргументов. */
function joinShellTokens(tokens: readonly string[]): string {
  return tokens.map(quoteShellToken).join(' ');
}

/**
 * Извлекает вложенную команду из обёрток: `sh -c`, `eval`, `sudo`, `env`,
 * `timeout`, `command`, `builtin`, `exec`, `nohup`, `setsid`, `nice`, `stdbuf`,
 * `ionice`, `watch`, `flock`, `xargs`. Ведущие обёртки снимаются послойно,
 * проверяется итоговая команда. `null` — не обёртка.
 */
export function extractWrappedCommand(segment: string, tokens: string[]): string | null {
  let i = 0;
  for (;;) {
    const cmd = tokens[i];
    if (cmd === undefined) return null;

    if (SHELL_COMMANDS.has(shellBasename(cmd))) {
      // `-c`, слитные `-lc`/`-ec` и приклеенная строка `-c'cmd'`.
      const flag = /^-([A-Za-z]*)c(.*)$/.exec(tokens[i + 1] ?? '');
      if (flag) {
        const rest = [flag[2] ?? '', ...tokens.slice(i + 2)].filter((t) => t !== '').join(' ');
        if (rest.trim() !== '') return rest;
        // fallback: токенизатор мог потерять кавычки — берём сырой остаток строки.
        const m = /(?:^|\s)-[A-Za-z]*c([\s\S]*)$/.exec(segment);
        return m ? m[1]! : null;
      }
      return i === 0 ? null : joinShellTokens(tokens.slice(i));
    }
    if (cmd === 'eval') {
      const rest = tokens.slice(i + 1).join(' ');
      if (rest.trim() !== '') return rest;
      const m = /(?:^|\s)eval\s+([\s\S]*)$/.exec(segment);
      return m ? m[1]! : null;
    }
    if (cmd === 'sudo') {
      i = skipWrapperOptions(tokens, i + 1, SUDO_VALUE_FLAGS);
    } else if (cmd === 'env') {
      let j = i + 1;
      while (j < tokens.length) {
        const t = tokens[j]!;
        if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir') {
          j += 2;
          continue;
        }
        if (t.startsWith('-') && t.length > 1) {
          j += 1;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
          j += 1;
          continue;
        }
        break;
      }
      i = j;
    } else if (cmd === 'timeout') {
      let j = i + 1;
      while (j < tokens.length && tokens[j]!.startsWith('-')) {
        const t = tokens[j]!;
        if (t === '-s' || t === '--signal' || t === '-k' || t === '--kill-after') j += 2;
        else j += 1;
      }
      j += 1; // длительность
      i = j;
    } else if (cmd === 'command') {
      let j = i + 1;
      // `-v`/`-V` — поиск, а не исполнение: не разворачиваем.
      if (tokens[j] === '-v' || tokens[j] === '-V') return null;
      if (tokens[j] === '-p') j += 1;
      i = j;
    } else if (cmd === 'builtin' || cmd === 'nohup') {
      i += 1;
    } else if (cmd === 'exec') {
      i = skipWrapperOptions(tokens, i + 1, EXEC_VALUE_FLAGS);
    } else if (cmd === 'setsid') {
      i = skipWrapperOptions(tokens, i + 1, EMPTY_FLAGS);
    } else if (cmd === 'nice') {
      let j = i + 1;
      const t = tokens[j] ?? '';
      if (t === '-n' || t === '--adjustment') j += 2;
      else if (/^-\d+$/.test(t) || /^-n\d+$/.test(t) || t.startsWith('--adjustment=')) j += 1;
      i = j;
    } else if (cmd === 'stdbuf') {
      i = skipWrapperOptions(tokens, i + 1, STDBUF_VALUE_FLAGS);
    } else if (cmd === 'ionice') {
      i = skipWrapperOptions(tokens, i + 1, IONICE_VALUE_FLAGS);
    } else if (cmd === 'watch') {
      let j = i + 1;
      while (j < tokens.length && tokens[j]!.startsWith('-')) {
        if (tokens[j] === '-n' || tokens[j] === '--interval') j += 2;
        else j += 1;
      }
      if (/^\d/.test(tokens[j] ?? '')) j += 1; // интервал
      // watch исполняет команду через `sh -c`: одиночный аргумент — код.
      if (tokens[j] !== undefined && /\s/.test(tokens[j]!)) return tokens[j]!;
      i = j;
    } else if (cmd === 'flock') {
      let j = i + 1;
      while (j < tokens.length && tokens[j]!.startsWith('-')) {
        if (tokens[j] === '-w' || tokens[j] === '--timeout') j += 2;
        else j += 1;
      }
      if (j < tokens.length && !tokens[j]!.startsWith('-')) j += 1; // lockfile
      // `flock <lock> -c <code>`: код — команда.
      if (tokens[j] === '-c' || tokens[j] === '--command') {
        return tokens[j + 1] ?? null;
      }
      i = j;
    } else if (cmd === 'xargs') {
      i = skipWrapperOptions(tokens, i + 1, XARGS_VALUE_FLAGS);
    } else if (cmd === 'su' || cmd === 'runuser') {
      i = skipWrapperOptions(tokens, i + 1, SU_VALUE_FLAGS);
    } else if (cmd === 'doas') {
      i = skipWrapperOptions(tokens, i + 1, DOAS_VALUE_FLAGS);
    } else if (cmd === 'chroot') {
      let j = skipWrapperOptions(tokens, i + 1, CHROOT_VALUE_FLAGS);
      if (j < tokens.length && !tokens[j]!.startsWith('-')) j += 1; // newroot
      i = j;
    } else if (cmd === 'unshare') {
      i = skipWrapperOptions(tokens, i + 1, UNSHARE_VALUE_FLAGS);
    } else if (cmd === 'nsenter') {
      i = skipWrapperOptions(tokens, i + 1, NSENTER_VALUE_FLAGS);
    } else if (cmd === 'systemd-run') {
      i = skipWrapperOptions(tokens, i + 1, SYSTEMD_RUN_VALUE_FLAGS);
    } else if (cmd === 'ssh') {
      let j = skipWrapperOptions(tokens, i + 1, SSH_VALUE_FLAGS);
      if (j < tokens.length && !tokens[j]!.startsWith('-')) j += 1; // host
      // Удалённая команда исполняется шеллом — разбираем как код (plain join).
      return j < tokens.length ? tokens.slice(j).join(' ') : null;
    } else if (cmd === 'script') {
      const j = skipWrapperOptions(tokens, i + 1, SCRIPT_VALUE_FLAGS);
      // Остаток — команда/файл typescript; скрипт исполняется шеллом.
      return j < tokens.length ? tokens.slice(j).join(' ') : null;
    } else {
      return i === 0 ? null : joinShellTokens(tokens.slice(i));
    }

    if (i >= tokens.length) return null;
  }
}

/** Есть ли в токене динамика, которую мы не умеем резолвить. */
function hasUnresolvedDynamic(text: string): boolean {
  // `)` — часть `$(...)`: токенизатор не режет подстановку, и закрывающая
  // скобка остаётся в пути (`$(echo /etc/passwd)` → токен `/etc/passwd)`).
  return /[$*?[`()]/.test(text);
}

/** Символы динамики — разделители при выделении литеральных фрагментов токена. */
const DYNAMIC_CHARS_RE = /[$*?[\](){}`]+/;

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

  // `/proc/<pid|self>/root|/cwd/<path>` — тот же файл, что `<path>`; проверяем
  // остаток ДО лексической нормализации (иначе `root/..` съедается как `/proc`).
  const procAlias = /^\/proc\/(?:\d+|self)\/(?:root|cwd)(\/.+)$/.exec(token);
  if (procAlias) {
    const inner = procAlias[1]!;
    return {
      path: normalize(inner),
      source: hasUnresolvedDynamic(inner) ? 'unknown' : 'literal',
    };
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
export function extractCommandPaths(tokens: string[], cwd: string, env?: PathResolveEnv): ExtractedPath[] {
  return extractCommandPathTokens(tokens, cwd, env).map((entry) => entry.resolved);
}

/** Семейство grep-подобных команд (первый не-флаговый аргумент — паттерн). */
const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep', 'rg']);
const AWK_FAMILY = new Set(['awk', 'gawk', 'mawk']);
/** Интерпретаторы с кодом в `-c`/`-e`. */
const INTERPRETER_COMMANDS = new Set(['python', 'python3', 'node', 'nodejs', 'perl', 'ruby', 'php']);

/**
 * Команды, которым можно передать строку-команду/код (F). Для них аргументы
 * сканируются на «похожесть на команду/код» и проверяются рекурсивно.
 */
const EMBEDDED_EXECUTORS = new Set([
  'env', 'sudo', 'su', 'runuser', 'doas', 'script', 'ssh', 'chroot', 'unshare',
  'nsenter', 'systemd-run', 'nice', 'flock', 'xargs', 'timeout', 'command',
  'nohup', 'setsid', 'stdbuf', 'ionice', 'watch', 'exec', 'builtin',
  'awk', 'gawk', 'mawk', 'find',
  'sh', 'bash', 'zsh', 'dash', 'ksh',
  'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun',
  'docker', 'podman', 'nerdctl', 'kubectl', 'oc',
]);
/** Префиксы interpreters/shell с версией (`python3.11`, `node20`, `sh4`). */
const EMBEDDED_VERSIONED_PREFIXES = [
  'python3', 'python', 'node', 'nodejs', 'php', 'ruby', 'perl', 'deno', 'bun',
  'bash', 'zsh', 'dash', 'ksh', 'sh',
];
/** Флаги, значение которых — команда/код. */
const CODE_VALUE_FLAGS = new Set([
  '-c', '--command', '-e', '--eval', '-r', '-p', '--print', '-S', '--split-string',
]);
const REDIRECT_OPERATOR_TOKENS = new Set(['&>>', '>>', '>&', '>|', '<>', '<&', '&>', '>', '<']);
/** Максимальная глубина рекурсивной проверки встроенных команд. */
const MAX_EMBEDDED_DEPTH = 3;

/** Команда входит в набор встроенных исполнителей (с версионными префиксами). */
function isEmbeddedExecutor(cmd: string): boolean {
  const base = shellBasename(cmd);
  if (EMBEDDED_EXECUTORS.has(base)) return true;
  return EMBEDDED_VERSIONED_PREFIXES.some((prefix) => {
    if (!base.startsWith(prefix)) return false;
    const suffix = base.slice(prefix.length);
    return suffix !== '' && /^[0-9.]+$/.test(suffix);
  });
}

/** Является ли токен code-флагом (`-c`, `--eval`, `--eval=…`, `-c<code>`). */
function isCodeFlagToken(token: string): boolean {
  if (CODE_VALUE_FLAGS.has(token)) return true;
  if (/^--(?:eval|command|print|split-string)=/.test(token)) return true;
  return /^-[ceprp]./.test(token) && !token.startsWith('--');
}
// `find`: значения `-path/-ipath/-wholename/-regex/-iregex` НЕ пропускаем —
// `-path` матчит полный путь (`*` пересекает `/`), поэтому относительный
// glob-паттерн может указывать на защищённый путь. `-name/-iname` тоже не
// пропускаем: шаблон без `/` (`*.ts`) путём не считается и так.

/** Флаги grep/rg, у которых значение — отдельный аргумент. */
const GREP_VALUE_FLAGS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '--after-context',
  '-B', '--before-context', '-C', '--context', '--include', '--exclude',
  '--exclude-dir', '--include-dir', '--label', '-d', '--directories', '-D',
  '--devices', '--binary-files', '--group-separator', '--field-match-separator',
  '--field-context-separator', '-g', '--glob', '-t', '--type', '-T', '--type-not',
  '--type-add', '--type-clear', '--max-depth', '--maxdepth', '--replace',
  '--replace-with', '--pre', '--pre-glob', '--encoding',
  '--sort', '--sortr', '--threads', '-j', '--max-columns', '--max-filesize',
  '--path-separator', '--context-separator', '--colors', '--color',
]);
/** Флаги sed, у которых значение — отдельный аргумент. */
const SED_VALUE_FLAGS = new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length']);
/** Флаги awk, у которых значение — отдельный аргумент. */
const AWK_VALUE_FLAGS = new Set(['-F', '--field-separator', '-v', '--assign', '-f', '--file', '-i', '--include', '-l', '--load']);
/** Флаги jq, у которых ДВА аргумента: имя и значение (файл — путь). */
const JQ_TWO_ARG_FLAGS = new Set(['--arg', '--argjson', '--slurpfile', '--rawfile', '--argfile']);
/** Флаги jq с одним аргументом (не фильтр). */
const JQ_ONE_ARG_FLAGS = new Set(['--indent', '--tab-width', '--library-path', '-L']);

/** Ведущее присваивание (`NAME=…`, `NAME+=…`) — не имя команды. */
function isLeadingAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(token);
}

/** Индекс имени команды сегмента (первый токен, не являющийся присваиванием). */
function commandIndex(tokens: readonly string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isLeadingAssignment(t)) continue;
    if (t === 'export' && i === 0) continue;
    return i;
  }
  return -1;
}

/** Имя команды сегмента (первый токен, не являющийся ведущим присваиванием). */
function commandToken(tokens: readonly string[]): string {
  const idx = commandIndex(tokens);
  return idx === -1 ? '' : tokens[idx]!;
}

/**
 * Индексы аргументов-паттернов (не файловых операндов) в токенах сегмента.
 *
 * Нужны для шага 6: sed-скрипт замены, regexp grep, шаблон find, программа awk,
 * набор tr, разделитель cut, фильтр jq — это не пути, и подтверждение на них
 * не запрашивается.
 */
function patternArgumentIndices(tokens: string[]): Set<number> {
  const skip = new Set<number>();
  if (tokens.length === 0) return skip;
  let cmdIdx = 0;
  while (cmdIdx < tokens.length
    && (tokens[cmdIdx] === 'sudo' || isLeadingAssignment(tokens[cmdIdx]!))) cmdIdx++;
  const cmd = tokens[cmdIdx] ?? '';
  const base = cmdIdx + 1;

  if (cmd === 'sed') {
    let hasExpression = false;
    for (let i = base; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === '-e' || t === '--expression') {
        hasExpression = true;
        if (i + 1 < tokens.length) skip.add(i + 1);
      } else if (t.startsWith('--expression=')) {
        hasExpression = true;
      } else if (t.startsWith('-e') && t.length > 2) {
        // слитная форма `-e's/a/b/'`
        hasExpression = true;
      } else if (t === '-f' || t === '--file' || t === '-l' || t === '--line-length') {
        i++; // значение — файл/число, не паттерн
      }
    }
    if (!hasExpression) {
      for (let i = base; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (SED_VALUE_FLAGS.has(t)) { i++; continue; }
        if (t.startsWith('-') && t.length > 1) continue;
        // «Скрипт», который выглядит как путь (`sed /etc/shadow`), проверяем
        // как операнд, а не пропускаем.
        const looksPath = t.startsWith('/') || t.startsWith('~')
          || t.startsWith('./') || t.startsWith('../');
        if (!looksPath) skip.add(i);
        break;
      }
    }
    return skip;
  }

  if (GREP_FAMILY.has(cmd)) {
    // ripgrep без паттерна (`rg --files`, `rg --type-list`) — первый операнд
    // это путь, а не паттерн.
    if (cmd === 'rg' && tokens.some((t) => t === '--files' || t === '--type-list')) return skip;
    let hasPatternSource = false;
    for (let i = base; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === '-e' || t === '--regexp') {
        hasPatternSource = true;
        if (i + 1 < tokens.length) skip.add(i + 1);
      } else if (t.startsWith('--regexp=')) {
        hasPatternSource = true;
      } else if (t === '-f' || t === '--file') {
        hasPatternSource = true;
        i++; // файл с паттернами — путь, не паттерн
      } else if (GREP_VALUE_FLAGS.has(t)) {
        i++;
      }
    }
    if (!hasPatternSource) {
      for (let i = base; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (GREP_VALUE_FLAGS.has(t)) { i++; continue; }
        if (t.startsWith('-') && t.length > 1) continue;
        skip.add(i);
        break;
      }
    }
    return skip;
  }

  if (AWK_FAMILY.has(cmd)) {
    let hasProgramFile = false;
    for (let i = base; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === '-f' || t === '--file') { hasProgramFile = true; i++; continue; }
      if (AWK_VALUE_FLAGS.has(t)) { i++; continue; }
    }
    if (!hasProgramFile) {
      for (let i = base; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (AWK_VALUE_FLAGS.has(t)) { i++; continue; }
        if (t.startsWith('-') && t.length > 1) continue;
        skip.add(i);
        break;
      }
    }
    return skip;
  }

  // `find` больше не имеет пропускаемых аргументов: значения `-path/-ipath/
  // -wholename/-name/-iname/-regex/-iregex` проверяются как пути. Шаблон без
  // `/` (`*.ts`) путём не считается — `find . -name '*.ts'` остаётся allow.

  if (cmd === 'tr') {
    // `tr` принимает наборы `SET1 [SET2]` — только первые два не-флаговых
    // операнда до первого перенаправления. Всё после оператора (`<`, `>`,
    // `>>`, `2>`, `2>>`, `&>`, `>&`) — цель/источник, обычная проверка путей.
    const isRedirect = (t: string): boolean =>
      t === '<' || t === '>' || t === '>>' || t === '2>' || t === '2>>'
      || t === '&>' || t === '>&' || /^(?:[0-9]?>>?|[0-9]?>&|&>|<)/.test(t);
    let operands = 0;
    for (let i = base; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (isRedirect(t)) break;
      if (t.startsWith('-') && t.length > 1) continue;
      if (operands < 2) {
        skip.add(i);
        operands++;
      }
    }
    return skip;
  }

  if (cmd === 'cut') {
    for (let i = base; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === '-d' || t === '--delimiter' || t === '--output-delimiter') {
        if (i + 1 < tokens.length) skip.add(i + 1);
      } else if (t.startsWith('--delimiter=') || t.startsWith('--output-delimiter=')) {
        skip.add(i);
      }
    }
    return skip;
  }

  if (cmd === 'jq') {
    // Один проход: фильтр — первый не-флаговый операнд. У `--arg/--argjson`
    // два аргумента (имя и значение), у `--slurpfile/--rawfile/--argfile`
    // второй аргумент — файл (остаётся в проверке путей).
    let hasFilterFile = false;
    let filterSeen = false;
    for (let i = base; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === '-f' || t === '--from-file') { hasFilterFile = true; i++; continue; }
      if (JQ_TWO_ARG_FLAGS.has(t)) { i += 2; continue; }
      if (JQ_ONE_ARG_FLAGS.has(t)) { i++; continue; }
      if (t.startsWith('-') && t.length > 1) continue;
      if (!hasFilterFile && !filterSeen) {
        skip.add(i);
        filterSeen = true;
      }
    }
    return skip;
  }

  return skip;
}

/** Разбирает слитный оператор перенаправления (`>&`, `>|`, `<>`, `2>`, `&>>`…) и цель. */
function parseRedirectToken(token: string): string | null {
  const m = /^[0-9]*(?:&>>|&>|>>|>&|<&|<>|>\||>|<)(.+)$/.exec(token);
  return m ? m[1]! : null;
}

/**
 * То же, что `extractCommandPaths`, но сохраняет и сырой токен: нужен для
 * fail-closed проверок динамики (маркеры защищённых путей, `ask`), где
 * разрешённый `path` для `source: 'unknown'` недостоверен.
 */
/**
 * Простое brace-expansion `{a,b}` (в т.ч. пустые альтернативы, без вложенности,
 * до 64 вариантов). `'literal'` — раскрывать нечего (или `{fd}`-префикс);
 * `null` — неподдерживаемая форма (`{1..3}`, вложенность) → fail-closed ask.
 */
function expandBraces(token: string): string[] | 'literal' | null {
  // `{{…}}`/`}}` — не brace-expansion (docker/kubectl-форматы, jsonpath).
  if (token.includes('{{') || token.includes('}}')) return 'literal';
  const open = token.indexOf('{');
  if (open === -1) return 'literal';
  const close = token.indexOf('}', open + 1);
  if (close === -1) return 'literal';
  const body = token.slice(open + 1, close);
  if (body.includes('{') || body.includes('}')) return null;
  if (body.includes('..')) return null;
  const parts = body.split(',');
  if (parts.length === 1) return 'literal';
  const prefix = token.slice(0, open);
  const suffix = token.slice(close + 1);
  const out: string[] = [];
  for (const part of parts) {
    const expanded = expandBraces(prefix + part + suffix);
    if (expanded === null) return null;
    const variants = expanded === 'literal' ? [prefix + part + suffix] : expanded;
    for (const variant of variants) {
      out.push(variant);
      if (out.length > 64) return null;
    }
  }
  return out;
}

export function extractCommandPathTokens(
  tokens: string[],
  cwd: string,
  env?: PathResolveEnv,
  skipIndices?: ReadonlySet<number>,
): Array<{ token: string; resolved: ExtractedPath }> {
  if (tokens.length === 0) return [];
  const result: Array<{ token: string; resolved: ExtractedPath }> = [];
  let afterDoubleDash = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true;
      continue;
    }
    // Флаги пропускаем; "-" (stdin) и "--" уже обработаны.
    if (!afterDoubleDash && token.startsWith('-') && token.length > 1) continue;
    // Аргумент-паттерн (shlex-скрипт sed, regexp grep, программа awk, шаблон
    // find, набор tr, разделитель cut, фильтр jq) — не файловый операнд.
    if (skipIndices?.has(i)) continue;

    const variants = expandBraces(token);
    if (variants === null) {
      // Неподдерживаемая форма — неизвестный путь (шаг 6 даст ask).
      result.push({ token, resolved: { path: resolve(cwd, token), source: 'unknown' } });
      continue;
    }
    const list = variants === 'literal' ? [token] : variants;
    for (const variant of list) {
      const extracted = tryResolvePath(variant, cwd, env);
      if (extracted) result.push({ token: variant, resolved: extracted });
    }
  }

  // Слитные перенаправления (`>/etc/shadow`, `2>/etc/passwd`, `&>…`): цель —
  // тоже путь, проверяем её как обычный операнд. После разбора операторов
  // токенизатором это fallback (раздельные формы уже попали выше).
  for (let i = 0; i < tokens.length; i++) {
    const target = parseRedirectToken(tokens[i]!);
    if (target === null) continue;
    if (/^\d+$/.test(target) || target === '-' || target === '&-') continue; // fd
    const variants = expandBraces(target);
    if (variants === null) {
      result.push({ token: target, resolved: { path: resolve(cwd, target), source: 'unknown' } });
      continue;
    }
    for (const variant of variants === 'literal' ? [target] : variants) {
      const extracted = tryResolvePath(variant, cwd, env);
      if (extracted) result.push({ token: variant, resolved: extracted });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fail-closed проверки неразрешимой динамики ($VAR, ${VAR}, glob, $())
// ---------------------------------------------------------------------------

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

/**
 * Явный признак Windows-пути: drive-absolute (`C:\x` / `C:/x`) или UNC
 * (`\\server\share`). Обратный слэш сам по себе путём не делает: в POSIX-shell
 * `\` — экранирование/регэксп (`\.sample$`, `^\s*Test`), а не разделитель.
 */
function isWindowsPathToken(token: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(token) || /^\\\\[^\\]/.test(token);
}

/** Есть ли в токене хоть один фрагмент, похожий на элемент пути. */
function hasPathLikeFragment(token: string): boolean {
  if (isWindowsPathToken(token)) return true;
  for (const fragment of token.split(DYNAMIC_CHARS_RE)) {
    if (isWindowsPathToken(fragment)) return true;
    if (fragment.includes('/') || fragment.startsWith('~')) return true;
  }
  return false;
}

/**
 * «Маркеры» защищённых путей политики — basename'ы deniedPaths/deniedPrefixes
 * (`~/.ssh` → `.ssh`, `{dataDir}/secrets` → `secrets`, `/etc/shadow` → `shadow`).
 * Позволяют отклонить токен с неразрешимой динамикой, литеральная часть
 * которого упирается в защищённый путь (сам путь проверить нельзя).
 */
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

/**
 * Содержит ли токен с неразрешимой динамикой литеральный фрагмент-путь,
 * попадающий в защищённый путь/префикс политики (по маркерам). `true` → deny.
 * Примеры: `$SYNTH_DATA_DIR/secrets/master.key`, `$USER/.ssh/id_rsa`,
 * `/data/secrets/*.key`, `$(pwd)/.ssh/...`.
 */
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

/** URL (`scheme://…`) — не файловый путь: внешние адреса не подтверждаем. */
function isUrlToken(token: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(token);
}

/** Glob-метасимволы (`(`/`)` сюда НЕ входят: это подстановка/текст, не шаблон файлов). */
const GLOB_CHARS_RE = /[*?[\]{}]/;

/**
 * Похож ли токен на файловый путь (для fail-closed `ask`, когда динамику
 * разрешить не удалось). Glob без разделителей (`*.ts`) и URL — не считаем,
 * чтобы не спрашивать подтверждение на рутинные команды. Обратный слэш
 * разделителем не является (POSIX: экранирование/регэксп) — Windows-пути
 * распознаются явно: `C:\x`, `C:/x`, `\\server\share`.
 */
export function looksLikePathToken(token: string): boolean {
  if (token === '' || token === '-') return false;
  if (isWindowsPathToken(token)) return true;
  if (isUrlToken(token)) return false;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(token)) return true; // $VAR / ${VAR}
  if (token.startsWith('~')) return true;
  return token.includes('/') || hasPathLikeFragment(token);
}

/**
 * Является ли токен с неразрешимой динамикой **целью-путём** (для fail-closed
 * `ask`, шаг 6 `checkShellSegment`). В отличие от `looksLikePathToken` (любой
 * `/` в токене) критерий строже: токен обязан **начинаться** как путь или
 * динамический путь, либо быть glob'ом с разделителем.
 *
 * Причина: `tokenizeCommand` снимает кавычки, но сохраняет пробелы внутри
 * токена, поэтому «путём» становилась целая строка текста —
 * `echo "=== diff vs origin/master ==="` и `node -e "console.log(require(...))"`
 * уходили на подтверждение пользователя (10+ ложных блокировок за сессию).
 *
 * Путь — если токен:
 * - начинается с `/` (абсолютный, в т.ч. динамический `/proc/$p/comm`),
 *   `~`, `./`, `../`;
 * - начинается с переменной: `$VAR`, `${VAR}`, `$VAR/...`;
 * - Windows-путь (`C:\x`, `C:/x`, `\\server\share`);
 * - содержит `../` (подъём вверх) в любом месте;
 * - содержит `/` **и** glob-метасимвол (`packages/<glob>/package.json`) — такой
 *   шаблон может раскрыться в защищённый путь, разрешить его нельзя (осознанно `ask`).
 *
 * Не путь — если токен содержит пробелы/табы (это текст в кавычках), является
 * URL (`scheme://`) или просто текстом с `/` в середине (`a/b`, `origin/master`).
 */
export function isPathLikeTarget(token: string): boolean {
  if (token === '' || token === '-') return false;
  // Пробелы/табы внутри токена — содержимое кавычек, а не имя файла.
  if (/\s/.test(token)) return false;
  if (isWindowsPathToken(token)) return true;
  if (isUrlToken(token)) return false;
  // `$VAR`, `${VAR}`, `$VAR/...` (но не `$p:` и не `${X}.json` — это текст/имя).
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?:\/|$)/.test(token)) return true;
  // Позиционные параметры (`$1`, `${1}`, `$@`, `${@}`, `$*`, `${*}`) —
  // неизвестная динамика-путь. `$?`, `$$`, `$!` — не пути (allow).
  if (/^\$(?:\{[0-9@*]+\}|[0-9]+|@|\*)(?:\/|$)/.test(token)) return true;
  if (token.startsWith('~')) return true;
  if (token.startsWith('/')) return true;
  if (token.startsWith('./') || token.startsWith('../')) return true;
  if (token.includes('../')) return true;
  // Glob с разделителем: шаблон может раскрыться в защищённый путь.
  if (token.includes('/') && GLOB_CHARS_RE.test(token)) return true;
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
export function checkShellCommand(
  command: string,
  cwd: string,
  policy: ShellPolicy,
  options?: { allowedRoots?: readonly string[]; depth?: number; bindings?: ReadonlyMap<string, ShellBinding> },
): ShellCheckResult {
  // Точное совпадение всей команды (например форк-бомба с разделителями внутри).
  for (const prefix of policy.deniedCommandPrefixes) {
    if (normalizeSpace(prefix) === normalizeSpace(command)) {
      return deniedByPrefix(prefix);
    }
  }

  // Тела heredoc не исполняются родительским shell — вырезаем до разбора
  // (содержимое для shell/интерпретатора закрывается fail-closed ask в сегменте).
  const analyzed = stripHeredocBodies(command);
  const segments = splitShellSegments(analyzed);
  if (segments.length === 0) {
    return { action: 'allow', reason: sm('shellguard.allow_default') };
  }

  const deniedPaths = policy.deniedPaths.map(expandHome);
  const approvalPaths = policy.approvalPaths.map(expandHome);
  const deniedPrefixes = policy.deniedPrefixes.map(expandHome);
  const env = resolveEnv(policy);
  // Биндинги считаются на уровне всей команды: `splitShellSegments` разрывает
  // `for ...; do ...` на сегменты, и значение переменной задано в другом.
  // Для вложенной команды — база из внешнего контекста + свои присваивания.
  const ownBindings = collectBindings(analyzed);
  const bindings = options?.bindings
    ? new Map<string, ShellBinding>([...options.bindings, ...ownBindings])
    : ownBindings;
  const roots = [cwd, ...(options?.allowedRoots ?? [])];
  const depth = options?.depth ?? 0;

  let ask: ShellCheckResult | null = null;
  // Периметр `cd`/`pushd` (N3): cwd меняется для последующих сегментов.
  let currentCwd = cwd;
  for (const segment of segments) {
    const result = checkShellSegment(
      segment, currentCwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots, depth,
    );
    if (result) {
      // Deny приоритетнее ask: `cat ~/.ssh/config; cat /etc/passwd` → deny.
      if (result.action === 'deny') return result;
      ask ??= result;
    }
    const nextCwd = resolveCdCwd(segment, currentCwd, env, bindings);
    if (nextCwd !== null) {
      if ('cwd' in nextCwd) currentCwd = nextCwd.cwd;
      else ask ??= askForDynamic(nextCwd.target, 'cwd');
    }
  }
  if (ask) return ask;

  return { action: 'allow', reason: sm('shellguard.allow_default') };
}

/** Значения переменных для резолва токенов: `$SYNTH_DATA_DIR` → dataDir инстанса. */
function resolveEnv(policy: ShellPolicy): PathResolveEnv | undefined {
  return policy.dataDir ? { vars: { SYNTH_DATA_DIR: policy.dataDir } } : undefined;
}

/** deny: токен с динамикой упирается в защищённый путь политики (fail-closed). */
function deniedByDynamicToken(token: string): ShellCheckResult {
  return {
    action: 'deny',
    reason: sm('shellguard.deny_path', { path: token }),
    matchedRule: 'shell-policy.deny',
    deniedPath: token,
    messageId: 'deny-protected-path',
    params: { path: token },
  };
}

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

/** Находится ли нормализованный путь внутри запрещённого префикса. */
function isUnderDeniedPrefix(norm: string, prefixEntry: string): boolean {
  const prefix = normalize(prefixEntry);
  return norm === prefix || norm.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}

/**
 * Варианты пути для сравнения с политикой: лексический и разыменованный.
 * Симлинк внутри workspace (`cat link/master.key`, `link -> {dataDir}/secrets`)
 * не должен обходить денлист — сравниваем и realpath. Неразрешимый путь
 * (битый симлинк/цикл) — только лексический вариант (fail-closed обеспечивает
 * отдельный слой: файловый тул `isSymlinkEscape`).
 */
function pathVariants(norm: string): string[] {
  const variants: string[] = [];
  const real = resolveRealPath(norm);
  if (real !== null && real !== norm) variants.push(norm, real);
  else variants.push(norm);
  // `/proc/<pid|self>/root/<path>` и `/cwd/<path>` — тот же файл, что `<path>`
  // (realpath часто недоступен): проверяем алиас теми же deny/approval.
  const procRoot = /^\/proc\/(?:\d+|self)\/(?:root|cwd)(\/.+)$/.exec(norm);
  if (procRoot) variants.push(normalize(procRoot[1]!));
  return variants;
}

/** Пустой набор биндингов (когда команда их не задаёт). */
const EMPTY_BINDINGS: ReadonlyMap<string, ShellBinding> = new Map();

/** Результат классификации разрешённого пути. */
type PathClassification =
  | { kind: 'deny'; result: ShellCheckResult }
  | { kind: 'ask'; result: ShellCheckResult };

/**
 * Классификация разрешённого литерального пути:
 * 1) точный deniedPaths → deny;
 * 2) approvalPaths → ask (исключение: `~/.ssh/config` внутри `~/.ssh` не денется);
 * 3) deniedPrefixes → deny.
 * Порядок 2 → 3 сохранён осознанно (как в исходном guard'е/hermes).
 */
function classifyResolvedPath(
  norm: string,
  deniedPaths: readonly string[],
  approvalPaths: readonly string[],
  deniedPrefixes: readonly string[],
): PathClassification | null {
  const variants = pathVariants(norm);
  const pathHit = deniedPaths.find((p) => variants.includes(normalize(p)));
  if (pathHit) return { kind: 'deny', result: deniedByPath(pathHit) };
  const approved = approvalPaths.find((p) => variants.includes(normalize(p)));
  if (approved) return { kind: 'ask', result: askByPath(approved) };
  for (const variant of variants) {
    const dirHit = deniedPrefixes.find((p) => isUnderDeniedPrefix(variant, p));
    if (dirHit) return { kind: 'deny', result: deniedByDir(variant, dirHit) };
  }
  return null;
}

/** Лимит записей при чтении каталога для workspace-glob (защита event loop). */
const GLOB_READDIR_LIMIT = 2000;

/**
 * Чтение имён каталога с лимитом через `opendirSync` (не грузит весь каталог
 * синхронно). Больше `limit` записей — `null` (дальше обычный `ask`).
 */
function readDirLimited(dir: string, limit: number): string[] | 'too-many' | null {
  let handle: Dir | undefined;
  try {
    handle = opendirSync(dir);
    const names: string[] = [];
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > limit) return 'too-many';
    }
    return names;
  } catch {
    return null;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // каталог уже закрыт/недоступен — не влияет на вердикт
    }
  }
}

/** Результат оценки workspace-glob в шаге 6. */
type WorkspaceGlobEvaluation =
  | { kind: 'skip' }   // не однокомпонентный glob в периметре — обычный `ask`
  | { kind: 'safe' }   // все совпадения безопасны — подтверждение не нужно
  | { kind: 'result'; result: ShellCheckResult };

/** Путь внутри корней: лексически и (если существует) после разыменования. */
function isInsideRoots(path: string, roots: readonly string[]): boolean {
  const real = resolveRealPath(path);
  return roots.some((root) => {
    if (!isLexicallyInside(root, path)) return false;
    if (real === null) return false; // не разрешается — fail-closed
    const realRoot = resolveRealPath(root);
    return realRoot !== null && isLexicallyInside(realRoot, real);
  });
}

/**
 * Оценивает glob-токен по фактическим совпадениям (шаг 6).
 *
 * Разрешается только glob в **последнем** компоненте (`dir/*.srl`): каталог
 * обязан быть литеральным, внутри периметра (лексически и после realpath), а
 * каждое совпадение проверяется как путь — deny/approval и realpath внутри
 * периметра. Симлинк из workspace наружу (`leakdir/*.key`) и многокомпонентный
 * glob (`<dir>/<glob>/file`) — `skip` (дальше обычный `ask`). Ошибка чтения
 * каталога или отсутствие совпадений — тоже `skip`.
 */
function evaluateWorkspaceGlob(
  token: string,
  cwd: string,
  env: PathResolveEnv | undefined,
  roots: readonly string[],
  deniedPaths: readonly string[],
  approvalPaths: readonly string[],
  deniedPrefixes: readonly string[],
): WorkspaceGlobEvaluation {
  if (/[$`]/.test(token)) return { kind: 'skip' };
  if (token.search(GLOB_CHARS_RE) === -1) return { kind: 'skip' };
  const lastSlash = token.lastIndexOf('/');
  const bare = lastSlash === -1;
  let dir: string;
  let pattern: string;
  if (bare) {
    // `*`, `*.ts` — совпадения в рабочем каталоге (H5).
    dir = cwd;
    pattern = token;
  } else {
    // Только glob в последнем компоненте (`dir/*.srl`).
    if (token.search(GLOB_CHARS_RE) < lastSlash) return { kind: 'skip' };
    if (token.split('/').includes('..')) return { kind: 'skip' };
    const dirToken = lastSlash === 0 ? '/' : token.slice(0, lastSlash);
    const resolved = tryResolvePath(dirToken, cwd, env);
    if (!resolved || resolved.source !== 'literal') return { kind: 'skip' };
    dir = resolved.path;
    // Литеральный каталог обязан быть внутри периметра (realpath обязателен).
    if (resolveRealPath(dir) === null || !isInsideRoots(dir, roots)) return { kind: 'skip' };
    pattern = token.slice(lastSlash + 1);
  }
  if (pattern === '') return { kind: 'skip' };

  const names = readDirLimited(dir, GLOB_READDIR_LIMIT);
  if (names === 'too-many') return { kind: 'result', result: askForDynamic(token) };
  if (names === null) return bare ? { kind: 'safe' } : { kind: 'skip' };
  if (names.length === 0) return bare ? { kind: 'safe' } : { kind: 'skip' };
  const matches = names.filter((name) => globMatch(pattern, name));
  if (matches.length === 0) return bare ? { kind: 'safe' } : { kind: 'skip' };

  // Deny приоритетнее ask: сначала все deny и проверка периметра, затем approval.
  let uncertain = false;
  let approval: ShellCheckResult | null = null;
  for (const name of matches) {
    const path = join(dir, name);
    const real = resolveRealPath(path);
    if (real === null || !isInsideRoots(path, roots)) {
      // Симлинк наружу/неразрешимый путь: bare-glob нельзя молча пропускать.
      if (bare) return { kind: 'result', result: askForDynamic(token) };
      uncertain = true;
      continue;
    }
    const classified = classifyResolvedPath(normalize(path), deniedPaths, approvalPaths, deniedPrefixes);
    if (!classified) continue;
    if (classified.kind === 'deny') return { kind: 'result', result: classified.result };
    approval ??= classified.result;
  }
  if (uncertain) return { kind: 'skip' };
  if (approval) return { kind: 'result', result: approval };
  return { kind: 'safe' };
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

/** Метасимволы/пробелы, при которых раскрытое значение — не одиночный путь. */
const UNSAFE_EXPANDED_VALUE_RE = /[\s;|&<>(){}`$]/;

/**
 * Раскрытое значение считается путём, только если это одиночный путь:
 * без пробелов и шелл-метасимволов. Иначе (`'cat /etc/shadow'`, `'rm -rf /'`)
 * это команда/текст — такое значение не помечаем раскрытым (шаг 6 даст `ask`).
 */
function isSinglePathValue(value: string): boolean {
  return value !== '' && !UNSAFE_EXPANDED_VALUE_RE.test(value);
}

/** ask на динамический/непроверяемый токен. */
function askForDynamic(
  token: string,
  askKind: NonNullable<ShellCheckResult['askKind']> = 'dynamic',
): ShellCheckResult {
  return {
    action: 'ask',
    reason: sm('shellguard.ask_path', { path: token }),
    matchedRule: 'shell-policy.approve',
    deniedPath: token,
    messageId: 'ask-protected-path',
    params: { path: token },
    askKind,
  };
}

/** ask: чистая динамическая подстановка передаётся как код/аргумент. */
function askForDynamicCode(code: string): ShellCheckResult {
  return {
    action: 'ask',
    reason: sm('shellguard.ask_code', { code }),
    matchedRule: 'shell-policy.approve',
    deniedPath: code,
    messageId: 'ask-dynamic-code',
    params: { code },
    askKind: 'dynamic',
  };
}

/** Вхождение в периметр: realpath — если путь существует, иначе лексически. */
function isInsideRootsLexicalFallback(path: string, roots: readonly string[]): boolean {
  const real = resolveRealPath(path);
  return roots.some((root) => {
    if (!isLexicallyInside(root, path)) return false;
    if (real === null) return true;
    const realRoot = resolveRealPath(root);
    return realRoot !== null && isLexicallyInside(realRoot, real);
  });
}

/** Рекурсивная проверка вложенной команды (с общими биндингами и roots). */
function nestedCheck(
  code: string,
  cwd: string,
  policy: ShellPolicy,
  deniedPaths: string[],
  approvalPaths: string[],
  deniedPrefixes: string[],
  env: PathResolveEnv | undefined,
  bindings: ReadonlyMap<string, ShellBinding> | undefined,
  roots: readonly string[],
): ShellCheckResult | null {
  let ask: ShellCheckResult | null = null;
  for (const segment of splitShellSegments(code)) {
    const r = checkShellSegment(
      segment, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots,
    );
    if (!r) continue;
    if (r.action === 'deny') return r;
    ask ??= r;
  }
  return ask;
}

/** `awk/gawk/mawk`: `system(...)`, `getline`/pipe/redirect, `-f` (программа в файле). */
function checkAwkProgram(
  tokens: string[],
  cwd: string,
  policy: ShellPolicy,
  deniedPaths: string[],
  approvalPaths: string[],
  deniedPrefixes: string[],
  env: PathResolveEnv | undefined,
  bindings: ReadonlyMap<string, ShellBinding> | undefined,
  roots: readonly string[],
): ShellCheckResult | null {
  const idx = commandIndex(tokens);
  if (idx < 0 || !AWK_FAMILY.has(tokens[idx]!)) return null;
  let j = idx + 1;
  while (j < tokens.length) {
    const t = tokens[j]!;
    if (t === '-f' || t === '--file') return askForDynamic(tokens.slice(j).join(' '));
    if (AWK_VALUE_FLAGS.has(t)) {
      j += 2;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      j += 1;
      continue;
    }
    break;
  }
  const program = tokens[j];
  if (program === undefined) return null;
  // Внешние эффекты, которые нельзя проверить статически, — fail-closed.
  if (/\bgetline\b/.test(program) || program.includes('|')
    || /\bprint(?:f)?\s*>/.test(program)) {
    return askForDynamic(program);
  }
  const systemRe = /system\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = systemRe.exec(program)) !== null) {
    const code = match[2]!;
    const r = nestedCheck(code, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots);
    if (r) return r;
  }
  return null;
}

/** `find ... -exec/-execdir <cmd>`: рекурсивно проверяет исполняемую команду. */
function checkFindExec(
  tokens: string[],
  cwd: string,
  policy: ShellPolicy,
  deniedPaths: string[],
  approvalPaths: string[],
  deniedPrefixes: string[],
  env: PathResolveEnv | undefined,
  bindings: ReadonlyMap<string, ShellBinding> | undefined,
  roots: readonly string[],
): ShellCheckResult | null {
  const idx = commandIndex(tokens);
  if (idx < 0 || tokens[idx] !== 'find') return null;
  for (let i = idx + 1; i < tokens.length; i++) {
    if (tokens[i] !== '-exec' && tokens[i] !== '-execdir') continue;
    const execTokens: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t === ';' || t === '+') break;
      execTokens.push(t === '{}' ? '__FIND_PATH__' : t);
    }
    if (execTokens.length === 0) continue;
    const joined = joinShellTokens(execTokens);
    const code = extractWrappedCommand(joined, execTokens) ?? joined;
    const r = nestedCheck(code, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots);
    if (r) return r;
  }
  return null;
}

/** Содержит ли код интерпретатора защищённый путь/маркер (в т.ч. внутри вызова). */
function codeTouchesProtectedPath(code: string, policy: ShellPolicy): boolean {
  if (tokenTouchesProtectedMarker(code, policy)) return true;
  const entries = [...(policy.deniedPaths ?? []), ...(policy.deniedPrefixes ?? [])];
  for (const entry of entries) {
    if (entry.includes('$') || entry.includes('{')) continue;
    const expanded = expandHome(entry);
    if (code.includes(entry) || code.includes(expanded)) return true;
  }
  return false;
}

/** `python|node|perl|ruby|php -c/-e <code>`: маркер защищённого пути → deny. */
function checkInterpreterCode(
  tokens: string[],
  policy: ShellPolicy,
): ShellCheckResult | null {
  const idx = commandIndex(tokens);
  if (idx < 0 || !INTERPRETER_COMMANDS.has(tokens[idx]!)) return null;
  for (let i = idx + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== '-c' && t !== '-e') continue;
    const code = tokens[i + 1];
    if (code !== undefined && codeTouchesProtectedPath(code, policy)) {
      return deniedByDynamicToken(code);
    }
  }
  return null;
}

/**
 * `find` с `-delete/-exec/-execdir`: стартовые пути вне периметра → ask,
 * стартовый путь под deniedPaths/deniedPrefixes → deny (удаление чужого).
 */
function checkFindMutationStarts(
  tokens: string[],
  cwd: string,
  env: PathResolveEnv | undefined,
  roots: readonly string[],
  deniedPaths: readonly string[],
  approvalPaths: readonly string[],
  deniedPrefixes: readonly string[],
): ShellCheckResult | null {
  const idx = commandIndex(tokens);
  if (idx < 0 || tokens[idx] !== 'find') return null;
  if (!tokens.some((t) => t === '-delete' || t === '-exec' || t === '-execdir')) return null;
  const starts: string[] = [];
  for (let i = idx + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '(' || t === '!' || t === ')') break;
    if (t.startsWith('-') && t.length > 1) break;
    starts.push(t);
  }
  for (const start of starts) {
    const resolved = tryResolvePath(start, cwd, env);
    if (!resolved || resolved.source !== 'literal') continue;
    const classified = classifyResolvedPath(normalize(resolved.path), deniedPaths, approvalPaths, deniedPrefixes);
    if (classified?.kind === 'deny') return classified.result;
  }
  for (const start of starts) {
    const resolved = tryResolvePath(start, cwd, env);
    if (!resolved || resolved.source !== 'literal') {
      // Динамический стартовый путь (`$(pwd)/..`, backtick) — fail-closed ask.
      if (hasUnresolvedDynamic(start)) return askForDynamic(start, 'mutation');
      continue;
    }
    if (!isInsideRootsLexicalFallback(resolved.path, roots)) return askForDynamic(start, 'mutation');
  }
  return null;
}

/**
 * Общий скан аргументов встроенных исполнителей (F): токены-команды/код
 * проверяются рекурсивно; маркер защищённого пути → deny. Awk/find обрабатываются
 * отдельно (их программа/шаблоны — не команда).
 */
function checkEmbeddedExecutorArgs(
  tokens: string[],
  cwd: string,
  policy: ShellPolicy,
  roots: readonly string[],
  depth: number,
  bindings?: ReadonlyMap<string, ShellBinding>,
): ShellCheckResult | null {
  const idx = commandIndex(tokens);
  if (idx < 0) return null;
  const cmd = tokens[idx]!;
  if (!isEmbeddedExecutor(cmd)) return null;
  const base = shellBasename(cmd);
  if (AWK_FAMILY.has(base) || base === 'find') return null;

  let ask: ShellCheckResult | null = null;
  // Динамическая «команда» перед code-флагом (`exec $C -c '…'`) — семантика
  // флага неизвестна: не денним по маркеру, wrapper-рекурсия даст ask.
  const hasDynamicCommandishBefore = (limit: number): boolean => {
    for (let k = idx + 1; k < limit; k++) {
      const tk = tokens[k]!;
      if (tk.startsWith('-') && tk.length > 1) continue;
      if (isCodeFlagToken(tokens[k - 1] ?? '')) continue;
      if (hasUnresolvedDynamic(tk)) return true;
    }
    return false;
  };
  for (let i = idx + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (REDIRECT_OPERATOR_TOKENS.has(token)) continue;
    // Слитное перенаправление (`</dev/tcp/…`) уже проверяется wrapper-рекурсией
    // и fallback-разбором цели — без биндингов даст ложный ask.
    if (parseRedirectToken(token) !== null) continue;
    const prev = tokens[i - 1] ?? '';
    let candidate: string | null = null;
    // `--eval=…`, `--command=…`, `--print=…`, `--split-string=…`
    const longEq = /^--(?:eval|command|print|split-string)=(.+)$/.exec(token);
    if (longEq) {
      candidate = longEq[1]!;
    } else if (token.startsWith('-') && token.length > 1) {
      // Флаг/опция: marker/путь внутри значения → deny; приклеенный код
      // (`-c<code>`, `-S…`, `-E…`, `script -qec<code>`, `-oX=<code>`) — рекурсия.
      if (codeTouchesProtectedPath(token, policy)) return deniedByDynamicToken(token);
      const gluedShort = /^-([ceprpSE])(.+)$/.exec(token);
      const gluedCluster = /^-[A-Za-z]*c(.+)$/.exec(token);
      const eqValue = /^--?[^=]+=(.+)$/.exec(token);
      if (gluedShort && !token.startsWith('--')) candidate = gluedShort[2]!;
      else if (gluedCluster) candidate = gluedCluster[1]!;
      else if (eqValue) {
        const value = eqValue[1]!;
        if (/\s/.test(value) || /[;|&<>()]/.test(value) || codeTouchesProtectedPath(value, policy)) {
          candidate = value;
        }
      }
      if (candidate === null) continue;
    } else if (isCodeFlagToken(prev) || /^-[A-Za-z]*c$/.test(prev)) {
      candidate = token;
    } else if (/\s/.test(token) || /[;|&<>()]/.test(token)) {
      candidate = token;
    }
    // Маркер сам по себе не делает обычный файловый операнд «кодом»
    // (`timeout 20 ansible-vault view secrets/credentials.yml`), но если токен
    // уже признан кодом/командой — проверяется ниже.
    if (candidate === null || candidate === '') continue;
    // Чистая динамическая подстановка как код/аргумент: не режем её на
    // `$(cat` и не рекурсируем по обрывку — fail-closed ask с полным токеном.
    if (/^\$\([\s\S]*\)$/.test(candidate) || /^`[\s\S]*`$/.test(candidate)
      || candidate.startsWith('$(')) {
      return askForDynamicCode(candidate);
    }
    if (hasDynamicCommandishBefore(i)) continue;

    if (codeTouchesProtectedPath(candidate, policy)) return deniedByDynamicToken(candidate);
    if (depth >= MAX_EMBEDDED_DEPTH) {
      ask ??= askForDynamic(candidate);
      continue;
    }
    const result = checkShellCommand(candidate, cwd, policy, {
      allowedRoots: roots,
      depth: depth + 1,
      ...(bindings ? { bindings } : {}),
    });
    if (result.action === 'deny') return result;
    if (result.action === 'ask') ask ??= result;
  }
  return ask;
}

/**
 * Снимает shell-префиксы, не меняющие команду: `!`, `time [-p]`, `{`, `(`,
 * `if/while/until/for`, `case … in`, а также ведущие `then/do/else/elif/fi/
 * done/esac/}`/`)` и хвостовые `}`/`)`. Нужно, чтобы `! bash -c …`, `time sh -c …`,
 * `{ sh -c …; }`, `( sh -c … )` проверялись как вложенная команда (N1).
 */
function stripShellPrefixes(input: string[]): string[] {
  const arr = input.slice();
  const shift = (): void => { arr.shift(); };
  let strippedParen = false;
  let strippedBrace = false;
  for (;;) {
    if (arr.length === 0) return arr;
    const first = arr[0]!;
    if (first === '!') { shift(); continue; }
    if (first === 'time') {
      shift();
      while (arr[0] === '-p' || arr[0] === '--') shift();
      continue;
    }
    if (first === '{') {
      strippedBrace = true;
      shift();
      continue;
    }
    if (first === '(') {
      strippedParen = true;
      shift();
      continue;
    }
    if (first === 'then' || first === 'do' || first === 'else'
      || first === 'elif' || first === 'fi' || first === 'done' || first === 'esac'
      || first === '}') {
      shift();
      continue;
    }
    if (first === 'if' || first === 'while' || first === 'until' || first === 'for') {
      shift();
      continue;
    }
    if (first === 'case') {
      shift();
      while (arr.length > 0 && arr[0] !== 'in') shift();
      if (arr[0] === 'in') shift();
      continue;
    }
    // Слитное `(`/`!` в начале слова: `(cd /tmp`, `!bash` (не `$(`).
    if (first.startsWith('(') && !first.startsWith('$(')) {
      strippedParen = true;
      arr[0] = first.slice(1);
      if (arr[0] === '') shift();
      continue;
    }
    if (first.startsWith('!') && first !== '!') {
      arr[0] = first.slice(1);
      if (arr[0] === '') shift();
      continue;
    }
    break;
  }
  // Хвостовые закрывающие срезаем только для реально снятой пары:
  // `)`, `}` — если снималась `(`/`{`; keywords — всегда.
  for (;;) {
    if (arr.length === 0) break;
    const last = arr[arr.length - 1]!;
    if (last === 'fi' || last === 'done' || last === 'esac') {
      arr.pop();
      continue;
    }
    if (last === ')' && strippedParen) {
      arr.pop();
      continue;
    }
    if (last === '}' && strippedBrace) {
      arr.pop();
      continue;
    }
    if (strippedParen && last.endsWith(')') && !last.endsWith('))') && last.length > 1) {
      arr[arr.length - 1] = last.slice(0, -1);
      continue;
    }
    break;
  }
  return arr;
}

/** Значение code-флага инструмента (`git -c`, `tar --to-command`, `rsync -e`). */
function checkToolCodeArgs(
  tokens: string[],
  cwd: string,
  policy: ShellPolicy,
  roots: readonly string[],
  depth: number,
  bindings?: ReadonlyMap<string, ShellBinding>,
): ShellCheckResult | null {
  const idx = commandIndex(tokens);
  if (idx < 0) return null;
  const cmd = shellBasename(tokens[idx]!);
  const values: string[] = [];
  if (cmd === 'git') {
    for (let i = idx + 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === '-c' && tokens[i + 1] !== undefined) {
        const pair = tokens[i + 1]!;
        const eq = pair.indexOf('=');
        if (eq >= 0) values.push(pair.slice(eq + 1));
        i++;
      } else if (t.startsWith('-c') && t.includes('=')) {
        const eq = t.indexOf('=');
        values.push(t.slice(eq + 1));
      }
    }
  } else if (cmd === 'tar') {
    for (let i = idx + 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === '--to-command' && tokens[i + 1] !== undefined) {
        values.push(tokens[i + 1]!);
        i++;
      } else if (t.startsWith('--to-command=')) {
        values.push(t.slice('--to-command='.length));
      }
    }
  } else if (cmd === 'rsync') {
    for (let i = idx + 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if ((t === '-e' || t === '--rsh') && tokens[i + 1] !== undefined) {
        values.push(tokens[i + 1]!);
        i++;
      } else if (t.startsWith('--rsh=')) {
        values.push(t.slice('--rsh='.length));
      } else if (t.startsWith('-e') && t.length > 2) {
        values.push(t.slice(2));
      }
    }
  }
  if (values.length === 0) return null;
  let ask: ShellCheckResult | null = null;
  for (const value of values) {
    if (value === '') continue;
    if (codeTouchesProtectedPath(value, policy)) return deniedByDynamicToken(value);
    if (!/\s/.test(value) && !/[;|&<>()]/.test(value) && !value.startsWith('-')) continue;
    if (depth >= MAX_EMBEDDED_DEPTH) {
      ask ??= askForDynamic(value);
      continue;
    }
    const result = checkShellCommand(value, cwd, policy, {
      allowedRoots: roots,
      depth: depth + 1,
      ...(bindings ? { bindings } : {}),
    });
    if (result.action === 'deny') return result;
    if (result.action === 'ask') ask ??= result;
  }
  return ask;
}

/**
 * Оценка cwd для вложенной команды обёртки: `env -C`, `chroot <root>`,
 * `sudo -D/--chdir` (N3). `null` — cwd не меняется.
 */
function wrapperCwd(tokens: string[], cwd: string, env: PathResolveEnv | undefined): string | null {
  const idx = commandIndex(tokens);
  if (idx < 0) return null;
  const cmd = shellBasename(tokens[idx]!);
  const resolve = (value: string | undefined): string | null => {
    if (value === undefined || value === '') return null;
    const resolved = tryResolvePath(value, cwd, env);
    return resolved && resolved.source === 'literal' ? resolved.path : null;
  };
  if (cmd === 'env') {
    for (let i = idx + 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if ((t === '-C' || t === '--chdir') && tokens[i + 1] !== undefined) return resolve(tokens[i + 1]);
      if (t.startsWith('--chdir=')) return resolve(t.slice('--chdir='.length));
      if (t.startsWith('-C') && t.length > 2) return resolve(t.slice(2));
    }
    return null;
  }
  if (cmd === 'sudo') {
    for (let i = idx + 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if ((t === '-D' || t === '--chdir') && tokens[i + 1] !== undefined) return resolve(tokens[i + 1]);
      if (t.startsWith('--chdir=')) return resolve(t.slice('--chdir='.length));
    }
    return null;
  }
  if (cmd === 'chroot') {
    const j = skipWrapperOptions(tokens, idx + 1, CHROOT_VALUE_FLAGS);
    return resolve(tokens[j]);
  }
  return null;
}

/** Результат вычисления cwd после `cd`/`pushd`. */
type CdResolution =
  | { cwd: string }
  | { ask: true; target: string }
  | null;

/** cwd после `cd`/`pushd <literal>`; `ask` — цель нерезолвима (fail-closed). */
function resolveCdCwd(
  segment: string,
  cwd: string,
  env: PathResolveEnv | undefined,
  bindings?: ReadonlyMap<string, ShellBinding>,
): CdResolution {
  const tokens = stripShellPrefixes(tokenizeCommand(segment));
  const idx = commandIndex(tokens);
  if (idx < 0) return null;
  const cmd = tokens[idx]!;
  if (cmd !== 'cd' && cmd !== 'pushd') return null;
  let j = idx + 1;
  while (j < tokens.length && tokens[j]!.startsWith('-') && tokens[j] !== '-') j += 1;
  const arg = tokens[j];
  if (arg === undefined) return { cwd: expandHome('~') };
  if (arg === '-') return { cwd };
  if (hasUnresolvedDynamic(arg)) {
    // `$D` при известном биндинге раскрываем; `$(...)`/backtick/неизвестная — ask.
    const values = expandToken(arg, bindings ?? EMPTY_BINDINGS);
    if (values !== null && values.length === 1) {
      const resolved = tryResolvePath(values[0]!, cwd, env);
      if (resolved && resolved.source === 'literal') return { cwd: resolved.path };
    }
    return { ask: true, target: arg };
  }
  const resolved = tryResolvePath(arg, cwd, env);
  if (resolved && resolved.source === 'literal') return { cwd: resolved.path };
  return { ask: true, target: arg };
}

/** Исполнитель, который может читать код/команду из stdin (heredoc/herestring). */
function isStdinCodeExecutor(cmd: string): boolean {
  const base = shellBasename(cmd);
  if (SHELL_COMMANDS.has(base)) return true;
  if (AWK_FAMILY.has(base)) return true;
  if (INTERPRETER_COMMANDS.has(base)) return true;
  return EMBEDDED_VERSIONED_PREFIXES.some((prefix) => {
    if (!base.startsWith(prefix)) return false;
    return /^[0-9.]+$/.test(base.slice(prefix.length));
  });
}

/**
 * Базовая команда сегмента (после снятия обёрток) — для проверки heredoc.
 * Строковое представление вложенной команды от `extractWrappedCommand`
 * безопасно для определения первого токена: heredoc-операторы не меняют его.
 */
function baseCommandForStdin(segment: string, tokens: string[]): string {
  const inner = extractWrappedCommand(segment, tokens);
  if (inner === null) {
    const idx = commandIndex(tokens);
    return idx >= 0 ? tokens[idx]! : '';
  }
  const innerTokens = tokenizeCommand(inner);
  const idx = commandIndex(innerTokens);
  return idx >= 0 ? innerTokens[idx]! : '';
}

/** Ищет heredoc-маркер (`<<`/`<<-`, не `<<<`) вне кавычек; возвращает делимитер. */
function findHeredocDelimiter(line: string): { delimiter: string; stripTabs: boolean } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i]!;
    if (ch === '\\' && !inSingle) { i++; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch !== '<' || line[i + 1] !== '<') continue;
    if (line[i + 2] === '<') return null; // herestring — тела нет
    let j = i + 2;
    let stripTabs = false;
    if (line[j] === '-') { stripTabs = true; j++; }
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
    let delimiter = '';
    if (line[j] === "'" || line[j] === '"') {
      const quote = line[j]!;
      j++;
      while (j < line.length && line[j] !== quote) { delimiter += line[j]; j++; }
    } else {
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j]!)) { delimiter += line[j]; j++; }
    }
    return delimiter === '' ? null : { delimiter, stripTabs };
  }
  return null;
}

/**
 * Удаляет тела heredoc **только для shell/интерпретаторов**, читающих код из
 * stdin (их содержимое не анализируется — вместо этого даётся ask). Для прочих
 * команд (`cat <<EOF`) поведение прежнее: тело остаётся в разборе (интерполяция
 * переменных и т.п.).
 */
function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;
  const lines = command.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const marker = findHeredocDelimiter(line);
    if (!marker) continue;
    // Только если heredoc-команда — shell/интерпретатор/awk.
    const lineTokens = stripShellPrefixes(tokenizeCommand(line));
    const base = baseCommandForStdin(line, lineTokens);
    if (base === '' || !isStdinCodeExecutor(base)) continue;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const candidate = marker.stripTabs ? lines[j]!.replace(/^\t+/, '') : lines[j]!;
      if (candidate === marker.delimiter) break;
    }
    i = j; // пропускаем тело и строку-делимитер
  }
  return out.join('\n');
}

/** ask: динамическое имя команды (не путь). */
function askForDynamicCommand(command: string): ShellCheckResult {
  return {
    action: 'ask',
    reason: sm('shellguard.ask_command', { command }),
    matchedRule: 'shell-policy.approve',
    deniedPath: command,
    messageId: 'ask-dynamic-command',
    params: { command },
    askKind: 'dynamic',
  };
}

/** Простое значение имени команды: без пробелов/метасимволов/glob. */
const SIMPLE_COMMAND_VALUE_RE = /^[^\s;|&<>(){}`$*?[\]]+$/;

/** Проверяет один сегмент команды; null — сегмент не нарушает политику. */
function checkShellSegment(
  segment: string,
  cwd: string,
  policy: ShellPolicy,
  deniedPaths: string[],
  approvalPaths: string[],
  deniedPrefixes: string[],
  env?: PathResolveEnv,
  bindings?: ReadonlyMap<string, ShellBinding>,
  roots: readonly string[] = [cwd],
  depth = 0,
): ShellCheckResult | null {
  const tokens = stripShellPrefixes(tokenizeCommand(segment));
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
  // вложенную команду (B4). Ask из вложенной откладываем: deny внешнего
  // сегмента приоритетнее (`sh -c 'cat ~/.ssh/config' /etc/passwd`).
  let deferredAsk: ShellCheckResult | null = null;
  // Код на stdin (`<<`, `<<-`, `<<<`): содержимое heredoc/herestring не
  // анализируется, поэтому для shell/интерпретаторов/awk — fail-closed ask.
  // `cat <<EOF`, `grep <<< "$x"` не трогаем (команда не исполняет stdin-код).
  const hasHeredoc = segment.includes('<<');
  const heredocBase = hasHeredoc ? baseCommandForStdin(segment, tokens) : '';
  const heredocCode = hasHeredoc && heredocBase !== '' && isStdinCodeExecutor(heredocBase);
  if (heredocCode) return askForDynamic('<<');
  const heredocData = hasHeredoc && !heredocCode;
  const inner = extractWrappedCommand(segment, tokens);
  if (inner !== null) {
    const innerCwd = wrapperCwd(tokens, cwd, env) ?? cwd;
    const innerSegments = splitShellSegments(inner);
    for (const s of innerSegments) {
      const r = checkShellSegment(s, innerCwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots, depth);
      if (!r) continue;
      if (r.action === 'deny') return r;
      deferredAsk ??= r;
    }
  }

  // 1c. Встроенные команды/код: awk system(...), find -exec, интерпретаторы.
  const embedded = checkAwkProgram(tokens, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots)
    ?? checkFindExec(tokens, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots)
    ?? checkInterpreterCode(tokens, policy);
  if (embedded) {
    if (embedded.action === 'deny') return embedded;
    deferredAsk ??= embedded;
  }
  // 1d. Общий скан аргументов встроенных исполнителей (F).
  const executorArgs = checkEmbeddedExecutorArgs(tokens, cwd, policy, roots, depth, bindings);
  if (executorArgs) {
    if (executorArgs.action === 'deny') return executorArgs;
    deferredAsk ??= executorArgs;
  }
  // 1e. Код в опциях инструментов (`git -c`, `tar --to-command`, `rsync -e`).
  const toolCode = checkToolCodeArgs(tokens, cwd, policy, roots, depth, bindings);
  if (toolCode) {
    if (toolCode.action === 'deny') return toolCode;
    deferredAsk ??= toolCode;
  }

  // 2. Неразрешимая динамика ($VAR, ${VAR}, glob, $()) — fail-closed:
  // литеральные фрагменты токена проверяем по маркерам защищённых путей.
  // `cat $SYNTH_DATA_DIR/secrets/master.key`, `$USER/.ssh/id_rsa`,
  // `/data/secrets/*.key`, `$(pwd)/.ssh/x` → deny (раньше проходили молча).
  // Brace-expansion применяется до маркерной проверки (`$X/shad{ow,}`).
  for (const token of tokens) {
    if (!hasUnresolvedDynamic(token)) continue;
    const brace = expandBraces(token);
    const variants = brace === null || brace === 'literal' ? [token] : brace;
    if (variants.some((variant) => tokenTouchesProtectedMarker(variant, policy))) {
      return deniedByDynamicToken(token);
    }
  }

  // 2b. Присваивания `NAME=value`: значение тоже путь и может обойти проверку
  // аргументов (`X=<dataDir>/secrets/master.key cat $X`). Deny-only: `ask` на
  // `PATH=$PATH:/opt/bin` не нужен — такие значения в deny не попадут.
  for (const token of tokens) {
    const assign = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(token);
    if (!assign) continue;
    const value = assign[1]!;
    const resolvedValue = tryResolvePath(value, cwd, env);
    if (resolvedValue && resolvedValue.source === 'literal') {
      const norm = normalize(resolvedValue.path);
      for (const variant of pathVariants(norm)) {
        const pathHit = deniedPaths.find((p) => normalize(p) === variant);
        if (pathHit) return deniedByPath(pathHit);
        const dirHit = deniedPrefixes.find((p) => isUnderDeniedPrefix(variant, p));
        if (dirHit) return deniedByDir(variant, dirHit);
      }
    } else if (hasUnresolvedDynamic(value) && tokenTouchesProtectedMarker(value, policy)) {
      return deniedByDynamicToken(value);
    }
  }

  const patternIndices = patternArgumentIndices(tokens);
  const extracted = extractCommandPathTokens(tokens, cwd, env, patternIndices);

  // 3. Литеральные аргументы: deny (точный путь/префикс) приоритетнее ask;
  // approvalPaths — исключение из deniedPrefixes (`~/.ssh/config` → ask).
  const asks: ShellCheckResult[] = [];
  const findStarts = checkFindMutationStarts(
    tokens, cwd, env, roots, deniedPaths, approvalPaths, deniedPrefixes,
  );
  if (findStarts) {
    if (findStarts.action === 'deny') return findStarts;
    asks.push(findStarts);
  }
  for (const { resolved } of extracted) {
    if (resolved.source !== 'literal') continue;
    const classified = classifyResolvedPath(
      normalize(resolved.path), deniedPaths, approvalPaths, deniedPrefixes,
    );
    if (!classified) continue;
    if (classified.kind === 'deny') return classified.result;
    asks.push(classified.result);
  }

  // 4. Присваивания и `for`-циклы: если динамический токен раскрывается в
  // одиночные литеральные пути, проверяем КАЖДОЕ значение. Значение с
  // пробелами/шелл-метасимволами — не путь, а команда/текст (`eval $C`,
  // `sh -c "$C"`): не помечаем раскрытым, шаг 6 останется fail-closed.
  const resolvedDynamic = new Set<number>();
  const expanded: string[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const { token, resolved } = extracted[i]!;
    if (resolved.source === 'literal') continue;
    const values = expandToken(token, bindings ?? EMPTY_BINDINGS);
    if (values === null || values.length === 0) continue;
    const paths: string[] = [];
    let allLiteral = true;
    for (const value of values) {
      if (!isSinglePathValue(value)) {
        allLiteral = false;
        break;
      }
      const r = tryResolvePath(value, cwd, env);
      if (!r || r.source !== 'literal') {
        allLiteral = false;
        break;
      }
      paths.push(r.path);
    }
    if (!allLiteral) continue;
    expanded.push(...paths);
    resolvedDynamic.add(i);
  }
  for (const path of expanded) {
    const classified = classifyResolvedPath(
      normalize(path), deniedPaths, approvalPaths, deniedPrefixes,
    );
    if (!classified) continue;
    if (classified.kind === 'deny') return classified.result;
    asks.push(classified.result);
  }

  // 5. После всех deny — ask (approvalPaths литералов и раскрытых значений).
  // Не возвращаем сразу: другой токен (glob) может дать deny — он приоритетнее.

  // 5b. Динамическое имя команды (`$C`, `` `...` ``) — fail-closed ask:
  // что именно запустится, неизвестно (`C='rm -rf /'; $C`). Ведущие
  // присваивания (`PATH=… ls`) именем команды не считаются.
  const commandWord = commandToken(tokens);
  const testContext = commandWord === '[' || commandWord === '[['
    || commandWord === 'test' || commandWord === '((' || commandWord === '(((';
  if (/[$`]/.test(commandWord)) {
    // Чистая подстановка как код/команда — отдельное сообщение, не «имя команды».
    if (commandWord.startsWith('$(') || commandWord.startsWith('`')) {
      asks.push(askForDynamicCode(commandWord));
    } else {
      // Если имя команды раскрывается из литеральных биндингов (`for t in …`)
      // в простые значения — проверяем каждый вариант как отдельную команду.
      const values = expandToken(commandWord, bindings ?? EMPTY_BINDINGS);
      const simple = values !== null && values.length > 0
        && values.every((value) => SIMPLE_COMMAND_VALUE_RE.test(value));
      if (!simple || depth >= MAX_EMBEDDED_DEPTH) {
        asks.push(askForDynamicCommand(commandWord));
      } else {
        const cmdIdx = commandIndex(tokens);
        for (const value of values!) {
          const rewrittenTokens = tokens.slice();
          rewrittenTokens[cmdIdx] = value;
          const rewritten = joinShellTokens(rewrittenTokens);
          const r = checkShellSegment(
            rewritten, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes,
            env, bindings, roots, depth + 1,
          );
          if (!r) continue;
          if (r.action === 'deny') return r;
          deferredAsk ??= r;
        }
      }
    }
  }

  // 6. Неразрешимая динамика-путь без защищённых маркеров: подтверждение
  // пользователя (не пропускаем молча). Критерий «путь» — строгий
  // (`isPathLikeTarget`): текст в кавычках (`echo "a/b (c)"`), JS-однострочники
  // и `origin/master` путями не считаются. Раскрытые значения (4) пропускаем;
  // однокомпонентный glob внутри периметра проверяется по фактическим
  // совпадениям (`evaluateWorkspaceGlob`), остальное — `ask`.
  const unsupportedBraces = new Set(tokens.filter((token) => expandBraces(token) === null));
  for (let i = 0; i < extracted.length; i++) {
    const { token, resolved } = extracted[i]!;
    if (resolved.source === 'literal') continue;
    if (resolvedDynamic.has(i)) continue;
    // `$VAR` в тест-контексте (`[ … ]`, `[[ … ]]`, `test`, `(( … ))`) или в
    // heredoc/herestring-данных (`grep <<< "$x"`) — значение, а не путь.
    if ((testContext || heredocData) && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(token)) continue;
    // Слитное перенаправление: сам оператор не путь — цель добавлена операндом.
    if (parseRedirectToken(token) !== null) continue;
    if (unsupportedBraces.has(token)) {
      asks.push(askForDynamic(token));
      continue;
    }
    const isGlob = GLOB_CHARS_RE.test(token);
    if (!isGlob && !isPathLikeTarget(token)) continue;
    const glob = evaluateWorkspaceGlob(
      token, cwd, env, roots, deniedPaths, approvalPaths, deniedPrefixes,
    );
    if (glob.kind === 'result') {
      if (glob.result.action === 'deny') return glob.result;
      asks.push(glob.result);
      continue;
    }
    if (glob.kind === 'safe') continue;
    if (!isPathLikeTarget(token)) continue;
    asks.push(askForDynamic(token));
  }

  if (asks.length > 0) return asks[0]!;
  if (deferredAsk) return deferredAsk;
  return null;
}

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

/** Собирает паттерны из вложенной команды; `false` — нерезолвимая динамика. */
function collectShellPatterns(
  segment: string,
  bindings: ReadonlyMap<string, ShellBinding>,
  out: string[],
  depth: number,
): boolean {
  const rawTokens = tokenizeCommand(segment);
  if (rawTokens.length === 0) return true;
  if (SHELL_HEADER_KEYWORDS.has(rawTokens[0]!)) return true;
  const tokens = stripShellPrefixes(rawTokens);
  if (tokens.length === 0) return true;

  const inner = extractWrappedCommand(segment, tokens);
  if (inner !== null) {
    if (depth >= MAX_EMBEDDED_DEPTH) return false;
    for (const nested of splitShellSegments(inner)) {
      if (!collectShellPatterns(nested, bindings, out, depth + 1)) return false;
    }
    return true;
  }

  const cmdIdx = commandIndex(tokens);
  if (cmdIdx < 0) return true;
  const cmd = tokens[cmdIdx]!;
  if (cmd === '') return true;

  if (/[$`]/.test(cmd)) {
    const values = expandToken(cmd, bindings);
    if (values === null || values.length === 0) return false;
    if (!values.every((value) => SIMPLE_COMMAND_VALUE_RE.test(value))) return false;
    for (const value of values) {
      const effective = tokens.slice();
      effective[cmdIdx] = value;
      out.push(shellPatternFor(effective, value));
    }
    return true;
  }
  out.push(shellPatternFor(tokens, cmd));
  return true;
}

/**
 * Паттерны для сессионного shell-гранта (`{ "<pattern>": "allow" }`).
 * `null` — хотя бы одна команда нерезолвима (грант безопасно не выдаётся);
 * `[]` — паттернов нет (только заголовки). Дедуп, порядок появления, ≤ 20.
 */
export function shellSavePatterns(command: string): string[] | null {
  const bindings = collectBindings(command);
  const out: string[] = [];
  for (const segment of splitShellSegments(command)) {
    if (!collectShellPatterns(segment, bindings, out, 0)) return null;
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

  const bindings = collectBindings(command);
  let checked = false;

  const matches = (tokens: string[], cmdIdx: number, cmd: string): boolean => {
    const effective = tokens.slice();
    effective[cmdIdx] = cmd;
    const rendered = joinShellTokens(effective);
    return patterns.some((pattern) => matchShellCommandPattern(pattern, rendered));
  };

  const grantedSegment = (segment: string, depth: number): boolean => {
    const rawTokens = tokenizeCommand(segment);
    if (rawTokens.length === 0) return true;
    if (SHELL_HEADER_KEYWORDS.has(rawTokens[0]!)) return true;
    const tokens = stripShellPrefixes(rawTokens);
    if (tokens.length === 0) return true;

    const inner = extractWrappedCommand(segment, tokens);
    if (inner !== null) {
      if (depth >= MAX_EMBEDDED_DEPTH) return false;
      return splitShellSegments(inner).every((nested) => grantedSegment(nested, depth + 1));
    }

    const cmdIdx = commandIndex(tokens);
    if (cmdIdx < 0) return true;
    const cmd = tokens[cmdIdx]!;
    checked = true;
    if (/[$`]/.test(cmd)) {
      const values = expandToken(cmd, bindings);
      if (values === null || values.length === 0) return false;
      return values.every((value) => {
        if (!SIMPLE_COMMAND_VALUE_RE.test(value)) return false;
        return matches(tokens, cmdIdx, value);
      });
    }
    return matches(tokens, cmdIdx, cmd);
  };

  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (!grantedSegment(segment, 0)) return false;
  }
  return checked;
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
