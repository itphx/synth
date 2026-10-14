import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PermissionEvaluator } from './evaluator.js';
import type { PermissionConfig, SessionMode, PlanMode } from '@itphx/synth-shared';

/**
 * AD-075/AD-029 (fail-closed): путь ВНЕ рабочего каталога проекта не должен
 * молча разрешаться. Абсолютные пути и разворачивание `~`/`$HOME`/`$PWD`
 * (resolvePath) подпадают под `permission.rules.external_directory`; при
 * отсутствии явного правила дефолт — `ask` (требуется подтверждение), в
 * plan/strict — `deny`. Пути внутри workspace не затрагиваются.
 */

const CWD = '/workspace/project';
const HOME = homedir();

function check(
  toolName: string,
  params: Record<string, unknown>,
  opts: {
    config?: PermissionConfig;
    sessionMode?: SessionMode;
    planMode?: PlanMode;
    planApproved?: boolean;
  } = {},
) {
  return new PermissionEvaluator(opts.config ?? { rules: {}, askTimeoutMs: 30_000 }).check({
    toolName,
    params,
    workingDir: CWD,
    sessionMode: opts.sessionMode ?? 'act',
    planMode: opts.planMode ?? 'auto',
    planApproved: opts.planApproved ?? false,
  });
}

describe('external_directory — fail-closed по умолчанию (act)', () => {
  it('read_file с абсолютным путём вне workspace → ask (не allow)', () => {
    const d = check('read_file', { file_path: '/etc/hosts' });
    expect(d.action).toBe('ask');
    expect(d.matchedRule).toBe('external_directory.default');
  });

  it('write_file / edit_file / delete_file / create_directory вне workspace → ask', () => {
    expect(check('write_file', { file_path: '/tmp/out.txt', content: 'x' }).action).toBe('ask');
    expect(check('edit_file', { file_path: '/tmp/out.txt', old_string: 'a', new_string: 'b' }).action).toBe('ask');
    expect(check('delete_file', { file_path: '/tmp/out.txt' }).action).toBe('ask');
    expect(check('create_directory', { path: '/tmp/newdir' }).action).toBe('ask');
  });

  it('`~` разворачивается в HOME и тоже попадает под external_directory', () => {
    const d = check('read_file', { file_path: '~/notes.txt' });
    expect(d.action).toBe('ask');
    expect(d.matchedRule).toBe('external_directory.default');

    const dollar = check('read_file', { file_path: '$HOME/notes.txt' });
    expect(dollar.action).toBe('ask');
  });

  it('$PWD/.. (выход вверх) → ask', () => {
    const d = check('read_file', { file_path: '$PWD/../sibling.txt' });
    expect(d.action).toBe('ask');
  });
});

describe('external_directory — пути внутри workspace не затрагиваются', () => {
  it('относительный и абсолютный путь внутри workingDir → allow без правил', () => {
    expect(check('read_file', { file_path: 'a.txt' }).action).toBe('allow');
    expect(check('read_file', { file_path: join(CWD, 'a.txt') }).action).toBe('allow');
    expect(check('write_file', { file_path: 'src/a.ts', content: 'x' }).action).toBe('allow');
    expect(check('delete_file', { file_path: 'a.txt' }).action).toBe('allow');
    expect(check('list_directory', { path: '.' }).action).toBe('allow');
    expect(check('list_directory', { path: join(CWD, 'src') }).action).toBe('allow');
    expect(check('create_directory', { path: 'new' }).action).toBe('allow');
  });

  it('execute_shell без cwd или с cwd внутри workspace → allow', () => {
    expect(check('execute_shell', { command: 'ls' }).action).toBe('allow');
    expect(check('execute_shell', { command: 'ls', cwd: 'sub' }).action).toBe('allow');
    expect(check('execute_shell', { command: 'ls', cwd: CWD }).action).toBe('allow');
  });
});

describe('external_directory — явное правило имеет приоритет', () => {
  it('внешний путь → deny по правилу {"*":"deny"}', () => {
    const cfg: PermissionConfig = { rules: { external_directory: { '*': 'deny' } }, askTimeoutMs: 30_000 };
    const d = check('read_file', { file_path: '/etc/hosts' }, { config: cfg });
    expect(d.action).toBe('deny');
    expect(d.matchedRule).toBe('external_directory.*');
    // внутри workspace правило не применяется
    expect(check('read_file', { file_path: 'a.txt' }, { config: cfg }).action).toBe('allow');
  });

  it('внешний путь → allow по правилу {"*":"allow"}', () => {
    const cfg: PermissionConfig = { rules: { external_directory: { '*': 'allow' } }, askTimeoutMs: 30_000 };
    expect(check('read_file', { file_path: '/etc/hosts' }, { config: cfg }).action).toBe('allow');
  });

  it('паттерн /tmp/* работает, непокрытый путь → ask (fallback)', () => {
    const cfg: PermissionConfig = { rules: { external_directory: { '/tmp/*': 'allow' } }, askTimeoutMs: 30_000 };
    expect(check('read_file', { file_path: '/tmp/x.txt' }, { config: cfg }).action).toBe('allow');
    expect(check('read_file', { file_path: '/etc/hosts' }, { config: cfg }).action).toBe('ask');
  });

  it('правило тула приоритетнее external_directory', () => {
    const cfg: PermissionConfig = {
      rules: { read_file: { '/etc/hosts': 'allow' } },
      askTimeoutMs: 30_000,
    };
    expect(check('read_file', { file_path: '/etc/hosts' }, { config: cfg }).action).toBe('allow');
  });

  it('"*":"allow" не ослабляет external_directory-дефолт для внешних путей', () => {
    const cfg: PermissionConfig = { rules: { '*': 'allow' }, askTimeoutMs: 30_000 };
    expect(check('read_file', { file_path: '/etc/hosts' }, { config: cfg }).action).toBe('ask');
    expect(check('read_file', { file_path: 'a.txt' }, { config: cfg }).action).toBe('allow');
  });
});

