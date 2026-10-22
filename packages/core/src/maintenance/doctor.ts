// ADR-091, раздел «Проверка»: команда `synth doctor` — health инстанса,
// целостность данных, доступность мастер-ключа/секретов, провайдеры и модели,
// write-доступ к `dataDir` и состояние миграций.
//
// После `restore` проверка обязательна, поэтому doctor работает по явному
// `--data-dir` и **преимущественно read-only**: единственная запись — пробный
// файл `{dataDir}/.doctor-probe` (создать → удалить) для проверки доступа.
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SYNTH_VERSION } from '@itphx/synth-shared';
import { checkInstanceCompatibility, readInstanceMeta } from '../storage/instance-meta.js';
import { masterKeyFilePath, readMasterKeyFile } from '../security/crypto.js';
import type { StorageBackendKind, StorageHealth } from '../storage/storage-context.js';

/**
 * Статус отдельной проверки (ADR-091). `skipped` — проверка неприменима к
 * выбранному backend'у хранения (напр. файловые проверки при `storage.backend=postgres`).
 */
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skipped';

/** Результат одной проверки инстанса (ADR-091). */
export interface DoctorCheck {
  /** Стабильный id проверки, напр. `data-dir`. */
  id: string;
  /** Человекочитаемое название. */
  title: string;
  status: DoctorStatus;
  /** Подробность (факты: пути, счётчики, фактические права). */
  detail?: string;
  /** Что сделать при `warn`/`fail`. */
  hint?: string;
}

/** Итог `synth doctor` (ADR-091). */
export interface DoctorResult {
  /** `false`, если хотя бы одна проверка завершилась `fail`. */
  ok: boolean;
  checks: DoctorCheck[];
  dataDir: string;
  /** `SYNTH_VERSION` запущенного пакета. */
  version: string;
}

/** Опции прогона проверок (ADR-091). */
export interface DoctorOptions {
  /** Каталог данных инстанса (явный `--data-dir`). */
  dataDir: string;
  /** Результат `resolveSecretKey(synth, env)` (env > config, пусто — файл). */
  secretKey?: string;
  /** Окружение процесса (источник `SYNTH_SECRET_KEY` для отчёта). */
  env?: NodeJS.ProcessEnv;
  /** `synth.security.secretKey`, если задан в config. */
  configSecretKey?: string;
  /**
   * ADR-096: физический backend хранения (`storage.backend`); по умолчанию
   * `file`. При `postgres` файловые проверки помечаются `skipped`, добавляются
   * `db-connection`/`db-schema`.
   */
  storageBackend?: StorageBackendKind;
  /**
   * ADR-097: read-only проба БД (`postgres`) — соединение (latency) и версия
   * схемы. Реализуется драйвером (`StorageContext.health`). Не задана, а
   * backend=`postgres` — проверка `db-connection` падает с понятной причиной.
   */
  dbHealth?: () => Promise<StorageHealth>;
}

/** Опции CLI-команды `synth doctor` (ADR-091). */
export interface DoctorCommandOptions extends DoctorOptions {
  /** Вывод в JSON вместо человекочитаемого. */
  json?: boolean;
  /** Канал вывода (по умолчанию `console.log`). */
  log?: (msg: string) => void;
}

/** Имя пробного файла проверки доступа на запись. */
const PROBE_FILENAME = '.doctor-probe';
/** Возраст файла-лока, после которого он считается потенциально стухшим. */
const STALE_LOCK_MS = 10 * 60 * 1000;

/** Формат прав в восьмеричном виде (`0644`). */
function _octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/** Файл существует и не пуст. */
async function _fileNonEmpty(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/** Рекурсивный подсчёт `.json`-файлов в каталоге (нет каталога → 0). */
async function _countJsonFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await _countJsonFiles(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      count += 1;
    }
  }
  return count;
}

/** Разбор плоского каталога JSON-записей: всего файлов и список битых id. */
async function _inspectJsonDir(dir: string): Promise<{ total: number; broken: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { total: 0, broken: [] };
  }
  const broken: string[] = [];
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    total += 1;
    try {
      JSON.parse(await readFile(join(dir, name), 'utf-8'));
    } catch {
      broken.push(name.replace(/\.json$/, ''));
    }
  }
  return { total, broken };
}

