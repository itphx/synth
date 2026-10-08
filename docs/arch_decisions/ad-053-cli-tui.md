# AD-053: CLI и TUI

> **Статус:** ⏳ Не реализовано (проект)
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D8, идея 8; прототип `~/dev/aic/t11/synth-cli/`).
> **Связано:** [AD-023](./ad-023-configuration.md), [AD-038](./ad-038-npm-packages.md),
> [AD-042](./ad-042-hybrid-mode.md), [AD-046](./ad-046-skills-and-slash-commands.md),
> [AD-079](./ad-079-local-home-independent-instances.md).

**Решение:** навести порядок в CLI и расширить интерфейс:

- **паритет двух интерфейсов** — публикуемый CLI (`@itphx/synth`) и dev-CLI (`@itphx/synth-core`) должны
  предоставлять согласованный набор команд;
- сделать CLI **клиентом API v2** (а не только локальным процессом);
- добавить **TUI** (полноэкранный терминальный интерфейс).

## Контекст

### Что уже есть

- Два расходящихся CLI:
  - `packages/synth/src/cli.ts` — публикуемый: `serve`, `connect`, `disconnect`, `publish`, `fork`, `chat`,
    `show`, `add`, `list`, `delete`, `audit`, `secrets`; **нет** `config`, `session`, `update`;
  - `packages/core/src/main.ts` — богаче: дополнительно `config`, `update`, `session`, `secrets`.
- REPL есть (команда `chat`, на `node:readline`); **TUI нет**; зависимостей `blessed`/`ink` нет.
- В прототипе t11 CLI богаче: `~/dev/aic/t11/synth-cli/` (chunker/embeddings/git/session).

### Проблема

Пользователь публикуемого пакета и разработчик получают разные наборы команд; поведение расходится.
CLI не является полноценным клиентом удалённого API v2 (хотя гибрид это позволяет). Нет полноэкранного
терминального интерфейса для работы без браузера.

## Детали

### Паритет CLI

- Свести наборы команд двух CLI к согласованному; определить, что публично, что dev-only.
- Устранить расхождения в опциях/поведении (`config`/`session`/`update`, флаги home/профилей и т. п.).

### CLI как клиент API v2

- Команды работают с удалённым сервером через API v2 (как UI), а не только с локальным `dataDir`.
- Учесть аутентификацию (ключ/OIDC, [AD-043](./ad-043-unified-identity-login.md)) и гибрид
  ([AD-042](./ad-042-hybrid-mode.md)); пути/конфиг — через [AD-023](./ad-023-configuration.md) и
  home-раскладку [AD-079](./ad-079-local-home-independent-instances.md).
- Согласовать со slash-командами скиллов ([AD-046](./ad-046-skills-and-slash-commands.md)) в интерактивном
  режиме.

### TUI

- Полноэкранный интерфейс (сессии/сообщения/статус) — новая зависимость (`blessed`/`ink`), вопрос о
  необходимости и стеке открыт.
- Публикация остаётся в рамках [AD-038](./ad-038-npm-packages.md) (тонкая `@itphx/synth`).

## Статус реализации в коде

**Не реализовано.**

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- `packages/synth/src/cli.ts`: команды `serve`, `connect`, `disconnect`, `publish`, `fork`, `chat`, `show`,
  `add`, `list`, `delete`, `audit`, `secrets`.
- `packages/core/src/main.ts`: дополнительно `config` (`:468`), `update` (`:607`), `session` (`:666`).
- REPL реализован через `node:readline` (`cli.ts:719`, `main.ts:557`); TUI нет.
- Зависимостей `blessed`/`ink` (и `node-pty`/`xterm`) в `package.json` нет.

> Расхождения подтверждены; перечень команд может меняться — при реализации сверить актуальные `cli.ts`
> и `main.ts`.

## Открытые вопросы

- Единый CLI или два (публикуемый + dev)?
- TUI-стек (`blessed`/`ink`) — новая зависимость, нужна ли?
- Какие команды считать публичным контрактом, а какие dev-only?

## Связи

- [AD-023](./ad-023-configuration.md) «Конфигурация» — флаги/env/приоритеты CLI.
- [AD-038](./ad-038-npm-packages.md) «npm-пакеты» — публикуемая тонкая CLI-обёртка.
- [AD-042](./ad-042-hybrid-mode.md) «Гибридный режим» — работа CLI с удалённым сервером.
- [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — `/`-команды в интерактивном CLI.
- [AD-079](./ad-079-local-home-independent-instances.md) «Локальный home» — пути и изоляция инстансов.
- [AD-043](./ad-043-unified-identity-login.md) «Единая идентичность» — аутентификация как клиента API.
- Смежные черновики: D19/AD-064 (встроенные терминал/браузер в UI).
