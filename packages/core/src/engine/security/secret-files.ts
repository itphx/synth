/**
 * Политика «файлы и каталоги секретов» (ADR-107, docs/MEMORY.md §10.1).
 *
 * Зачем в ядре, а не в плагине памяти: статический сканер расширений
 * (PROP-068 §4.3) считает **любое** упоминание имён секретных файлов
 * (`exfil_secret_path`) попыткой эксфильтрации и блокирует бандл вердиктом
 * `dangerous`. Плагину, который эти файлы **исключает**, такой вердикт
 * выносится по ложному срабатыванию. Поэтому список и предикаты живут в
 * ядре, а плагин спрашивает хост через сервис фасада `facade.security`
 * (ADR-107): в бандле нет ни одного имени секретного файла.
 *
 * Политика применяется к сбору корпуса индекса (`source.kind='files'`) и
 * является единственным барьером: обфускации при индексации нет, поэтому
 * секреты просто не должны попадать в корпус.
 */

/** Точные имена файлов (basename, lower-case). */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'secret.json',
  'secret.yaml',
  'secret.yml',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
]);

/** Префиксы имён (ключи SSH и т.п.). */
const SECRET_FILE_PREFIXES: readonly string[] = [
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
];

/** Суффиксы/расширения (ключи, хранилища, сертификаты). */
const SECRET_FILE_SUFFIXES: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.kdbx',
];

/** Регулярные шаблоны для вариантов имён. */
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env\./, // .env.local, .env.production, .env.example
  /^service-account.*\.json$/,
  /\.tfstate(\.|$)/,
];

/** Каталоги, в которых секреты лежат по соглашению. */
const SECRET_DIRECTORIES: ReadonlySet<string> = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.terraform',
  '.gcloud',
  'secrets',
]);

/**
 * Файл с секретами/ключами (по basename, регистронезависимо).
 *
 * `path` не ожидается — вызывающий передаёт имя записи каталога.
 */
export function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_FILE_NAMES.has(lower)) return true;
  if (lower.startsWith('.env.')) return true;
  if (SECRET_FILE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  if (SECRET_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(lower));
}

/** Каталог, в котором секреты лежат по соглашению. */
export function isSecretDirectoryName(name: string): boolean {
  return SECRET_DIRECTORIES.has(name.toLowerCase());
}
