import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as undici from 'undici';
import { GitService, resolveRepoPath, sanitizeGitEnv } from './git-service.js';
import { DEFAULT_MAX_OUTPUT_BYTES, type ExecRequest, type ExecutionPort } from '../execution/ports/index.js';
import { initTlsTrust, _resetTlsTrustForTests } from '../security/tls.js';

const execFileAsync = promisify(execFile);

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

/** Запуск git в тесте напрямую (без GitService) — подготовка репозиториев. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
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

  it('cloneRepo с веткой использует `clone --branch <branch>`', async () => {
    const bare = await createBareRepo(root);
    const port = new CapturingPort();
    const svc = new GitService(root, { execution: port });
    await svc.cloneRepo(ws, 'repos/branchy', `file://${bare}`, 'main');
    const args = port.calls.at(-1)?.command;
    expect(args).toMatchObject({ kind: 'argv', file: 'git' });
    if (args?.kind === 'argv') {
      expect(args.args?.slice(0, 5)).toEqual(['clone', '--branch', 'main', `file://${bare}`, join(ws, 'repos', 'branchy')]);
    }
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