/** Проверка 1: каталог данных существует, создаётся и доступен на запись. */
async function _checkDataDir(dataDir: string): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = { id: 'data-dir', title: 'Каталог данных' };
  try {
    await mkdir(dataDir, { recursive: true });
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      detail: `${dataDir}: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'проверьте путь и права на каталог данных',
    };
  }

  const probePath = join(dataDir, PROBE_FILENAME);
  try {
    await writeFile(probePath, 'doctor', 'utf-8');
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      detail: `${dataDir}: нет доступа на запись (${err instanceof Error ? err.message : String(err)})`,
      hint: 'выдайте процессу права на запись в каталог данных',
    };
  }
  // Удаление за собой обязательно; ошибку удаления проглатываем (read-only режим).
  await unlink(probePath).catch(() => {});
  return { ...base, status: 'ok', detail: dataDir };
}

/** Проверка 2: совместимость схемы данных (ADR-092). */
async function _checkSchema(dataDir: string): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = { id: 'schema', title: 'Схема данных' };
  const compatibility = await checkInstanceCompatibility(dataDir);
  const detail = `схема ${compatibility.currentVersion} (ожидается ${compatibility.expectedVersion})`;
  if (compatibility.status === 'too-new') {
    return {
      ...base,
      status: 'fail',
      detail,
      hint: 'обновите Synth — данные новее версии пакета',
    };
  }
  if (compatibility.status === 'pending') {
    return {
      ...base,
      status: 'warn',
      detail,
      hint: 'synth migrate',
    };
  }
  return { ...base, status: 'ok', detail };
}

/** Проверка 3: доступность мастер-ключа секретов at-rest (ADR-076). */
async function _checkMasterKey(opts: DoctorOptions): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = { id: 'master-key', title: 'Мастер-ключ' };
  const keyPath = masterKeyFilePath(opts.dataDir);
  const sshCount = await _countJsonFiles(join(opts.dataDir, 'secrets', 'ssh-keys'));

  const hasEnvKey = !!opts.env?.SYNTH_SECRET_KEY?.trim();
  const hasConfigKey = !!opts.configSecretKey?.trim();
  const hasExplicitKey = !!opts.secretKey?.trim();
  const hasFileKey = await _fileNonEmpty(keyPath);

  // Печатаем только источник, не значение ключа.
  let source: string | null = null;
  if (hasEnvKey) source = 'env SYNTH_SECRET_KEY';
  else if (hasConfigKey) source = 'config security.secretKey';
  else if (hasExplicitKey) source = 'явный ключ';
  else if (hasFileKey) source = `файл ${keyPath}`;

  if (!source) {
    if (sshCount > 0) {
      return {
        ...base,
        status: 'fail',
        detail: `есть ${sshCount} зашифрованных SSH-ключ(ей), но мастер-ключ не найден`,
        hint: 'задайте SYNTH_SECRET_KEY/security.secretKey или восстановите secrets/master.key',
      };
    }
    return { ...base, status: 'ok', detail: 'не требуется (нет зашифрованных секретов)' };
  }

  // Файловый ключ есть — проверим, что материал валиден (base64/hex, 32 Б).
  if (!hasEnvKey && !hasConfigKey && !hasExplicitKey && hasFileKey) {
    try {
      await readMasterKeyFile(opts.dataDir);
    } catch (err) {
      return {
        ...base,
        status: 'fail',
        detail: `${keyPath}: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'восстановите secrets/master.key или задайте SYNTH_SECRET_KEY',
      };
    }
  }

  return { ...base, status: 'ok', detail: `источник: ${source}` };
}

