# ADR-132: Встроенный терминал — PTY на точке исполнения, вкладка в UI

> **Статус:** ✅ Реализовано
> **Дата:** 2026-11-16
> **Источник:** PROP-132 (принят 2026-11-16; файл удалён после принятия).
> **Связано:** [ADR-019](./adr-019-react-spa.md), [ADR-024](./adr-024-eventhub-transport.md),
> [ADR-029](./adr-029-granular-permissions.md), [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md),
> [ADR-075](./adr-075-project-workspace-provisioning.md), [ADR-113](./adr-113-background-processes.md),
> [ADR-114](./adr-114-git-worktrees.md), [ADR-126](./adr-126-input-surface-commands-mentions-snippets.md),
> [ADR-135](./adr-135-execution-contour.md), [ADR-136](./adr-136-shell-trust.md),
> [ADR-137](./adr-137-executor-isolation.md), [ADR-140](./adr-140-project-access-sharing.md).

## Контекст

Интерактивного shell в продукте не было: `execute_shell` — односторонний запуск с таймаутом,
фоновые процессы ([ADR-113](./adr-113-background-processes.md)) — неинтерактивный реестр, а порт
исполнения ([ADR-135](./adr-135-execution-contour.md)) вовсе не умел `stdin`/PTY. При этом человек
и агент работают в одном рабочем каталоге ([ADR-075](./adr-075-project-workspace-provisioning.md)),
и задачи «покрутить TUI», «посмотреть на процесс», «дать агенту живой терминал» без PTY не
выполнимы. Терминал как побочный продукт `execute_shell` тоже не годился: интерактивность,
живучесть и мультиклиент требуют отдельного контура.

## Решение

1. **PTY — на точке исполнения.** Порт исполнения получает PTY-возможность (`ExecutionPort.openPty`),
   исполнитель — протокол PTY (`features.pty`, маршруты `/pty/*`); без поддержки — честный отказ
   (`EPTY`), без тихого фоллбека. Иначе терминал и `execute_shell` смотрели бы в разные ФС.
   Провайдер — `@homebridge/node-pty-prebuilt-multiarch` (ленивый `import()`); в образе — zsh +
   Oh My Zsh (пин-коммит) с темой `synth`, bash доступен, tmux ≥ 3.3 — **только ручной запуск
   внутри терминала**, не backend. В flavor'е `browser` PTY нет (там Chromium/Playwright).
2. **Владение — проектное, привязка к сессии опциональна.** Терминал принадлежит проекту;
   привязка к сессии даёт cwd = worktree сессии ([ADR-114](./adr-114-git-worktrees.md)) → иначе
   `project.workspace`, и переход «терминал → сессия» в шапке.
3. **Лимиты:** 8 живых терминалов на проект и 32 на инстанс (`terminal.maxPerProject` /
   `terminal.maxPerInstance`).
4. **Права — на границе, по роли проекта.** Чтение (`GET`) — `canReadProject`; запись
   (`input`/`resize`/`rename`/`delete`) — `canEditProjectContent` ([ADR-140](./adr-140-project-access-sharing.md));
   в DTO терминала — `can_write`. Ввод разрешён любому с write (мультиклиент).
