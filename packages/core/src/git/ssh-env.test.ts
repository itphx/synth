import { describe, it, expect, vi } from 'vitest';
import { access, chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createSshEnv,
  isProcessAlive,
  isSshUrl,
  normalizePrivateKeyMaterial,
  readProcessState,
  SshEnvError,
  terminateProcess,
} from './ssh-env.js';

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Есть ли программа в окружении: `ENOENT` — нет; прочий сбой — есть
 * (программа может не поддерживать вызванный флаг).
 */
async function hasProgram(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: 10_000 });
    return true;
  } catch (err) {
    return (err as { code?: string | number }).code !== 'ENOENT';
  }
}

/**
 * Агентные инструменты в окружении (`ssh-agent`/`ssh-add`/`ssh-keygen`).
 *
 * Нет их — агентные тесты пропускаются (а не падают): в slim-образе
 * исполнителя `ssh-agent` может отсутствовать.
 */
const AGENT_TOOLS_AVAILABLE = (
  await Promise.all([
    hasProgram('ssh-agent', ['-h']),
    hasProgram('ssh-add', ['-h']),
    hasProgram('ssh-keygen', ['--help']),
  ])
).every(Boolean);

/**
 * Ключ для агентных тестов — генерируется в рантайме (`ssh-keygen`), чтобы в
 * исходниках не было приватного ключа (secret-scan).
 */
async function generateKey(passphrase?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-ssh-key-'));
  try {
    const path = join(dir, 'id_ed25519');
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', passphrase ?? '', '-f', path, '-q']);
    return await readFile(path, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Каталоги материала с pid-файлом агента (следы неудачной подготовки). */
async function dirsWithAgentPidFile(): Promise<string[]> {
  const root = tmpdir();
  const entries = await readdir(root).catch(() => [] as string[]);
  const found: string[] = [];
  for (const name of entries) {
    if (!name.startsWith('synth-ssh-')) continue;
    if (await exists(join(root, name, 'agent.pid'))) found.push(join(root, name));
  }
  return found;
}

/** Дождаться смерти процесса (после `SIGTERM` он уходит не мгновенно). */
async function waitProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Настоящий **зомби**: процесс завершился, но его родитель жив и не сделал
 * `wait` — запись в таблице процессов осталась, а `kill(pid, 0)` возвращает
 * успех.
 *
 * Родитель — `sh`, который форкает фонового ребёнка и делает `exec`: после
 * `exec` фоновым ребёнком «родитель» становится обычный `sleep`, который
 * детей не reap'ит (в отличие от оболочки с обработчиком `SIGCHLD`).
 * Так зомби воспроизводится **детерминированно**, независимо от того, кто
 * переиспользует pid.
 */
async function spawnZombie(): Promise<{ pid: number; stop: () => void }> {
  const parent = spawn('sh', ['-c', 'sleep 300 & echo $!; exec sleep 300'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pid = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('не дождались pid фонового процесса')), 10_000);
    timer.unref?.();
    parent.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const match = /(\d+)/.exec(buf);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
  });
  // Убиваем фонового процесса — он переходит в состояние `Z` (родитель жив).
  process.kill(pid, 'SIGKILL');
  const stop = (): void => {
    try {
      parent.kill('SIGKILL');
    } catch {
      // Родитель уже мёртв — не ошибка.
    }
  };
  return { pid, stop };
}

/**
 * Предупреждения логгера (`warning()` → `console.warn`) за время вызова.
 *
 * @returns массив текстов предупреждений
 */
function collectWarnings(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(' '));
  });
  return { messages, restore: () => spy.mockRestore() };
}

/** Спецсимволы, ломающие наивную конкатенацию: `$`, `"`, `'`, `\`, пробел, перевод строки. */
const TRICKY_PASSPHRASE = 'p$a"s\'\\ w\nrd';

