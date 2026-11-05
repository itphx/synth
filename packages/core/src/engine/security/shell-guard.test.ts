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
  looksLikePathToken,
  isPathLikeTarget,
  loadShellPolicy,
  clearShellPolicyCache,
  matchShellCommandPattern,
} from './shell-guard.js';
import type { ShellPolicy } from './shell-guard.js';

const CWD = '/workspace/project';
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

function extractedPaths(tokens: string[], cwd = CWD) {
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
    expect(tokenizeCommand('echo "a b c"')).toEqual(['echo', 'a b c']);
  });

  it('экранирование backslash вне кавычек', () => {
    expect(tokenizeCommand('echo foo\\ bar')).toEqual(['echo', 'foo bar']);
  });

  it('перенаправления — отдельные токены вне кавычек', () => {
    expect(tokenizeCommand('echo a > f')).toEqual(['echo', 'a', '>', 'f']);
    expect(tokenizeCommand('echo "a > f"')).toEqual(['echo', 'a > f']);
  });

  it('пустая строка — пустой массив', () => {
    expect(tokenizeCommand('')).toEqual([]);
    expect(tokenizeCommand('   ')).toEqual([]);
  });

  it('незакрытая кавычка дочитывается до конца', () => {
    expect(tokenizeCommand('echo "abc')).toEqual(['echo', 'abc']);
  });
});

describe('extractCommandPaths', () => {
  it('резолвит ~ в домашний каталог', () => {
    const res = extractedPaths(['cat', '~/.git-credentials']);
    expect(res).toEqual([{ path: '~/.git-credentials', source: 'literal' }]);
  });

  it('резолвит $HOME в начале токена', () => {
    const res = extractedPaths(['cat', '$HOME/.ssh/id_rsa']);
    expect(res).toEqual([{ path: '~/.ssh/id_rsa', source: 'literal' }]);
  });

  it('резолвит $PWD в cwd', () => {
    const res = extractedPaths(['ls', '$PWD/foo']);
    expect(res).toEqual([{ path: '/workspace/project/foo', source: 'literal' }]);
  });

  it('резолвит относительные пути от cwd', () => {
    const res = extractedPaths(['cat', 'src/file.ts']);
    expect(res).toEqual([{ path: '/workspace/project/src/file.ts', source: 'literal' }]);
  });

  it('абсолютный путь остаётся как есть', () => {
    const res = extractedPaths(['cat', '/etc/passwd']);
    expect(res).toEqual([{ path: '/etc/passwd', source: 'literal' }]);
  });

  it('флаги пропускаются, -- включает последующие токены', () => {
    const res = extractedPaths(['ls', '-la', '/tmp', '--', '-weird']);
    expect(res).toEqual([
      { path: '/tmp', source: 'literal' },
      { path: '/workspace/project/-weird', source: 'literal' },
    ]);
  });

  it('динамика → unknown: переменная, glob, подстановка, backtick', () => {
    expect(extractedPaths(['cat', '$USER/.ssh/id_rsa'])[0]?.source).toBe('unknown');
    expect(extractedPaths(['cat', '*.log'])[0]?.source).toBe('unknown');
    expect(extractedPaths(['cat', '$(pwd)/x'])[0]?.source).toBe('unknown');
    expect(extractedPaths(['cat', '`ls`/x'])[0]?.source).toBe('unknown');
    expect(extractedPaths(['cat', '/tmp/file?.txt'])[0]?.source).toBe('unknown');
  });

  it('без аргументов-путей — пустой результат', () => {
    expect(extractedPaths(['ls'])).toEqual([]);
    expect(extractedPaths(['echo'])).toEqual([]);
  });

  it('экранированный пробел: путь определяется через tryResolvePath (литерал), а не эвристикой', () => {
    // `cat my\ file.txt` — токенизатор снимает экранирование, токен литеральный.
    expect(tokenizeCommand('cat my\\ file.txt')).toEqual(['cat', 'my file.txt']);
    expect(extractedPaths(['cat', 'my file.txt'])).toEqual([
      { path: '/workspace/project/my file.txt', source: 'literal' },
    ]);
    // литеральный токен со обратным слэшем внутри одинарных кавычек — тоже литерал
    expect(extractedPaths(['cat', 'dir\\file.txt'])[0]?.source).toBe('literal');
  });
});

describe('looksLikePathToken', () => {
  it('Windows-пути распознаются явно (drive-absolute и UNC)', () => {
    expect(looksLikePathToken('C:\\Windows\\x')).toBe(true);
    expect(looksLikePathToken('c:/Windows/x')).toBe(true);
    expect(looksLikePathToken('\\\\srv\\share')).toBe(true);
    expect(looksLikePathToken('C:\\Windows\\$x')).toBe(true);
  });

  it('обратный слэш сам по себе — не разделитель (экранирование/регэксп)', () => {
    expect(looksLikePathToken('\\.sample$')).toBe(false);
    expect(looksLikePathToken('^\\s*Test')).toBe(false);
    expect(looksLikePathToken('FAIL\\|Failed')).toBe(false);
  });

  it('законные случаи по-прежнему пути', () => {
    expect(looksLikePathToken('~/.ssh')).toBe(true);
    expect(looksLikePathToken('/etc/passwd')).toBe(true);
    expect(looksLikePathToken('./x')).toBe(true);
    expect(looksLikePathToken('../x')).toBe(true);
    expect(looksLikePathToken('$VAR/secrets')).toBe(true);
    expect(looksLikePathToken('$HOME')).toBe(true);
    expect(looksLikePathToken('foo/bar')).toBe(true);
  });

  it('рутина не считается путём: glob без разделителей, URL, короткие флаги', () => {
    expect(looksLikePathToken('*.key')).toBe(false);
    expect(looksLikePathToken('https://example.com/x')).toBe(false);
    expect(looksLikePathToken('-')).toBe(false);
    expect(looksLikePathToken('')).toBe(false);
  });
});

describe('isPathLikeTarget — строгий критерий «путь» для fail-closed ask', () => {
  it('начинается как путь → цель-путь', () => {
    expect(isPathLikeTarget('/etc/passwd')).toBe(true);
    expect(isPathLikeTarget('/proc/$p/comm')).toBe(true);
    expect(isPathLikeTarget('~/.ssh')).toBe(true);
    expect(isPathLikeTarget('./x')).toBe(true);
    expect(isPathLikeTarget('../x')).toBe(true);
    expect(isPathLikeTarget('a/../b')).toBe(true);
    expect(isPathLikeTarget('C:\\Windows\\x')).toBe(true);
    expect(isPathLikeTarget('c:/Windows/x')).toBe(true);
    expect(isPathLikeTarget('\\\\srv\\share')).toBe(true);
  });

  it('переменная в начале → цель-путь ($VAR, ${VAR}, $VAR/...)', () => {
    expect(isPathLikeTarget('$X')).toBe(true);
    expect(isPathLikeTarget('${X}')).toBe(true);
    expect(isPathLikeTarget('$X/file')).toBe(true);
    expect(isPathLikeTarget('${X}/file')).toBe(true);
    // не путь: переменная с хвостом-текстом (`$p:` — echo-текст, `${X}.json` — имя)
    expect(isPathLikeTarget('$p:')).toBe(false);
    expect(isPathLikeTarget('${X}.json')).toBe(false);
  });

  it('glob с разделителем — цель-путь (может раскрыться в защищённый)', () => {
    expect(isPathLikeTarget('packages/*/package.json')).toBe(true);
    expect(isPathLikeTarget('*/x')).toBe(true);
    expect(isPathLikeTarget('src/**/*.ts')).toBe(true);
    // glob без разделителей — рутина
    expect(isPathLikeTarget('*.ts')).toBe(false);
  });

  it('текст в кавычках и URL — не путь', () => {
    expect(isPathLikeTarget('=== diff vs origin/master (stat tail) ===')).toBe(false);
    expect(isPathLikeTarget("console.log(require('zod/package.json').version)")).toBe(false);
    expect(isPathLikeTarget('a/b')).toBe(false);
    expect(isPathLikeTarget('origin/master')).toBe(false);
    expect(isPathLikeTarget('https://example.com/x')).toBe(false);
    expect(isPathLikeTarget('my file.txt')).toBe(false);
    expect(isPathLikeTarget('')).toBe(false);
    expect(isPathLikeTarget('-')).toBe(false);
  });
});

