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
import { globMatch } from '@itphx/synth-shared';
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

/**
 * Извлекает вложенную команду из обёрток, исполняющих строку как shell-код:
 * `sh -c <cmd>`, `bash -c <cmd>`, `zsh -c <cmd>`, `eval <cmd>`, `sudo <cmd>`.
 * Возвращает null, если команда не является обёрткой.
 */
export function extractWrappedCommand(segment: string, tokens: string[]): string | null {
  const cmd = tokens[0] ?? '';
  if (cmd === 'sh' || cmd === 'bash' || cmd === 'zsh') {
    // `-c`, слитные `-lc`/`-ec` и приклеенная строка `-c'cmd'`.
    const flag = /^-([A-Za-z]*)c(.*)$/.exec(tokens[1] ?? '');
    if (flag) {
      const rest = [flag[2] ?? '', ...tokens.slice(2)].filter((t) => t !== '').join(' ');
      if (rest.trim() !== '') return rest;
      // fallback: токенизатор мог потерять кавычки — берём сырой остаток строки.
      const m = /(?:^|\s)-[A-Za-z]*c([\s\S]*)$/.exec(segment);
      return m ? m[1]! : null;
    }
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

/** Имя команды сегмента (первый токен, не являющийся ведущим присваиванием). */
function commandToken(tokens: readonly string[]): string {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isLeadingAssignment(t)) continue;
    if (t === 'export' && i === 0) continue;
    return t;
  }
  return '';
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

    const extracted = tryResolvePath(token, cwd, env);
    if (extracted) result.push({ token, resolved: extracted });
  }

  // Слитные перенаправления (`>/etc/shadow`, `2>/etc/passwd`, `&>…`): цель —
  // тоже путь, проверяем её как обычный операнд. Раздельные формы (`> file`)
  // уже попадают в результат выше.
  for (let i = 0; i < tokens.length; i++) {
    const target = parseRedirectToken(tokens[i]!);
    if (target === null) continue;
    if (/^\d+$/.test(target) || target === '-' || target === '&-') continue; // fd
    const extracted = tryResolvePath(target, cwd, env);
    if (extracted) result.push({ token: target, resolved: extracted });
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
  options?: { allowedRoots?: readonly string[] },
): ShellCheckResult {
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
  const env = resolveEnv(policy);
  // Биндинги считаются на уровне всей команды: `splitShellSegments` разрывает
  // `for ...; do ...` на сегменты, и значение переменной задано в другом.
  const bindings = collectBindings(command);
  const roots = [cwd, ...(options?.allowedRoots ?? [])];

  let ask: ShellCheckResult | null = null;
  for (const segment of segments) {
    const result = checkShellSegment(
      segment, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots,
    );
    if (!result) continue;
    // Deny приоритетнее ask: `cat ~/.ssh/config; cat /etc/passwd` → deny.
    if (result.action === 'deny') return result;
    ask ??= result;
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
  const real = resolveRealPath(norm);
  return real !== null && real !== norm ? [norm, real] : [norm];
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
function readDirLimited(dir: string, limit: number): string[] | null {
  let handle: Dir | undefined;
  try {
    handle = opendirSync(dir);
    const names: string[] = [];
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > limit) return null;
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
  const lastSlash = token.lastIndexOf('/');
  if (lastSlash === -1) return { kind: 'skip' };
  if (token.search(GLOB_CHARS_RE) === -1 || token.search(GLOB_CHARS_RE) < lastSlash) {
    return { kind: 'skip' };
  }
  const components = token.split('/');
  if (components.includes('..')) return { kind: 'skip' };

  const dirToken = lastSlash === 0 ? '/' : token.slice(0, lastSlash);
  const resolved = tryResolvePath(dirToken, cwd, env);
  if (!resolved || resolved.source !== 'literal') return { kind: 'skip' };
  const dir = resolved.path;
  // Литеральный каталог обязан быть внутри периметра (realpath обязателен).
  if (resolveRealPath(dir) === null || !isInsideRoots(dir, roots)) return { kind: 'skip' };

  const pattern = token.slice(lastSlash + 1);
  if (pattern === '') return { kind: 'skip' };
  const names = readDirLimited(dir, GLOB_READDIR_LIMIT);
  if (names === null) return { kind: 'skip' };
  const matches = names.filter((name) => globMatch(pattern, name));
  if (matches.length === 0) return { kind: 'skip' };

  // Deny приоритетнее ask: сначала все deny и проверка периметра, затем approval.
  let uncertain = false;
  let approval: ShellCheckResult | null = null;
  for (const name of matches) {
    const path = join(dir, name);
    if (resolveRealPath(path) === null || !isInsideRoots(path, roots)) {
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
  // вложенную команду (B4). Ask из вложенной откладываем: deny внешнего
  // сегмента приоритетнее (`sh -c 'cat ~/.ssh/config' /etc/passwd`).
  let deferredAsk: ShellCheckResult | null = null;
  const inner = extractWrappedCommand(segment, tokens);
  if (inner !== null) {
    const innerSegments = splitShellSegments(inner);
    for (const s of innerSegments) {
      const r = checkShellSegment(s, cwd, policy, deniedPaths, approvalPaths, deniedPrefixes, env, bindings, roots);
      if (!r) continue;
      if (r.action === 'deny') return r;
      deferredAsk ??= r;
    }
  }

  // 2. Неразрешимая динамика ($VAR, ${VAR}, glob, $()) — fail-closed:
  // литеральные фрагменты токена проверяем по маркерам защищённых путей.
  // `cat $SYNTH_DATA_DIR/secrets/master.key`, `$USER/.ssh/id_rsa`,
  // `/data/secrets/*.key`, `$(pwd)/.ssh/x` → deny (раньше проходили молча).
  for (const token of tokens) {
    if (!hasUnresolvedDynamic(token)) continue;
    if (tokenTouchesProtectedMarker(token, policy)) return deniedByDynamicToken(token);
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
  if (/[$`]/.test(commandWord)) {
    asks.push({
      action: 'ask',
      reason: sm('shellguard.ask_path', { path: commandWord }),
      matchedRule: 'shell-policy.approve',
      deniedPath: commandWord,
      messageId: 'ask-protected-path',
      params: { path: commandWord },
    });
  }

  // 6. Неразрешимая динамика-путь без защищённых маркеров: подтверждение
  // пользователя (не пропускаем молча). Критерий «путь» — строгий
  // (`isPathLikeTarget`): текст в кавычках (`echo "a/b (c)"`), JS-однострочники
  // и `origin/master` путями не считаются. Раскрытые значения (4) пропускаем;
  // однокомпонентный glob внутри периметра проверяется по фактическим
  // совпадениям (`evaluateWorkspaceGlob`), остальное — `ask`.
  for (let i = 0; i < extracted.length; i++) {
    const { token, resolved } = extracted[i]!;
    if (resolved.source === 'literal') continue;
    if (resolvedDynamic.has(i)) continue;
    // Слитное перенаправление (`</dev/tcp/…`, `>/file`): сам оператор не путь —
    // цель уже добавлена отдельным операндом (`extractCommandPathTokens`).
    if (parseRedirectToken(token) !== null) continue;
    if (!isPathLikeTarget(token)) continue;
    const glob = evaluateWorkspaceGlob(
      token, cwd, env, roots, deniedPaths, approvalPaths, deniedPrefixes,
    );
    if (glob.kind === 'result') {
      if (glob.result.action === 'deny') return glob.result;
      asks.push(glob.result);
      continue;
    }
    if (glob.kind === 'safe') continue;
    asks.push({
      action: 'ask',
      reason: sm('shellguard.ask_path', { path: token }),
      matchedRule: 'shell-policy.approve',
      deniedPath: token,
      messageId: 'ask-protected-path',
      params: { path: token },
    });
  }

  if (asks.length > 0) return asks[0]!;
  if (deferredAsk) return deferredAsk;
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