/**
 * Подставные `ssh-agent`/`ssh-add` — тестовый хелпер для проверки эскалации
 * гашения агента.
 *
 * Настоящий `ssh-agent -D` (foreground-режим, в котором мы его поднимаем)
 * **не выходит**: он печатает pid и живёт, пока его не погасят. Подставной
 * агент устроен так же, но может **игнорировать** `SIGTERM` (как зависший
 * агент в проде) и живёт, пока не придёт `SIGKILL`:
 * - создаёт «сокет» (обычный файл — код проверяет только существование);
 * - печатает `echo Agent pid <pid>;` в формате, который понимает разбор;
 * - pid — **собственный** (`$$`): подставной агент и есть тот процесс, который
 *   мы гасим (в foreground-режиме агент — наш ребёнок, его reапит Node);
 * - `ssh-add` — заглушка с кодом 0 (ключ добавлять нечем).
 */
function fakeAgentScript(ignoreSigterm: boolean): string {
  return `#!/bin/sh
# Подставной ssh-agent (foreground-режим): живёт, пока не придёт сигнал.
sock=""
while [ $# -gt 0 ]; do
  case "$1" in
    -a) sock="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$sock" ]; then : > "$sock"; fi
echo "echo Agent pid $$;"
${ignoreSigterm ? 'trap "" TERM' : ''}
while : ; do sleep 0.2; done
`;
}

const FAKE_SSH_ADD_SCRIPT = `#!/bin/sh
# Подставной ssh-add: ключ «добавлен» (возвращаем 0).
exit 0
`;

/**
 * Подставить подставные `ssh-agent`/`ssh-add` в `PATH`.
 *
 * @param opts.ignoreSigterm — агент игнорирует `SIGTERM` (иначе умирает от него)
 * @returns функция восстановления исходного `PATH`
 */
async function withFakeAgentTools(opts: { ignoreSigterm?: boolean } = {}): Promise<() => void> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-fake-agent-'));
  await writeFile(join(dir, 'ssh-agent'), fakeAgentScript(opts.ignoreSigterm === true), {
    encoding: 'utf-8',
    mode: 0o755,
  });
  await writeFile(join(dir, 'ssh-add'), FAKE_SSH_ADD_SCRIPT, { encoding: 'utf-8', mode: 0o755 });
  await chmod(join(dir, 'ssh-agent'), 0o755).catch(() => {});
  await chmod(join(dir, 'ssh-add'), 0o755).catch(() => {});
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    void rm(dir, { recursive: true, force: true }).catch(() => {});
  };
}