describe('isMutatingCommand', () => {
  const mut = (cmd: string) => isMutatingCommand(tokenizeCommand(cmd), cmd);

  it('мутирующие файловые команды', () => {
    expect(mut('rm -rf x')).toBe(true);
    expect(mut('mv a b')).toBe(true);
    expect(mut('cp a b')).toBe(true);
    expect(mut('mkdir -p x')).toBe(true);
    expect(mut('chmod +x f')).toBe(true);
    expect(mut('tee out.txt')).toBe(true);
  });

  it('read-only команды', () => {
    expect(mut('ls')).toBe(false);
    expect(mut('cat file')).toBe(false);
    expect(mut('pwd')).toBe(false);
    expect(mut('echo hello')).toBe(false);
    expect(mut('grep x file')).toBe(false);
    expect(mut('head -5 file')).toBe(false);
    expect(mut('which node')).toBe(false);
    expect(mut('date')).toBe(false);
  });

  it('git: write-подкоманды мутирующие, read-only — нет', () => {
    expect(mut('git status')).toBe(false);
    expect(mut('git diff')).toBe(false);
    expect(mut('git log')).toBe(false);
    expect(mut('git show')).toBe(false);
    expect(mut('git blame')).toBe(false);
    expect(mut('git branch')).toBe(false);
    expect(mut('git commit -m x')).toBe(true);
    expect(mut('git push')).toBe(true);
    expect(mut('git pull')).toBe(true);
    expect(mut('git checkout main')).toBe(true);
    expect(mut('git reset --hard')).toBe(true);
    expect(mut('git stash push')).toBe(true);
    expect(mut('git merge feature')).toBe(true);
  });

  it('перенаправления делают команду мутирующей', () => {
    expect(mut('echo a > f')).toBe(true);
    expect(mut('echo a >> f')).toBe(true);
    expect(mut('echo "a > f"')).toBe(false);
  });

  it('пайпы: мутирующий сегмент делает всю команду мутирующей', () => {
    expect(mut('cat a | grep x')).toBe(false);
    expect(mut('cat a | tee out')).toBe(true);
    expect(mut('echo x | rm -rf tmp')).toBe(true);
  });

  it('менеджеры пакетов мутирующие', () => {
    expect(mut('npm install express')).toBe(true);
    expect(mut('pnpm add lodash')).toBe(true);
    expect(mut('apt-get update')).toBe(true);
    expect(mut('pip install flask')).toBe(true);
  });

  it('curl/wget: только с write-флагами', () => {
    expect(mut('curl -s https://example.com')).toBe(false);
    expect(mut('curl -o out.json https://example.com')).toBe(true);
    expect(mut('curl --output-dir /tmp -O https://x')).toBe(true);
    expect(mut('wget https://example.com/f')).toBe(false);
    expect(mut('wget -O f https://example.com/f')).toBe(true);
  });

  it('sed: -n read-only, остальное мутирующее', () => {
    expect(mut("sed -n '1p' file")).toBe(false);
    expect(mut("sed 's/a/b/' file")).toBe(true);
    expect(mut("sed -i 's/a/b/' file")).toBe(true);
  });

  it('cat ~/.git-credentials — read-only (это денлист, не мутация)', () => {
    expect(mut('cat ~/.git-credentials')).toBe(false);
  });
});

describe('checkShellCommand', () => {
  const check = (cmd: string, cwd = CWD, policy: ShellPolicy = TEST_POLICY) => checkShellCommand(cmd, cwd, policy);

  it('deniedCommandPrefixes: rm -rf /', () => {
    const r = check('rm -rf /');
    expect(r.action).toBe('deny');
    expect(r.matchedRule).toBe('shell-policy.deny');
  });

  it('deniedCommandPrefixes: префикс по токенам не срабатывает на другие пути', () => {
    expect(check('rm -rf /home/user/project/x').action).toBe('allow');
    expect(check('rm -rf').action).toBe('allow');
  });

  it('deniedCommandPrefixes: chmod -R 777 /', () => {
    expect(check('chmod -R 777 /').action).toBe('deny');
  });

  it('deniedCommandPrefixes: форк-бомба по точному совпадению строки', () => {
    expect(check(':(){ :|:& };:').action).toBe('deny');
  });

  it('deniedPaths: cat ~/.ssh/id_rsa', () => {
    const r = check('cat ~/.ssh/id_rsa');
    expect(r.action).toBe('deny');
    expect(r.deniedPath).toContain('.ssh/id_rsa');
  });

  it('deniedPaths: абсолютный /etc/passwd', () => {
    expect(check('cat /etc/passwd').action).toBe('deny');
  });

  it('deniedPrefixes: ~/.aws', () => {
    const r = check('cat ~/.aws/credentials');
    expect(r.action).toBe('deny');
    expect(r.deniedPath).toContain('.aws');
  });

  it('deniedPrefixes: /etc/sudoers.d', () => {
    expect(check('cat /etc/sudoers.d/foo').action).toBe('deny');
  });

  it('approvalPaths: ~/.ssh/config → ask (до префикса ~/.ssh)', () => {
    const r = check('cat ~/.ssh/config');
    expect(r.action).toBe('ask');
    expect(r.matchedRule).toBe('shell-policy.approve');
  });

  it('разрешает обычные команды', () => {
    expect(check('ls -la').action).toBe('allow');
    expect(check('cat src/main.ts').action).toBe('allow');
    expect(check('npm test').action).toBe('allow');
  });

  it('динамический путь-путь без защищённых маркеров → ask (fail-closed, не пропускаем молча)', () => {
    // $USER не резолвится → unknown; путь-подобный токен → ask (раньше молча allow).
    expect(check('cat $USER/x').action).toBe('ask');
    expect(check('cat $USER/x').messageId).toBe('ask-protected-path');
  });

  it('рутинные динамические аргументы без защищённых путей не блокируются', () => {
    // glob без разделителей, URL, аргумент-подстановка без `/` — не пути.
    expect(check("find . -name '*.ts'").action).toBe('allow');
    expect(check('curl -s https://example.com/$VER/api').action).toBe('allow');
    expect(check('echo $(ls)').action).toBe('allow');
  });

  it('динамика с защищённым маркером → deny (fail-closed)', () => {
    // неизвестная переменная + литеральный фрагмент защищённого пути
    const r = check('cat $SOMEDIR/etc/shadow');
    expect(r.action).toBe('deny');
    expect(r.matchedRule).toBe('shell-policy.deny');
    // неизвестная переменная + фрагмент .ssh/id_rsa
    expect(check('cat $USER/.ssh/id_rsa').action).toBe('deny');
    // glob внутри защищённого каталога (фрагмент ~/.aws)
    expect(check('cat ~/.aws/*').action).toBe('deny');
    // glob по префиксу из политики
    expect(check('cat /etc/sudoers.d/*').action).toBe('deny');
    // подстановка $(...) с защищённым путём в литеральном фрагменте
    expect(check('cat $(echo /etc/passwd)').action).toBe('deny');
    // backtick
    expect(check('cat `pwd`/.ssh/id_rsa').action).toBe('deny');
  });

  it('динамика в присваивании: значение-путь проверяется (обход `X=... cat $X`)', () => {
    expect(check('X=/etc/passwd cat $X').action).toBe('deny');
    expect(check('X=$USER/.ssh/id_rsa cat $X').action).toBe('deny');
    expect(check('X=~/.ssh cat $X').action).toBe('deny');
    // рутинные присваивания не блокируются
    expect(check('NODE_ENV=production npm test').action).toBe('allow');
    expect(check('PATH=$PATH:/opt/bin ls').action).toBe('allow');
  });

  it('пустая политика — всё allow', () => {
    const empty: ShellPolicy = { deniedPaths: [], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] };
    expect(check('cat ~/.ssh/id_rsa', CWD, empty).action).toBe('allow');
  });
});

