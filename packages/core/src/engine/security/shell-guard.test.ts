import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tokenizeCommand,
  splitShellSegments,
  extractCommandPaths,
  isMutatingCommand,
  checkShellCommand,
  matchShellCommandPattern,
  shellSavePatterns,
  shellGrantPlan,
  isShellCommandGranted,
} from './shell-guard.js';
import type { ShellPolicy } from './shell-guard.js';

const HOME = process.env.HOME || '/root';

/** Политика для unit-тестов (не зависит от файлов на диске). */
const TEST_POLICY: ShellPolicy = {
  deniedPaths: [
    '~/.ssh/authorized_keys',
    '~/.ssh/id_rsa',
    '~/.ssh/id_ed25519',
    '~/.git-credentials',
    '/etc/sudoers',
    '/etc/passwd',
    '/etc/shadow',
  ],
  deniedPrefixes: ['~/.ssh', '~/.aws', '~/.gnupg', '/etc/sudoers.d'],
  approvalPaths: ['~/.ssh/config'],
  deniedCommandPrefixes: [
    'rm -rf /',
    'chmod -R 777 /',
    'sudo rm -rf /',
    'find / -delete',
    'find / -exec',
    ':(){ :|:& };:',
  ],
};

function extractedPaths(tokens: string[], cwd: string) {
  return extractCommandPaths(tokens, cwd).map((p) => ({ ...p, path: p.path.replace(HOME, '~') }));
}

