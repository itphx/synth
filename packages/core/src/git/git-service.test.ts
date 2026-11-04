import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as undici from 'undici';
import { GitService, resolveRepoPath, sanitizeGitEnv } from './git-service.js';
import { InlineExecutionPort } from '../execution/inline-execution-port.js';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  ExecutionError,
  isExecutionError,
  type ExecRequest,
  type ExecResult,
  type ExecSecret,
  type ExecutionPort,
} from '../execution/ports/index.js';
import { initTlsTrust, _resetTlsTrustForTests } from '../security/tls.js';

const execFileAsync = promisify(execFile);

// Фикстура: PEM собирается в рантайме, чтобы в исходниках не было литерала
// заголовка приватного ключа (secret-scan); тело — заведомая заглушка.
const pem = (body: string): string => {
  const label = 'OPENSSH PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};

/** CA-фикстура (самоподписанный тестовый серт) — валидный PEM. */
const CERT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'security',
  '__fixtures__',
  'tls-test-selfsigned.pem',
);
/** Живые сетевые проверки — только по явному запросу (`SYNTH_TEST_NETWORK=1`). */
const LIVE_NETWORK = process.env.SYNTH_TEST_NETWORK === '1';
/** Системный CA-бандл (Linux) для живой проверки https. */
const SYSTEM_CA = '/etc/ssl/certs/ca-certificates.crt';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Код брошенной ошибки (сервис бросает plain-object `{error, code}`). */
function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? '';
  }
  throw new Error('ожидалось исключение');
}

/**
 * Запуск git в тесте напрямую (без GitService) — подготовка репозиториев.
 * Identity передаётся пер-вызовом: тест не зависит от глобального/системного
 * git-конфига окружения (в CI его нет и `git commit` падал с «Author identity unknown»).
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=Тест Юникод', '-c', 'user.email=test@example.com', ...args],
    { cwd },
  );
  return stdout;
}

/** Инициализирует репозиторий и настраивает identity для коммитов в тесте. */
async function initRepoAt(dir: string, branch = 'main'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '--initial-branch', branch]);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Тест Юникод']);
}