describe('checkShellCommand — строгий критерий «путь» для непроверяемой динамики (шаг 6)', () => {
  const check = (cmd: string, cwd = CWD, policy: ShellPolicy = TEST_POLICY) => checkShellCommand(cmd, cwd, policy);

  it('текст с `/` в кавычках не уходит на подтверждение (регресс: ложные ask)', () => {
    // раньше «путём» считалась вся строка внутри кавычек → ask на безобидный echo
    expect(check('echo "=== diff vs origin/master (stat tail) ==="').action).toBe('allow');
    // JS-однострочник: `/` в середине текста — не путь
    expect(check(`node -e "console.log(require('zod/package.json').version)"`).action).toBe('allow');
  });

  it('shell-цикл: `ask` даёт только реальный динамический путь /proc/$p/comm', () => {
    // `/proc/$p/comm` начинается с `/` — абсолютный неразрешимый путь, fail-closed
    // оставляем (иначе `cat /etc/$X/shadow` проходил бы молча). Причина ask —
    // именно этот токен, а текст цикла (`for …; do echo …; done`) его не даёт.
    // Токен несёт и закрывающую скобку подстановки (`$(cat …)`) — она в пути.
    const r = check('for p in $(pgrep -f synth); do echo pid $p: $(cat /proc/$p/comm); done');
    expect(r.action).toBe('ask');
    expect(r.messageId).toBe('ask-protected-path');
    expect(r.deniedPath?.startsWith('/proc/$p/comm')).toBe(true);
    // без абсолютного динамического пути цикл проходит
    expect(check('for f in $(ls); do echo done $f:; done').action).toBe('allow');
  });

  it('обычные команды остаются allow', () => {
    expect(check('echo hello').action).toBe('allow');
    expect(check('git status').action).toBe('allow');
    expect(check('cd synth && pnpm test').action).toBe('allow');
  });

  it('реальные динамические пути по-прежнему ask', () => {
    expect(check('cat $X').action).toBe('ask');
    expect(check('cat ${X}').action).toBe('ask');
    expect(check('cat $X/file').action).toBe('ask');
    // `~` + неразрешимая динамика (`~/x` — литерал, резолвится через HOME)
    expect(check('cat ~/x*').action).toBe('ask');
    // glob от текущего каталога и подъём за его пределы — ask (нет совпадений/вне периметра)
    expect(check('cat ./x*').action).toBe('ask');
    expect(check('cat ../x*').action).toBe('ask');
    // многокомпонентный glob — ask (см. workspace-glob)
    expect(check('ls packages/*/package.json').action).toBe('ask');
  });

  it('deny защищённых путей из динамики не ослаблен (шаг 2 приоритетнее)', () => {
    expect(check('cat $HOME/.ssh/id_rsa').action).toBe('deny');
    expect(check('cat $X/.ssh/id_rsa').action).toBe('deny');
    expect(check('cat $X/etc/passwd').action).toBe('deny');
  });
});

describe('checkShellCommand — fail-closed динамика + {dataDir}/secrets (H5)', () => {
  const DATA_DIR = '/srv/synth/data';
  /** Политика как у оркестратора: protected-paths + динамические префиксы + dataDir. */
  const POLICY: ShellPolicy = {
    ...TEST_POLICY,
    deniedPrefixes: [...TEST_POLICY.deniedPrefixes, join(DATA_DIR, 'secrets'), join(DATA_DIR, 'security')],
    dataDir: DATA_DIR,
  };
  const check = (cmd: string) => checkShellCommand(cmd, CWD, POLICY);

  it('sh -c cat $SYNTH_DATA_DIR/secrets/master.key → deny (обход через обёртку)', () => {
    const r = check("sh -c 'cat $SYNTH_DATA_DIR/secrets/master.key'");
    expect(r.action).toBe('deny');
    expect(r.matchedRule).toBe('shell-policy.deny');
  });

  it('неизвестная переменная + фрагмент secrets/... → deny по маркеру {dataDir}/secrets', () => {
    // дата-каталог не известен (другой инстанс) — резолва нет, но литеральный
    // фрагмент `secrets/master.key` упирается в защищённый префикс → deny
    expect(check('cat $OTHER_DATA_DIR/secrets/master.key').action).toBe('deny');
    expect(check("sh -c 'cat $OTHER_DATA_DIR/secrets/ssh-keys/k.json'").action).toBe('deny');
  });

  it('cat ${SYNTH_DATA_DIR}/secrets/master.key → deny ($SYNTH_DATA_DIR резолвится по dataDir)', () => {
    expect(check('cat ${SYNTH_DATA_DIR}/secrets/master.key').action).toBe('deny');
    expect(check('cat $SYNTH_DATA_DIR/secrets/ssh-keys/k.json').action).toBe('deny');
    expect(check('cat $SYNTH_DATA_DIR/security/protected-paths.json').action).toBe('deny');
  });

  it('каталожные пути: мастер-ключ/ssh-ключи/override-файл → deny', () => {
    expect(check(`cat ${DATA_DIR}/secrets/master.key`).action).toBe('deny');
    expect(check(`rm -rf ${DATA_DIR}/secrets`).action).toBe('deny');
    expect(check(`cat ${DATA_DIR}/secrets/api-key`).action).toBe('deny');
  });

  it('$HOME/.ssh/id_rsa (не-literal резолв) → deny', () => {
    expect(check('cat $HOME/.ssh/id_rsa').action).toBe('deny');
    expect(check('cat ${HOME}/.ssh/id_ed25519').action).toBe('deny');
  });

  it('регресс: литеральные запрещённые пути блокируются как раньше', () => {
    expect(check('cat ~/.ssh/id_rsa').action).toBe('deny');
    expect(check('cat /etc/passwd').action).toBe('deny');
    expect(check('cat ~/.ssh/config').action).toBe('ask');
    expect(check('cat ~/.aws/credentials').action).toBe('deny');
    expect(check('rm -rf /').action).toBe('deny');
  });

  it('рутинные команды не дают ложных deny', () => {
    expect(check('git status').action).toBe('allow');
    expect(check('npm test').action).toBe('allow');
    expect(check('node --version').action).toBe('allow');
    expect(check('cat README.md').action).toBe('allow');
    expect(check('ls -la').action).toBe('allow');
    expect(check('git commit -m "fix: typo"').action).toBe('allow');
    expect(check(`cat ${DATA_DIR}/settings.json`).action).toBe('allow');
    expect(check(`ls ${DATA_DIR}/sessions`).action).toBe('allow');
  });

  it('регресс: защищённые пути из динамики по-прежнему deny/ask', () => {
    expect(check('cat $SYNTH_DATA_DIR/secrets/master.key').action).toBe('deny');
    expect(check('cat ~/.ssh/id_rsa').action).toBe('deny');
    expect(check('cat /etc/shadow').action).toBe('deny');
    // динамический токен с маркером защищённого префикса — fail-closed deny
    // (маркеры срабатывают до резолва approvalPaths); литерал — ask
    expect(check('ls $HOME/.ssh/config').action).toBe('deny');
    expect(check('ls ~/.ssh/config').action).toBe('ask');
    expect(check('ls $HOME/.ssh/id_ed25519').action).toBe('deny');
  });
});

describe('checkShellCommand — regex/escape-аргументы не считаются путями', () => {
  const check = (cmd: string, cwd = CWD, policy: ShellPolicy = TEST_POLICY) => checkShellCommand(cmd, cwd, policy);

  it('grep -v с regex-якорем ($ и экранированная точка) — allow', () => {
    // обратный слэш в POSIX-shell — экранирование, а не разделитель пути
    expect(check("ls synth/.git/hooks | grep -v '\\.sample$'").action).toBe('allow');
    expect(check("ls .git/hooks | grep -v '\\.sample$'").action).toBe('allow');
    expect(check("grep -r '\\.sample$' .").action).toBe('allow');
  });

  it('grep -E с экранированными классами символов — allow', () => {
    expect(check("grep -E '^\\s*Test Files'").action).toBe('allow');
    expect(check("grep -E 'FAIL|Failed Tests'").action).toBe('allow');
    expect(check("grep -E 'a\\|b' file.txt").action).toBe('allow');
  });

  it('escape-аргумент со пробелом остаётся литеральным путём (не ask)', () => {
    expect(check('cat my\\ file.txt').action).toBe('allow');
    expect(check('touch my\\ file.txt').action).toBe('allow');
  });
});

