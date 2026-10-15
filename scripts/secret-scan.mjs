#!/usr/bin/env node
/**
 * scripts/secret-scan.mjs — secret-scan без внешних зависимостей (Node 22+, только `node:*` и `git`).
 *
 * Зачем собственный сканер, а не gitleaks-бинарник: на раннерах GitVerse внешняя сеть
 * нестабильна/недоступна (см. `scripts/ci-helm.sh` — get.helm.sh не открывается, helm ставится
 * из зеркал/образа). Скачивание релиза gitleaks с GitHub — тот же класс риска, поэтому гейт
 * релиза опирается на инструмент, который есть в любой джобе всегда: node + git.
 *
 * Возможности:
 *   * правила regex (+ Shannon-entropy и проверки формата для «generic»-правил), версионируемые здесь;
 *   * поддержка allowlist из `.gitleaks.toml` (подмножество TOML: `[extend]`, `[[allowlists]]`,
 *     legacy `[allowlist]`; ключи `paths` / `regexes` / `stopwords`: AND внутри блока, OR между блоками);
 *   * три режима: рабочее дерево (`worktree`, включая новые незакоммиченные файлы, но не
 *     игнорируемые `.gitignore` — в т.ч. `tmp/`), вся история по добавленным строкам (`commits`),
 *     вся история по уникальным blob-ам (`blobs`, строгий);
 *   * маскирование находки в выводе и отчёте (секрет целиком не печатается — ни в логе, ни в артефакте);
 *   * JSON-отчёт для артефакта аудита (`--report <path>`).
 *
 * Использование:
 *   node scripts/secret-scan.mjs                                  # worktree + вся история (commits)
 *   node scripts/secret-scan.mjs --mode blobs                     # строго: все уникальные blob-ы истории
 *   node scripts/secret-scan.mjs --mode commits --range v0.10.1..HEAD
 *   node scripts/secret-scan.mjs --report tmp/security/secret-scan.json --quiet
 *   node scripts/secret-scan.mjs --list-allowlists                # что реально подавляется (для аудита)
 *   node scripts/secret-scan.mjs --list-rules
 *
 * Коды возврата: 0 — чисто (в т.ч. когда все находки подавлены allowlist), 1 — есть находки,
 *                2 — ошибка запуска/конфигурации (в CI трактуется как падение джобы).
 *
 * Сканер только читает файлы и объекты git: ничего не пишет (кроме `--report`) и не ходит в сеть.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

// --- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const values = new Map();
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--') && a.includes('=')) {
    const idx = a.indexOf('=');
    values.set(a.slice(0, idx), a.slice(idx + 1));
  } else if (a.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
    values.set(a, argv[i + 1]);
  }
}
const get = (name, fallback = undefined) => (values.has(name) ? values.get(name) : fallback);

const ROOT = resolve(get('--root', '.'));
const MODE = get('--mode', 'auto'); // auto = worktree + commits
const RANGE = get('--range', null);
const CONFIG_PATH = resolve(ROOT, get('--config', '.gitleaks.toml'));
const REPORT_PATH = get('--report', null);
const QUIET = flags.has('--quiet');
const JSON_OUT = flags.has('--json');
const MAX_FILE_BYTES = Number(get('--max-file-bytes', String(2 * 1024 * 1024)));
const MAX_FINDINGS = Number(get('--max-findings', '200'));

const out = (s) => !QUIET && !JSON_OUT && process.stdout.write(`${s}\n`);

// --- Правила ----------------------------------------------------------------
/**
 * severity: `critical` — приватный ключ / ключ самого Synth; `high` — токен с явным префиксом
 * провайдера; `medium` — «generic»-креды по присваиванию (дополнительно проверяются entropy
 * и формат значения, чтобы правило не срабатывало на ссылках вида `this.config.clientSecret`).
 *
 * Опции правила:
 *   entropy    — минимальная Shannon-entropy значения;
 *   minLength  — минимальная длина значения (после strip);
 *   minClasses — сколько классов символов (a-z / A-Z / 0-9) должно быть в значении;
 *   strip      — префикс, не учитываемый в проверках длины/классов;
 *   stopwords  — подстроки, при наличии которых совпадение игнорируется;
 *   requires   — предикат по контексту (для проверки, что это реальный ключ, а не заголовок-плейсхолдер).
 */
