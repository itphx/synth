/**
 * PROP-068 §4.3 / PROP-090 §9: правила статического сканера расширений.
 *
 * Таблица правил — **чистые данные**: категория (ось классификации),
 * серьёзность (определяет вердикт через `severity → verdict`) и текстовый
 * шаблон. Составные правила (срабатывают по комбинации находок в одном
 * файле) описываются полем `when`.
 *
 * Правила сканера — **advisory**: они не исполняются, а только выносят
 * вердикт; блокирует установку матрица install-policy (PROP-068 §4.2).
 */
import type { PluginScanCategory, PluginScanSeverity } from '@itphx/synth-shared';

/** Контекст проверки правила (один файл бандла). */
export interface ScanRuleContext {
  /** Относительный путь файла. */
  path: string;
  /** Содержимое файла. */
  text: string;
  /** id'ы правил, сработавших в этом файле (в т.ч. составных). */
  hits: ReadonlySet<string>;
}

/** Одно правило сканера. */
export interface ScanRule {
  /** Стабильный id правила (используется в составных условиях). */
  id: string;
  /** Категория находки (PROP-068 §4.3). */
  category: PluginScanCategory;
  /** Серьёзность находки. */
  severity: PluginScanSeverity;
  /** Человекочитаемое описание находки. */
  description: string;
  /** Текстовый шаблон (нет у составных правил). */
  pattern?: RegExp;
  /** Условие срабатывания составного правила. */
  when?: (ctx: ScanRuleContext) => boolean;
  /** id'ы правил, чья строка указывается в находке составного правила. */
  lineFrom?: readonly string[];
}

/**
 * Правила сканера.
 *
 * Серьёзность подобрана так, чтобы вердикт не «стрелял» на безобидном коде:
 * - `low`/`info` → `safe` (обычная сетевая активность, чтение `process.env`);
 * - `medium` → `caution` (нужно подтверждение владельца для плагина);
 * - `high`/`critical` → `dangerous` (установка блокируется).
 */
