/**
 * Классификация foreground-процесса PTY (`engine/terminal/foreground-class.ts`).
 *
 * Наборы имён — данные (ssh/контейнеры и полноэкранные приложения), а
 * нормализация приводит `comm`/командную строку к одному виду: basename,
 * нижний регистр, без аргументов. От классификации зависит не только запрет
 * `terminal_run`, но и **снятие политики путей** внутри ssh — поэтому
 * проверяются границы: `ssh` vs `sshpass`, регистр, путь, аргументы, пустое
 * значение.
 */
import { describe, it, expect } from 'vitest';
import {
  FULL_SCREEN_COMMANDS,
  REMOTE_SHELL_COMMANDS,
  isFullScreenCommand,
  isRemoteShellCommand,
  normalizeForegroundCommand,
} from './foreground-class.js';

describe('normalizeForegroundCommand', () => {
  it('basename, нижний регистр, без аргументов', () => {
    expect(normalizeForegroundCommand('vim')).toBe('vim');
    expect(normalizeForegroundCommand('Vim')).toBe('vim');
    expect(normalizeForegroundCommand('/usr/bin/vim')).toBe('vim');
    expect(normalizeForegroundCommand('/usr/bin/Vim /etc/hosts')).toBe('vim');
    expect(normalizeForegroundCommand('  ssh   user@host  ')).toBe('ssh');
    expect(normalizeForegroundCommand('C:\\Windows\\notepad.exe')).toBe('notepad.exe');
  });

  it('срезает уточнение /proc/<pid>/comm после «:» и «,»', () => {
    // `/proc/<pid>/comm` у tmux — `tmux: server`: уточнение не часть имени.
    expect(normalizeForegroundCommand('tmux: server')).toBe('tmux');
    expect(normalizeForegroundCommand('/usr/bin/tmux: server')).toBe('tmux');
    expect(normalizeForegroundCommand('docker, exec')).toBe('docker');
    expect(normalizeForegroundCommand('SSH')).toBe('ssh');
    // Уточнение не мешает классификации.
    expect(isFullScreenCommand('tmux: server')).toBe(true);
    expect(isRemoteShellCommand('ssh: user@host')).toBe(true);
    expect(isFullScreenCommand('/usr/bin/top')).toBe(true);
  });

  it('пустое значение/undefined/null → пустая строка (неизвестно)', () => {
    expect(normalizeForegroundCommand()).toBe('');
    expect(normalizeForegroundCommand(null)).toBe('');
    expect(normalizeForegroundCommand('')).toBe('');
    expect(normalizeForegroundCommand('   ')).toBe('');
  });
});

describe('наборы команд', () => {
  it('remote-shell: ssh и контейнерные оболочки', () => {
    for (const name of [
      'ssh',
      'mosh',
      'sshpass',
      'sftp',
      'telnet',
      'docker',
      'podman',
      'nerdctl',
      'kubectl',
      'minikube',
      'oc',
    ]) {
      expect(REMOTE_SHELL_COMMANDS.has(name), name).toBe(true);
      expect(isRemoteShellCommand(name), name).toBe(true);
    }
  });

  it('full-screen: редакторы, пейджеры, мониторы, мультиплексоры', () => {
    for (const name of [
      'vi',
      'vim',
      'nvim',
      'nano',
      'emacs',
      'less',
      'more',
      'most',
      'man',
      'top',
      'htop',
      'btop',
      'nvtop',
      'mc',
      'tmux',
      'screen',
      'watch',
      'fzf',
    ]) {
      expect(FULL_SCREEN_COMMANDS.has(name), name).toBe(true);
      expect(isFullScreenCommand(name), name).toBe(true);
    }
  });

  it('классы не пересекаются и не распознают посторонние команды', () => {
    for (const name of REMOTE_SHELL_COMMANDS) {
      expect(isFullScreenCommand(name), name).toBe(false);
    }
    for (const name of ['bash', 'sleep', 'make', 'npm', 'git', 'ls']) {
      expect(isRemoteShellCommand(name), name).toBe(false);
      expect(isFullScreenCommand(name), name).toBe(false);
    }
  });

  it('классификатор нормализует вход (путь/аргументы/регистр)', () => {
    expect(isRemoteShellCommand('/usr/bin/SSH user@host')).toBe(true);
    expect(isFullScreenCommand('/usr/bin/htop -d 5')).toBe(true);
  });

  it('неизвестное значение — не remote-shell и не full-screen (fail-safe)', () => {
    expect(isRemoteShellCommand(undefined)).toBe(false);
    expect(isRemoteShellCommand('')).toBe(false);
    expect(isFullScreenCommand(null)).toBe(false);
    expect(isFullScreenCommand('some-exotic-tui')).toBe(false);
  });
});