const RULES = [
  {
    id: 'private-key',
    description: 'Приватный ключ (PEM/OpenSSH/PGP) в открытом виде',
    severity: 'critical',
    regex: /-----BEGIN(?: [A-Z0-9_]+){0,4} PRIVATE KEY(?: BLOCK)?-----/g,
    // Одиночный заголовок (`'-----BEGIN OPENSSH PRIVATE KEY-----'` как плейсхолдер/подсказка)
    // ключом не является: требуется тело ключа или парный END (в т.ч. в одной строке с `\n`).
    requires: ({ line, lines, lineIndex }) => {
      if (/-----END(?: [A-Z0-9_]+){0,4} PRIVATE KEY(?: BLOCK)?-----/.test(line)) return true;
      for (let k = lineIndex + 1; k < Math.min(lineIndex + 6, lines.length); k += 1) {
        if (/^[A-Za-z0-9+/=]{40,}$/.test(lines[k].trim())) return true;
        if (/-----END/.test(lines[k])) return false;
      }
      return false;
    },
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS Access Key ID',
    severity: 'high',
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g,
    entropy: 3.5,
  },
  {
    id: 'github-token',
    description: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_)',
    severity: 'high',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    id: 'npm-token',
    description: 'npm token (npm_…)',
    severity: 'high',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack token (xox…)',
    severity: 'high',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'telegram-bot-token',
    description: 'Telegram bot token (<bot_id>:<secret>)',
    severity: 'high',
    regex: /\b\d{8,12}:[A-Za-z0-9_-]{33,}\b/g,
  },
  {
    id: 'llm-api-key',
    description: 'Ключ LLM-провайдера (OpenAI/Anthropic и совместимые: sk-, sk-ant-, sk-proj-)',
    severity: 'high',
    regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/g,
    // Реальные ключи длинные и смешанного регистра; короткие/однорегистровые строки
    // (`sk-aaaa…`, `sk-test-aaaa…`) — фикстуры тестов, а не креды.
    strip: /^sk-(?:ant-|proj-)?/,
    minLength: 32,
    minClasses: 2,
    entropy: 3.5,
  },
  {
    id: 'jwt',
    description: 'JWT (три base64url-сегмента)',
    severity: 'medium',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: 'synth-service-key',
    description: 'Synth service-key / binding-key в открытом виде (synth_svc_…, synth_evt_…)',
    severity: 'critical',
    regex: /\bsynth_(?:svc|evt)_[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'synth-webhook-secret',
    description: 'Synth webhook signing secret (whsec_…)',
    severity: 'high',
    regex: /\bwhsec_[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'authorization-bearer',
    description: 'Литеральный Bearer-токен (заголовок Authorization / пример curl)',
    severity: 'high',
    regex: /(?<![A-Za-z])[Bb]earer\s+(?<secret>[A-Za-z0-9._~+/-]{24,}=*)/g,
    stopwords: ['<token>', '<key>', '<your', '${{', '$env', 'process.env', 'replace', 'placeholder'],
  },
  {
    id: 'authorization-basic',
    description: 'Литеральные Basic-креды (Authorization: Basic …)',
    severity: 'high',
    regex: /(?<![A-Za-z])[Bb]asic\s+(?<secret>[A-Za-z0-9+/]{24,}={0,2})/g,
  },
  {
    id: 'url-basic-auth',
    description: 'Креды в URL (scheme://user:password@host)',
    severity: 'high',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"]+:(?<secret>[^\s/@"]{8,})@/g,
    // Документационный плейсхолдер (`user:password@host` в описании/доках) — не креды;
    // реальная утечка (`https://admin:S3cret@db.internal`) этим не подавляется.
    stopwords: ['user:password', 'password@host', 'example.com'],
  },
  {
    id: 'generic-credential-literal',
    description: 'Литеральный секрет в присваивании (key/secret/token/password = "…")',
    severity: 'medium',
    regex:
      /(?<![A-Za-z0-9_])(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|pwd|token)\s*[:=]\s*(["'`])(?<secret>[A-Za-z0-9+/=_.-]{16,})\1/gi,
    entropy: 3.4,
    stopwords: [
      'process.env',
      'import.meta',
      '${{',
      '${',
      '<your',
      '<token>',
      '<key>',
      'placeholder',
      'changeme',
      'redacted',
      'example.com',
    ],
  },
  {
    id: 'generic-credential-assignment',
    description: 'Секрет без кавычек в присваивании (KEY=длинное_значение), `.env`-стиль',
    severity: 'medium',
    // Значение без `.` — отсекает ссылки на свойства (`config.secretKey`, `refreshed.accessToken`),
    // которые ловят «жадные» generic-правила и дают десятки ложных срабатываний в коде.
    regex:
      /(?<![A-Za-z0-9_])(?:API[_-]?KEY|SECRET[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|REFRESH[_-]?TOKEN|PRIVATE[_-]?KEY|PASSWORD|PASSWD|PWD|TOKEN)\s*[:=]\s*(?<secret>[A-Za-z0-9+/=_-]{20,})/g,
    entropy: 3.6,
    stopwords: ['process.env', '${{', '${', 'placeholder', 'changeme', 'redacted'],
  },
];

// --- Мини-парсер TOML (подмножество для .gitleaks.toml) ---------------------
/**
 * Поддерживается ровно то подмножество TOML, которое используется в `.gitleaks.toml`:
 * `[table]` / `[[array-of-tables]]`, скаляры (строки в '…' / "…" / '''…''' / """…""", bool, число),
 * массивы скаляров в одну строку и многострочные, `#`-комментарии.
 * Всё остальное — ошибка: лучше упасть (exit 2), чем молча проигнорировать allowlist.
 */
/** Убирает `#`-комментарий, не трогая содержимое строк в кавычках (обычных и тройных). */
function stripComment(line) {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') return line.slice(0, i).trimEnd();
    if (ch === '"' || ch === "'") {
      const q = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      const end = line.indexOf(q, i + q.length);
      if (end < 0) return line; // строка продолжается на следующей физической строке
      i = end + q.length;
      continue;
    }
    i += 1;
  }
  return line;
}

function parseTomlString(src, start) {
  const triple = src.startsWith("'''", start) || src.startsWith('"""', start);
  const q = triple ? src.slice(start, start + 3) : src[start];
  let i = start + q.length;
  let res = '';
  while (i < src.length) {
    if (triple && src.startsWith(q, i)) return [res, i + 3];
    if (!triple && src[i] === q) return [res, i + 1];
    if (!triple && src[i] === '\\') {
      const next = src[i + 1];
      res += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i += 2;
      continue;
    }
    res += src[i];
    i += 1;
  }
  throw new Error('незакрытая строка в TOML');
}

function parseTomlValue(src, start) {
  const s = src.slice(start);
  if (s.startsWith('"""') || s.startsWith("'''") || s.startsWith('"') || s.startsWith("'")) {
    return parseTomlString(src, start);
  }
  if (s[0] === '[') {
    const items = [];
    let i = start + 1;
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i += 1;
      if (i >= src.length) throw new Error('незакрытый массив в TOML');
      if (src[i] === ']') return [items, i + 1];
      const [value, next] = parseTomlValue(src, i);
      items.push(value);
      i = next;
    }
  }
  if (s.startsWith('true')) return [true, start + 4];
  if (s.startsWith('false')) return [false, start + 5];
  const num = /^[-+]?\d+(?:\.\d+)?/.exec(s);
  if (num) return [Number(num[0]), start + num[0].length];
  throw new Error(`неподдерживаемое значение TOML: ${s.slice(0, 40)}`);
}