/** Проверка 4: права каталога `secrets` (0700) и файлов ключей (0600). */
async function _checkSecretsPermissions(dataDir: string): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = {
    id: 'secrets-permissions',
    title: 'Права на секреты',
  };
  const dir = join(dataDir, 'secrets');
  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch {
    return { ...base, status: 'ok', detail: 'нет каталога secrets' };
  }
  if (!dirStat.isDirectory()) {
    return { ...base, status: 'warn', detail: `${dir} — не каталог` };
  }

  const issues: string[] = [];
  const dirMode = dirStat.mode & 0o777;
  if (dirMode !== 0o700) issues.push(`каталог: ${_octal(dirMode)}`);

  for (const name of ['master.key', 'api-key']) {
    try {
      const info = await stat(join(dir, name));
      const mode = info.mode & 0o777;
      if (mode !== 0o600) issues.push(`${name}: ${_octal(mode)}`);
    } catch {
      // Файла нет — проверять нечего.
    }
  }

  if (issues.length > 0) {
    return {
      ...base,
      status: 'warn',
      detail: issues.join(', '),
      hint: 'ожидается каталог 0700 и файлы 0600 (chmod 700 secrets && chmod 600 secrets/*)',
    };
  }
  return { ...base, status: 'ok', detail: 'каталог 0700, файлы 0600' };
}

/** Проверка 5: целостность JSON-записей и сводка по каталогам данных. */
async function _checkDataIntegrity(dataDir: string): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = {
    id: 'data-integrity',
    title: 'Целостность данных',
  };
  const sessions = await _inspectJsonDir(join(dataDir, 'sessions'));
  const projects = await _inspectJsonDir(join(dataDir, 'projects'));
  const providers = await _countJsonFiles(join(dataDir, 'providers'));
  const models = await _countJsonFiles(join(dataDir, 'models'));
  const agents = await _countJsonFiles(join(dataDir, 'agents'));

  const summary =
    `сессий: ${sessions.total}, проектов: ${projects.total}, ` +
    `провайдеров: ${providers}, моделей: ${models}, агентов: ${agents}`;

  const broken = [...sessions.broken, ...projects.broken];
  if (broken.length > 0) {
    return {
      ...base,
      status: 'fail',
      detail: `${summary}; битых файлов (${broken.length}): ${broken.join(', ')}`,
      hint: 'восстановите повреждённые записи из бэкапа (synth restore)',
    };
  }
  return { ...base, status: 'ok', detail: summary };
}

/** Проверка 6: наличие хотя бы одного провайдера и одной модели. */
async function _checkProviders(dataDir: string): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = { id: 'providers', title: 'Провайдеры и модели' };
  const providers = await _countJsonFiles(join(dataDir, 'providers'));
  const models = await _countJsonFiles(join(dataDir, 'models'));
  const detail = `провайдеров: ${providers}, моделей: ${models}`;

  if (providers === 0 || models === 0) {
    return {
      ...base,
      status: 'warn',
      detail,
      hint: 'добавьте провайдера/модель (docs/LLM_PROVIDERS.md)',
    };
  }
  return { ...base, status: 'ok', detail };
}

/** Проверка 7: возраст файловых локов (`{dataDir}/scheduler/*.lock`). */
async function _checkLocks(dataDir: string): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = { id: 'locks', title: 'Файловые локи' };
  const dir = join(dataDir, 'scheduler');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { ...base, status: 'ok' };
  }

  let count = 0;
  const stale: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    count += 1;
    try {
      const info = await stat(join(dir, name));
      const ageMs = Date.now() - info.mtimeMs;
      if (ageMs > STALE_LOCK_MS) stale.push(`${name} (${Math.round(ageMs / 60000)} мин)`);
    } catch {
      // Лок исчез между readdir и stat — не проблема.
    }
  }

  if (stale.length > 0) {
    return {
      ...base,
      status: 'warn',
      detail: `возможен стухший лок: ${stale.join(', ')}`,
      hint: 'убедитесь, что процесс-владелец не работает; лок снимется сам (stale takeover)',
    };
  }
  return { ...base, status: 'ok', ...(count > 0 ? { detail: `локов: ${count}` } : {}) };
}

/** Помечает проверку неприменимой к текущему backend'у (ADR-091/ADR-096). */
function _skippedCheck(id: string, title: string, detail = 'неприменимо (backend=postgres)'): DoctorCheck {
  return { id, title, status: 'skipped', detail };
}

/**
 * Проверка БД: реальное подключение (probe) + задержка. `postgres` — единственный
 * backend с `health()`; ошибка/исключение пробы → `fail`.
 */