/** Добавляет файл в индекс и коммитит; возвращает полный hash коммита. */
async function commitFile(dir: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(join(dir, name), content);
  await git(dir, ['add', '--', name]);
  await git(dir, ['commit', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

/** Создаёт bare-репозиторий (`git init --bare`) с одним коммитом в `main`. */
async function createBareRepo(base: string): Promise<string> {
  const bare = join(base, 'origin.git');
  const work = join(base, 'work');
  await git(base, ['init', '--bare', '--initial-branch=main', bare]);
  await git(base, ['clone', bare, work]);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'Тест Юникод']);
  await writeFile(join(work, 'README.md'), 'hello\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '-m', 'initial']);
  await git(work, ['push', 'origin', 'main']);
  return bare;
}

/** Порт-шпион: фиксирует запросы и отвечает заранее заданным stdout. */
class CapturingPort implements ExecutionPort {
  readonly calls: ExecRequest[] = [];
  readonly isRemote: boolean;
  stdout = 'true\n';

  constructor(opts: { isRemote?: boolean } = {}) {
    this.isRemote = opts.isRemote === true;
  }

  async execute(req: ExecRequest): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    durationMs: number;
  }> {
    this.calls.push(req);
    return { stdout: this.stdout, stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
  }
}

/**
 * Порт-шпион, который **исполняет** команды (inline) и запоминает запросы.
 *
 * `cloneRepo` после успешного `git clone` делает `rename` временного каталога:
 * с «глухим» моком временного каталога не возникает, и проверка аргументов
 * падала бы на `ENOENT` вместо проверки поведения.
 */
class DelegatingPort implements ExecutionPort {
  readonly calls: ExecRequest[] = [];
  readonly isRemote = false;
  private readonly inner = new InlineExecutionPort();

  async execute(req: ExecRequest): Promise<ExecResult> {
    this.calls.push(req);
    return this.inner.execute(req);
  }
}

/**
 * Порт, «истекающий по таймауту» на заданной git-подкоманде (без сети).
 *
 * Таймаут настоящего `git clone`/`fetch` воспроизводить нечем: сеть в тестах
 * недоступна, а ждать реальные минуты нельзя — мок порта даёт ту же ошибку
 * (`ExecutionError.reason = 'timeout'`), что и `InlineExecutionPort`.
 */
class TimingOutPort implements ExecutionPort {
  readonly calls: ExecRequest[] = [];
  readonly isRemote = false;

  constructor(private readonly failOn: 'clone' | 'fetch') {}

  async execute(req: ExecRequest): Promise<ExecResult> {
    this.calls.push(req);
    const args = req.command.kind === 'argv' ? req.command.args ?? [] : [];
    if (args.includes(this.failOn)) {
      throw new ExecutionError({
        message: `Command failed: git ${this.failOn}`,
        reason: 'timeout',
        killed: true,
      });
    }
    // Прочие git-вызовы (rev-parse/status) — успешны: путь «репозиторий есть».
    return { stdout: 'true\n', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
  }
}

/** Временные каталоги клонирования (`<repo>.tmp-<uuid>`) в каталоге-родителе. */
async function listTmpSiblings(parent: string): Promise<string[]> {
  const entries = await readdir(parent).catch(() => [] as string[]);
  return entries.filter((entry) => entry.includes('.tmp-'));
}

describe('GitService (ADR-076 §T3, ADR-077)', () => {
  let root: string;
  let ws: string;
  let service: GitService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-'));
    ws = join(root, 'workspace');
    await mkdir(ws, { recursive: true });
    service = new GitService(root);
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    undici.setGlobalDispatcher(new undici.Agent());
    await rm(root, { recursive: true, force: true });
  });

  it('initRepo создаёт репозиторий, getRepoStatus/scanWorkspace его видят', async () => {
    await service.initRepo(ws, 'repos/app', 'main');
    const repoPath = join(ws, 'repos', 'app');
    expect(await exists(join(repoPath, '.git'))).toBe(true);
    expect(await service.isRepo(repoPath)).toBe(true);

    await commitFile(repoPath, 'README.md', 'hello\n', 'initial');

    const status = await service.getRepoStatus(repoPath);
    expect(status?.isRepo).toBe(true);
    expect(status?.currentBranch).toBe('main');
    expect(status?.lastCommitSubject).toBe('initial');
    expect(Number.isNaN(Date.parse(status?.lastCommitAt ?? ''))).toBe(false);

    const scanned = await service.scanWorkspace(ws);
    expect(scanned.map((r) => r.path)).toContain('repos/app');
  });

  it('getRepoStatus: чистое и грязное дерево — ветка и последний коммит', async () => {
    const repoPath = join(ws, 'repo');
    await initRepoAt(repoPath);
    await commitFile(repoPath, 'a.txt', 'one\n', 'первый');

    const clean = await service.getRepoStatus(repoPath);
    expect(clean).toMatchObject({ path: '', isRepo: true, currentBranch: 'main' });

    await writeFile(join(repoPath, 'a.txt'), 'two\n');
    await writeFile(join(repoPath, 'untracked.txt'), 'new\n');
    await git(repoPath, ['add', 'a.txt']);
    await git(repoPath, ['mv', 'a.txt', 'renamed.txt']);

    const dirty = await service.getRepoStatus(repoPath);
    expect(dirty?.currentBranch).toBe('main');
    expect(dirty?.lastCommitSubject).toBe('первый');
  });

  it('getRepoStatus: не-репозиторий и отсутствующий путь → null, isRepo → false', async () => {
    expect(await service.isRepo(ws)).toBe(false);
    expect(await service.getRepoStatus(ws)).toBeNull();
    expect(await service.isRepo(join(ws, 'missing'))).toBe(false);
    expect(await service.getRepoStatus(join(ws, 'missing'))).toBeNull();
  });

  it('getLog: hash/shortHash/subject/author/date/branch (юникод, тело коммита)', async () => {
    const repoPath = join(ws, 'repo');
    await initRepoAt(repoPath);
    await commitFile(repoPath, 'a.txt', 'one\n', 'Первый коммит');
    await commitFile(repoPath, 'b.txt', 'two\n', 'Второй коммит\n\nТело сообщения\nвторая строка');

    const log = await service.getLog(ws, 'repo', 10);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      subject: 'Второй коммит',
      // Прежняя семантика getLog: `message` — subject (прежний log отдавал `%s`).
      message: 'Второй коммит',
      author: 'Тест Юникод',
      authorEmail: 'test@example.com',
      branch: 'main',
    });
    expect(log[0]?.hash).toHaveLength(40);
    expect(log[0]?.shortHash).toHaveLength(7);
    expect(log[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof log[0]?.relativeDate).toBe('string');
    expect(log[1]?.subject).toBe('Первый коммит');

    const limited = await service.getLog(ws, 'repo', 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.hash).toBe(log[0]?.hash);
  });

  it('getCommitDetail: сообщение с переводом строки и юникодом, файлы и diff', async () => {
    const repoPath = join(ws, 'repo');
    await initRepoAt(repoPath);
    await commitFile(repoPath, 'a.txt', 'one\n', 'Первый коммит');
    const hash = await commitFile(
      repoPath,
      'b.txt',
      'две строки\n',
      'Subject строка\n\nТело сообщения\nвторая строка',
    );

    const detail = await service.getCommitDetail(ws, 'repo', hash);
    expect(detail.hash).toBe(hash);
    expect(detail.shortHash).toBe(hash.slice(0, 7));
    expect(detail.subject).toBe('Subject строка');
    expect(detail.message).toContain('Subject строка');
    expect(detail.message).toContain('Тело сообщения');
    expect(detail.message).toContain('вторая строка');
    expect(detail.message.match(/Subject строка/g)).toHaveLength(1);
    expect(detail.author).toBe('Тест Юникод');
    expect(detail.authorEmail).toBe('test@example.com');
    expect(detail.branch).toBe('main');
    expect(detail.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const file = detail.files.find((f) => f.path === 'b.txt');
    expect(file).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
    expect(detail.diff).toContain('diff --git');
    expect(detail.diff).toContain('+две строки');
  });

  it('cloneRepo клонирует из локального bare-репозитория (file://)', async () => {
    const bare = await createBareRepo(root);
    const repo = await service.cloneRepo(ws, 'repos/clone', `file://${bare}`);
    expect(repo.path).toBe('repos/clone');
    expect(await exists(join(ws, 'repos', 'clone', 'README.md'))).toBe(true);

    const status = await service.getRepoStatus(join(ws, 'repos', 'clone'));
    expect(status?.currentBranch).toBe('main');

    const scanned = await service.scanWorkspace(ws);
    expect(scanned.find((r) => r.path === 'repos/clone')?.isRepo).toBe(true);
  });

  it('cloneRepo с веткой использует `clone --branch <branch>` во временный каталог', async () => {
    const bare = await createBareRepo(root);
    const port = new DelegatingPort();
    const svc = new GitService(root, { execution: port });
    await svc.cloneRepo(ws, 'repos/branchy', `file://${bare}`, 'main');

    const command = port.calls.at(-1)?.command;
    expect(command).toMatchObject({ kind: 'argv', file: 'git' });
    if (command?.kind !== 'argv') throw new Error('ожидалась argv-форма');
    const argv = command.args ?? [];

    // ADR-076: клон идёт в `<repo>.tmp-<uuid>` рядом с целевым каталогом —
    // цель `git clone` больше не абсолютный путь репозитория.
    const at = argv.indexOf('clone');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(argv.slice(at, at + 4)).toEqual(['clone', '--branch', 'main', `file://${bare}`]);

    const target = argv.at(-1) ?? '';
    const expectedTarget = join(ws, 'repos', 'branchy');
    expect(dirname(target)).toBe(dirname(expectedTarget));
    expect(basename(target)).toMatch(/^branchy\.tmp-[0-9a-f-]{36}$/);
    expect(target.startsWith(`${expectedTarget}.tmp-`)).toBe(true);
    expect(target).not.toBe(expectedTarget);

    // Клон действительно выполнен и переименован в целевой путь.
    expect(await exists(join(expectedTarget, 'README.md'))).toBe(true);
  });

  it('cloneRepo: успешный клон атомарен — целевой каталог есть, временных не осталось', async () => {
    const bare = await createBareRepo(root);
    const target = join(ws, 'repos', 'atomic');

    const repo = await service.cloneRepo(ws, 'repos/atomic', `file://${bare}`);

    expect(repo).toMatchObject({ path: 'repos/atomic', isRepo: true });
    expect(await exists(join(target, 'README.md'))).toBe(true);
    // Временные каталоги `*.tmp-<uuid>` убираются/переименовываются: на диске их нет.
    expect(await listTmpSiblings(join(ws, 'repos'))).toEqual([]);
  });

  it('cloneRepo: неуспешный клон не оставляет ни целевого каталога, ни `.tmp-*`', async () => {
    const missingUrl = `file://${join(root, 'nope-origin.git')}`;
    const target = join(ws, 'repos', 'broken');

    const err = await service.cloneRepo(ws, 'repos/broken', missingUrl).catch((e: unknown) => e);

    // Ошибка не подменяется на «занятый путь»/таймаут — это исходная ошибка git.
    expect(isExecutionError(err)).toBe(true);
    expect((err as { code?: string }).code).not.toBe('git.clone_timeout');
    expect(err).toBeInstanceOf(Error);

    expect(await exists(target)).toBe(false);
    expect(await listTmpSiblings(join(ws, 'repos'))).toEqual([]);
  });

  it('cloneRepo: таймаут порта → git.clone_timeout, следов на диске нет', async () => {
    const port = new TimingOutPort('clone');
    const svc = new GitService(root, { execution: port, cloneTimeoutMs: 1234 });
    const target = join(ws, 'repos', 'slow');

    const err = await svc
      .cloneRepo(ws, 'repos/slow', 'https://example.invalid/org/slow.git')
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'git.clone_timeout' });
    expect((err as { error: string }).error).toContain('1234');
    // Таймаут проброшен в порт — иначе «зависший» clone ждал бы вечно.
    expect(port.calls.at(-1)?.timeoutMs).toBe(1234);

    expect(await exists(target)).toBe(false);
    expect(await listTmpSiblings(join(ws, 'repos'))).toEqual([]);
  });

  it('fetchRepo: таймаут порта → git.fetch_timeout', async () => {
    const port = new TimingOutPort('fetch');
    const svc = new GitService(root, { execution: port, fetchTimeoutMs: 4321 });

    const err = await svc.fetchRepo(ws, 'repos/app').catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'git.fetch_timeout' });
    expect((err as { error: string }).error).toContain('4321');
    expect(port.calls.at(-1)?.timeoutMs).toBe(4321);
  });

  it('fetchRepo обновляет remote-ветку', async () => {
    const bare = await createBareRepo(root);
    await service.cloneRepo(ws, 'repos/app', `file://${bare}`);

    const work = join(root, 'work');
    await writeFile(join(work, 'README.md'), 'hello again\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'second']);
    await git(work, ['push', 'origin', 'main']);
    const pushed = (await git(work, ['rev-parse', 'HEAD'])).trim();

    await expect(service.fetchRepo(ws, 'repos/app')).resolves.toBeUndefined();
    const fetched = (await git(join(ws, 'repos', 'app'), ['rev-parse', 'origin/main'])).trim();
    expect(fetched).toBe(pushed);
  });

  it('fetchRepo с явным remote и env', async () => {
    const bare = await createBareRepo(root);
    await service.cloneRepo(ws, 'repos/app', `file://${bare}`);
    await expect(service.fetchRepo(ws, 'repos/app', { remote: 'origin', env: { GIT_SSH_COMMAND: 'ssh -i x' } })).resolves.toBeUndefined();
  });

  it('исполнение — через переданный порт: argv, requires, cwd, env', async () => {
    const port = new CapturingPort();
    const svc = new GitService(root, { execution: port });
    expect(await svc.isRepo(join(ws, 'repo'))).toBe(true);

    const req = port.calls.at(-1);
    expect(req?.command).toEqual({ kind: 'argv', file: 'git', args: ['rev-parse', '--is-inside-work-tree'] });
    expect(req?.requires).toEqual(['git']);
    expect(req?.cwd).toBe(join(ws, 'repo'));
    expect(req?.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(req?.env?.PATH).toBe(process.env.PATH);
    expect(req?.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(req?.timeoutMs).toBeUndefined();

    await svc.isRepo(join(ws, 'repo'), { env: { GIT_SSH_COMMAND: 'ssh -i /key' } });
    expect(port.calls.at(-1)?.env?.GIT_SSH_COMMAND).toBe('ssh -i /key');
  });

  it('секрет вызова (SSH-ключ) доходит до порта значением, а не путём к файлу', async () => {
    const port = new CapturingPort();
    const svc = new GitService(root, { execution: port });
    const secret: ExecSecret = {
      kind: 'ssh-key',
      privateKey: pem('key'),
      passphrase: 'pass',
    };

    await svc.isRepo(join(ws, 'repo'), { secrets: [secret] });

    const req = port.calls.at(-1);
    expect(req?.secrets).toHaveLength(1);
    expect(req?.secrets?.[0]?.kind).toBe('ssh-key');
    expect(req?.secrets?.[0]?.privateKey).toBe(secret.privateKey);
    expect(req?.secrets?.[0]?.passphrase).toBe('pass');
    // Секрет — значение, а не путь: пути в control plane на исполнителе нет.
    expect(JSON.stringify(req?.secrets)).not.toContain('synth-ssh-');
  });

  it('порт получает санитайзенное окружение (ambient GIT_*/EDITOR не протекают)', async () => {
    const saved: Record<string, string | undefined> = {
      EDITOR: process.env.EDITOR,
      GIT_PAGER: process.env.GIT_PAGER,
    };
    process.env.EDITOR = 'vim';
    process.env.GIT_PAGER = 'cat';
    try {
      const port = new CapturingPort();
      await new GitService(root, { execution: port }).isRepo(ws);
      const env = port.calls.at(-1)?.env;
      expect(env).not.toHaveProperty('EDITOR');
      expect(env).not.toHaveProperty('GIT_PAGER');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('sanitizeGitEnv вырезает git*-ключи и не-git blocklist, оставляя безопасные', () => {
    const sanitized = sanitizeGitEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      Editor: 'vim',
      PAGER: 'less',
      Prefix: '/opt/tools',
      SSH_ASKPASS: '/tmp/askpass',
      GIT_EDITOR: 'nano',
      GIT_PAGER: 'cat',
      GIT_SSH_COMMAND: 'ssh -i /nonexistent -o BatchMode=yes',
      GIT_ASKPASS: '/tmp/git-askpass',
      GIT_CONFIG_COUNT: '1',
      git_terminal_prompt: '1',
      UNSET_KEY: undefined,
    });

    expect(sanitized).toEqual({ PATH: '/usr/bin', HOME: '/home/user' });
  });

  it('git-вызов с env не падает, даже если process.env содержит blocklist-ключи (регресс ADR-076)', async () => {
    const saved: Record<string, string | undefined> = {
      EDITOR: process.env.EDITOR,
      PAGER: process.env.PAGER,
      GIT_PAGER: process.env.GIT_PAGER,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
    };
    process.env.EDITOR = 'vim';
    process.env.PAGER = 'less';
    process.env.GIT_PAGER = 'cat';
    process.env.GIT_SSH_COMMAND = 'ssh -i /nonexistent';
    try {
      // Ambient-значения не протекают в git: окружение собирается
      // `sanitizeGitEnv` + `GIT_TERMINAL_PROMPT=0` + явный `env` вызова.
      await service.initRepo(ws, 'repos/regress', 'main', {
        env: { GIT_SSH_COMMAND: 'ssh -i /nonexistent -o BatchMode=yes' },
      });
      expect(await exists(join(ws, 'repos', 'regress', '.git'))).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('resolveRepoPath отвергает traversal и абсолютные пути', () => {
    expect(resolveRepoPath(ws, 'repos/app')).toBe(join(ws, 'repos', 'app'));
    expect(thrownCode(() => resolveRepoPath(ws, '../escape'))).toBe('PATH_TRAVERSAL');
    expect(thrownCode(() => resolveRepoPath(ws, 'a/../../escape'))).toBe('PATH_TRAVERSAL');
    expect(thrownCode(() => resolveRepoPath(ws, '/etc/passwd'))).toBe('PATH_TRAVERSAL');
  });

  it('resolveRepoPath: несуществующий путь внутри workspace разрешён (initRepo-сценарий)', async () => {
    // Каталога ещё нет — проверяется ближайший существующий предок (workspace).
    expect(resolveRepoPath(ws, 'repos/brand/new')).toBe(join(ws, 'repos', 'brand', 'new'));

    await service.initRepo(ws, 'repos/brand/new', 'main');
    expect(await exists(join(ws, 'repos', 'brand', 'new', '.git'))).toBe(true);
    expect(resolveRepoPath(ws, 'repos/brand/new')).toBe(join(ws, 'repos', 'brand', 'new'));
  });

  it('resolveRepoPath: симлинк внутри workspace → наружу отклоняется (PATH_TRAVERSAL)', async () => {
    const outside = join(root, 'outside');
    await mkdir(join(outside, 'sub'), { recursive: true });
    await symlink(outside, join(ws, 'escape'));

    expect(thrownCode(() => resolveRepoPath(ws, 'escape'))).toBe('PATH_TRAVERSAL');
    // Та же цель через промежуточную компоненту: `link/sub` лексически внутри,
    // реально — снаружи.
    expect(thrownCode(() => resolveRepoPath(ws, 'escape/sub'))).toBe('PATH_TRAVERSAL');
    // Ещё не созданная цель под симлинком наружу — тоже отказ.
    expect(thrownCode(() => resolveRepoPath(ws, 'escape/new-repo'))).toBe('PATH_TRAVERSAL');
  });

  it('resolveRepoPath: симлинк в промежуточной компоненте → наружу отклоняется', async () => {
    const outside = join(root, 'outside');
    await mkdir(join(outside, 'nested'), { recursive: true });
    await symlink(outside, join(ws, 'link'));

    expect(thrownCode(() => resolveRepoPath(ws, 'link/nested'))).toBe('PATH_TRAVERSAL');
    expect(thrownCode(() => resolveRepoPath(ws, 'link/nested/deeper'))).toBe('PATH_TRAVERSAL');
  });

  it('resolveRepoPath: dangling-симлинк отклоняется (fail-closed)', async () => {
    await symlink(join(root, 'missing-target'), join(ws, 'dangling'));

    expect(thrownCode(() => resolveRepoPath(ws, 'dangling'))).toBe('PATH_TRAVERSAL');
    expect(thrownCode(() => resolveRepoPath(ws, 'dangling/sub'))).toBe('PATH_TRAVERSAL');
  });

  it('resolveRepoPath: симлинк, ведущий ВНУТРЬ workspace, разрешён (легитимный случай)', async () => {
    await mkdir(join(ws, 'repos', 'real'), { recursive: true });
    await symlink(join(ws, 'repos', 'real'), join(ws, 'alias'));

    // Возвращается лексический путь (адрес для git), а не realpath.
    expect(resolveRepoPath(ws, 'alias')).toBe(join(ws, 'alias'));
    expect(resolveRepoPath(ws, 'alias/file.txt')).toBe(join(ws, 'alias', 'file.txt'));
  });

  it('removeLocal не удаляет ничего за пределами workspace (симлинк наружу)', async () => {
    const outside = join(root, 'keep');
    await mkdir(outside, { recursive: true });
    const precious = join(outside, 'precious.txt');
    await writeFile(precious, 'must survive\n');
    await symlink(outside, join(ws, 'evil'));

    await expect(service.removeLocal(ws, 'evil')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
    // `rm -rf` не выполнен: внешний каталог и файл целы.
    expect(await exists(precious)).toBe(true);
    expect(await exists(join(ws, 'evil'))).toBe(true);
  });

  // TOCTOU-остаток: проверка и деструктивная операция разнесены во времени.
  // Статический кейс «компонента уже подменена симлинком до вызова» закрыт
  // каноническим адресом операции (`resolveOperationalRepoPath`) + перепроверкой
  // перед ФС; саму гонку (подмена строго между resolve и `rm`) юнит-тестом
  // детерминированно не воспроизвести без инъекции в fs/`openat`-семантики.
  it('removeLocal: подменённый родительский компонент (симлинк наружу) → отказ, снаружи цел', async () => {
    const outside = join(root, 'outside-repos');
    await mkdir(join(outside, 'app'), { recursive: true });
    const precious = join(outside, 'app', 'precious.txt');
    await writeFile(precious, 'must survive\n');
    await symlink(outside, join(ws, 'repos'));

    await expect(service.removeLocal(ws, 'repos/app')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
    expect(await exists(precious)).toBe(true);
    expect(await exists(join(outside, 'app'))).toBe(true);
  });

  it('initRepo: родительский компонент — симлинк наружу → отказ, снаружи ничего не создано', async () => {
    const outside = join(root, 'outside-init');
    await mkdir(outside, { recursive: true });
    const precious = join(outside, 'precious.txt');
    await writeFile(precious, 'must survive\n');
    await symlink(outside, join(ws, 'vendor'));

    await expect(service.initRepo(ws, 'vendor/new', 'main')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });
    expect(await exists(join(outside, 'new'))).toBe(false);
    expect(await exists(precious)).toBe(true);
    expect(await readdir(outside)).toEqual(['precious.txt']);
  });

  it('cloneRepo: родительский компонент — симлинк наружу → отказ, снаружи ничего не создано', async () => {
    const bare = await createBareRepo(root);
    const outside = join(root, 'outside-clone');
    await mkdir(outside, { recursive: true });
    const precious = join(outside, 'precious.txt');
    await writeFile(precious, 'must survive\n');
    await symlink(outside, join(ws, 'vendor'));

    await expect(service.cloneRepo(ws, 'vendor/app', `file://${bare}`)).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });
    expect(await exists(join(outside, 'app'))).toBe(false);
    expect(await exists(precious)).toBe(true);
    expect(await listTmpSiblings(outside)).toEqual([]);
  });

  it('cloneRepo: целью не может быть корень workspace (временный каталог не появляется рядом)', async () => {
    const bare = await createBareRepo(root);
    const before = (await readdir(root)).sort();

    await expect(service.cloneRepo(ws, '.', `file://${bare}`)).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });
    expect((await readdir(root)).sort()).toEqual(before);
  });

  it('операции по симлинку ВНУТРЬ workspace идут по разрешённому пути, а не по ссылке', async () => {
    const real = join(ws, 'real-repos');
    await mkdir(real, { recursive: true });
    await symlink(real, join(ws, 'alias'));

    // initRepo создаёт каталог в реальном месте.
    await service.initRepo(ws, 'alias/init', 'main');
    expect(await exists(join(real, 'init', '.git'))).toBe(true);

    // cloneRepo кладёт клон и `.tmp-*` к реальному родителю.
    const bare = await createBareRepo(root);
    await service.cloneRepo(ws, 'alias/clone', `file://${bare}`);
    expect(await exists(join(real, 'clone', 'README.md'))).toBe(true);
    expect(await listTmpSiblings(real)).toEqual([]);

    // removeLocal удаляет реальный каталог (по разрешённому пути), ссылка цела.
    await service.removeLocal(ws, 'alias/clone');
    expect(await exists(join(real, 'clone'))).toBe(false);
    expect(await exists(join(ws, 'alias'))).toBe(true);
  });

  it('removeLocal удаляет каталог, но отвергает traversal и корень workspace', async () => {
    const bare = await createBareRepo(root);
    await service.cloneRepo(ws, 'repos/app', `file://${bare}`);
    const target = join(ws, 'repos', 'app');
    expect(await exists(target)).toBe(true);

    await service.removeLocal(ws, 'repos/app');
    expect(await exists(target)).toBe(false);

    await expect(service.removeLocal(ws, '../outside')).rejects.toBeTruthy();
    await expect(service.removeLocal(ws, '')).rejects.toBeTruthy();
  });

  it('ADR-099: git-сервис с сконфигурированным CA работает (clone из file://)', async () => {
    await initTlsTrust({ security: { tls: { caFile: CERT_PATH } } }, {});
    try {
      const bare = await createBareRepo(root);
      await service.cloneRepo(ws, 'repos/ca', `file://${bare}`);
      expect(await exists(join(ws, 'repos', 'ca', 'README.md'))).toBe(true);
    } finally {
      _resetTlsTrustForTests();
      undici.setGlobalDispatcher(new undici.Agent());
    }
  });

  // Живая сетевая проверка (по умолчанию выключена): `SYNTH_TEST_NETWORK=1`
  // `pnpm --filter @itphx/synth-core test -- --run src/git/git-service.test.ts`.
  it.runIf(LIVE_NETWORK)('ADR-099 (live): ls-remote публичного репозитория с валидным CA', async () => {
    const refs = await git(ws, ['-c', `http.sslCAInfo=${SYSTEM_CA}`, 'ls-remote', 'https://github.com/octocat/Hello-World.git', 'HEAD']);
    expect(refs.trim().length).toBeGreaterThan(0);
  });
});