describe('checkShellCommand — обходы через разделители и обёртки (B1/B2/B4)', () => {
  const check = (cmd: string, cwd = CWD, policy: ShellPolicy = TEST_POLICY) => checkShellCommand(cmd, cwd, policy);
  const mut = (cmd: string) => isMutatingCommand(tokenizeCommand(cmd), cmd);

  it('B1: "echo x; rm -rf /" — мутирующая и deny (денлист в любом сегменте)', () => {
    expect(mut('echo x; rm -rf /')).toBe(true);
    expect(check('echo x; rm -rf /').action).toBe('deny');
  });

  it('B1: "echo x && rm -rf /" — мутирующая и deny', () => {
    expect(mut('echo x && rm -rf /')).toBe(true);
    expect(check('echo x && rm -rf /').action).toBe('deny');
  });

  it('B1: "cd / && rm -rf /" — мутирующая и deny', () => {
    expect(mut('cd / && rm -rf /')).toBe(true);
    expect(check('cd / && rm -rf /').action).toBe('deny');
  });

  it('B1: "echo x || rm -rf /" и "echo x & rm -rf /" — deny', () => {
    expect(mut('echo x || rm -rf /')).toBe(true);
    expect(check('echo x || rm -rf /').action).toBe('deny');
    expect(mut('echo x & rm -rf /')).toBe(true);
    expect(check('echo x & rm -rf /').action).toBe('deny');
  });

  it('B1: перенос строки тоже разделитель — deny', () => {
    expect(mut('echo x\nrm -rf /')).toBe(true);
    expect(check('echo x\nrm -rf /').action).toBe('deny');
  });

  it('B2: путь из денлиста в любом сегменте — ask/deny', () => {
    expect(check('cat ~/.ssh/config; echo hi').action).toBe('ask');
    expect(check('echo hi; cat ~/.ssh/config').action).toBe('ask');
    expect(check('echo x; cat ~/.ssh/id_rsa').action).toBe('deny');
    expect(check('echo x && cat /etc/passwd').action).toBe('deny');
  });

  it('B4: sh -c с опасной командой — deny; с безопасной — allow', () => {
    expect(mut("sh -c 'rm -rf /'")).toBe(true);
    expect(check("sh -c 'rm -rf /'").action).toBe('deny');
    expect(mut("sh -c 'echo hi'")).toBe(false);
    expect(check("sh -c 'echo hi'").action).toBe('allow');
    expect(check("bash -c 'rm -rf /'").action).toBe('deny');
    expect(check("zsh -c 'rm -rf /'").action).toBe('deny');
  });

  it('B4: sh -c с вложенным разделителем — deny по второму сегменту', () => {
    expect(check("sh -c 'echo hi; rm -rf /'").action).toBe('deny');
    expect(check('sh -c "rm -rf /"').action).toBe('deny');
  });

  it('B4: eval с опасной командой — deny; с безопасной — allow', () => {
    expect(mut("eval 'rm -rf /'")).toBe(true);
    expect(check("eval 'rm -rf /'").action).toBe('deny');
    expect(check("eval 'echo hi'").action).toBe('allow');
  });

  it('B4: sudo rm -rf / — deny (и мутирующая для plan)', () => {
    expect(mut('sudo rm -rf /')).toBe(true);
    expect(check('sudo rm -rf /').action).toBe('deny');
    expect(mut('sudo npm install x')).toBe(true);
    expect(check('echo x; sudo rm -rf /').action).toBe('deny');
  });

  it('B4: find с -delete/-exec — deny и мутирующая; read-only find — нет', () => {
    expect(mut('find / -delete')).toBe(true);
    expect(check('find / -delete').action).toBe('deny');
    expect(mut('find / -exec rm -rf {} \\;')).toBe(true);
    expect(check('find / -exec rm -rf {} \\;').action).toBe('deny');
    expect(mut("find . -name '*.ts'")).toBe(false);
    expect(check("find . -name '*.ts'").action).toBe('allow');
  });

  it('кавычки: точка с запятой в кавычках — НЕ разделитель', () => {
    expect(mut("echo ';'")).toBe(false);
    expect(check("echo ';'").action).toBe('allow');
    expect(mut("echo 'x;rm -rf /'")).toBe(false);
    expect(check("echo 'x;rm -rf /'").action).toBe('allow');
  });

  it('разделители внутри $(...) не разбивают команду (динамика)', () => {
    expect(mut('echo "$(ls; rm x)"')).toBe(false);
    expect(check('echo "$(ls; rm x)"').action).toBe('allow');
    expect(mut('echo $(ls; rm x)')).toBe(false);
    expect(check('echo $(ls; rm x)').action).toBe('allow');
  });

  it('read-only команды с разделителями остаются read-only', () => {
    expect(mut('echo a; echo b')).toBe(false);
    expect(mut('git status && git diff')).toBe(false);
    expect(check('git status && git diff').action).toBe('allow');
  });
});