function parseToml(text) {
  const root = {};
  let current = root;
  const rawLines = text.split('\n');
  let idx = 0;
  while (idx < rawLines.length) {
    const line = stripComment(rawLines[idx]);
    if (!line.trim()) {
      idx += 1;
      continue;
    }
    const mTable = /^\[\[?\s*([A-Za-z0-9_.-]+)\s*\]?\]?\]?$/.exec(line.trim());
    if (mTable) {
      const isArray = line.trim().startsWith('[[');
      const pathParts = mTable[1].split('.');
      let node = root;
      for (const part of pathParts.slice(0, -1)) {
        node[part] = node[part] ?? {};
        node = node[part];
      }
      const leaf = pathParts[pathParts.length - 1];
      if (isArray) {
        node[leaf] = node[leaf] ?? [];
        const entry = {};
        node[leaf].push(entry);
        current = entry;
      } else {
        node[leaf] = node[leaf] ?? {};
        current = node[leaf];
      }
      idx += 1;
      continue;
    }
    const mKey = /^([A-Za-z0-9_.-]+)\s*=\s*([\s\S]*)$/.exec(line.trim());
    if (!mKey) throw new Error(`не разобрана строка TOML: ${line.trim().slice(0, 60)}`);
    let valueSrc = mKey[2];
    let consumed = 1;
    let value;
    // Значение может занимать несколько физических строк (массивы, тройные кавычки):
    // дочитываем строки, пока парсер не признает значение полным.
    for (;;) {
      try {
        [value] = parseTomlValue(valueSrc, 0);
        break;
      } catch (err) {
        if (idx + consumed >= rawLines.length) throw err;
        consumed += 1;
        valueSrc = rawLines
          .slice(idx, idx + consumed)
          .map((l) => stripComment(l))
          .join('\n')
          .replace(/^[^=]+=\s*/, '');
      }
    }
    current[mKey[1]] = value;
    idx += consumed;
  }
  return root;
}