describe('tokenizeCommand', () => {
  it('разделяет по пробелам', () => {
    expect(tokenizeCommand('ls -la /tmp')).toEqual(['ls', '-la', '/tmp']);
  });

  it('одинарные кавычки сохраняют содержимое как один токен', () => {
    expect(tokenizeCommand("echo 'hello world'")).toEqual(['echo', 'hello world']);
    expect(tokenizeCommand("cat '~/.ssh/id_rsa'")).toEqual(['cat', '~/.ssh/id_rsa']);
  });

  it('двойные кавычки сохраняют содержимое как один токен', () => {
    expect(tokenizeCommand('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('экранирование backslash вне кавычек', () => {
    expect(tokenizeCommand('cat my\\ file.txt')).toEqual(['cat', 'my file.txt']);
  });

  it('перенаправления — отдельные токены вне кавычек', () => {
    expect(tokenizeCommand('echo x>/tmp/y')).toEqual(['echo', 'x', '>', '/tmp/y']);
    expect(tokenizeCommand("echo 'a>b'")).toEqual(['echo', 'a>b']);
  });

  it('пустая строка — пустой массив', () => {
    expect(tokenizeCommand('')).toEqual([]);
    expect(tokenizeCommand('   ')).toEqual([]);
  });
});

describe('splitShellSegments', () => {
  it('режет по разделителям вне кавычек', () => {
    expect(splitShellSegments('a; b && c || d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('не режет внутри кавычек и $(...)', () => {
    expect(splitShellSegments("echo 'a;b'")).toEqual(["echo 'a;b'"]);
    expect(splitShellSegments('echo $(a; b)')).toEqual(['echo $(a; b)']);
  });

  it('не режет &/| внутри операторов перенаправления', () => {
    expect(splitShellSegments('echo x &>/tmp/y')).toEqual(['echo x &>/tmp/y']);
    expect(splitShellSegments('echo x 2>&1')).toEqual(['echo x 2>&1']);
  });
});

describe('extractCommandPaths', () => {
  const CWD = '/workspace/project';

  it('резолвит ~, $HOME, $PWD и относительные пути', () => {
    expect(extractedPaths(['cat', '~/.git-credentials'], CWD))
      .toEqual([{ path: '~/.git-credentials', source: 'literal' }]);
    expect(extractedPaths(['cat', '$HOME/.ssh/id_rsa'], CWD))
      .toEqual([{ path: '~/.ssh/id_rsa', source: 'literal' }]);
    expect(extractedPaths(['ls', '$PWD/foo'], CWD))
      .toEqual([{ path: '/workspace/project/foo', source: 'literal' }]);
    expect(extractedPaths(['cat', 'src/file.ts'], CWD))
      .toEqual([{ path: '/workspace/project/src/file.ts', source: 'literal' }]);
  });

  it('абсолютный путь остаётся как есть, флаги пропускаются, -- включает операнды', () => {
    expect(extractedPaths(['cat', '/etc/passwd'], CWD))
      .toEqual([{ path: '/etc/passwd', source: 'literal' }]);
    expect(extractedPaths(['ls', '-la', '/tmp', '--', '-weird'], CWD)).toEqual([
      { path: '/tmp', source: 'literal' },
      { path: '/workspace/project/-weird', source: 'literal' },
    ]);
  });

  it('динамика → unknown', () => {
    expect(extractedPaths(['cat', '$USER/.ssh/id_rsa'], CWD)[0]?.source).toBe('unknown');
    expect(extractedPaths(['cat', '*.log'], CWD)[0]?.source).toBe('unknown');
    expect(extractedPaths(['cat', '$(pwd)/x'], CWD)[0]?.source).toBe('unknown');
    expect(extractedPaths(['cat', '`ls`/x'], CWD)[0]?.source).toBe('unknown');
  });

  it('без аргументов-путей — пустой результат', () => {
    expect(extractedPaths(['ls'], CWD)).toEqual([]);
    expect(extractedPaths(['echo'], CWD)).toEqual([]);
  });

  it('цель слитного перенаправления — тоже путь', () => {
    const res = extractedPaths(['echo', 'x', '2>/tmp/log'], CWD);
    expect(res.some((p) => p.path === '/tmp/log')).toBe(true);
  });
});

describe('isMutatingCommand', () => {
  const mut = (cmd: string) => isMutatingCommand(tokenizeCommand(cmd), cmd);

  it('мутирующие файловые команды', () => {
    for (const cmd of ['rm x', 'mv a b', 'cp a b', 'mkdir d', 'touch f', 'chmod 600 f', 'tee out']) {
      expect(mut(cmd), cmd).toBe(true);
    }
  });

  it('read-only команды', () => {
    for (const cmd of ['ls -la', 'cat f', 'pwd', 'echo hi', 'grep -v x f', 'head -5 f', 'wc -l f']) {
      expect(mut(cmd), cmd).toBe(false);
    }
  });

  it('git: write-подкоманды мутирующие, read-only — нет', () => {
    expect(mut('git commit -m x')).toBe(true);
    expect(mut('git push')).toBe(true);
    expect(mut('git status')).toBe(false);
    expect(mut('git diff')).toBe(false);
  });

  it('перенаправления и пайпы', () => {
    expect(mut('echo x > f')).toBe(true);
    expect(mut('echo x >> f')).toBe(true);
    expect(mut('cat a | rm b')).toBe(true);
    expect(mut('cat a | head')).toBe(false);
  });

  it('менеджеры пакетов и curl/wget', () => {
    expect(mut('npm install x')).toBe(true);
    expect(mut('pip3 install x')).toBe(true);
    expect(mut('curl -s url')).toBe(false);
    expect(mut('curl -o f url')).toBe(true);
    expect(mut('wget -O f url')).toBe(true);
  });

  it('sed: -n read-only, остальное мутирующее', () => {
    expect(mut("sed -n '1,5p' f")).toBe(false);
    expect(mut("sed -i 's/a/b/' f")).toBe(true);
  });

  it('оболочки/eval мутирующие (код не разбирается)', () => {
    expect(mut("sh -c 'ls'")).toBe(true);
    expect(mut("eval 'ls'")).toBe(true);
    expect(mut('sudo rm -rf x')).toBe(true);
  });

  it('find: -delete/-exec мутирующие', () => {
    expect(mut('find . -name x')).toBe(false);
    expect(mut('find . -delete')).toBe(true);
  });
});

describe('checkShellCommand — явные правила', () => {
  let root: string;
  let scripts: string;
  let outside: string;
  let fileYml: string;

  const check = (cmd: string, cwd = root, policy: ShellPolicy = TEST_POLICY) =>
    checkShellCommand(cmd, cwd, policy);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-shell-ws-'));
    scripts = join(root, 'scripts');
    outside = await mkdtemp(join(tmpdir(), 'synth-shell-out-'));
    fileYml = join(root, 'file.yml');
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'a.sh'), 'echo a\n');
    await writeFile(join(scripts, 'b.sh'), 'echo b\n');
    await writeFile(fileYml, 'image: x\n');
    await writeFile(join(root, 'notes.txt'), 'hello\n');
    await writeFile(join(outside, 'ext.txt'), 'x\n');
    await writeFile(join(outside, 'ext.js'), 'x\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  // --- protected paths -----------------------------------------------------

  it('protected: cat ~/.ssh/id_rsa → deny', () => {
    const r = check('cat ~/.ssh/id_rsa');
    expect(r.action).toBe('deny');
    expect(r.matchedRule).toBe('shell-policy.deny');
    expect(r.deniedPath).toContain('.ssh/id_rsa');
  });

  it('protected: cat $HOME/.ssh/id_rsa → deny', () => {
    expect(check('cat $HOME/.ssh/id_rsa').action).toBe('deny');
  });

  it('protected: cat /etc/passwd → deny', () => {
    expect(check('cat /etc/passwd').action).toBe('deny');
  });

  it('protected: точный путь и префикс директории', () => {
    expect(check('cat ~/.aws/credentials').action).toBe('deny');
    expect(check('cat /etc/sudoers.d/foo').action).toBe('deny');
  });

  it('protected: approvalPaths ~/.ssh/config → ask (до префикса ~/.ssh)', () => {
    const r = check('cat ~/.ssh/config');
    expect(r.action).toBe('ask');
    expect(r.askKind).toBe('protected');
    expect(r.matchedRule).toBe('shell-policy.approve');
  });

  it('protected: защищённый путь в любом сегменте — deny', () => {
    expect(check('echo x; cat /etc/passwd').action).toBe('deny');
    expect(check('echo x && cat /etc/passwd').action).toBe('deny');
  });

  // --- deniedCommandPrefixes ----------------------------------------------

  it('prefixes: rm -rf / и find / -delete → deny', () => {
    expect(check('rm -rf /').action).toBe('deny');
    expect(check('find / -delete').action).toBe('deny');
    expect(check('chmod -R 777 /').action).toBe('deny');
    expect(check(':(){ :|:& };:').action).toBe('deny');
  });

  it('prefixes: другой путь не денется по префиксу', () => {
    expect(check(`rm -rf ${root}/x`).action).toBe('allow');
    expect(check('rm -rf /srv/data').action).toBe('ask');
    expect(check('rm -rf').action).toBe('allow');
  });

  // --- external_directory --------------------------------------------------

  it('external: существующий путь вне периметра → ask external', () => {
    const r = check('cat /etc/hostname');
    expect(r.action).toBe('ask');
    expect(r.askKind).toBe('external');
    expect(r.messageId).toBe('ask-external-directory');
    expect(r.askPaths).toEqual(['/etc/hostname']);
  });

  it('external: файл вне периметра → ask, внутри → allow', () => {
    expect(check(`cat ${join(outside, 'ext.txt')}`).action).toBe('ask');
    expect(check(`cat ${join(root, 'notes.txt')}`).action).toBe('allow');
    expect(check('cat notes.txt').action).toBe('allow');
  });

  it('external: несуществующий путь вне периметра не спрашивается', () => {
    expect(check('cat /no/such/file.txt').action).toBe('allow');
  });

  it('external: cd-цель вне периметра → ask', () => {
    const r = check('cd /tmp && cat x');
    expect(r.action).toBe('ask');
    expect(r.askKind).toBe('external');
    expect(r.askPaths?.[0]).toBe('/tmp');
  });

  it('external: cd внутри периметра меняет cwd для следующих сегментов', () => {
    expect(check('cd scripts && cat a.sh').action).toBe('allow');
    expect(check('cd scripts && cat /etc/hostname').action).toBe('ask');
  });

  it('external: цель редиректа — всегда путь', () => {
    expect(check('echo hi > out.txt').action).toBe('allow');
    expect(check('echo hi > /etc/synth-new-file').action).toBe('ask');
    expect(check('echo hi > /etc/passwd').action).toBe('deny');
  });

  it('external: исключения периметра не спрашиваются', () => {
    expect(check('echo hi > /dev/null').action).toBe('allow');
  });

  it('external: не-флаговый операнд команды-писателя проверяется, даже если файла нет', () => {
    expect(check('cp file /etc/cron.d/x').action).toBe('ask');
    expect(check('mkdir -p build/out').action).toBe('allow');
    expect(check('rm -f /tmp/synth-new-file').action).toBe('ask');
  });

  // --- glob ----------------------------------------------------------------

  it('glob внутри периметра — allow (совпадения проверяются)', () => {
    expect(check('cat scripts/*.sh').action).toBe('allow');
    expect(check('for f in scripts/*.sh; do bash -n "$f"; done').action).toBe('allow');
  });

  it('glob защищённого каталога — deny (каталог политики)', () => {
    expect(check('cat ~/.ssh/*').action).toBe('deny');
    expect(check('cat ~/.aws/*').action).toBe('deny');
  });

  it('glob вне периметра — ask с askPaths (все совпадения)', () => {
    const r = check(`ls ${outside}/*.js`);
    expect(r.action).toBe('ask');
    expect(r.askKind).toBe('external');
    expect(r.askPaths).toEqual([join(outside, 'ext.js')]);
  });

  it('glob без совпадений/каталога — не проверяется', () => {
    expect(check('cat scripts/*.nomatch').action).toBe('allow');
    expect(check('cat no-such-dir/*.sh').action).toBe('allow');
  });

  // --- принятые риски -----------------------------------------------------

  it('риск: обёртка не разбирается, но литеральный путь-токен проверяется', () => {
    // путь внутри quoted-токена (код для sh) — не путь: не проверяется
    expect(check("sh -c 'cat ~/.ssh/id_rsa'").action).toBe('allow');
    // а вот литеральный токен-путь виден guard'у независимо от обёртки
    expect(check('sudo -u root cat ~/.ssh/id_rsa').action).toBe('deny');
  });

  it('риск: неизвестная переменная/подстановка/backtick не проверяются', () => {
    expect(check('cat $SECRET').action).toBe('allow');
    expect(check('cat $(ls ~/.ssh)').action).toBe('allow');
    expect(check('cat `pwd`/.ssh/id_rsa').action).toBe('allow');
    expect(check('echo $(cat /etc/passwd)').action).toBe('allow');
  });

  it('риск: программы awk/sed не анализируются', () => {
    expect(check('awk \'/^[a-zA-Z]/ { sect = $0; sub(/\\\\//, "", sect); next } { print $2 }\' file.yml').action)
      .toBe('allow');
    expect(check("sed -n '/^image/s/.*//p' file.yml").action).toBe('allow');
    expect(check("sed -i 's/a/b/' file.yml").action).toBe('allow');
    // find-программа не анализируется, но стартовый путь `/` — литеральный
    // токен-путь вне периметра: external ask (не «анализ команды»).
    expect(check('find / -name passwd').action).toBe('ask');
    expect(check('find . -name passwd').action).toBe('allow');
  });

  it('известные переменные резолвятся ($SYNTH_DATA_DIR → deny защищённого префикса)', () => {
    const dataDir = join(outside, 'data');
    const policy: ShellPolicy = {
      ...TEST_POLICY,
      dataDir,
      deniedPrefixes: [...TEST_POLICY.deniedPrefixes, join(dataDir, 'secrets')],
    };
    expect(check('cat $SYNTH_DATA_DIR/secrets/master.key', root, policy).action).toBe('deny');
    expect(check('cat ${SYNTH_DATA_DIR}/secrets/master.key', root, policy).action).toBe('deny');
  });

  it('рутинные команды остаются allow', () => {
    expect(check('ls -la').action).toBe('allow');
    expect(check('npm test').action).toBe('allow');
    expect(check('git status').action).toBe('allow');
    expect(check('cat src/main.ts').action).toBe('allow');
    expect(check('echo "=== diff vs origin/master ==="').action).toBe('allow');
  });

  it('пустая политика: защищённых путей нет, но периметр действует', () => {
    const empty: ShellPolicy = {
      deniedPaths: [], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [],
    };
    expect(check(`cat ${join(root, 'notes.txt')}`, root, empty).action).toBe('allow');
    expect(check(`cat ${join(outside, 'ext.txt')}`, root, empty).action).toBe('ask');
    expect(check(`cat ${join(outside, 'ext.txt')}`, root, empty).askKind).toBe('external');
  });

  it('deny приоритетнее ask (по сегментам)', () => {
    expect(check(`cat ${join(outside, 'ext.txt')}; cat /etc/passwd`).action).toBe('deny');
  });
});

describe('checkShellCommand — симлинки', () => {
  let root: string;
  let secrets: string;
  let policy: ShellPolicy;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-shell-link-'));
    secrets = join(root, 'protected-dir');
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, 'master.key'), 'secret\n');
    await writeFile(join(root, 'plain.txt'), 'plain\n');
    policy = {
      ...TEST_POLICY,
      deniedPrefixes: [...TEST_POLICY.deniedPrefixes, secrets],
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('симлинк-каталог на защищённый путь → deny', async () => {
    await symlink(secrets, join(root, 'link-dir'));
    expect(checkShellCommand('cat link-dir/master.key', root, policy).action).toBe('deny');
  });

  it('симлинк-файл на защищённый путь → deny', async () => {
    await symlink(join(secrets, 'master.key'), join(root, 'link-file'));
    expect(checkShellCommand('cat link-file', root, policy).action).toBe('deny');
  });

  it('симлинк на незащищённый путь → allow', async () => {
    await symlink(join(root, 'plain.txt'), join(root, 'link-plain'));
    expect(checkShellCommand('cat link-plain', root, policy).action).toBe('allow');
  });

  it('glob через симлинк наружу → deny (совпадение — защищённый путь)', async () => {
    await symlink(secrets, join(root, 'link-dir'));
    expect(checkShellCommand('cat link-dir/*', root, policy).action).toBe('deny');
  });
});

describe('matchShellCommandPattern', () => {
  it('"*" матчит любую команду', () => {
    expect(matchShellCommandPattern('*', 'anything at all')).toBe(true);
  });

  it('префиксный паттерн', () => {
    expect(matchShellCommandPattern('npm install *', 'npm install x')).toBe(true);
    expect(matchShellCommandPattern('npm install *', 'npm run build')).toBe(false);
    expect(matchShellCommandPattern('git commit *', 'git commit -m "x"')).toBe(true);
  });

  it('точное совпадение без glob', () => {
    expect(matchShellCommandPattern('ls -la', 'ls -la')).toBe(true);
    expect(matchShellCommandPattern('ls -la', 'ls -l')).toBe(false);
  });

  it('fallback на globMatch', () => {
    expect(matchShellCommandPattern('ls *', 'ls -la')).toBe(true);
  });
});

describe('shellSavePatterns / isShellCommandGranted', () => {
  it('паттерны команды: команда + подкоманда', () => {
    expect(shellSavePatterns('git status')).toEqual(['git status *']);
    expect(shellSavePatterns('ls -la')).toEqual(['ls *']);
  });

  it('for-заголовок паттерн не даёт; тело цикла — даёт', () => {
    expect(shellSavePatterns('for f in a b; do echo $f; done')).toEqual(['echo *']);
  });

  it('смешанная команда: cd/grep/wc/ls', () => {
    expect(shellSavePatterns('cd sub && grep -l x *.js | wc -l; ls'))
      .toEqual(['cd *', 'grep *', 'wc *', 'ls *']);
  });

  it('нерезолвимое имя команды → null (грант не выдаётся)', () => {
    expect(shellSavePatterns('$CMD --version')).toBeNull();
    expect(shellSavePatterns('for t in a b; do "$t" --version; done')).toBeNull();
  });

  it('heredoc: shebang, комментарии и делимитер — не команды', () => {
    const command = '#!/bin/bash\n# comment\ncat <<EOF\ntext\nEOF\nls -la';
    expect(shellSavePatterns(command)).toEqual(['cat *', 'ls *']);
  });

  it('дедуп и потолок 20 паттернов', () => {
    expect(shellSavePatterns('ls; ls; ls')).toEqual(['ls *']);
    const many = Array.from({ length: 25 }, (_, i) => `cmd${i} x`).join('; ');
    expect(shellSavePatterns(many)).toHaveLength(20);
  });

  it('isShellCommandGranted: покрытие каждого сегмента', () => {
    const rules = { execute_shell: { 'ls *': 'allow', 'cat *': 'allow' } } as const;
    expect(isShellCommandGranted('ls -la', rules)).toBe(true);
    expect(isShellCommandGranted('ls -la; cat x', rules)).toBe(true);
    expect(isShellCommandGranted('ls -la; rm x', rules)).toBe(false);
    expect(isShellCommandGranted('$CMD', rules)).toBe(false);
  });

  it('строковый allow покрывает всё', () => {
    expect(isShellCommandGranted('rm -rf x', { execute_shell: 'allow' })).toBe(true);
    expect(isShellCommandGranted('rm -rf x', {})).toBe(false);
  });
});

describe('shellGrantPlan — грант по виновнику', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-grant-'));
    await writeFile(join(root, 'a.js'), 'x');
    await mkdir(join(root, 'sub'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('dynamic: каталог виновника, паттернов нет: каталог виновника, паттернов нет', () => {
    const plan = shellGrantPlan('grep -l x *.js | head', { askKind: 'dynamic', params: { path: '*.js' } }, { cwd: root });
    expect(plan.patterns).toEqual([]);
    expect(plan.directories).toEqual([root]);
  });

  it('относительный каталог токена: dir/*.js → абсолютный dir', () => {
    const plan = shellGrantPlan('cat sub/*.js', { askKind: 'dynamic', params: { path: 'sub/*.js' } }, { cwd: root });
    expect(plan.directories).toEqual([join(root, 'sub')]);
  });

  it('cd меняет базу для bare-glob', () => {
    const plan = shellGrantPlan('cd sub; cat *.js', { askKind: 'dynamic', params: { path: '*.js' } }, { cwd: root });
    expect(plan.directories).toEqual([join(root, 'sub')]);
  });

  it('динамика в токене-виновнике: каталог не определяется', () => {
    const plan = shellGrantPlan('cat $X/*.js', { askKind: 'dynamic', params: { path: '$X/*.js' } }, { cwd: root });
    expect(plan.directories).toEqual([]);
  });

  it('external: каталог из askPaths (файл → dirname)', () => {
    const plan = shellGrantPlan('cat /tmp/x/y.txt', {
      askKind: 'external',
      params: { path: '/tmp/x/y.txt' },
      paths: ['/tmp/x/y.txt'],
    }, { cwd: root });
    expect(plan.patterns).toEqual([]);
    expect(plan.directories).toEqual(['/tmp/x']);
  });

  it('protected/mutation/cwd — грант не предлагается', () => {
    for (const askKind of ['protected', 'mutation', 'cwd'] as const) {
      const plan = shellGrantPlan('cat ~/.ssh/config', { askKind, params: { path: '~/.ssh/config' } }, { cwd: root });
      expect(plan.patterns).toEqual([]);
      expect(plan.directories).toEqual([]);
    }
  });

  it('без trigger: командных паттернов/каталогов нет, команды показаны', () => {
    const plan = shellGrantPlan('cat a.js; ls', undefined, { cwd: root });
    expect(plan.commands).toEqual(['cat a.js', 'ls']);
    expect(plan.patterns).toEqual([]);
    expect(plan.directories).toEqual([]);
  });
});