5. **Тулы агента** ([ADR-029](./adr-029-granular-permissions.md)): capability `terminal` (отдельная
   от `shell`) — `terminal_list|open|read|snapshot|write|signal|close|run`; в plan-режиме — только
   чтение. `terminal_run` — один тул с параметром `background` (по умолчанию — с ожиданием),
   `terminal_write {enter:true}` проходит `checkShellCommand`; все операции — в аудит
   ([ADR-136](./adr-136-shell-trust.md)). `terminal_snapshot` — «экран вместо потока» (TUI-программы),
   `terminal_signal` — управляющие сигналы (`^C`/`^\`/`^Z`); в полноэкранном приложении
   `terminal_run` запрещён (терминал занят) — работа через `terminal_write` + `terminal_snapshot`.
6. **Живучесть — только PTY.** Терминал без подписчиков и без привязки к активной сессии закрывается
   по простою (`terminal.idleMinutes`, по умолчанию 2 дня); пока терминал жив, control plane раз в
   5 минут шлёт heartbeat пулу исполнителей (пул живёт по своему idle-таймауту). Перезапуск ядра/пода
   убивает терминал: остаются снимки (`terminals/<id>/meta.json` + `output.txt`), из них терминал
   восстанавливается (`terminal.autoRestore`, по умолчанию включено) и показывается завершённым;
   «Перезапустить» (`POST /terminals/:id/restart`) поднимает новый.
7. **Настройки** — секция `terminal.*` в `config.yaml`/env и в UI: приоритет **env > runtime
   (`settings.json`/PG) > `config.yaml` > дефолт**; применяется live. Мастер-выключатель
   `terminal.enabled`; при выключении `/api/v2/terminals*` → `403 TERMINALS_DISABLED`, живые
   терминалы закрываются, capability `terminal` модели недоступна.
8. **UI.** Вкладка `terminal` центральной области ([ADR-019](./adr-019-react-spa.md)): эмулятор
   xterm.js, вкладка-сессия с переключателем по терминалам сессии, карточки терминалов — во
   вкладке «Фоновые процессы» правой панели, плавающая кнопка — при живом привязанном терминале.
   Темы и шрифт — из `preferences.terminal` профиля (тема «как интерфейс» — маппинг токенов,
   шрифт — стек с Nerd-сабсетом). Мобильный адаптив — по [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md).
9. **Вывод в LLM — только по явному действию человека.** «Спросить агента» отправляет вопрос
   **с отдельным полем `context`** (`{terminal_id, content, cwd?, shell?, status?, lines?, truncated?}`,
   кап 32 КиБ) — сервер кладёт служебное сообщение-контекст **перед** вопросом
   ([docs/MESSAGE_FLOW.md](../MESSAGE_FLOW.md)); «Прикрепить вывод» вставляет блок в формате
   `terminal_read` (`[CONTENT terminal=…]` … `[CONTENT END]`) в черновик композера. Автоматически
   вывод терминала в модель не уходит.

## Альтернативы

- **tmux как backend** — отклонён: терминал переживал бы рестарт ядра, но требовал бы отдельного
  демона на точке исполнения, своей модели сессий/окон и прав — цена несоразмерна; tmux остаётся
  ручным инструментом внутри терминала.
- **Отдельный exec-путь для терминала** (в обход порта исполнения) — отклонён: разошлись бы
  рабочий каталог, containment, лимиты и аудит с `execute_shell` (ADR-135/136).
- **Владение сессией, а не проектом** — отклонён: терминал — рабочее место человека в проекте, он
  переживает сессию и виден всем участникам проекта; привязка к сессии — лишь удобство (cwd, переход).
- **Поток вывода в шине событий** — отклонён: волатильный поток не журналируется и не реплеится,
  а шина — канал метаданных; вывод идёт HTTP-потоком NDJSON, по шине — только
  `terminal.created|updated|exited|deleted`.
- **Блок `<terminal_context>` в тексте вопроса** — отклонён: вывод попадал бы в текст сообщения и
  терял бы отдельную семантику; выбран отдельное поле `context` в теле `POST /sessions/:id/prompt`.

## Последствия и ограничения

- Терминал — **не** замена `execute_shell` и фоновым процессам; переживание рестарта ядра не
  гарантировано (только восстановление из снимка).
- В flavor'е `browser` терминала нет; PTY требует `features.pty` у исполнителя — старый образ
  даёт явный отказ.
- Гибридный форвард PTY между инстансами — вне объёма; контекст терминала пробрасывается как есть.
- Проверено: сквозной сценарий в браузере (вкладка/переключатель/док «Спросить агента»),
  split-режим (control plane ↔ исполнитель, PTY на пуле) и кластерный запуск терминала
  (`readOnlyRootFilesystem`); `terminal_run`, сигналы, snapshot и foreground-классификация
  покрыты тестами.
- Остаточные ограничения: браузерный flavor без PTY; гибридный форвард PTY между инстансами
  не поддерживается; tmux-backend не реализован.

## Статус в коде

- **Порт/провайдер:** `packages/core/src/execution/ports/execution-port.ts` (`openPty`, `PtyHandle`),
  `packages/core/src/execution/pty/*` (провайдер, foreground-классификация).
- **Ядро:** `packages/core/src/engine/terminal/*` (`TerminalService`, кольцевой буфер, снимки,
  аудит, метрики), `packages/core/src/server/routes/terminals.ts`,
  `packages/core/src/server/app/terminal-{service,port}.ts`, `/api/v2/settings/terminal`.
- **Исполнитель:** протокол PTY, `features.pty`, `/pty/*` (`packages/executor/src/pty-{service,client}.ts`).
- **Тулы:** `packages/core/src/engine/tools/terminals.ts`, capability `terminal`.
- **UI:** `packages/ui/src/components/terminal/*` (`TerminalView`, `TerminalSessionView`,
  `TerminalAskDock`, поток, быстрые клавиши), `lib/terminalTabs.ts`, `lib/theme/terminal.ts`,
  `lib/terminalFonts.ts`, `components/settings/TerminalAdminSettings.tsx`.
- **Образ:** tier 6 (`docker/install-tier-6.sh`) — zsh + Oh My Zsh + tmux + `ncurses-term`,
  `/etc/synth/zshrc`, `/etc/synth/tmux.conf`.

Контракты и настройки: [docs/API_V2.md](../API_V2.md) §5.43–5.44, [docs/CONFIGURATION.md](../CONFIGURATION.md)
§«Терминалы», [docs/TOOLS.md](../TOOLS.md) §«Терминалы», [docs/EXECUTION.md](../EXECUTION.md),
[docs/MESSAGE_FLOW.md](../MESSAGE_FLOW.md) §8.33, [docs/OBSERVABILITY.md](../OBSERVABILITY.md).

## История

- 2026-11-16 — принято из PROP-132 (PTY на точке исполнения, проектное владение, лимиты 8/32,
  права read/write, тулы, idle 2 дня + heartbeat 5 мин, снимки/autoRestore, `terminal.*` env>runtime>config,
  вкладка в UI, «Спросить агента» через `context`); файл предложения удалён.
