/**
 * PROP-090 Ф4б-2: тесты менеджера процессов плагинов (`remote/process.ts`).
 *
 * Проверки — на **настоящем дочернем процессе** (`process.execPath` + написанный
 * тестом `dist/server.js`), а не на моке `spawn`: именно этот слой отвечает за
 * спавн без `shell`, минимальное окружение, ожидание строки готовности в stdout,
 * опрос `GET /health`, файл токена (`0600`) и остановку процесса
 * (`SIGTERM` → `SIGKILL`). Мок скрыл бы ровно те дефекты, ради которых менеджер
 * написан.
 *
 * Детерминизм: сервер всегда слушает `127.0.0.1:0` и сообщает реальный порт в
 * строке готовности — фиксированных портов в тестах нет. Таймауты менеджера
 * сужены (сотни миллисекунд), чтобы негативные кейсы не ждали дефолтные 10 c.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLUGIN_PROTOCOL_VERSION } from '@itphx/synth-shared';

import { PluginLoadError } from '../activation.js';
import { RemotePluginClient } from './client.js';
import {
  PLUGIN_TOKEN_FILE,
  PluginProcessManager,
  pluginTokenPath,
} from './process.js';
import type { PluginProcessHandle, PluginProcessManagerOptions } from './process.js';

const NAME = 'demo-plugin';
const VERSION = '1.0.0';

/** Временные каталоги теста (убираются в `afterEach`). */
const tempDirs: string[] = [];
/** Менеджеры теста — чтобы гарантированно погасить процессы. */
const managers: PluginProcessManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Временный каталог (учитывается в уборке). */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Сервер плагина: ESM-модуль на `node:http` (см. `makeBundle`). */
interface ServerScriptOptions {
  /** Не печатать строку готовности (процесс живёт, но готовности нет). */
  omitReadyLine?: boolean;
  /**
   * Порт в строке готовности, который сервер **не** занимает: имитация «порт
   * занят другим процессом / health не поднялся».
   */
  readyPort?: number;
  /** Напечатать токен в stderr (проверка редактирования логов). */
  echoToken?: boolean;
  /** Завершить процесс с кодом сразу после строки готовности. */
  exitAfterReady?: number;
}

/** Текст `dist/server.js`: контракт точки входа сервера плагина. */
function serverScript(options: ServerScriptOptions = {}): string {
  const ready = options.omitReadyLine
    ? ''
    : options.readyPort !== undefined
      ? `process.stdout.write('SYNTH_PLUGIN_READY port=${options.readyPort}\\n');`
      : "process.stdout.write('SYNTH_PLUGIN_READY port=' + port + '\\n');";
  const listen = options.readyPort === undefined;
  const exit = options.exitAfterReady !== undefined ? `process.exit(${options.exitAfterReady});` : '';

  return `import { createServer } from 'node:http';

const TOKEN = process.env.SYNTH_PLUGIN_TOKEN ?? '';
const NAME = ${JSON.stringify(NAME)};
const VERSION = ${JSON.stringify(VERSION)};
${options.echoToken ? "process.stderr.write('received token: ' + TOKEN + '\\n');" : ''}
const server = createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') {
    json(200, { status: 'ok' });
    return;
  }
  if ((req.headers.authorization ?? '') !== 'Bearer ' + TOKEN) {
    json(401, { error: { reason: 'unauthorized' } });
    return;
  }
  if (req.url === '/capabilities') {
    json(200, { protocol: ${PLUGIN_PROTOCOL_VERSION}, name: NAME, version: VERSION, points: {} });
    return;
  }
  if (req.url === '/invoke') {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString('utf-8'); });
    req.on('end', () => json(200, { ok: true, output: 'ok' }));
    return;
  }
  json(404, { error: { reason: 'unknown_id' } });
});

process.on('SIGTERM', () => { process.exit(0); });

${listen ? `server.listen(Number(process.env.SYNTH_PLUGIN_PORT ?? '0'), '127.0.0.1', () => {
  const port = server.address().port;
  ${ready}
  ${exit}
});` : `// Порт не занимаем: health по строке готовности не ответит.
${ready}
${exit}
setInterval(() => undefined, 1000);`}
`;
}

/**
 * Каталог бандла с `dist/server.js`.
 *
 * `package.json` с `"type": "module"` обязателен: без него Node трактует
 * `dist/server.js` как CommonJS и `import` в точке входа не работает.
 */
