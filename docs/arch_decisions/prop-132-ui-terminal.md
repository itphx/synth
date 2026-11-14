# PROP-132: Встроенный терминал в UI

> **Статус:** 🧩 Предложение — терминал во вкладке центральной области, список — в «Фоновых процессах»
> **Решение до:** 2026-12-31
> **Дата:** 2026-11-09
> **Источник:** выделено из [PROP-064](./prop-064-agent-browser.md) (2026-11-09); исходная идея — D19/`Фичи.md` (Terminal), 2026-09-16.
> **Связано:** [ADR-019](./adr-019-react-spa.md), [ADR-024](./adr-024-eventhub-transport.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md), [ADR-075](./adr-075-project-workspace-provisioning.md), [ADR-077](./legacy/adr-077-runtime-toolchain.md), [ADR-113](./adr-113-background-processes.md), [ADR-114](./adr-114-git-worktrees.md), [ADR-135](./adr-135-execution-contour.md), [ADR-136](./adr-136-shell-trust.md), [ADR-137](./adr-137-executor-isolation.md), [ADR-140](./adr-140-project-access-sharing.md), [ADR-126](./adr-126-input-surface-commands-mentions-snippets.md)
> **Обновлено:** 2026-11-14 — решения по месту, живучести, правам, агенту, внешнему виду и PTY-провайдеру.

## Решение (предложение)

Терминал — интерактивная shell-сессия, которую видит человек и которой может пользоваться агент. Терминал **принадлежит проекту**, привязка к сессии — опциональна. Исполнение — тем же путём, что `execute_shell`: порт исполнения, permission-слой, containment, лимиты, аудит. Отдельного exec-пути для терминала не появляется — к порту добавляется только PTY-возможность.

Вывод терминала по умолчанию **не отправляется в LLM**: только явное действие человека («Прикрепить вывод» — блок `<terminal_context>` к следующему сообщению).

## Решения владельца

| Вопрос | Решение |
|---|---|
| Где живёт терминал | Новый вид вкладки в центральной области; список живых — карточками в существующей вкладке «Фоновые процессы» правой панели (новая вкладка не заводится), фильтр `all \| процессы \| сабагенты \| терминалы` |
| Привязка к сессии | Опциональна; если терминал привязан — плавающая кнопка справа ведёт в терминал, в шапке терминала — кнопка перехода в сессию. cwd = worktree сессии → `project.workspace` |
| Сколько терминалов | Несколько: лимит 8 на проект и 32 на инстанс |
| Живучесть | Только PTY; tmux как backend не используется (tmux остаётся в образе — ручной запуск внутри терминала). Рестарт ядра/пода убивает терминал: UI показывает «завершён» и «Перезапустить» |
| Права | Видят все с доступом к проекту; read = просмотр, write (`input`/`resize`/`delete`) = `canEditProjectContent`; проверка на сервере, в DTO `can_write`. Ввод разрешён любому с write одновременно (мультиклиент) |
| Агент | Тулы `terminal_list/open/read/write/close`, capability `terminal` (отдельная от `shell`); в plan — только чтение; `terminal_write {enter:true}` проходит `checkShellCommand`; все операции в аудит (ADR-136) |
| Внешний вид | Темы и отдельные настройки (шрифт, размер, межстрочный интервал, курсор, scrollback) — в профиле на сервере (`ProfileData.preferences.terminal`, `PATCH /auth/profile/preferences`), UI кэширует локально; тема «как интерфейс» — маппинг токенов + встроенные терминальные схемы |
| Шрифты | Встроенный `Symbols Nerd Font Mono` (сабсет PUA/Powerline, woff2, ≤ 400 КБ) как fallback терминального стека: powerline-разделители и глифы OMZ/Nerd-тем рисуются одинаково у всех. Лицензии (MIT Nerd Fonts + иконочные) — рядом с ассетом |
| PTY-провайдер | Точка исполнения: inline (core) — `@homebridge/node-pty-prebuilt-multiarch` (точный пин, упаковочный форк upstream, prebuilds, SLSA-provenance); исполнитель — протокол 8 + `features.pty` + `/pty/*`; старый исполнитель → `EPTY`/явный отказ |
| Образ исполнителя | zsh + Oh My Zsh (пин) по умолчанию, bash доступен, tmux ≥ 3.3, `ncurses-term`, продуктовый `/etc/synth/tmux.conf`; local-режим — `terminal.shell` → `$SHELL` → `/bin/bash` |
| Idle | 2 дня без подписчиков и без привязки к активной сессии (настраивается) |
| Гибрид | В MVP — честный отказ (как `DETACH_UNSUPPORTED`); тула `terminal_restart` нет — `close` + `open` |
| Инстанс-выключатель | `terminal.enabled`; приоритет `SYNTH_TERMINAL_ENABLED` (env) > runtime (UI, `settings.json`/PG) > `config.yaml` > дефолт `true`. Применяется live; выключение закрывает живые терминалы и запрещает новые |