function loadAllowlists(configPath) {
  if (!existsSync(configPath)) {
    return { blocks: [], source: null, note: 'конфиг .gitleaks.toml не найден — allowlist пуст' };
  }
  const parsed = parseToml(readFileSync(configPath, 'utf8'));
  const blocks = [];
  const push = (block) => {
    const entry = {
      description: String(block.description ?? '(без описания)'),
      paths: Array.isArray(block.paths) ? block.paths.map(String) : [],
      regexes: Array.isArray(block.regexes) ? block.regexes.map(String) : [],
      stopwords: Array.isArray(block.stopwords) ? block.stopwords.map(String) : [],
    };
    if (entry.paths.length || entry.regexes.length || entry.stopwords.length) blocks.push(entry);
  };
  for (const a of Array.isArray(parsed.allowlists) ? parsed.allowlists : []) push(a);
  if (parsed.allowlist) push(parsed.allowlist);
  return {
    blocks,
    source: relative(ROOT, configPath) || configPath,
    note: `allowlist-блоков: ${blocks.length}`,
  };
}

// --- Сопоставление ----------------------------------------------------------

function shannonEntropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function classCount(s) {
  let n = 0;
  if (/[a-z]/.test(s)) n += 1;
  if (/[A-Z]/.test(s)) n += 1;
  if (/[0-9]/.test(s)) n += 1;
  return n;
}

function mask(secret) {
  if (secret.length <= 12) return `${secret.slice(0, 2)}…${secret.slice(-2)} (len ${secret.length})`;
  return `${secret.slice(0, 8)}…${secret.slice(-4)} (len ${secret.length})`;
}

/**
 * Подавление находки allowlist-блоками. Семантика как в gitleaks: условия внутри блока
 * объединяются через И, между блоками — через ИЛИ. `paths` проверяются по пути файла,
 * `regexes`/`stopwords` — по строке кода (`regexTarget = "line"`) и/или по значению.
 */
function isSuppressed({ file, lineText, secret }, allowlists) {
  for (const block of allowlists) {
    const conditions = [];
    if (block.paths.length) conditions.push(block.paths.some((p) => new RegExp(p).test(file)));
    if (block.regexes.length) {
      const hay = `${lineText ?? ''}\n${secret ?? ''}`;
      conditions.push(block.regexes.some((r) => new RegExp(r).test(hay)));
    }
    if (block.stopwords.length) {
      const hay = `${lineText ?? ''}\n${secret ?? ''}`.toLowerCase();
      conditions.push(block.stopwords.some((w) => hay.includes(w.toLowerCase())));
    }
    if (conditions.length && conditions.every(Boolean)) return block.description;
  }
  return null;
}

const SKIP_PATH_RE = /(^|\/)(node_modules|\.git|dist|build|coverage|\.pnpm-store|tmp)\//;

function shouldSkipPath(path) {
  const p = path.split(sep).join('/');
  if (SKIP_PATH_RE.test(p)) return true;
  if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.min\.js|.*\.snap)$/.test(p)) return true;
  return false;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * Сканирует текстовый фрагмент. Находки дедуплицируются по `file:line:masked`
 * (одно и то же значение не должно попадать в отчёт дважды — например, под двумя generic-правилами).
 */