describe('checkShellCommand — паттерны аргументов, workspace-glob и переменные', () => {
  const check = (cmd: string, cwd = CWD, policy: ShellPolicy = TEST_POLICY, allowedRoots?: string[]) =>
    checkShellCommand(cmd, cwd, policy, allowedRoots ? { allowedRoots } : undefined);

  it('аргументы-паттерны не считаются путями (sed/grep); find — проверяется', () => {
    expect(check("sed 's/=.*/=<set>/'").action).toBe('allow');
    expect(check("grep 's/.*\\.//'").action).toBe('allow');
    // `-path` матчит полный путь (`*` пересекает `/`) — fail-closed ask
    expect(check("find . -not -path '*/.git/*'").action).toBe('ask');
    expect(check("find . -name '*.ts'").action).toBe('allow');
  });

  it('слитные перенаправления: >&, >|, <>, 2>&, &> — цель проверяется', () => {
    expect(check("echo 'ssh-rsa' >&~/.ssh/authorized_keys").action).toBe('deny');
    expect(check('echo x >|/etc/passwd').action).toBe('deny');
    expect(check('cat <>/etc/shadow').action).toBe('deny');
    expect(check('cat 2>&/etc/shadow').action).toBe('deny');
    expect(check('echo x &>/etc/shadow').action).toBe('deny');
    expect(check('echo x &>>/etc/passwd').action).toBe('deny');
    // дескрипторы, а не файлы
    expect(check('cmd 2>&1').action).toBe('allow');
    expect(check('cmd >&1').action).toBe('allow');
    // over-block (осознанно): кавычки снимаются, текст выглядит как redirect
    expect(check("echo '>~/.ssh/authorized_keys'").action).toBe('deny');
  });

  it('tr: наборы не пути, но цель перенаправления проверяется', () => {
    expect(check('tr -d a < /etc/shadow').action).toBe('deny');
    expect(check('tr -d a < /etc/passwd').action).toBe('deny');
    expect(check('tr a b > ~/.ssh/authorized_keys').action).toBe('deny');
    // слитные перенаправления
    expect(check('tr a b &>/etc/shadow').action).toBe('deny');
    expect(check('cat x >/etc/passwd').action).toBe('deny');
    // наборы-«пути» не уходят в ask и не денятся
    expect(check("tr '/' '_' < file.txt").action).toBe('allow');
    expect(check('tr a b < README.md').action).toBe('allow');
  });

  it('workspace-glob: однокомпонентный внутри периметра — allow, иначе ask', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-shell-glob-'));
    try {
      const ws = join(dir, 'ws');
      await mkdir(join(ws, 'k3s/certs/k3s/server/tls'), { recursive: true });
      await writeFile(join(ws, 'k3s/certs/k3s/server/tls/a.srl'), 'x');
      await mkdir(join(ws, 'other'), { recursive: true });
      await writeFile(join(ws, 'other', 'a.txt'), 'x');

      // последний компонент, каталог существует — allow
      expect(check('ls k3s/certs/k3s/server/tls/*.srl', ws).action).toBe('allow');
      // многокомпонентный glob — ask
      expect(check('ls packages/*/package.json').action).toBe('ask');
      expect(check('cat ./*/*.key', ws).action).toBe('ask');
      // вне периметра — ask
      expect(check('ls /etc/ssh/ssh_config.d/*').action).toBe('ask');
      expect(check('ls /proc/*').action).toBe('ask');
      // нет каталога/совпадений — ask
      expect(check('ls nope/*.srl', ws).action).toBe('ask');
      expect(check('cat ./x*', ws).action).toBe('ask');
      // allowedRoots — тоже периметр
      expect(check('ls other/*.txt', ws, TEST_POLICY, [join(ws, 'other')]).action).toBe('allow');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('find -path/-ipath: абсолютный путь проверяется как путь', () => {
    const DATA = '/var/synth/data';
    const policy: ShellPolicy = {
      ...TEST_POLICY,
      deniedPaths: [...TEST_POLICY.deniedPaths, `${DATA}/secrets/master.key`],
      deniedPrefixes: [...TEST_POLICY.deniedPrefixes, `${DATA}/secrets`],
    };
    expect(check('find /etc -path /etc/shadow -delete').action).toBe('deny');
    expect(check(`find ${DATA} -path ${DATA}/secrets/master.key -delete`, CWD, policy).action).toBe('deny');
    // `-path` матчит полный путь: относительный glob тоже проверяется (ask)
    expect(check("find /etc -ipath '/etc/pass*' -delete").action).toBe('ask');
    expect(check(`find ${DATA} -path '*/*.key' -delete`, CWD, policy).action).toBe('ask');
    expect(check("find . -path '*/.git/*'").action).toBe('ask');
    // шаблон без `/` путём не считается
    expect(check("find . -name '*.ts'").action).toBe('allow');
    expect(check("find . -name '*shadow*'").action).toBe('allow');
  });

  it('sed: слитные -e и «скрипт»-путь', () => {
    expect(check("sed -e's/a/b/' /etc/shadow").action).toBe('deny');
    expect(check("sed -i -e's/a/b/' /etc/shadow").action).toBe('deny');
    // нормальная форма не сломана
    expect(check("sed -n '1,40p' README.md").action).toBe('allow');
  });

  it('jq: файл из --slurpfile/--rawfile проверяется как путь', () => {
    expect(check('jq --slurpfile v /etc/shadow .').action).toBe('deny');
    expect(check('jq --rawfile v /etc/shadow .').action).toBe('deny');
  });

  it('раскрытое значение-команда не путь; динамическое имя команды — ask', () => {
    const cases = [
      "C='cat /etc/shadow'; eval $C",
      "C='rm -rf /'; eval $C",
      `C='cat /etc/shadow'; sh -c "$C"`,
      `C='cat /etc/shadow'; bash -c "$C"`,
      "C='cat /etc/shadow'; sudo $C",
      "C='cat /etc/shadow'; $C",
    ];
    for (const cmd of cases) expect(check(cmd).action).not.toBe('allow');
    // простые значения раскрываются и проверяются как команда
    expect(check('C=ls; $C').action).toBe('allow');
    // слитные формы обёртки — тоже рекурсия
    expect(check(`bash -lc 'cat /etc/shadow'`).action).toBe('deny');
    expect(check(`sh -c'cat /etc/shadow'`).action).toBe('deny');
  });

  it('+= присваивание: значение неизвестно, deny по маркерам сохраняется', () => {
    const DATA = '/var/synth/data';
    const policy: ShellPolicy = {
      ...TEST_POLICY,
      deniedPaths: [...TEST_POLICY.deniedPaths, `${DATA}/secrets/master.key`],
      deniedPrefixes: [...TEST_POLICY.deniedPrefixes, `${DATA}/secrets`],
    };
    expect(check('D=/var/synth/data/; D+=secrets; cat $D/master.key', CWD, policy).action).toBe('deny');
    expect(check('H=~/.ss; H+=h; cat $H/id_rsa').action).toBe('deny');
  });

  it('for-цикл из литеральных слов — allow', () => {
    expect(check('for r in ansible/itphx.loc k3s/keycloak; do git -C "$r" status; done').action).toBe('allow');
    expect(check(
      'for hp in 10.0.0.1:22 10.0.0.2:22; do h=${hp%:*}; p=${hp#*:}; timeout 3 bash -c "</dev/tcp/$h/$p"; done',
    ).action).toBe('allow');
  });

  it('присваивание литерала раскрывается: путь проверяется (deny сохраняется)', () => {
    expect(check('TLS=../../k3s/certs/tls; cat $TLS/client-ca.crt').action).toBe('allow');
    expect(check('TLS=~/.ssh; cat $TLS/id_rsa').action).toBe('deny');
    expect(check('for f in ~/.ssh/id_rsa; do cat "$f"; done').action).toBe('deny');
  });

  it('неизвестная динамика остаётся ask (fail-closed)', () => {
    expect(check('cat $X').action).toBe('ask');
    expect(check('cat ${X}').action).toBe('ask');
    expect(check('cat $X/file').action).toBe('ask');
    expect(check('for p in $(pgrep -f synth); do cat /proc/$p/comm; done').action).toBe('ask');
    // значения из потока (`while read`) неизвестны
    expect(check('while read -r n ip; do echo "$n"; done').action).toBe('ask');
  });
});

describe('checkShellCommand — deny приоритетнее ask (внутри сегмента и по сегментам)', () => {
  const DATA = '/var/synth/data';
  const policy: ShellPolicy = {
    ...TEST_POLICY,
    deniedPaths: [...TEST_POLICY.deniedPaths, `${DATA}/secrets/master.key`],
    deniedPrefixes: [...TEST_POLICY.deniedPrefixes, `${DATA}/secrets`],
  };
  const check = (cmd: string) => checkShellCommand(cmd, CWD, policy);

  it('approval-путь рядом с запрещённым — deny', () => {
    // known_hosts под deniedPrefix ~/.ssh, config — approvalPath
    expect(check('cat ~/.ssh/config ~/.ssh/known_hosts').action).toBe('deny');
    expect(check(`cat ~/.ssh/config ${DATA}/secrets/master.key`).action).toBe('deny');
  });

  it('deny во втором сегменте перекрывает ask в первом', () => {
    expect(check('cat ~/.ssh/config; cat /etc/passwd').action).toBe('deny');
  });

  it('одиночный approval-путь остаётся ask', () => {
    expect(check('cat ~/.ssh/config').action).toBe('ask');
    // approvalPaths — исключение из deniedPrefixes и для ls
    expect(check('ls ~/.ssh/config').action).toBe('ask');
  });
});

describe('matchShellCommandPattern', () => {
  it('"*" матчит любую команду', () => {
    expect(matchShellCommandPattern('*', 'npm install express')).toBe(true);
    expect(matchShellCommandPattern('*', 'git status')).toBe(true);
  });

  it('префиксный паттерн "npm install *"', () => {
    expect(matchShellCommandPattern('npm install *', 'npm install express')).toBe(true);
    expect(matchShellCommandPattern('npm install *', 'npm install')).toBe(true);
    expect(matchShellCommandPattern('npm install *', 'npm run test')).toBe(false);
  });

  it('префиксный паттерн "git commit *"', () => {
    expect(matchShellCommandPattern('git commit *', 'git commit -m "x"')).toBe(true);
    expect(matchShellCommandPattern('git commit *', 'git status')).toBe(false);
  });

  it('точное совпадение без glob', () => {
    expect(matchShellCommandPattern('git status', 'git status')).toBe(true);
    expect(matchShellCommandPattern('git status', 'git status --short')).toBe(false);
  });
});

describe('loadShellPolicy', () => {
  let sysDir: string;
  let overrideDir: string;

  beforeEach(async () => {
    sysDir = await mkdtemp(join(tmpdir(), 'synth-shell-policy-'));
    overrideDir = await mkdtemp(join(tmpdir(), 'synth-shell-override-'));
    clearShellPolicyCache();
  });

  afterEach(async () => {
    await rm(sysDir, { recursive: true, force: true });
    await rm(overrideDir, { recursive: true, force: true });
  });

  it('системный дефолт загружается из definitions', async () => {
    await writeFile(join(sysDir, 'shell-policy.json'), JSON.stringify({
      deniedPaths: ['~/.ssh/id_rsa'],
      deniedPrefixes: [],
      approvalPaths: [],
      deniedCommandPrefixes: [],
    }));
    const policy = loadShellPolicy({ systemDir: sysDir });
    expect(policy.deniedPaths).toContain('~/.ssh/id_rsa');
    expect(policy.deniedPrefixes).toEqual([]);
  });

  it('override полностью заменяет системный', async () => {
    await writeFile(join(sysDir, 'shell-policy.json'), JSON.stringify({
      deniedPaths: ['~/.ssh/id_rsa'],
      deniedPrefixes: ['~/.ssh'],
      approvalPaths: [],
      deniedCommandPrefixes: [],
    }));
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(overrideDir, 'shell-policy.json'), JSON.stringify({
      deniedPaths: ['/custom/secret'],
      deniedPrefixes: [],
      approvalPaths: [],
      deniedCommandPrefixes: [],
    }));
    const policy = loadShellPolicy({ systemDir: sysDir, overridePath: join(overrideDir, 'shell-policy.json') });
    expect(policy.deniedPaths).toEqual(['/custom/secret']);
    // системные записи заменены, не объединены
    expect(policy.deniedPaths).not.toContain('~/.ssh/id_rsa');
  });

  it('без override — только системная', async () => {
    await writeFile(join(sysDir, 'shell-policy.json'), JSON.stringify({
      deniedPaths: ['/etc/passwd'],
      deniedPrefixes: [],
      approvalPaths: [],
      deniedCommandPrefixes: [],
    }));
    const policy = loadShellPolicy({ systemDir: sysDir });
    expect(policy.deniedPaths).toEqual(['/etc/passwd']);
  });

  it('реальный системный дефолт из репозитория загружается', () => {
    const policy = loadShellPolicy();
    expect(policy.deniedPaths.length).toBeGreaterThan(0);
    expect(policy.deniedPaths).toContain('~/.ssh/id_rsa');
    expect(policy.deniedPrefixes).toContain('~/.aws');
    expect(policy.approvalPaths).toContain('~/.ssh/config');
    expect(policy.deniedCommandPrefixes).toContain('rm -rf /');
  });
});

/** Обход shell-денлиста через симлинк внутри workspace (link -> защищённый путь). */
describe('checkShellCommand — обход через симлинк', () => {
  let tmpDir: string;
  let ws: string;
  let secrets: string;
  let policy: ShellPolicy;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-symlink-'));
    ws = join(tmpDir, 'ws');
    secrets = join(tmpDir, 'secrets');
    await mkdir(ws, { recursive: true });
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, 'master.key'), 'KEY');
    await symlink(secrets, join(ws, 'leakdir'));
    await symlink(join(secrets, 'master.key'), join(ws, 'leak.key'));
    await mkdir(join(ws, 'sub'));
    await symlink(join(ws, 'sub'), join(ws, 'inlink'));
    policy = {
      deniedPaths: [join(secrets, 'master.key')],
      deniedPrefixes: [secrets],
      approvalPaths: [],
      deniedCommandPrefixes: [],
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('cat через симлинк-каталог на защищённый путь → deny', () => {
    const r = checkShellCommand('cat leakdir/master.key', ws, policy);
    expect(r.action).toBe('deny');
    expect(r.matchedRule).toBe('shell-policy.deny');
  });

  it('cat через симлинк-файл на защищённый путь → deny', () => {
    const r = checkShellCommand('cat leak.key', ws, policy);
    expect(r.action).toBe('deny');
  });

  it('присваивание с симлинком на защищённый путь → deny', () => {
    const r = checkShellCommand('X=leakdir/master.key cat $X', ws, policy);
    expect(r.action).toBe('deny');
  });

  it('симлинк внутрь на незащищённый путь → allow', () => {
    const r = checkShellCommand('cat inlink/file.txt', ws, policy);
    expect(r.action).toBe('allow');
  });

  it('workspace-glob через симлинк наружу → ask (realpath вне периметра)', () => {
    const r = checkShellCommand('ls leakdir/*.key', ws, policy);
    expect(r.action).toBe('ask');
  });

  it('многокомпонентный glob через симлинк → ask', () => {
    expect(checkShellCommand('cat ./*/*.key', ws, policy).action).toBe('ask');
    expect(checkShellCommand('cat ./leakdir/*', ws, policy).action).toBe('ask');
  });

  it('workspace-glob по безопасному каталогу → allow', async () => {
    await writeFile(join(ws, 'sub', 'ok.txt'), 'x');
    expect(checkShellCommand('cat sub/*.txt', ws, policy).action).toBe('allow');
  });

  it('регрессия: лексический защищённый путь → deny', () => {
    const r = checkShellCommand(`cat ${join(secrets, 'master.key')}`, ws, policy);
    expect(r.action).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// H1–H8: предсуществующие обходы (closure-аудит)
// ---------------------------------------------------------------------------

describe('tokenizeCommand — операторы перенаправления (H1)', () => {
  it('оператор выделяется отдельным токеном, слово разрывается', () => {
    expect(tokenizeCommand('x&>/f')).toEqual(['x', '&>', '/f']);
    expect(tokenizeCommand('hi>/f')).toEqual(['hi', '>', '/f']);
    expect(tokenizeCommand('2>&1')).toEqual(['2', '>&', '1']);
    expect(tokenizeCommand('{fd}>/f')).toEqual(['{fd}', '>', '/f']);
    expect(tokenizeCommand('x>|/f')).toEqual(['x', '>|', '/f']);
    expect(tokenizeCommand('x>&/f')).toEqual(['x', '>&', '/f']);
    expect(tokenizeCommand('x&>>/f')).toEqual(['x', '&>>', '/f']);
    expect(tokenizeCommand('cat <>/f')).toEqual(['cat', '<>', '/f']);
  });

  it('кавычки и $() не трогаем', () => {
    expect(tokenizeCommand('echo "a > b"')).toEqual(['echo', 'a > b']);
    expect(tokenizeCommand("awk '$1>2'")).toEqual(['awk', '$1>2']);
    expect(tokenizeCommand("grep 'a|b'")).toEqual(['grep', 'a|b']);
    expect(tokenizeCommand('echo $(a>b)')).toEqual(['echo', '$(a>b)']);
  });

  it('splitShellSegments не режет &/| внутри операторов', () => {
    expect(splitShellSegments('x&>f')).toEqual(['x&>f']);
    expect(splitShellSegments('x>|f')).toEqual(['x>|f']);
    expect(splitShellSegments('x>&f')).toEqual(['x>&f']);
    expect(splitShellSegments('x&>>f')).toEqual(['x&>>f']);
    // фоновый & и пайп | по-прежнему разделители
    expect(splitShellSegments('a & b')).toEqual(['a', 'b']);
    expect(splitShellSegments('a | b')).toEqual(['a', 'b']);
  });
});

describe('H1: приклеенные перенаправления проверяются как пути', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('защищённые цели → deny', () => {
    expect(check('echo x&>/etc/shadow').action).toBe('deny');
    expect(check('echo hi>/etc/shadow').action).toBe('deny');
    expect(check('x=1>/etc/shadow').action).toBe('deny');
    expect(check('{fd}>/etc/shadow').action).toBe('deny');
    expect(check('x>|/etc/passwd').action).toBe('deny');
    expect(check('x>&/etc/shadow').action).toBe('deny');
    expect(check('hi</etc/shadow').action).toBe('deny');
    expect(check('echo x&>>/etc/passwd').action).toBe('deny');
    expect(check('cat <>/etc/shadow').action).toBe('deny');
  });

  it('fd-дубли остаются allow', () => {
    expect(check('cmd 2>&1').action).toBe('allow');
    expect(check('cmd >&2').action).toBe('allow');
    expect(check('cmd >&-').action).toBe('allow');
  });
});

describe('H2: префиксные обёртки', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('вложенная shell-команда под обёрткой → deny', () => {
    const cases = [
      "env sh -c 'cat /etc/shadow'",
      "env -i sh -c 'cat /etc/shadow'",
      "timeout 3 bash -c 'cat /etc/shadow'",
      "command sh -c 'cat /etc/shadow'",
      "nohup sh -c 'cat /etc/shadow'",
      "exec /bin/sh -c 'cat /etc/shadow'",
      "nice -n 5 sh -c 'cat /etc/shadow'",
      "stdbuf -o0 sh -c 'cat /etc/shadow'",
      "xargs sh -c 'cat /etc/shadow'",
      "flock /tmp/l sh -c 'cat /etc/shadow'",
      "watch -n 1 'cat /etc/shadow'",
    ];
    for (const cmd of cases) expect(check(cmd).action).toBe('deny');
  });

  it('легитимные обёртки не ломаются', () => {
    expect(check('env').action).toBe('allow');
    expect(check('command -v git').action).toBe('allow');
    expect(check('timeout 5 npm test').action).toBe('allow');
    expect(check('nice -n 5 ls').action).toBe('allow');
  });

  it('exec с раскрываемым именем команды проверяется как команда', () => {
    expect(check("C=/bin/sh; exec $C -c 'cat /etc/shadow'").action).toBe('deny');
  });
});

describe('H3: awk system(...), find -exec, код интерпретаторов', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('awk system(...) рекурсивно проверяется', () => {
    expect(check('awk \'BEGIN{system("cat /etc/shadow")}\'').action).toBe('deny');
    expect(check('awk \'BEGIN{system("rm -rf /")}\'').action).toBe('deny');
    expect(check("awk '{print $1}' file").action).toBe('allow');
  });

  it('awk getline/pipe/redirect и -f — fail-closed ask', () => {
    expect(check("awk 'BEGIN{getline; print}'").action).toBe('ask');
    expect(check('awk -f script.awk file').action).toBe('ask');
  });

  it('find -exec проверяет исполняемую команду', () => {
    expect(check("find . -exec sh -c 'cat /etc/shadow' ;").action).toBe('deny');
    expect(check('find . -exec cat {} ;').action).toBe('allow');
  });

  it('интерпретаторы с кодом: маркер защищённого пути → deny', () => {
    expect(check(`python3 -c "print(open('/etc/shadow').read())"`).action).toBe('deny');
    expect(check('node -e "console.log(1)"').action).toBe('allow');
  });
});

describe('H4: find -delete/-exec вне периметра', () => {
  it('стартовый путь вне roots → ask, защищённый старт → deny', () => {
    const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY, { allowedRoots: [CWD] });
    expect(check('find /etc -name shadow -delete').action).toBe('ask');
    expect(check("find /var/synth/data -name '*.key' -delete").action).toBe('ask');
    expect(check('find ~ -name id_rsa -delete').action).toBe('ask');
    expect(check('find /etc/shadow -delete').action).toBe('deny');
    expect(check("find . -name '*.tmp' -delete").action).toBe('allow');
  });
});