async function _checkDbConnection(getHealth: () => Promise<StorageHealth>): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = { id: 'db-connection', title: 'Подключение к БД' };
  try {
    const health = await getHealth();
    if (!health.ok) {
      return {
        ...base,
        status: 'fail',
        detail: health.error ? `ошибка: ${health.error}` : 'БД недоступна',
        hint: 'проверьте storage.postgres (host/port/database), пароль и доступность сервера БД',
      };
    }
    const latency = health.latencyMs !== undefined ? `, ${health.latencyMs} мс` : '';
    return { ...base, status: 'ok', detail: `соединение установлено${latency}` };
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      hint: 'проверьте storage.postgres и доступность сервера БД',
    };
  }
}

/**
 * Проверка схемы БД (ADR-097): сравнение версии БД с ожидаемой драйвером.
 * Схема новее → `fail` (понижение версии не мигрирует назад); отстаёт/нет → `warn`
 * (`synth migrate`); нет соединения — `skipped` (не вводим в заблуждение).
 */
async function _checkDbSchema(getHealth: () => Promise<StorageHealth>): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = { id: 'db-schema', title: 'Схема БД' };
  const health = await getHealth();
  if (!health.ok) {
    return { ...base, status: 'skipped', detail: 'пропущено: нет соединения с БД' };
  }
  const current = health.schemaVersion ?? null;
  const expected = health.expectedSchemaVersion;
  const detail = `схема ${current === null ? 'не инициализирована' : current}${
    expected !== undefined ? ` (ожидается ${expected})` : ''
  }`;
  if (current === null) {
    return { ...base, status: 'warn', detail, hint: 'synth migrate' };
  }
  if (expected !== undefined && current > expected) {
    return {
      ...base,
      status: 'fail',
      detail,
      hint: 'схема БД новее драйвера — обновите Synth (понижение версии не мигрирует назад)',
    };
  }
  if (expected !== undefined && current < expected) {
    return { ...base, status: 'warn', detail, hint: 'synth migrate' };
  }
  return { ...base, status: 'ok', detail };
}

/** Проверка 8: версия пакета и версия данных (`meta.json`). */
async function _checkVersion(dataDir: string): Promise<DoctorCheck> {
  const base: Pick<DoctorCheck, 'id' | 'title'> = { id: 'version', title: 'Версия' };
  const meta = await readInstanceMeta(dataDir);
  const instanceVersion = meta?.instanceVersion?.trim();
  if (!instanceVersion) {
    return { ...base, status: 'ok', detail: `пакет ${SYNTH_VERSION}; meta.json без instanceVersion` };
  }
  if (instanceVersion === SYNTH_VERSION) {
    return { ...base, status: 'ok', detail: `пакет ${SYNTH_VERSION} совпадает с данными` };
  }
  // Не `warn`: версия пакета может быть новее данных (миграция — отдельная проверка).
  return {
    ...base,
    status: 'ok',
    detail: `пакет ${SYNTH_VERSION}, данные ${instanceVersion}`,
  };
}