function scanText(file, text, meta, allowlists, acc) {
  const lines = text.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line || line.length > 4000) continue;
    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      let m;
      while ((m = rule.regex.exec(line)) !== null) {
        if (m[0] === '') {
          rule.regex.lastIndex += 1;
          continue;
        }
        const raw = m.groups?.secret ?? m[0];
        const secret = rule.strip ? raw.replace(rule.strip, '') : raw;
        if (rule.minLength !== undefined && secret.length < rule.minLength) continue;
        if (rule.minClasses !== undefined && classCount(secret) < rule.minClasses) continue;
        if (rule.entropy !== undefined && shannonEntropy(secret) < rule.entropy) continue;
        if (rule.stopwords?.length) {
          const hay = `${line}\n${secret}`.toLowerCase();
          if (rule.stopwords.some((w) => hay.includes(w.toLowerCase()))) continue;
        }
        if (rule.requires && !rule.requires({ line, lines, lineIndex, match: m })) continue;

        // Номер строки: в режимах worktree/blobs — строка внутри версии файла,
        // в режиме commits — реальная строка в коммите (считается из заголовка хунка).
        const finding = {
          rule: rule.id,
          severity: rule.severity,
          description: rule.description,
          file,
          line: (meta?.line ?? 0) + lineIndex + 1,
          commit: meta?.commit ?? null,
          masked: mask(raw),
        };
        const key = `${finding.file}:${finding.line}:${finding.masked}`;
        if (acc.seen.has(key)) continue;
        acc.seen.add(key);
        const suppressedBy = isSuppressed({ file, lineText: line, secret: raw }, allowlists);
        if (suppressedBy) acc.suppressed.push({ ...finding, allowlist: suppressedBy });
        else if (acc.findings.length < MAX_FINDINGS) acc.findings.push(finding);
      }
    }
  }
}

// --- Источники данных -------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function scanWorktree(allowlists, acc) {
  // `--cached` + `--others --exclude-standard`: отслеживаемые файлы И новые (ещё не закоммиченные)
  // файлы, но не игнорируемые `.gitignore` (в т.ч. `tmp/**`, `node_modules/**`, `dist/**`).
  // Так локальный прогон видит подготавливаемые к релизу файлы, а временные файлы агентов
  // (только в `tmp/`, по правилам проекта) в скан не попадают.
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
  let scanned = 0;
  for (const file of files) {
    if (shouldSkipPath(file)) continue;
    const abs = resolve(ROOT, file);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    scanned += 1;
    scanText(file, buf.toString('utf8'), {}, allowlists, acc);
  }
  return scanned;
}

function scanCommits(allowlists, acc, range) {
  // Стримим `git log -p` и сканируем только добавленные строки: каждая строка, когда-либо
  // попавшая в историю, в каком-то коммите была добавленной — то есть история покрывается целиком.
  const args = ['log', '-p', '--unified=0', '--no-color', '--no-renames', '--pretty=format:\u0001%H'];
  if (range) args.push(range);
  const text = git(args);
  let commit = null;
  let file = null;
  let newLine = 0;
  let scanned = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('\u0001')) {
      commit = raw.slice(1).trim();
      continue;
    }
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim();
      continue;
    }
    if (raw.startsWith('@@')) {
      // `--unified=0`: добавляемые строки хунка идут подряд, начиная с `+c`.
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      if (m) newLine = Number(m[1]);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++') && file && !shouldSkipPath(file)) {
      scanned += 1;
      scanText(file, raw.slice(1), { commit, line: newLine - 1 }, allowlists, acc);
      newLine += 1;
    }
  }
  return scanned;
}