describe('H5: bare-glob и симлинк', () => {
  it('симлинк наружу в cwd → ask, обычные файлы → allow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-shell-bareglob-'));
    try {
      const ws = join(dir, 'ws');
      const secrets = join(dir, 'secrets');
      await mkdir(ws, { recursive: true });
      await mkdir(secrets, { recursive: true });
      await writeFile(join(secrets, 'master.key'), 'KEY');
      await symlink(join(secrets, 'master.key'), join(ws, 'leak.key'));
      await writeFile(join(ws, 'a.ts'), 'x');
      const policy: ShellPolicy = {
        deniedPaths: [join(secrets, 'master.key')],
        deniedPrefixes: [secrets],
        approvalPaths: [],
        deniedCommandPrefixes: [],
      };
      expect(checkShellCommand('cat *', ws, policy, { allowedRoots: [ws] }).action).toBe('ask');
      expect(checkShellCommand('ls *.ts', ws, policy, { allowedRoots: [ws] }).action).toBe('allow');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('H6: brace expansion', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('простые {a,b} раскрываются до проверки', () => {
    expect(check('cat /etc/shad{ow,}').action).toBe('deny');
    expect(check('cp /etc/shadow{,.bak}').action).toBe('deny');
    expect(check('ls file{1,2}.txt').action).toBe('allow');
  });

  it('неподдерживаемая форма — ask', () => {
    expect(check('ls file{1..3}').action).toBe('ask');
  });
});

describe('H7: /proc/<pid>/root/<path>', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('алиас проверяется как путь', () => {
    expect(check('cat /proc/1/root/etc/shadow').action).toBe('deny');
    expect(check('cat /proc/1/root/etc/hosts').action).toBe('allow');
    expect(check('cat /proc/self/root/etc/passwd').action).toBe('deny');
  });
});

