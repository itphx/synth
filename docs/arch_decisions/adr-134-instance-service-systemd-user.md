# ADR-134: Сервис инстанса: synth service и systemd --user

> **Статус:** ✅ Реализовано
> **Дата:** 2026-11-11
> **Связано:** [ADR-042](./adr-042-hybrid-mode.md), [ADR-043](./adr-043-unified-identity-login.md),
> [ADR-046](./adr-046-skills-and-slash-commands.md), [ADR-079](./adr-079-local-home-independent-instances.md),
> [ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md),
> [ADR-099](./adr-099-egress-tls-trust.md), [ADR-131](./adr-131-self-management-tools.md).

## Контекст

Локальный инстанс (`synth serve`) живёт как обычный foreground-процесс: `dev.sh` — про отладку,
`standalone.sh` — про запуск из собранных пакетов, Docker/Helm — про managed-контуры. Постоянной
эксплуатации «как службы» нет: пользователь пишет unit руками (ошибается в `Restart`, `KillMode`,
кодах выхода и путях), а перезапуск из UI/CLI (ADR-092 п. 7, exit 75) работает только при живом
супервизоре. Offline-установщик (ADR-121) решает другую задачу — развёртывание в закрытом контуре
без Node, — и не даёт управления сервисом. Итог: единственный штатный способ «пусть работает
всегда» — самодельный unit, который никто не тестирует.

## Решение

1. **`synth service` — единственный поддерживаемый путь провижининга.**
   `install|status|start|stop|restart|enable|disable|logs|uninstall`, плюс `--print-unit`,
   `--dry-run`, `--json`. Ручное написание unit и offline-установщик для non-bundle сценария
   заменяются этой командой; логика — в core (CLI-пакет тонкий, ADR-038).
2. **Только `--user`-юнит.** Файл — `$XDG_CONFIG_HOME/systemd/user/synth.service` (fallback
   `~/.config/systemd/user`), `WantedBy=default.target`; `--system` не поддерживается (root-сценарий
   вне модели прав инстанса и вне скилла).
3. **Юнит (фиксированный шаблон).** `Environment=SYNTH_RESTART_MODE=process`,
   `Restart=on-failure`, `RestartForceExitStatus=75`, `RestartSec=3`, `KillMode=mixed`,
   `TimeoutStopSec=30`, `EnvironmentFile=-%h/.config/synth/service.env` (0600, без секретов) и
   маркер `# Managed by synth service install`. Чужой unit без маркера не перезаписывается —
   нужен явный `--force`.
4. **Параметры установки.** Порт (`--port`, default 4300), адрес прослушивания (`--host`, default
   `127.0.0.1`), каталог (`--home` либо `--data-dir` + `--config`); гибрид — `--connect <url>`
   (+ `--oidc-issuer`/`--oidc-client-id`). Авторизация гибрида — только сохранённые credentials
   после ручного `synth connect` (device flow): секретов в unit и в `service.env` нет. После
   установки выполняется `loginctl enable-linger`; неудача — предупреждение, не ошибка (сервис
   работает до logout, автозапуск после перезагрузки — нет).
5. **Скилл `synth-service`** (встроенный, команда `/service`) спрашивает параметры инструментом
   `question`, вызывает CLI, проверяет `synth service status --json` и `GET /health`; файлы unit
   агент **не пишет**.

## Реализация

- **CLI:** `packages/core/src/cli/service-commands.ts` — подкоманды `install|status|start|stop|restart|enable|disable|logs|uninstall`,
  флаги `--print-unit/--dry-run/--json/--force/--no-autostart/--no-start/--no-linger`, чистые функции
  генератора unit и парсера статуса, подключение в `@itphx/synth` (`program.addCommand`) и в dev-CLI.
  `EnvironmentFile` пишется без кавычек с C-экранированием (systemd не снимает кавычки в этой директиве),
  `ExecStart` — `node <abs cli.js> serve …` с экранированием, `SYNTH_RESTART_MODE=process`.
- **Скилл:** `synth-service` (`/service`) в `engine/skills/builtin.ts` — спрашивает параметры
  инструментом `question`, вызывает CLI, проверяет `status --json` и `/health`, unit не пишет.
- **Проверка:** `pnpm typecheck`, `pnpm lint`, `pnpm test` — зелёные; smoke на этой машине:
  `--print-unit` проходит `systemd-analyze verify`, реальная установка `--user` → `active`, `linger`,
  `/health` ok, рестарт из UI (`exit 75`) поднимает новый PID и меняет `startedAt`, `uninstall`
  снимает unit и оставляет env/данные; секрет ключа больше не печатается в journal.

## Альтернативы

- **«Только скилл»** (агент сам пишет unit через shell) — отклонено не из-за
  `~/.config/systemd`: в защищённых путях (`definitions/protected-paths.json`) только
  `/etc/systemd` (системный контур нам и не нужен — userspace-юнит лежит в home). Причины
  другие: `/etc/systemd` агенту запрещён, запись вне workspace даёт `external_directory`
  (permission-слой спрашивает/отклоняет), `systemctl` — мутирующая команда (permission-слой
  не даёт выполнить её без вопроса), а сгенерированный «на лету» unit недетерминирован и не
  покрыт тестами — шаблон должен быть кодом (`renderServiceUnit`).
- **System-юнит (`--system`)** — отклонён: требует root, смешивает права ОС и права инстанса,
  ломает модель «один пользователь — свои инстансы» (ADR-079).
- **Docker/k8s как ответ на «работать всегда»** — это отдельные пути поставки (ADR-077/ADR-091),
  они не покрывают локальный home на машине разработчика.

## Последствия

- У сервиса появляется контракт жизненного цикла: `process`-режим + exit 75 (ADR-092) теперь
  работают из коробки, а `restart` из UI/CLI поднимает новый процесс без ручного супервизора.
- `enable-linger` — единственная операция, требующая прав вне home; её провал деградирует
  автозапуск, но не установку.
- Секреты остаются в сторе креденшелов (ADR-043/ADR-105), `service.env` — только неконфиденциальные
  переменные; чужой unit не затирается молча.
- На не-systemd платформах команда сообщает о неподдерживаемости, а не эмулирует сервис.

## История

- 2026-11-11 — создан (задача: сервис systemd + каналы обновлений)
- 2026-11-11 — реализовано: CLI, скилл, smoke под systemd (статус ✅)
