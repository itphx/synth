import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as undici from 'undici';
import { simpleGit } from 'simple-git';
import { GitService, resolveRepoPath, sanitizeGitEnv } from './git-service.js';
import { initTlsTrust, _resetTlsTrustForTests } from '../security/tls.js';

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

/** Создаёт bare-репозиторий (`git init --bare`) с одним коммитом в `main`. */
async function createBareRepo(base: string): Promise<string> {
  const bare = join(base, 'origin.git');
  const work = join(base, 'work');
  const g = simpleGit();
  await g.raw(['init', '--bare', '--initial-branch=main', bare]);
  await g.clone(bare, work);
  const wg = simpleGit(work);
  await wg.addConfig('user.email', 'test@example.com');
  await wg.addConfig('user.name', 'Test');
  await writeFile(join(work, 'README.md'), 'hello\n');
  await wg.add('.');
  await wg.commit('initial');
  await wg.push('origin', 'main');
  return bare;
}

describe('GitService (ADR-076 §T3)', () => {
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
    await rm(root, { recursive: true, force: true });
  });

  it('initRepo создаёт репозиторий, getRepoStatus/scanWorkspace его видят', async () => {
    await service.initRepo(ws, 'repos/app', 'main');
    const repoPath = join(ws, 'repos', 'app');
    expect(await exists(join(repoPath, '.git'))).toBe(true);

    // Коммит: пустой репозиторий не имеет HEAD (revparse падает) — как в backend.
    const g = simpleGit(repoPath);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await writeFile(join(repoPath, 'README.md'), 'hello\n');
    await g.add('.');
    await g.commit('initial');

    const status = await service.getRepoStatus(repoPath);
    expect(status?.isRepo).toBe(true);
    expect(status?.currentBranch).toBe('main');

    const scanned = await service.scanWorkspace(ws);
    expect(scanned.map((r) => r.path)).toContain('repos/app');
  });

  it('cloneRepo клонирует из локального bare-репозитория (file://)', async () => {
    const bare = await createBareRepo(root);
    const repo = await service.cloneRepo(ws, 'repos/clone', `file://${bare}`);
    expect(repo.path).toBe('repos/clone');
    expect(await exists(join(ws, 'repos', 'clone', 'README.md'))).toBe(true);

    const scanned = await service.scanWorkspace(ws);
    expect(scanned.find((r) => r.path === 'repos/clone')?.isRepo).toBe(true);
  });

  it('fetchRepo выполняет fetch без ошибок', async () => {
    const bare = await createBareRepo(root);
    await service.cloneRepo(ws, 'repos/app', `file://${bare}`);
    await expect(service.fetchRepo(ws, 'repos/app')).resolves.toBeUndefined();
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
      // До фикса полный process.env утекал в simple-git.env() и вызов падал
      // на blockUnsafeOperationsPlugin (`Use of "EDITOR" ...`).
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

  /**
   * ADR-099: живая проверка канала CA. Env-путь (`GIT_SSL_CAINFO`) сервису
   * закрыт (sanitizeGitEnv + allowEnvironment-guard), поэтому CA передаётся
   * пер-вызовом через опцию `config` инстанса simple-git. Здесь проверяем, что
   * такой `-c http.sslCAInfo=<path>` реально доезжает до git и им принимается.
   */
  it('ADR-099: config-опция simple-git доезжает до git (http.sslCAInfo принимается)', async () => {
    const bare = await createBareRepo(root);
    const g = simpleGit({ config: [`http.sslCAInfo=${CERT_PATH}`] });
    const refs = await g.listRemote([bare]);
    expect(refs).toContain('refs/heads/main');
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
    const g = simpleGit({ config: [`http.sslCAInfo=${SYSTEM_CA}`] });
    const refs = await g.listRemote(['https://github.com/octocat/Hello-World.git', 'HEAD']);
    expect(refs.trim().length).toBeGreaterThan(0);
  });
});