describe('H8: позиционные параметры', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('$1/$@/$* — неизвестная динамика-путь → ask', () => {
    expect(check('cat $1').action).toBe('ask');
    expect(check('cat $@').action).toBe('ask');
    expect(check('cat $*').action).toBe('ask');
  });

  it('$? / $$ — не пути', () => {
    expect(check('echo $?').action).toBe('allow');
    expect(check('echo $$').action).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// F: общий скан встроенных команд + точечные фиксы
// ---------------------------------------------------------------------------

describe('F: EMBEDDED_EXECUTORS — строка-команда/код проверяется рекурсивно', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('code/команда под встроенным исполнителем → deny', () => {
    const cases = [
      "env -S 'cat /etc/shadow'",
      "sudo -s 'cat /etc/shadow'",
      "nice -n5 sh -c 'cat /etc/shadow'",
      "flock /tmp/l -c 'cat /etc/shadow'",
      `php -r 'readfile("/etc/shadow")'`,
      `node --eval 'require("fs").readFileSync("/etc/shadow")'`,
      `python3.11 -c 'print(open("/etc/shadow").read())'`,
      "su -c 'cat /etc/shadow'",
      "runuser -c 'cat /etc/shadow'",
      'doas cat /etc/shadow',
      "chroot / sh -c 'cat /etc/shadow'",
      "unshare -r sh -c 'cat /etc/shadow'",
      "nsenter -t 1 -m sh -c 'cat /etc/shadow'",
      "script -qec 'cat /etc/shadow' /dev/null",
      "ssh host 'cat /etc/shadow'",
      "systemd-run --scope /bin/sh -c 'cat /etc/shadow'",
      `node20 -e 'require("fs").readFileSync("/etc/shadow")'`,
      "cat list | xargs -I{} sh -c 'cat ${1}' _ {}",
      // длинные/слитные формы code-флагов
      "env --split-string='cat /etc/shadow'",
      "env -S'cat /etc/shadow'",
      `node -p "require('fs').readFileSync('/etc/shadow','utf8')"`,
      `node --eval='require("fs").readFileSync("/etc/shadow")'`,
    ];
    for (const cmd of cases) expect(check(cmd).action).not.toBe('allow');
  });

  it('легитимные команды под исполнителями не ломаются', () => {
    const cases = [
      'env',
      'command -v git',
      'timeout 5 npm test',
      'nice -n 5 ls',
      'stdbuf -oL ls',
      'xargs -n1 echo',
      "ssh host 'ls -la'",
      "script -qec 'ls' /dev/null",
      "python3 -c 'print(1)'",
      'node -e "console.log(1)"',
      "awk '{print $1}' file",
      'find . -exec cat {} ;',
      'npm test > /tmp/out 2>&1',
      'timeout 30 pnpm test',
      'env NODE_ENV=test pnpm test',
      "find . -name '*.ts' -print",
      "awk -F: '{print $1}' /etc/hosts",
      'watch -n2 date',
      "nice -n 10 timeout 60 bash -c 'echo hi'",
      'command git status',
      'exec 3>/dev/null',
      'flock /tmp/l npm test',
      "echo 'a > b' > /tmp/f",
      "curl 'https://x/?a=1&b=2' > /tmp/o",
      "grep -E 'a|b' file",
      "awk -F'|' '{print $2}' file",
    ];
    for (const cmd of cases) expect(check(cmd).action).toBe('allow');
  });
});

describe('F: точечные фиксы (nice/flock/find/proc/позиционные)', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY, { allowedRoots: [CWD] });

  it('nice: -n5/--adjustment/--adjustment=/ -5 — опции, не команда', () => {
    const deny = [
      "nice -n5 sh -c 'cat /etc/shadow'",
      "nice --adjustment=5 sh -c 'cat /etc/shadow'",
      "nice --adjustment 5 sh -c 'cat /etc/shadow'",
      "nice -5 sh -c 'cat /etc/shadow'",
    ];
    for (const cmd of deny) expect(check(cmd).action).toBe('deny');
    expect(check('nice -n 5 ls').action).toBe('allow');
  });

  it('flock: -c/--command — код; lockfile — путь', () => {
    expect(check("flock /tmp/l -c 'cat /etc/shadow'").action).toBe('deny');
    expect(check("flock /tmp/l --command 'cat /etc/shadow'").action).toBe('deny');
    expect(check("flock /etc/shadow -c 'ls'").action).toBe('deny');
    expect(check('flock /tmp/l npm test').action).toBe('allow');
  });

  it('find: динамический стартовый путь → ask', () => {
    expect(check('find $(pwd)/.. -delete').action).toBe('ask');
    expect(check('find `pwd`/.. -name "*.tmp" -delete').action).toBe('ask');
    expect(check("find . -name '*.tmp' -delete").action).toBe('allow');
  });

  it('/proc/<pid>/cwd/<path> — алиас пути', () => {
    expect(check('cat /proc/1/cwd/etc/shadow').action).toBe('deny');
    expect(check('cat /proc/self/cwd/etc/passwd').action).toBe('deny');
    expect(check('cat /proc/1/cwd/etc/hosts').action).toBe('allow');
    // `..` после root/cwd не съедается лексической нормализацией
    expect(check('cat /proc/self/root/../../etc/shadow').action).toBe('deny');
    expect(check('cat /proc/1/root/../etc/shadow').action).toBe('deny');
  });

  it('${1}/${@}/${*}/${10}/${0} — ask; $?/$$/$! — allow', () => {
    for (const token of ['${1}', '${@}', '${*}', '${10}', '${0}']) {
      expect(check(`cat ${token}`).action).toBe('ask');
    }
    expect(check('echo $?').action).toBe('allow');
    expect(check('echo $$').action).toBe('allow');
    expect(check('echo $!').action).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// A–E: shell-префиксы, приклеенные опции, контейнеры, cd-периметр, ложные ask
// ---------------------------------------------------------------------------

describe('A: shell-префиксы перед командой', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('! / time / { } / ( ) / if / while / for / case → проверяется вложенная', () => {
    const cases = [
      "! bash -c 'cat /etc/shadow'",
      "time sh -c 'cat /etc/shadow'",
      "time -p sh -c 'cat /etc/shadow'",
      "{ sh -c 'cat /etc/shadow'; }",
      "( sh -c 'cat /etc/shadow' )",
      'time find /etc -name x -delete',
      "! awk 'BEGIN{system(\"cat /etc/shadow\")}'",
    ];
    for (const cmd of cases) expect(check(cmd).action).not.toBe('allow');
  });

  it('легитимные префиксы не ломаются', () => {
    expect(check('time ls').action).toBe('allow');
    expect(check('{ ls; }').action).toBe('allow');
    expect(check('( cd /tmp && ls )').action).toBe('allow');
    expect(check('if true; then ls; fi').action).toBe('allow');
  });
});

describe('B: приклеенные опции-исполнители', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('opts с кодом/маркером → deny', () => {
    expect(check("ssh -oProxyCommand='cat /etc/shadow' host").action).toBe('deny');
    expect(check("ssh -oLocalCommand='cat /etc/shadow' host").action).toBe('deny');
    expect(check("script -qec'cat /etc/shadow' /dev/null").action).toBe('deny');
    expect(check(`perl -E'open F,"/etc/shadow"'`).action).toBe('deny');
    expect(check(`node -p'require("fs").readFileSync("/etc/shadow")'`).action).toBe('deny');
  });

  it('легитимные опции — allow', () => {
    expect(check("ssh -o StrictHostKeyChecking=no host 'ls'").action).toBe('allow');
    expect(check("script -qec 'ls' /dev/null").action).toBe('allow');
  });
});

describe('C: контейнерные исполнители и код в опциях инструментов', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('docker/kubectl/podman с shell-кодом → deny', () => {
    expect(check("docker exec c sh -c 'cat /etc/shadow'").action).toBe('deny');
    expect(check("kubectl exec -it pod -- sh -c 'cat /etc/shadow'").action).toBe('deny');
    expect(check("podman run --rm img sh -c 'cat /etc/shadow'").action).toBe('deny');
  });

  it('форматы/переменные контейнеров — allow', () => {
    expect(check('docker run -e "A=b c" img').action).toBe('allow');
    expect(check("kubectl exec -it pod -- sh -c 'ls'").action).toBe('allow');
    expect(check("docker ps --format '{{.Names}}'").action).toBe('allow');
  });

  it('git -c / tar --to-command / rsync -e → deny', () => {
    expect(check("git -c core.pager='cat /etc/shadow' log").action).toBe('deny');
    expect(check("tar --to-command='cat /etc/shadow' -xf a.tar").action).toBe('deny');
    expect(check("rsync -e 'cat /etc/shadow' a b").action).toBe('deny');
  });
});

describe('D: периметр cd/pushd/env -C/chroot', () => {
  const DATA = '/var/synth/data';
  const policy: ShellPolicy = {
    ...TEST_POLICY,
    deniedPrefixes: [...TEST_POLICY.deniedPrefixes, `${DATA}/secrets`],
  };
  const check = (cmd: string) => checkShellCommand(cmd, CWD, policy, { allowedRoots: [CWD] });

  it('cd меняет cwd для последующих сегментов', () => {
    expect(check('cd ~ && cat .ssh/id_rsa').action).toBe('deny');
    expect(check('cd / && cat etc/shadow').action).toBe('deny');
    expect(check(`cd ${DATA} && cat secrets/master.key`).action).toBe('deny');
    expect(check('cd /tmp && cat /etc/hosts').action).toBe('allow');
    expect(check('( cd /; cat etc/shadow )').action).toBe('deny');
  });

  it('env -C / chroot передают cwd в рекурсию', () => {
    expect(check(`env -C ${DATA} cat secrets/master.key`).action).toBe('deny');
    expect(check('chroot /etc cat shadow').action).toBe('deny');
    expect(check(`env -C ${DATA} sh -c 'cat secrets/master.key'`).action).toBe('deny');
    expect(check(`env --chdir ${DATA} sh -c 'cat secrets/master.key'`).action).toBe('deny');
    expect(check(`sudo -D ${DATA} sh -c 'cat secrets/master.key'`).action).toBe('deny');
  });

  it('динамический cd: bindings раскрываются, нерезолвимое — ask', () => {
    expect(check(`D=${DATA}; cd $D && cat secrets/master.key`).action).toBe('deny');
    expect(check('D=/tmp; cd $D && ls').action).toBe('allow');
    expect(check(`cd $(echo ${DATA}) && cat secrets/master.key`).action).not.toBe('allow');
    expect(check(`pushd $(echo ${DATA}) && cat secrets/master.key`).action).not.toBe('allow');
    expect(check('cd $(echo /tmp)').action).toBe('ask');
    expect(check('cd $(pwd)').action).toBe('ask');
    // `$(...)` не даёт срезать закрывающую скобку как групповую
    expect(check(`cd "$(echo ${DATA})" && cat secrets/master.key`).action).not.toBe('allow');
  });
});

describe('E: ложные ask (brace-форматы, тест-контекст)', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('{{…}} и скобки без запятой — литерал, не brace-expansion', () => {
    expect(check("docker ps --format '{{.Names}}'").action).toBe('allow');
    expect(check("kubectl get pods -o jsonpath='{.items[*].name}'").action).toBe('allow');
  });

  it('$VAR в тест-контексте — значение, не путь', () => {
    expect(check('[[ "$a" > "$b" ]]').action).toBe('allow');
    expect(check('test "$a" -gt 2').action).toBe('allow');
    expect(check('if [ -f "$f" ]; then').action).toBe('allow');
    // вне тест-контекста — по-прежнему ask
    expect(check('cat $X').action).toBe('ask');
  });

  it('find -path осознанно остаётся ask', () => {
    expect(check("find . -name '*.ts' -not -path './node_modules/*'").action).toBe('ask');
  });
});