export const PLUGIN_SCAN_RULES: readonly ScanRule[] = [
  // ── exfiltration ──────────────────────────────────────────────────────
  {
    id: 'exfil_env_read',
    category: 'exfiltration',
    severity: 'low',
    description: 'Чтение переменных окружения (process.env) — потенциальный источник данных для выноса',
    pattern: /\bprocess\s*\.\s*env\b/,
  },
  {
    id: 'exfil_env_network',
    category: 'exfiltration',
    severity: 'medium',
    description: 'Чтение process.env вместе с сетевым вызовом — вероятная выгрузка данных окружения',
    when: (ctx) =>
      ctx.hits.has('exfil_env_read') && (ctx.hits.has('net_fetch') || ctx.hits.has('net_socket')),
    lineFrom: ['exfil_env_read'],
  },
  {
    id: 'exfil_secret_path',
    category: 'exfiltration',
    severity: 'high',
    description: 'Обращение к файлам с секретами (.env, id_rsa, credentials.json, сертификаты)',
    pattern:
      /(^|[^\w./\\-])(\.env(\.\w+)?|id_rsa|id_ed25519|credentials(\.json)?|\.pem|\.p12|\.pfx|secrets?[\\/])/i,
  },
  {
    id: 'exfil_dotfile_credentials',
    category: 'exfiltration',
    severity: 'medium',
    description: 'Обращение к файлам с учётными данными (.netrc, .npmrc, .aws/credentials)',
    pattern: /(^|[^\w./\\-])(\.netrc|\.npmrc|\.aws[\\/]credentials)/i,
  },
  {
    id: 'exfil_home_dir',
    category: 'exfiltration',
    severity: 'medium',
    description: 'Определение домашнего каталога пользователя (os.homedir / $HOME)',
    pattern: /\bos\s*\.\s*homedir\s*\(|process\s*\.\s*env\s*\.\s*(HOME|USERPROFILE)/,
  },

  // ── injection ─────────────────────────────────────────────────────────
  {
    id: 'inj_ignore_previous',
    category: 'injection',
    severity: 'high',
    description: 'Инструкция модели игнорировать предыдущие указания (prompt injection)',
    pattern:
      /(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|preceding|above|earlier)\s+(instructions?|prompts?|rules?|directions?)/i,
  },
  {
    id: 'inj_reveal_prompt',
    category: 'injection',
    severity: 'high',
    description: 'Требование раскрыть системный промпт (prompt injection)',
    pattern:
      /(reveal|print|show|output|repeat|dump|expose)\s+(me\s+)?(your|the|all)\s+(system\s+)?(prompt|instructions?)/i,
  },
  {
    id: 'inj_role_switch',
    category: 'injection',
    severity: 'medium',
    description: 'Подмена роли модели (перехват инструкций)',
    pattern: /(you\s+are\s+now\b|act\s+as\s+if\s+you\s+(are|were)\b|new\s+persona\b)/i,
  },
  {
    id: 'inj_hide_from_user',
    category: 'injection',
    severity: 'medium',
    description: 'Инструкция скрыть действия от пользователя',
    pattern: /do\s+not\s+(tell|inform|mention|notify|ask)\s+the\s+(user|human|operator)/i,
  },
  {
    id: 'inj_inline_shell',
    category: 'injection',
    severity: 'medium',
    description: 'Inline-shell конструкция (механизм ADR-046) в содержимом бандла',
    pattern: /!`[^`\n]+`/,
  },

  // ── destructive ───────────────────────────────────────────────────────
  {
    id: 'des_shell_rm_rf',
    category: 'destructive',
    severity: 'medium',
    description: 'Рекурсивное удаление по shell (rm -rf)',
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/,
  },
  {
    id: 'des_fs_delete',
    category: 'destructive',
    severity: 'medium',
    description: 'Удаление файлов/каталогов через fs (rmSync/unlinkSync/rmdirSync)',
    pattern: /\b(rmSync|unlinkSync|rmdirSync|truncateSync)\s*\(|\bfs\s*\.\s*(rm|unlink)\s*\(/,
  },
  {
    id: 'des_sql_drop',
    category: 'destructive',
    severity: 'high',
    description: 'Разрушающая SQL-операция (DROP/TRUNCATE/DELETE)',
    pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i,
  },
  {
    id: 'des_chmod_777',
    category: 'destructive',
    severity: 'medium',
    description: 'Выдача прав «всем» (chmod 777)',
    pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/,
  },
  {
    id: 'des_sudo',
    category: 'destructive',
    severity: 'medium',
    description: 'Запуск команд через sudo',
    pattern: /\bsudo\s+[a-zA-Z/]/,
  },
  {
    id: 'des_child_process',
    category: 'destructive',
    severity: 'medium',
    description: 'Запуск дочерних процессов (child_process/execSync/spawnSync)',
    pattern:
      /(require\s*\(\s*['"](node:)?child_process['"]\s*\)|from\s+['"](node:)?child_process['"]|\b(execSync|execFileSync|spawnSync)\s*\()/,
  },

  // ── persistence ───────────────────────────────────────────────────────
  {
    id: 'per_crontab',
    category: 'persistence',
    severity: 'high',
    description: 'Закрепление через cron (crontab / /etc/cron.d)',
    pattern: /\bcrontab\b|\/etc\/cron\.[a-z]+/,
  },
  {
    id: 'per_systemd',
    category: 'persistence',
    severity: 'high',
    description: 'Закрепление через systemd/launchd (юнит или автозапуск)',
    pattern: /\/etc\/systemd|\bsystemctl\s+(enable|start)\b|LaunchDaemons?\b|LaunchAgents\b/,
  },
  {
    id: 'per_shell_rc',
    category: 'persistence',
    severity: 'high',
    description: 'Закрепление через профили оболочки (.bashrc/.zshrc/rc.local)',
    pattern: /~\/\.(bashrc|zshrc|profile|bash_profile|zprofile)\b|\/etc\/rc\.local/,
  },
  {
    id: 'per_ssh_authorized_keys',
    category: 'persistence',
    severity: 'high',
    description: 'Закрепление через authorized_keys (доступ по SSH)',
    pattern: /authorized_keys/,
  },
  {
    id: 'per_global_install',
    category: 'persistence',
    severity: 'medium',
    description: 'Глобальная установка пакета (npm i -g / pnpm add -g)',
    pattern: /\b(npm|yarn|pnpm)\s+(i|install|add)\b[^\n;]*\s-g\b|\byarn\s+global\b/,
  },
  {
    id: 'per_install_script',
    category: 'persistence',
    severity: 'medium',
    description: 'Lifecycle-скрипт установки в манифесте пакета (pre/postinstall)',
    pattern: /["'](pre|post|prepare)install["']\s*:/,
  },

  // ── network ───────────────────────────────────────────────────────────
  {
    id: 'net_fetch',
    category: 'network',
    severity: 'low',
    description: 'Сетевой вызов из бандла (fetch/axios/XHR)',
    pattern: /\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b|\bsendBeacon\s*\(|\bhttps?\.(get|request)\s*\(/,
  },
  {
    id: 'net_socket',
    category: 'network',
    severity: 'low',
    description: 'Исходящее соединение (net.connect/WebSocket/dgram/http2)',
    pattern: /\bnet\s*\.\s*(connect|createConnection)\s*\(|\bnew\s+WebSocket\s*\(|\bdgram\b|\bhttp2\b/,
  },
  {
    id: 'net_dns',
    category: 'network',
    severity: 'low',
    description: 'DNS-запрос из бандла (dns.lookup/resolve)',
    pattern: /\bdns\s*\.\s*(lookup|resolve|resolve4|resolve6)\s*\(/,
  },
  {
    id: 'net_remote_exec',
    category: 'network',
    severity: 'high',
    description: 'Удалённое выполнение кода (загрузка скрипта по сети и запуск)',
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
  },

  // ── obfuscation ───────────────────────────────────────────────────────
  {
    id: 'obf_eval',
    category: 'obfuscation',
    severity: 'high',
    description: 'Выполнение кода из строки (eval)',
    pattern: /(^|[^\w.$])eval\s*\(/,
  },
  {
    id: 'obf_function_ctor',
    category: 'obfuscation',
    severity: 'high',
    description: 'Создание функции из строки (new Function)',
    pattern: /new\s+Function\s*\(/,
  },
  {
    id: 'obf_base64',
    category: 'obfuscation',
    severity: 'medium',
    description: 'Декодирование base64 (замаскированное содержимое)',
    pattern: /\bBuffer\s*\.\s*from\s*\([^)]*['"]base64['"]|\batob\s*\(|\bbase64\s+-d\b/i,
  },
  {
    id: 'obf_hex_escape',
    category: 'obfuscation',
    severity: 'medium',
    description: 'Длинная серия hex-экранирований (замаскированное содержимое)',
    pattern: /(\\x[0-9a-fA-F]{2}){8,}/,
  },
];

/**
 * Скрытые (невидимые) unicode-символы — отдельная категория
 * `invisible_unicode` (PROP-068 §4.3): вердикт **не ниже** `caution`.
 *
 * Диапазоны: zero-width, bidi-управление, word joiner, BOM, теги, soft hyphen.
 */
export const INVISIBLE_UNICODE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'zero-width', pattern: /[\u200B-\u200F\u2060\uFEFF]/ },
  { name: 'bidi-control', pattern: /[\u202A-\u202E\u2066-\u2069]/ },
  { name: 'unicode-tag', pattern: /[\u{E0000}-\u{E007F}]/u },
  { name: 'soft-hyphen', pattern: /\u00AD/ },
];