Новые зависимости (одобрены): `@homebridge/node-pty-prebuilt-multiarch`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`.

## Контекст

### Что уже есть

- `execute_shell` — bash, `cwd` внутри рабочего каталога, таймаут 120 с, вывод усекается; исполнение через `ExecutionPort` (ADR-077/135), в remote-режиме — на исполнителе.
- Фоновые процессы (`spawnBackground`, ADR-113) — реестр, лог в blob, stop; это **не** интерактивный терминал.
- Правая панель UI: вкладка «Фоновые процессы» (`packages/ui/src/components/panels/ProcessesTab.tsx`) — место карточек терминалов; виды вкладок центральной области — `CenterTabType` (`packages/ui/src/stores/useUIStore.ts`).
- `ProfileData.preferences` и `PATCH /auth/profile/preferences` — серверное хранение настроек профиля.
- PTY/attach в порту исполнения **не реализованы**: `stdin` в контракте отсутствует осознанно (`docs/EXECUTION.md`).

## Архитектура (решения, не спецификация)

### Где живёт PTY

PTY поднимается на точке исполнения — там же, где идут команды; иначе терминал и `execute_shell` смотрели бы в разные ФС. Порт получает PTY-методы, у исполнителя — протокол 8, `features.pty` и маршруты `/pty/*`; без `features.pty` — `EPTY`/`unavailable(dependency)`, без тихого фоллбека.

### Транспорт

- Метаданные — обычные события шины: `terminal.created`, `terminal.updated`, `terminal.exited`, `terminal.deleted`.
- Поток вывода (`terminal.data`) — **новый класс «волатильных» событий**: не журналируются, не реплеятся, дропаются при переполнении очереди; догон — `GET /terminals/:id/output?since=`. Канал тот же (`/ws/events` + SSE-фоллбек) — новых каналов не заводим (инвариант 6), но класс событий фиксируется явно.
- Ввод — HTTP `POST /terminals/:id/input`, resize — HTTP `POST /terminals/:id/resize`; права, аудит и rate limit — на границе (инвариант 16), новых входных WS-кадров нет.

### Инстанс-выключатель

- `SYNTH_TERMINAL_ENABLED` > runtime (`GET/PUT/DELETE /api/v2/settings/terminal`, раздел «Настройки → Терминал», ADMIN) > `terminal.enabled` в config > `true`. Если значение задано env — UI read-only, запись → 409.
- Выключено ⇒ `/api/v2/terminals*` → `403` `TERMINALS_DISABLED`, события `terminal.*` не публикуются, вкладка `terminal` не открывается, живые терминалы закрываются (`terminal.deleted` с причиной `disabled`), карточки и плавающая кнопка скрыты, capability `terminal` недоступна модели (тулы не попадают в промпт).
- На исполнителе — предохранитель `SYNTH_EXECUTOR_PTY=0` → `features.pty: false`.

### UI

- Вкладка `terminal` в центральной области: эмулятор xterm.js (`@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links`), тема и шрифт — из настроек терминала.
- Шапка: имя, статус, «Перезапустить», «Прикрепить вывод», «Спросить агента», «Перейти в сессию», «Закрыть».
- Правая панель: карточки терминалов в «Фоновых процессах» (shell, cwd, статус, привязанная сессия, «Открыть», «Остановить»).
- Плавающая кнопка справа — если у активной сессии есть живой привязанный терминал.
- Мобильный адаптив — по ADR-044: вкладка во всю ширину, ряд спец-клавиш, bracketed paste.
- Шрифты терминала: выбор моноширинного (как у редактора кода) + встроенный `Synth Nerd Symbols`; xterm получает готовый стек `TERMINAL_FONT_STACK`, перед инициализацией — `preloadTerminalFont()`.

### Права и безопасность

- Проверка на сервере, на границе: read = `canReadProject`, write = `canEditProjectContent` (инвариант 21); `VIEWER` — 403 на ввод. Роуты попадают в матрицу доступа (`session-idor-matrix`/`route-access-census`).
- Секреты в выводе не обфусцируются автоматически и не уходят в LLM без явного действия человека.

### Агент

- Тулы `terminal_list/open/read/write/close` с capability `terminal` (отдельной от `shell`); в plan-режиме — только чтение; `terminal_write {enter:true}` проходит `checkShellCommand`; каждая операция — в аудит (ADR-136).
- «Спросить агента из терминала» — горячая клавиша `Ctrl/Cmd+Shift+Enter` (настраивается) или кнопка в шапке: док-композер с автоконтекстом (последние N строк + cwd + shell) → в привязанную сессию или выбранную. В LLM ничего не уходит автоматически.
- «Прикрепить вывод» — блок `<terminal_context>` к следующему сообщению.

### Образ и окружение

Исполнитель: zsh + Oh My Zsh (пин) по умолчанию, bash доступен, tmux ≥ 3.3, `ncurses-term`, продуктовый `/etc/synth/tmux.conf` (tmux — только ручной запуск внутри терминала, не backend). Local-режим: `terminal.shell` → `$SHELL` → `/bin/bash`.

## Что берём из эталонов

- **Openchamber** (`refs/openchamber`) — модель владения: PTY живёт на сервере, клиент владеет только раскладкой вкладок; snapshot-on-attach и реплей на исходном размере; ring buffer на терминал с догоном по курсору.
- **Pi** (`refs/pi-agent-hub`, `refs/pi-tmux`) — дисциплина контрактов, **не** tmux: точный target для write-операций, разведение lifecycle-операций (close/open вместо restart), идемпотентность записи, prune только по подтверждённому отсутствию.
- **dots** (`refs/dots`) — состав образа (zsh + OMZ с пиннингом, tmux ≥ 3.3, ncurses-term, tree/procps) и санитарные настройки tmux (`tmux-256color`, `focus-events`, `set-clipboard`, явный `window-size`).

## Не цели

- Замена `execute_shell` и фоновых процессов (ADR-113).
- Терминал, переживающий рестарт ядра/пода (tmux-backend), и форвард PTY в гибриде — MVP честно отказывает.
- Терминал в мессенджерах и TUI.
- Автоматическая отправка вывода терминала в LLM.

## Статус в коде

**Не реализовано.** Проверено по репозиторию (`packages/**`, без `dist/`/`node_modules/`):

- `execute_shell` есть, PTY/stdin в порту нет (`docs/EXECUTION.md`); протокол исполнителя — 7, PTY-маршрутов и `features.pty` нет.
- xterm.js, `node-pty` и `@homebridge/node-pty-prebuilt-multiarch` не используются; вида вкладки `terminal` нет.
- Событий `terminal.*`, волатильного класса событий и HTTP-роутов `/terminals*` нет; настройки `terminal.enabled` и `/api/v2/settings/terminal` нет.
- Capability `terminal` и тулов `terminal_*` нет; в `ToolCapability` её нет.
- `preferences.terminal`, карточек терминалов в «Фоновых процессах» и «Спросить агента» нет; ассета шрифта, `terminalFonts.ts` и `@font-face` нет.
- zsh/Oh My Zsh/tmux/`ncurses-term` в образе исполнителя нет; `/etc/synth/tmux.conf` нет.
- `!`-shell-режим композера отсутствует (ADR-126) — он ждёт терминал.

## Связи

- [ADR-019](./adr-019-react-spa.md) — SPA и панели UI.
- [ADR-024](./adr-024-eventhub-transport.md) — единый транспорт, без новых каналов.
- [ADR-029](./adr-029-granular-permissions.md) — permissions, plan-режим, capability.
- [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) — мобильный адаптив.
- [ADR-075](./adr-075-project-workspace-provisioning.md) — workspace и containment.
- [ADR-077](./legacy/adr-077-runtime-toolchain.md) — `ExecutionPort` и исполнитель; [ADR-135](./adr-135-execution-contour.md) — контур исполнения.
- [ADR-113](./adr-113-background-processes.md) — фоновые процессы (не PTY, но общий реестр).
- [ADR-114](./adr-114-git-worktrees.md) — worktree сессии как cwd терминала.
- [ADR-136](./adr-136-shell-trust.md) — shell-guard и аудит исполнений; [ADR-137](./adr-137-executor-isolation.md) — изоляция образа.
- [ADR-140](./adr-140-project-access-sharing.md) — права участников проекта.
- [ADR-126](./adr-126-input-surface-commands-mentions-snippets.md) — `!`-shell-режим композера.
- [PROP-064](./prop-064-agent-browser.md) — браузер (выделен из общего документа).

## История

- 2026-11-09 — предложение создано выделением терминальной части из PROP-064; зафиксировано, что PTY живёт на точке исполнения, а поток идёт через существующую шину.
- 2026-11-14 — решения по месту, живучести, правам, агенту, внешнему виду и PTY-провайдеру (исследование refs/openchamber, refs/pi-agent-hub, refs/dots).