describe('stdin-код: heredoc/herestring для shell/интерпретаторов', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('<< / <<- / <<< перед shell/интерпретатором → ask', () => {
    expect(check("bash <<< 'cat /etc/shadow'").action).toBe('ask');
    expect(check('sh <<EOF\ncat /etc/shadow\nEOF').action).toBe('ask');
    expect(check("python3 <<EOF\nprint(open('/etc/shadow').read())\nEOF").action).toBe('ask');
    expect(check('sh <<-EOF\ncat /etc/shadow\nEOF').action).toBe('ask');
  });

  it('heredoc/herestring для обычных команд не трогаем', () => {
    expect(check('cat <<EOF > /tmp/f').action).toBe('allow');
    expect(check("cat <<< 'hello'").action).toBe('allow');
    expect(check('grep <<< "$x"').action).toBe('allow');
  });
});

describe('динамическое имя команды: раскрытие простых значений', () => {
  const check = (cmd: string) => checkShellCommand(cmd, CWD, TEST_POLICY);

  it('точная команда владельца (for t in …; do "$t" --version) → allow', () => {
    const cmd = 'echo "HOME=$HOME USER=$(id -un)"; for t in ansible ansible-vault kubectl helm just git; do printf \'%-14s\' "$t"; command -v "$t" >/dev/null 2>&1 && ($t --version 2>&1 | head -1) || echo MISSING; done; echo \'--- tmp/ проекта ---\'; ls -la tmp';
    expect(check(cmd).action).toBe('allow');
  });

  it('for-цикл с простыми значениями → allow', () => {
    expect(check('for t in ansible kubectl; do "$t" --version; done').action).toBe('allow');
  });

  it('раскрытые значения проверяются как команды', () => {
    expect(check('C=rm; $C -rf /').action).toBe('deny');
    expect(check('C=cat; $C /etc/shadow').action).toBe('deny');
    expect(check("C=/bin/sh; $C -c 'cat /etc/shadow'").action).toBe('deny');
  });

  it('значения с пробелами/метасимволами и неизвестная динамика → ask', () => {
    const r = check("C='cat /etc/shadow'; $C");
    expect(r.action).toBe('ask');
    expect(r.messageId).toBe('ask-dynamic-command');
    expect(check("C='rm -rf /'; eval $C").action).toBe('ask');
    expect(check('X=$(which ls); $X').action).toBe('ask');
    expect(check('cat $X').action).toBe('ask');
    expect(check('for c in cat; do $c $1; done').action).toBe('ask');
  });
});