async function makeBundle(options: ServerScriptOptions = {}): Promise<string> {
  const dir = await makeTempDir('synth-plugin-process-');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n', 'utf-8');
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'server.js'), serverScript(options), 'utf-8');
  return dir;
}

/** Каталог секретов инстанса (`{secretsDir}/plugin-token`). */
async function makeSecretsDir(): Promise<string> {
  return makeTempDir('synth-plugin-secrets-');
}

/** Менеджер с сужеными таймаутами и сбором предупреждений в массив. */
function makeManager(
  secretsDir: string,
  over: {
    readyTimeoutMs?: number;
    healthTimeoutMs?: number;
    stopTimeoutMs?: number;
    spawn?: PluginProcessManagerOptions['spawn'];
    warnings?: string[];
  } = {},
): PluginProcessManager {
  const warnings = over.warnings ?? [];
  const manager = new PluginProcessManager({
    secretsDir,
    readyTimeoutMs: over.readyTimeoutMs ?? 5_000,
    healthTimeoutMs: over.healthTimeoutMs ?? 1_000,
    stopTimeoutMs: over.stopTimeoutMs ?? 2_000,
    logger: { warn: (message: string) => warnings.push(message) },
    ...(over.spawn ? { spawn: over.spawn } : {}),
  });
  managers.push(manager);
  return manager;
}

/** `start`, который обязан отказать: возвращает ошибку (проверив её тип). */
async function startFailure(start: () => Promise<unknown>): Promise<PluginLoadError> {
  try {
    await start();
  } catch (err) {
    expect(err).toBeInstanceOf(PluginLoadError);
    return err as PluginLoadError;
  }
  throw new Error('ожидался отказ start(), но процесс запустился');
}

/** Порт, который заведомо никто не слушает (открыт и сразу закрыт тестом). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * `spawn`, оборачивающий настоящий `node:child_process.spawn` и
 * запоминающий pid: сам менеджер pid наружу не отдаёт, а проверить
 * «процесс остановлен» иначе нечем.
 */
function recordingSpawn(pids: Array<number | undefined>) {
  return (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ): PluginProcessHandle => {
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    }) as unknown as PluginProcessHandle;
    pids.push(child.pid);
    return child;
  };
}

/** `spawn`, считающий вызовы: доказательство «отказ до spawn». */
function countingSpawn(counter: { calls: number }): NonNullable<PluginProcessManagerOptions['spawn']> {
  const record = recordingSpawn([]);
  return (command, args, options) => {
    counter.calls += 1;
    return record(command, args, options);
  };
}

/** Процесс жив (`kill(pid, 0)`), `EPERM` — тоже «жив». */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Дождаться состояния (процесс убит асинхронно — exit приходит событием). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`условие не выполнилось за ${timeoutMs} мс`);
}

// ── Успешный запуск ──────────────────────────────────────────────────────

describe('PluginProcessManager: запуск процесса плагина', () => {
  it('start() отдаёт loopback-адрес и токен; протокол сервера доступен клиенту', async () => {
    const rootDir = await makeBundle();
    const secretsDir = await makeSecretsDir();
    const manager = makeManager(secretsDir);

    const proc = await manager.start({ name: NAME, rootDir });

    expect(proc.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proc.token.length).toBeGreaterThan(0);

    // `GET /health` — без токена, процесс жив.
    const health = await fetch(`${proc.url}/health`);
    expect(health.status).toBe(200);
    await health.body?.cancel();

    // Клиент Ф4б-1 читает `capabilities` по контракту протокола.
    const client = new RemotePluginClient({
      baseUrl: proc.url,
      token: proc.token,
      name: NAME,
      version: VERSION,
    });
    expect(await client.capabilities()).toEqual({
      protocol: PLUGIN_PROTOCOL_VERSION,
      name: NAME,
      version: VERSION,
      points: {},
    });

    // `POST /invoke` — успешный ответ точки.
    await expect(client.invoke('promptBlocks', 'plugin.demo.tip', {})).resolves.toBe('ok');

    // Bearer обязателен: без заголовка — 401 (тело с причиной `unauthorized`).
    const unauth = await fetch(`${proc.url}/capabilities`);
    expect(unauth.status).toBe(401);
    expect(((await unauth.json()) as { error?: { reason?: string } }).error?.reason).toBe(
      'unauthorized',
    );

    await proc.stop();
  });

  it('окружение процесса — ровно четыре переменные; команда без shell', async () => {
    const rootDir = await makeBundle();
    const secretsDir = await makeSecretsDir();
    const record = recordingSpawn([]);
    let captured:
      | {
          command: string;
          args: string[];
          options: { cwd: string; env: Record<string, string> };
        }
      | undefined;
    const manager = makeManager(secretsDir, {
      spawn: (command, args, options) => {
        captured = { command, args, options };
        return record(command, args, options);
      },
    });

    const proc = await manager.start({ name: NAME, rootDir });

    expect(captured).toBeDefined();
    // Ровно `process.execPath` + один абсолютный аргумент: shell не участвует.
    expect(captured!.command).toBe(process.execPath);
    expect(captured!.args).toEqual([join(rootDir, 'dist', 'server.js')]);
    // Наследуется только необходимое: секреты хоста плагину не передаются.
    expect(Object.keys(captured!.options.env).sort()).toEqual([
      'NODE_ENV',
      'PATH',
      'SYNTH_PLUGIN_PORT',
      'SYNTH_PLUGIN_TOKEN',
    ]);
    expect(captured!.options.env.SYNTH_PLUGIN_PORT).toBe('0');
    expect(captured!.options.env.SYNTH_PLUGIN_TOKEN).toBe(proc.token);
    expect(captured!.options.cwd).toBe(rootDir);

    await manager.stopAll();
  });
});

