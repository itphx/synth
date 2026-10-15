# PROP-053: CLI и TUI

> **Статус:** 🧩 Предложение — CLI и TUI: паритет публикуемого и dev-CLI, CLI как клиент API v2
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D8, идея 8; прототип `~/dev/aic/t11/synth-cli/`).
> **Связано:** [ADR-023](./adr-023-configuration.md), [ADR-038](./adr-038-npm-packages.md),
> [ADR-042](./adr-042-hybrid-mode.md), [ADR-046](./adr-046-skills-and-slash-commands.md),
> [ADR-079](./adr-079-local-home-independent-instances.md).

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
- Учесть аутентификацию (ключ/OIDC, [ADR-043](./adr-043-unified-identity-login.md)) и гибрид
  ([ADR-042](./adr-042-hybrid-mode.md)); пути/конфиг — через [ADR-023](./adr-023-configuration.md) и
  home-раскладку [ADR-079](./adr-079-local-home-independent-instances.md).
- Согласовать со slash-командами скиллов ([ADR-046](./adr-046-skills-and-slash-commands.md)) в интерактивном
  режиме.

### TUI

- Полноэкранный интерфейс (сессии/сообщения/статус) — новая зависимость (`blessed`/`ink`), вопрос о
  необходимости и стеке открыт.
- Публикация остаётся в рамках [ADR-038](./adr-038-npm-packages.md) (тонкая `@itphx/synth`).

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

- [ADR-023](./adr-023-configuration.md) «Конфигурация» — флаги/env/приоритеты CLI.
- [ADR-038](./adr-038-npm-packages.md) «npm-пакеты» — публикуемая тонкая CLI-обёртка.
- [ADR-042](./adr-042-hybrid-mode.md) «Гибридный режим» — работа CLI с удалённым сервером.
- [ADR-046](./adr-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — `/`-команды в интерактивном CLI.
- [ADR-079](./adr-079-local-home-independent-instances.md) «Локальный home» — пути и изоляция инстансов.
- [ADR-043](./adr-043-unified-identity-login.md) «Единая идентичность» — аутентификация как клиента API.
- Смежные черновики: D19/PROP-064 (встроенные терминал/браузер в UI).