/**
 * Прогоняет проверки инстанса (ADR-091). Строго read-only, кроме пробного файла
 * `{dataDir}/.doctor-probe` (создать → удалить). Каждая проверка независима:
 * исключение внутри превращается в `fail` с текстом ошибки, остальные выполняются.
 */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const postgres = opts.storageBackend === 'postgres';
  // Проба БД выполняется один раз и переиспользуется проверками `db-*`.
  let healthPromise: Promise<StorageHealth> | undefined;
  const getHealth = (): Promise<StorageHealth> => {
    if (!healthPromise) {
      healthPromise = opts.dbHealth
        ? opts.dbHealth()
        : Promise.resolve({ ok: false, error: 'проба БД не сконфигурирована' });
    }
    return healthPromise;
  };

  const specs: Array<{ id: string; title: string; run: () => Promise<DoctorCheck> }> = [
    { id: 'data-dir', title: 'Каталог данных', run: () => _checkDataDir(opts.dataDir) },
  ];
  if (postgres) {
    // ADR-091/ADR-097: при backend=postgres данные в БД — файловые проверки
    // неприменимы (`skipped`), вместо них проба соединения и версия схемы БД.
    specs.push(
      { id: 'db-connection', title: 'Подключение к БД', run: () => _checkDbConnection(getHealth) },
      { id: 'db-schema', title: 'Схема БД', run: () => _checkDbSchema(getHealth) },
      { id: 'master-key', title: 'Мастер-ключ', run: () => _checkMasterKey(opts) },
      {
        id: 'secrets-permissions',
        title: 'Права на секреты',
        run: () => _checkSecretsPermissions(opts.dataDir),
      },
      { id: 'schema', title: 'Схема данных', run: async () => _skippedCheck('schema', 'Схема данных') },
      {
        id: 'data-integrity',
        title: 'Целостность данных',
        run: async () => _skippedCheck('data-integrity', 'Целостность данных'),
      },
      {
        id: 'providers',
        title: 'Провайдеры и модели',
        run: async () => _skippedCheck('providers', 'Провайдеры и модели'),
      },
      { id: 'locks', title: 'Файловые локи', run: async () => _skippedCheck('locks', 'Файловые локи') },
      { id: 'version', title: 'Версия', run: async () => _skippedCheck('version', 'Версия') },
    );
  } else {
    specs.push(
      { id: 'schema', title: 'Схема данных', run: () => _checkSchema(opts.dataDir) },
      { id: 'master-key', title: 'Мастер-ключ', run: () => _checkMasterKey(opts) },
      {
        id: 'secrets-permissions',
        title: 'Права на секреты',
        run: () => _checkSecretsPermissions(opts.dataDir),
      },
      {
        id: 'data-integrity',
        title: 'Целостность данных',
        run: () => _checkDataIntegrity(opts.dataDir),
      },
      { id: 'providers', title: 'Провайдеры и модели', run: () => _checkProviders(opts.dataDir) },
      { id: 'locks', title: 'Файловые локи', run: () => _checkLocks(opts.dataDir) },
      { id: 'version', title: 'Версия', run: () => _checkVersion(opts.dataDir) },
    );
  }

  for (const spec of specs) {
    try {
      checks.push(await spec.run());
    } catch (err) {
      checks.push({
        id: spec.id,
        title: spec.title,
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: checks.every((c) => c.status !== 'fail'),
    checks,
    dataDir: opts.dataDir,
    version: SYNTH_VERSION,
  };
}

/** Иконка статуса для человекочитаемого вывода. */
const STATUS_ICON: Record<DoctorStatus, string> = { ok: '✓', warn: '⚠', fail: '✗', skipped: '−' };

/** Рендерит результат: человекочитаемый вывод (✓/⚠/✗ + hint) либо JSON. */
export function renderDoctorResult(result: DoctorResult, opts?: { json?: boolean }): string {
  if (opts?.json) {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [`Инстанс Synth ${result.version} · ${result.dataDir}`];
  for (const check of result.checks) {
    const detail = check.detail ? ` — ${check.detail}` : '';
    lines.push(`${STATUS_ICON[check.status]} ${check.title}${detail}`);
    if (check.hint) lines.push(`    → ${check.hint}`);
  }

  const warn = result.checks.filter((c) => c.status === 'warn').length;
  const fail = result.checks.filter((c) => c.status === 'fail').length;
  const skipped = result.checks.filter((c) => c.status === 'skipped').length;
  const summary = result.ok ? 'Инстанс в порядке' : 'Обнаружены проблемы';
  const skippedPart = skipped > 0 ? `, skipped: ${skipped}` : '';
  lines.push('', `${summary} (warn: ${warn}, fail: ${fail}${skippedPart})`);
  return lines.join('\n');
}

/**
 * Тело CLI-команды `synth doctor` (ADR-091): прогон проверок и вывод.
 *
 * @returns код выхода процесса (1 — есть `fail`, иначе 0).
 */
export async function runDoctorCommand(opts: DoctorCommandOptions): Promise<number> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const result = await runDoctor(opts);
  log(renderDoctorResult(result, { json: opts.json }));
  return result.ok ? 0 : 1;
}