// ── Токен инстанса ───────────────────────────────────────────────────────

describe('PluginProcessManager: файл токена инстанса', () => {
  it('токен создаётся с правами 0600 и переиспользуется (тот же менеджер и новый)', async () => {
    const rootDir = await makeBundle();
    const secretsDir = await makeSecretsDir();
    const manager = makeManager(secretsDir);

    const first = await manager.start({ name: NAME, rootDir });
    const path = pluginTokenPath(secretsDir);
    expect(path).toBe(join(secretsDir, PLUGIN_TOKEN_FILE));

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await readFile(path, 'utf-8')).trim()).toBe(first.token);

    // Второй процесс того же менеджера — тот же токен (один на инстанс).
    const second = await manager.start({ name: 'second-plugin', rootDir });
    expect(second.token).toBe(first.token);

    // Новый экземпляр менеджера (перезапуск инстанса) читает файл, а не создаёт новый.
    const another = makeManager(secretsDir);
    const third = await another.start({ name: NAME, rootDir });
    expect(third.token).toBe(first.token);

    await manager.stopAll();
    await another.stopAll();
  });

  it('значение токена не попадает ни в лог, ни в текст ошибки менеджера', async () => {
    // Процесс печатает токен в stderr и падает, не сообщив о готовности.
    const rootDir = await makeBundle({
      omitReadyLine: true,
      echoToken: true,
      exitAfterReady: 1,
    });
    const secretsDir = await makeSecretsDir();
    const warnings: string[] = [];
    const manager = makeManager(secretsDir, { readyTimeoutMs: 2_000, warnings });

    const error = await startFailure(() => manager.start({ name: NAME, rootDir }));

    // Токен уже создан (до spawn) — значит его значение существует и его надо вырезать.
    const token = (await readFile(pluginTokenPath(secretsDir), 'utf-8')).trim();
    expect(token.length).toBeGreaterThan(0);

    expect(error.message).not.toContain(token);
    expect(warnings.join('\n')).not.toContain(token);
    // Причина отказа при этом информативна.
    expect(error.message).toMatch(/завершился до готовности/);
  });
});

// ── Отказы: готовность и health ──────────────────────────────────────────