function scanBlobs(allowlists, acc) {
  return new Promise((resolvePromise, rejectPromise) => {
    // Строгий режим: каждый уникальный blob истории читается ровно один раз (dedup по sha).
    const listing = git(['rev-list', '--all', '--objects']).split('\n').filter(Boolean);
    const bySha = new Map();
    for (const line of listing) {
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const sha = line.slice(0, sp);
      const path = line.slice(sp + 1);
      if (!path || shouldSkipPath(path)) continue;
      if (!bySha.has(sha)) bySha.set(sha, path);
    }
    const shas = [...bySha.keys()];
    if (!shas.length) {
      resolvePromise(0);
      return;
    }
    const child = spawn('git', ['cat-file', '--batch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = Buffer.alloc(0);
    let scanned = 0;

    const consume = () => {
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        const parts = buf.subarray(0, nl).toString('utf8').split(' ');
        if (parts[1] === 'missing' || parts.length < 3) {
          buf = buf.subarray(nl + 1);
          continue;
        }
        const size = Number(parts[2]);
        if (buf.length < nl + 1 + size + 1) return;
        const payload = buf.subarray(nl + 1, nl + 1 + size);
        buf = buf.subarray(nl + 1 + size + 1);
        if (size > 0 && size <= MAX_FILE_BYTES && !isBinary(payload)) {
          scanned += 1;
          scanText(bySha.get(parts[0]) ?? parts[0], payload.toString('utf8'), {}, allowlists, acc);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      consume();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => (code === 0 ? resolvePromise(scanned) : rejectPromise(new Error(`git cat-file: код ${code}`))));
    child.stdin.end(`${shas.join('\n')}\n`);
  });
}

// --- main -------------------------------------------------------------------

if (flags.has('--help') || flags.has('-h')) {
  process.stdout.write(`${readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n')}\n`);
  process.exit(0);
}
if (flags.has('--list-rules')) {
  for (const r of RULES) process.stdout.write(`${r.severity.padEnd(8)} ${r.id.padEnd(32)} ${r.description}\n`);
  process.exit(0);
}

const started = Date.now();
let allowlists;
try {
  allowlists = loadAllowlists(CONFIG_PATH);
} catch (err) {
  process.stderr.write(`secret-scan: не удалось прочитать конфиг ${CONFIG_PATH}: ${err.message}\n`);
  process.exit(2);
}
if (flags.has('--list-allowlists')) {
  process.stdout.write(`allowlist из ${allowlists.source ?? '—'} (${allowlists.note}):\n`);
  for (const b of allowlists.blocks) {
    process.stdout.write(`  * ${b.description}\n`);
    for (const p of b.paths) process.stdout.write(`      path: ${p}\n`);
    for (const r of b.regexes) process.stdout.write(`      regex: ${r}\n`);
    for (const s of b.stopwords) process.stdout.write(`      stopword: ${s}\n`);
  }
  process.exit(0);
}

const acc = { findings: [], suppressed: [], seen: new Set() };
const scannedParts = [];

try {
  const modes = MODE === 'auto' ? ['worktree', 'commits'] : MODE.split(',');
  for (const mode of modes) {
    if (mode === 'worktree') scannedParts.push(`worktree=${scanWorktree(allowlists.blocks, acc)}`);
    else if (mode === 'commits') scannedParts.push(`commits=${scanCommits(allowlists.blocks, acc, RANGE)}`);
    else if (mode === 'blobs') scannedParts.push(`blobs=${await scanBlobs(allowlists.blocks, acc)}`);
    else throw new Error(`неизвестный режим: ${mode}`);
  }
} catch (err) {
  process.stderr.write(`secret-scan: ошибка сканирования: ${err.message}\n`);
  process.exit(2);
}

const elapsedMs = Date.now() - started;
const clean = acc.findings.length === 0;

if (!JSON_OUT) {
  out(
    `secret-scan: режим ${MODE}${RANGE ? ` (${RANGE})` : ''}, единиц: ${scannedParts.join(' ')}, ` +
      `правил: ${RULES.length}, конфиг: ${allowlists.source ?? '—'} (${allowlists.note}), ${elapsedMs} мс`,
  );
  for (const f of acc.findings) {
    out(
      `  НАХОДКА ${f.severity.toUpperCase()} [${f.rule}] ${f.file}:${f.line}${f.commit ? ` @${f.commit.slice(0, 8)}` : ''}\n` +
        `           ${f.masked} — ${f.description}`,
    );
  }
  if (acc.suppressed.length) {
    const byAllow = new Map();
    for (const s of acc.suppressed) byAllow.set(s.allowlist, (byAllow.get(s.allowlist) ?? 0) + 1);
    out(
      `  подавлено allowlist: ${acc.suppressed.length} (` +
        [...byAllow.entries()].map(([k, v]) => `${k}: ${v}`).join('; ') +
        ')',
    );
  }
  out(
    clean
      ? `secret-scan: ЧИСТО — находок нет (${elapsedMs} мс)`
      : `secret-scan: НАЙДЕНО ${acc.findings.length} — требуется разбор (релиз блокируется)`,
  );
}

const stripSecrets = (f) => ({ ...f, secret: undefined, line_text: undefined });
const report = {
  tool: 'scripts/secret-scan.mjs',
  schema: 'synth.security.secret-scan/v1',
  mode: MODE,
  range: RANGE,
  config: allowlists.source,
  rules: RULES.length,
  scanned: scannedParts.join(' '),
  elapsed_ms: elapsedMs,
  findings: acc.findings.map(stripSecrets),
  findings_count: acc.findings.length,
  suppressed_count: acc.suppressed.length,
  suppressed: acc.suppressed.map((s) => ({ rule: s.rule, file: s.file, line: s.line, allowlist: s.allowlist, masked: s.masked })),
  clean,
};
if (REPORT_PATH) {
  const abs = resolve(ROOT, REPORT_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
  out(`secret-scan: отчёт записан в ${REPORT_PATH}`);
}
if (JSON_OUT) process.stdout.write(`${JSON.stringify(report)}\n`);

process.exit(clean ? 0 : 1);
