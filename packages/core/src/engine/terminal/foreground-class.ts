/**
 * Классификация foreground-процесса PTY (протокол исполнителя 9).
 *
 * `PtyHandle.inspect()` отдаёт **факт** из ядра ОС: какой процесс сейчас на
 * переднем плане терминала (`PtyForeground`). Сам по себе факт — это только
 * имя процесса; сервису терминалов и тулам нужно решение:
 *
 * - **в фокусе оболочка** (`isShell`) — можно запускать обёрнутые команды;
 * - **в фокусе удалённая оболочка** (`ssh`, `docker exec`, `kubectl exec`, …) —
 *   запуск разрешён: маркер завершения текстовый и работает по ту сторону
 *   соединения, а локальные пути политики shell-guard внутри удалённой машины
 *   не значимы;
 * - **в фокусе полноэкранное приложение** (`vim`, `less`, `htop`, `tmux`, …) —
 *   запуск запрещён: TUI перехватывает ввод, маркер не отследить;
 * - **в фокусе что-то ещё** (`sleep`, `make`, `npm`) — терминал занят: команда
 *   ушла бы в stdin чужого процесса, а маркер — в его вывод.
 *
 * Наборы имён — **данные**, а не логика: имена процессов сравниваются без
 * пути, в нижнем регистре и без аргументов (`normalizeForegroundCommand`).
 * Список не претендует на полноту (guardrail, ADR-136): неизвестная программа
 * попадает в «терминал занят» — это безопаснее, чем отправить команду в её
 * stdin.
 */

/**
 * Программы, внутри которых запуск команды безопасен: они открывают
 * собственную оболочку на удалённой машине/в контейнере.
 *
 * `ssh`/`mosh`/`telnet`/`sftp` — сетевые сессии; `docker`/`podman`/`nerdctl`/
 * `kubectl`/`minikube`/`oc` — контейнерные оболочки (`exec`/`run`/`attach`).
 * Маркер завершения запуска — **текстовая строка**, поэтому она доходит и
 * через ssh, и через контейнер (OSC мультиплексоры и удалённые оболочки
 * съедают).
 */
export const REMOTE_SHELL_COMMANDS: ReadonlySet<string> = new Set([
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
]);

/**
 * Полноэкранные приложения (TUI): перехватывают ввод и перерисовывают экран.
 *
 * В них `terminal_run` не работает — строка-маркер либо не выполнится, либо
 * придёт в чужой поток, а терминал останется занятым. Работа там — клавишами
 * (`terminal_write`) и снимком экрана (`terminal_snapshot`).
 */
export const FULL_SCREEN_COMMANDS: ReadonlySet<string> = new Set([
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
]);

/**
 * Нормализовать имя foreground-процесса: basename, нижний регистр, без
 * аргументов.
 *
 * `inspect()` в разных реализациях отдаёт и `comm` (`vim`), и командную строку
 * (`vim /etc/hosts`) — для классификации нужен только исполняемый файл:
 * `"/usr/bin/Vim"` → `vim`, `"ssh user@host"` → `ssh`. Пустое значение/`null` →
 * пустая строка (классификатор ответит «неизвестно»).
 */
export function normalizeForegroundCommand(command?: string | null): string {
  if (typeof command !== 'string') return '';
  const trimmed = command.trim();
  if (trimmed === '') return '';
  const first = trimmed.split(/\s+/)[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? '';
  return base.trim().toLowerCase();
}

/** В фокусе удалённая оболочка/контейнер — запуск команды разрешён. */
export function isRemoteShellCommand(command?: string | null): boolean {
  return REMOTE_SHELL_COMMANDS.has(normalizeForegroundCommand(command));
}

/** В фокусе полноэкранное приложение — запуск команды запрещён. */
export function isFullScreenCommand(command?: string | null): boolean {
  return FULL_SCREEN_COMMANDS.has(normalizeForegroundCommand(command));
}