describe('ssh-env (ADR-076 §T3)', () => {
  it('isSshUrl распознаёт git@ и ssh://', () => {
    expect(isSshUrl('git@github.com:org/repo.git')).toBe(true);
    expect(isSshUrl('ssh://git@host/org/repo.git')).toBe(true);
    expect(isSshUrl('https://github.com/org/repo.git')).toBe(false);
    expect(isSshUrl('file:///tmp/repo')).toBe(false);
  });

  it('createSshEnv без passphrase пишет ключ 0600 и BatchMode (регресс)', async () => {
    const { env, cleanup } = await createSshEnv({ privateKey: '-----BEGIN KEY-----\nsecret\n' });
    const command = env.GIT_SSH_COMMAND ?? '';
    expect(command).toContain('-o IdentitiesOnly=yes');
    expect(command).toContain('-o BatchMode=yes');
    expect(command).toContain('-i ');
    // Без passphrase askpass не подключается.
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS_REQUIRE).toBeUndefined();

    const match = /-i (\S+)/.exec(command);
    expect(match).not.toBeNull();
    const keyPath = match![1]!;
    expect(await exists(keyPath)).toBe(true);
    const st = await stat(keyPath);
    expect(st.mode & 0o777).toBe(0o600);

    const dir = dirname(keyPath);
    await cleanup();
    expect(await exists(keyPath)).toBe(false);
    expect(await exists(dir)).toBe(false);

    // Идемпотентность.
    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('createSshEnv с passphrase готовит askpass 0700 и не ставит BatchMode', async () => {
    const { env, cleanup } = await createSshEnv({ privateKey: 'key-material', passphrase: TRICKY_PASSPHRASE });
    try {
      const command = env.GIT_SSH_COMMAND ?? '';
      expect(command).toContain('-i ');
      expect(command).toContain('-o NumberOfPasswordPrompts=1');
      // BatchMode глушит askpass — его быть не должно.
      expect(command).not.toContain('BatchMode=yes');

      const keyPath = /-i (\S+)/.exec(command)?.[1];
      expect(keyPath).toBeTruthy();
      const keyStat = await stat(keyPath!);
      expect(keyStat.mode & 0o777).toBe(0o600);

      expect(env.SSH_ASKPASS).toBeTruthy();
      expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
      const askpassPath = env.SSH_ASKPASS!;

      // Скрипт лежит в том же temp-каталоге (удаляется cleanup).
      expect(dirname(askpassPath)).toBe(dirname(keyPath!));
      expect(await exists(askpassPath)).toBe(true);
      const askpassStat = await stat(askpassPath);
      expect(askpassStat.mode & 0o777).toBe(0o700);

      // Запускаем askpass и сверяем ровно исходный passphrase (со спецсимволами).
      const { stdout } = await execFileAsync(askpassPath, []);
      expect(String(stdout)).toBe(TRICKY_PASSPHRASE);
    } finally {
      await cleanup();
    }

    // cleanup удаляет каталог вместе со скриптом.
    const match = /-i (\S+)/.exec(env.GIT_SSH_COMMAND ?? '');
    const dir = dirname(match?.[1] ?? '');
    expect(await exists(env.SSH_ASKPASS!)).toBe(false);
    expect(await exists(dir)).toBe(false);

    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('agent:false — поведение прежнее (файл ключа живёт до cleanup)', async () => {
    const { env, cleanup } = await createSshEnv({ privateKey: '-----BEGIN KEY-----\nsecret\n', agent: false });
    try {
      expect(env.GIT_SSH_COMMAND).toContain('-i ');
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.SSH_AGENT_PID).toBeUndefined();
      const keyPath = /-i (\S+)/.exec(env.GIT_SSH_COMMAND ?? '')?.[1];
      expect(keyPath).toBeTruthy();
      expect(await exists(keyPath!)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

/**
 * Ключ без завершающего перевода строки (живой инстанс, ADR-076).
 *
 * Ключ в реестре хранится **без** завершающего `\n` (последний байт — `-` от
 * `-----END OPENSSH PRIVATE KEY-----`). `ssh-add` такой файл не принимает
 * («invalid format») — в agent-режиме падала материализация секрета вызова.
 * Нормализация — в единственной точке записи ключа (`writeKeyFile`): обе
 * ветки (git и agent).
 */
describe('ssh-env: ключ без завершающего перевода строки', () => {
  it('нормализация дописывает \\n и не трогает ключ, который его уже имеет', () => {
    expect(normalizePrivateKeyMaterial('KEY')).toBe('KEY\n');
    expect(normalizePrivateKeyMaterial('KEY\n')).toBe('KEY\n');
    // CRLF-ключ не ломаем: он уже заканчивается на `\n`.
    expect(normalizePrivateKeyMaterial('KEY\r\n')).toBe('KEY\r\n');
    // Пустой материал — как есть (не добавляем мусорный перевод строки).
    expect(normalizePrivateKeyMaterial('')).toBe('');
  });

  it('agent:false — в файл ключа дописан \\n (ключ читается ssh)', async () => {
    const { env, cleanup } = await createSshEnv({ privateKey: '-----BEGIN KEY-----\nsecret' });
    try {
      const keyPath = /-i (\S+)/.exec(env.GIT_SSH_COMMAND ?? '')?.[1];
      expect(keyPath).toBeTruthy();
      const written = await readFile(keyPath!, 'utf-8');
      expect(written.endsWith('\n')).toBe(true);
      expect(written).toBe('-----BEGIN KEY-----\nsecret\n');
    } finally {
      await cleanup();
    }
  });

  it('agent:false — ключ с \\r\\n записывается без изменений', async () => {
    const material = '-----BEGIN KEY-----\r\nsecret\r\n';
    const { env, cleanup } = await createSshEnv({ privateKey: material });
    try {
      const keyPath = /-i (\S+)/.exec(env.GIT_SSH_COMMAND ?? '')?.[1];
      expect(keyPath).toBeTruthy();
      // Байт в байт: переводы строк внутри ключа не меняем.
      expect(await readFile(keyPath!, 'utf-8')).toBe(material);
    } finally {
      await cleanup();
    }
  });
});

describe.skipIf(!AGENT_TOOLS_AVAILABLE)('ssh-env: ключ без завершающего \\n (agent-режим)', () => {
  it('ключ без завершающего \\n добавляется в агент (ssh-add -l видит идентичность)', async () => {
    // Реальный ключ из реестра: последний байт — `-`, без перевода строки.
    const privateKey = (await generateKey()).replace(/\n$/, '');
    expect(privateKey.endsWith('\n')).toBe(false);

    const { env, cleanup } = await createSshEnv({ privateKey, agent: true });
    try {
      const sock = env.SSH_AUTH_SOCK!;
      const { stdout } = await execFileAsync('ssh-add', ['-l'], {
        env: { ...process.env, SSH_AUTH_SOCK: sock },
      });
      // Идентичность в памяти агента есть — значит `ssh-add` принял ключ.
      expect(String(stdout).trim().length).toBeGreaterThan(0);
      expect(String(stdout)).toContain('ED25519');
    } finally {
      await cleanup();
    }
  });

  it('agent:false — ключ без завершающего \\n записывается валидным (ssh-keygen читает)', async () => {
    const privateKey = (await generateKey()).replace(/\n$/, '');
    const { env, cleanup } = await createSshEnv({ privateKey, agent: false });
    try {
      const keyPath = /-i (\S+)/.exec(env.GIT_SSH_COMMAND ?? '')?.[1];
      expect(keyPath).toBeTruthy();
      const written = await readFile(keyPath!, 'utf-8');
      expect(written.endsWith('\n')).toBe(true);
      // Тот же PEM-парсер, что у `ssh`/`ssh-add`: ключ без перевода строки он
      // не принимает («invalid format»), с переводом — принимает.
      const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath!]);
      expect(String(stdout).trim().startsWith('ssh-ed25519')).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe.skipIf(!AGENT_TOOLS_AVAILABLE)('ssh-env: агентный режим (PROP-124 §2)', () => {
  it('agent:true — SSH_AUTH_SOCK/SSH_AGENT_PID, ключ удалён, агент видит идентичность', async () => {
    const privateKey = await generateKey();
    const { env, cleanup } = await createSshEnv({ privateKey, agent: true });
    const sock = env.SSH_AUTH_SOCK;
    const pid = Number(env.SSH_AGENT_PID);
    try {
      expect(sock).toBeTruthy();
      expect(Number.isInteger(pid)).toBe(true);
      // Агентный режим не смешивается с git-режимом.
      expect(env.GIT_SSH_COMMAND).toBeUndefined();
      expect(env.SSH_ASKPASS).toBeUndefined();

      const dir = dirname(sock!);
      // Сокет и pid-файл — в каталоге материала.
      expect(await exists(join(dir, 'agent.sock'))).toBe(true);
      expect(await exists(join(dir, 'agent.pid'))).toBe(true);
      // Файла ключа нет: материал остался только в памяти агента.
      expect(await exists(join(dir, 'key'))).toBe(false);

      // Агент видит добавленную идентичность.
      const { stdout } = await execFileAsync('ssh-add', ['-l'], {
        env: { ...process.env, SSH_AUTH_SOCK: sock! },
      });
      expect(String(stdout).trim().length).toBeGreaterThan(0);
      // Агент жив.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      await cleanup();
    }

    // cleanup: агент мёртв, каталога нет.
    expect(await waitProcessGone(pid)).toBe(true);
    expect(await exists(dirname(sock!))).toBe(false);
    // Идемпотентно.
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('ключ с passphrase (askpass) — идентичность добавлена, askpass удалён', async () => {
    const passphrase = 'agent-passphrase';
    const privateKey = await generateKey(passphrase);
    const { env, cleanup } = await createSshEnv({ privateKey, passphrase, agent: true });
    try {
      const { stdout } = await execFileAsync('ssh-add', ['-l'], {
        env: { ...process.env, SSH_AUTH_SOCK: env.SSH_AUTH_SOCK! },
      });
      expect(String(stdout).trim().length).toBeGreaterThan(0);
      // Askpass-скрипт удалён вместе с ключом — материал на диске не остался.
      const dir = dirname(env.SSH_AUTH_SOCK!);
      expect(await exists(join(dir, 'askpass.sh'))).toBe(false);
      expect(await exists(join(dir, 'key'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('битый ключ — agent_failed, каталог убран (гарантированный cleanup)', async () => {
    await expect(createSshEnv({ privateKey: 'это не ключ', agent: true })).rejects.toMatchObject({
      name: 'SshEnvError',
      code: 'agent_failed',
    });
    // Ни одного каталога с pid-файлом агента не осталось.
    expect(await dirsWithAgentPidFile()).toEqual([]);
  });

  it('текст ошибки не содержит материал ключа', async () => {
    const secret = 'супер-секретный-материал';
    try {
      await createSshEnv({ privateKey: secret, agent: true });
    } catch (err) {
      expect(err).toBeInstanceOf(SshEnvError);
      expect(String((err as SshEnvError).message)).not.toContain(secret);
    }
  });
});

/**
 * Жизненный цикл агента (PROP-124 §2): агент поднимается в **foreground-режиме**
 * (`ssh-agent -D`) — он остаётся нашим ребёнком, и после смерти его reапит Node
 * (в контейнере, где процесс — PID 1, демонизированный агент осиротел бы и
 * остался зомби навсегда: `kill(pid, 0)` на зомби возвращает успех).
 *
 * `cleanup` обязан гасить агент **наверняка**: `SIGTERM` → ожидание → `SIGKILL`
 * → ожидание. Предупреждение «агент не завершился» — только для **реально
 * живого** процесса (зомби мёртв).
 */
describe('ssh-env: жёсткое завершение агента', () => {
  it('агент, игнорирующий SIGTERM, убит через SIGKILL — без ложного предупреждения', async () => {
    const restorePath = await withFakeAgentTools({ ignoreSigterm: true });
    const warnings = collectWarnings();
    try {
      const { env, cleanup } = await createSshEnv({
        privateKey: 'это не ключ',
        agent: true,
        // Короткие ожидания — тест не должен висеть.
        agentKill: { termGraceMs: 300, killGraceMs: 1_000, pollMs: 25 },
      });
      const pid = Number(env.SSH_AGENT_PID);
      const dir = dirname(env.SSH_AUTH_SOCK!);
      expect(Number.isInteger(pid)).toBe(true);
      // Агент жив и **игнорирует** SIGTERM (иначе эскалация не проверяется).
      expect(() => process.kill(pid, 0)).not.toThrow();
      process.kill(pid, 'SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        timer.unref?.();
      });
      expect(() => process.kill(pid, 0)).not.toThrow();

      const startedAt = Date.now();
      await cleanup();
      const elapsed = Date.now() - startedAt;

      // Агент мёртв (SIGKILL), каталог убран.
      expect(await waitProcessGone(pid)).toBe(true);
      expect(await exists(dir)).toBe(false);
      // cleanup не висит: суммарное ожидание ограничено таймаутами.
      expect(elapsed).toBeLessThan(5_000);
      // Ложного «агент остался жив» быть не должно (процесс убит, а не зомби).
      expect(warnings.messages.filter((m) => m.includes('ssh-agent не завершился'))).toEqual([]);
      // Идемпотентность.
      await expect(cleanup()).resolves.toBeUndefined();
    } finally {
      warnings.restore();
      restorePath();
    }
  });

  it('агент, корректно умирающий по SIGTERM — без предупреждения', async () => {
    const restorePath = await withFakeAgentTools();
    const warnings = collectWarnings();
    try {
      const { env, cleanup } = await createSshEnv({
        privateKey: 'это не ключ',
        agent: true,
        agentKill: { termGraceMs: 300, killGraceMs: 1_000, pollMs: 25 },
      });
      const pid = Number(env.SSH_AGENT_PID);
      expect(Number.isInteger(pid)).toBe(true);

      await cleanup();

      expect(await waitProcessGone(pid)).toBe(true);
      expect(warnings.messages.filter((m) => m.includes('ssh-agent не завершился'))).toEqual([]);
    } finally {
      warnings.restore();
      restorePath();
    }
  });

  it('после cleanup агент reапнут Node — зомби не остаётся', async () => {
    const restorePath = await withFakeAgentTools();
    try {
      const { env, cleanup } = await createSshEnv({
        privateKey: 'это не ключ',
        agent: true,
        agentKill: { termGraceMs: 300, killGraceMs: 1_000, pollMs: 25 },
      });
      const pid = Number(env.SSH_AGENT_PID);
      await cleanup();
      // Процесса нет вовсе (не зомби): состояние не читается — запись в
      // таблице процессов убрана.
      expect(readProcessState(pid)).toBeNull();
    } finally {
      restorePath();
    }
  });

  it('в каталоге материала — файл владельца (pid и время старта)', async () => {
    const restorePath = await withFakeAgentTools();
    try {
      const { env, cleanup } = await createSshEnv({
        privateKey: 'это не ключ',
        agent: true,
        agentKill: { termGraceMs: 100, killGraceMs: 500, pollMs: 25 },
      });
      try {
        const dir = dirname(env.SSH_AUTH_SOCK!);
        const owner = await readFile(join(dir, 'owner.pid'), 'utf-8');
        const [pidRaw, startRaw] = owner.split('\n');
        // Владелец — процесс, создавший агента (текущий процесс теста).
        expect(Number.parseInt((pidRaw ?? '').trim(), 10)).toBe(process.pid);
        // Время старта — best-effort (на Linux доступно).
        expect((startRaw ?? '').trim().length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    } finally {
      restorePath();
    }
  });
});

/**
 * Зомби (`Z`) — процесс завершился, но родитель не сделал `wait`.
 *
 * `kill(pid, 0)` на зомби возвращает успех, поэтому «живость» по сигналу врёт:
 * процесс мёртв (ресурсы, в том числе память с ключом, освобождены), и
 * предупреждение «ssh-agent остался жив» — ложное.
 */
describe('ssh-env: зомби не считается живым', () => {
  it('состояние Z — процесс мёртв (isProcessAlive → false)', async () => {
    const zombie = await spawnZombie();
    try {
      // Ждём перехода в состояние `Z`.
      const deadline = Date.now() + 5_000;
      while (readProcessState(zombie.pid) !== 'Z' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(readProcessState(zombie.pid)).toBe('Z');
      // По сигналу зомби «жив» — именно поэтому нужна проверка состояния.
      expect(() => process.kill(zombie.pid, 0)).not.toThrow();
      expect(isProcessAlive(zombie.pid)).toBe(false);
    } finally {
      zombie.stop();
    }
  });

  it('terminateProcess на зомби: процесс мёртв, предупреждения нет', async () => {
    const zombie = await spawnZombie();
    const warnings = collectWarnings();
    try {
      const deadline = Date.now() + 5_000;
      while (readProcessState(zombie.pid) !== 'Z' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(readProcessState(zombie.pid)).toBe('Z');

      const gone = await terminateProcess(zombie.pid, {
        termGraceMs: 100,
        killGraceMs: 200,
        pollMs: 25,
      });
      // Зомби — мёртвый процесс: эскалация не нужна, ложного предупреждения нет.
      expect(gone).toBe(true);
      expect(warnings.messages.filter((m) => m.includes('ssh-agent не завершился'))).toEqual([]);
    } finally {
      warnings.restore();
      zombie.stop();
    }
  });
});