describe('PluginProcessManager: отказы готовности', () => {
  it('нет строки готовности → PluginLoadError «не сообщил о готовности», процесс остановлен', async () => {
    const rootDir = await makeBundle({ omitReadyLine: true });
    const secretsDir = await makeSecretsDir();
    const pids: Array<number | undefined> = [];
    const manager = makeManager(secretsDir, {
      readyTimeoutMs: 400,
      spawn: recordingSpawn(pids),
    });

    const error = await startFailure(() => manager.start({ name: NAME, rootDir }));

    expect(error.message).toMatch(/не сообщил о готовности/);
    expect(pids).toHaveLength(1);
    // Процесс был жив (иначе проверка ниже ничего не доказывала бы) — и погашен.
    await waitFor(() => !isAlive(pids[0]));
  });

  it('health не отвечает → ошибка про health, процесс остановлен', async () => {
    // Строка готовности с портом, который никто не слушает: «процесс поднялся,
    // а health недоступен» — порт занят другим процессом / сервер не поднял health.
    const rootDir = await makeBundle({ readyPort: await closedPort() });
    const secretsDir = await makeSecretsDir();
    const pids: Array<number | undefined> = [];
    const manager = makeManager(secretsDir, {
      readyTimeoutMs: 500,
      healthTimeoutMs: 200,
      spawn: recordingSpawn(pids),
    });

    const error = await startFailure(() => manager.start({ name: NAME, rootDir }));

    expect(error.message).toMatch(/health не ответил/);
    expect(error.message).toMatch(/остановлен/);
    expect(pids).toHaveLength(1);
    await waitFor(() => !isAlive(pids[0]));
  });

  it('процесс вышел до готовности (код ≠ 0) → отказ с кодом выхода', async () => {
    const rootDir = await makeBundle({ omitReadyLine: true, exitAfterReady: 3 });
    const secretsDir = await makeSecretsDir();
    const manager = makeManager(secretsDir, { readyTimeoutMs: 2_000 });

    const error = await startFailure(() => manager.start({ name: NAME, rootDir }));
    expect(error.message).toMatch(/завершился до готовности \(код 3\)/);
  });
});

// ── Остановка ────────────────────────────────────────────────────────────

describe('PluginProcessManager: остановка', () => {
  it('stop() освобождает порт и идемпотентен; повторный start() на том же каталоге работает', async () => {
    const rootDir = await makeBundle();
    const secretsDir = await makeSecretsDir();
    const pids: Array<number | undefined> = [];
    const manager = makeManager(secretsDir, { spawn: recordingSpawn(pids) });

    const proc = await manager.start({ name: NAME, rootDir });
    const url = proc.url;
    expect(isAlive(pids[0])).toBe(true);

    await proc.stop();
    expect(isAlive(pids[0])).toBe(false);
    // Порт освобождён: процесс больше не отвечает.
    await expect(fetch(`${url}/health`)).rejects.toThrow();

    // Идемпотентность: повторный (в т.ч. параллельный) stop не бросает.
    await expect(proc.stop()).resolves.toBeUndefined();
    await expect(Promise.all([proc.stop(), proc.stop()])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    // Тот же каталог снова запускается — «порт освобождён» подтверждается делом.
    const again = await manager.start({ name: NAME, rootDir });
    expect(again.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${again.url}/health`);
    expect(health.status).toBe(200);
    await health.body?.cancel();

    await manager.stopAll();
  });

  it('stopAll() останавливает все процессы (и повторный вызов безопасен)', async () => {
    const rootDir = await makeBundle();
    const secretsDir = await makeSecretsDir();
    const pids: Array<number | undefined> = [];
    const manager = makeManager(secretsDir, { spawn: recordingSpawn(pids) });

    await manager.start({ name: 'first-plugin', rootDir });
    await manager.start({ name: 'second-plugin', rootDir });
    expect(pids).toHaveLength(2);
    expect(pids.every((pid) => isAlive(pid))).toBe(true);

    await manager.stopAll();
    await waitFor(() => pids.every((pid) => !isAlive(pid)));
    await expect(manager.stopAll()).resolves.toBeUndefined();
  });
});

// ── Точка входа: containment ─────────────────────────────────────────────

describe('PluginProcessManager: точка входа бандла', () => {
  it('точка входа вне rootDir (`../evil.js`) отвергается до spawn', async () => {
    const rootDir = await makeBundle();
    const secretsDir = await makeSecretsDir();
    const counter = { calls: 0 };
    const manager = makeManager(secretsDir, { spawn: countingSpawn(counter) });

    for (const entry of ['../evil.js', 'dist/../../evil.js', '/etc/passwd']) {
      const error = await startFailure(() => manager.start({ name: NAME, rootDir, entry }));
      expect(error.message).toMatch(/недопустимая серверная точка входа/);
    }
    expect(counter.calls).toBe(0);
  });

  it('отсутствующий файл точки входа отвергается до spawn', async () => {
    const rootDir = await makeTempDir('synth-plugin-process-empty-');
    const secretsDir = await makeSecretsDir();
    const counter = { calls: 0 };
    const manager = makeManager(secretsDir, { spawn: countingSpawn(counter) });

    const error = await startFailure(() => manager.start({ name: NAME, rootDir }));
    expect(error.message).toMatch(/не найдена в бандле/);
    expect(counter.calls).toBe(0);
  });
});