describe('external_directory — execute_shell cwd вне workspace', () => {
  it('без правил cwd вне workspace → ask', () => {
    const d = check('execute_shell', { command: 'ls', cwd: '/elsewhere' });
    expect(d.action).toBe('ask');
    expect(d.matchedRule).toBe('external_directory.default');
  });

  it('правило external_directory {"*":"deny"} → deny для cwd вне workspace', () => {
    const cfg: PermissionConfig = { rules: { external_directory: { '*': 'deny' }, '*': 'allow' }, askTimeoutMs: 30_000 };
    expect(check('execute_shell', { command: 'ls', cwd: '/elsewhere' }, { config: cfg }).action).toBe('deny');
  });
});

describe('external_directory — режимы (plan/yolo)', () => {
  it('plan: чтение вне workspace → deny (fail-closed)', () => {
    const d = check('read_file', { file_path: '/etc/hosts' }, { sessionMode: 'plan' });
    expect(d.action).toBe('deny');
    expect(d.matchedRule).toBe('external_directory.default');
    // внутри workspace чтение в plan по-прежнему разрешено
    expect(check('read_file', { file_path: 'a.txt' }, { sessionMode: 'plan' }).action).toBe('allow');
  });

  it('strict без утверждённого плана → deny, с утверждённым → ask', () => {
    expect(check('read_file', { file_path: '/etc/hosts' }, { planMode: 'strict', planApproved: false }).action).toBe('deny');
    expect(check('read_file', { file_path: '/etc/hosts' }, { planMode: 'strict', planApproved: true }).action).toBe('ask');
  });

  it('plan_mode off → ask (рестрикция не активна)', () => {
    const d = check('read_file', { file_path: '/etc/hosts' }, { sessionMode: 'plan', planMode: 'off' });
    expect(d.action).toBe('ask');
  });

  it('yolo: ask автоподтверждается → allow; deny-правило остаётся deny', () => {
    expect(check('read_file', { file_path: '/etc/hosts' }, { sessionMode: 'yolo' }).action).toBe('allow');
    const cfg: PermissionConfig = { rules: { external_directory: { '*': 'deny' } }, askTimeoutMs: 30_000 };
    expect(check('read_file', { file_path: '/etc/hosts' }, { sessionMode: 'yolo', config: cfg }).action).toBe('deny');
  });

  it('HOME-путь в plan → deny (вектор `~` закрыт и в plan)', () => {
    const d = check('read_file', { file_path: '~/secret.txt' }, { sessionMode: 'plan' });
    expect(d.action).toBe('deny');
  });

  it('HOME не совпадает с workspace (предпосылка теста)', () => {
    expect(HOME).not.toBe(CWD);
  });
});

describe('external_directory — обратная совместимость (паттерн тула внутри workspace)', () => {
  it('файловое правило тула по относительному паттерну продолжает работать', () => {
    const cfg: PermissionConfig = { rules: { read: { '*': 'allow', '*.env': 'ask' } }, askTimeoutMs: 30_000 };
    expect(check('read_file', { file_path: '.env' }, { config: cfg }).action).toBe('ask');
    expect(check('read_file', { file_path: 'src/main.ts' }, { config: cfg }).action).toBe('allow');
  });
});

describe('external_directory — граничные случаи путей', () => {
  it('путь-сиблинг с общим префиксом ("<cwd>-evil") считается внешним', () => {
    const sibling = `${CWD}-evil/x.txt`;
    const d = check('read_file', { file_path: sibling });
    expect(d.action).toBe('ask');
    expect(d.matchedRule).toBe('external_directory.default');
  });

  it('сам workingDir и нормализованные внутренние пути ("sub/../a") — внутри', () => {
    expect(check('list_directory', { path: CWD }).action).toBe('allow');
    expect(check('read_file', { file_path: `${CWD}/sub/../a.txt` }).action).toBe('allow');
    expect(check('read_file', { file_path: 'sub/../a.txt' }).action).toBe('allow');
  });

  it('выход вверх из workspace ("..") — внешний путь → ask', () => {
    expect(check('read_file', { file_path: '../other.txt' }).action).toBe('ask');
    expect(check('read_file', { file_path: 'sub/../../other.txt' }).action).toBe('ask');
  });

  it('подкаталог workspace не путается с родителем', () => {
    // внутри подкаталога
    expect(check('list_directory', { path: `${CWD}/nested/deep` }).action).toBe('allow');
    // родитель workspace — уже внешний
    expect(check('list_directory', { path: '/workspace' }).action).toBe('ask');
  });
});
