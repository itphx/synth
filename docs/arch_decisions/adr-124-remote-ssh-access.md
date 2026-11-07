# ADR-124: Удалённый SSH-доступ агента — два режима работы с ключами (`tools` / `agent`)

> **Статус:** ✅ Реализовано
> **Дата:** 2026-11-07
> **Источник:** PROP-124
> **Связано:** [ADR-076](./adr-076-git-repo-registry-ssh.md) (реестр SSH-ключей), [ADR-077](./adr-077-runtime-toolchain.md) (порт исполнения, секреты вызова), [ADR-078](./adr-078-runtime-dependency-availability.md) (доступность программ), [ADR-099](./adr-099-egress-tls-trust.md) (egress/TLS), [ADR-105](./adr-105-external-credentials.md) (модель «секрет → транспорт»), [ADR-113](./adr-113-background-processes.md) (фоновые процессы).

## Контекст и проблема

SSH-ключи Synth работали только для git: `reveal()` → `ExecSecret` → `createSshEnv()` →
`GIT_SSH_COMMAND`, а эту переменную понимает только git. Нужны были оба сценария: адресные
операции с проверяемой политикой (хост известен заранее) и работа существующих проектов
пользователя (Ansible, скрипты) — без специальных тулов и переписывания инвентарей. При этом
адресной политики для raw TCP нет (ADR-099 покрывает HTTP), а выдать ключ в свободный shell
означало бы снять любые ограничения.

## Решение

1. **Режим инстанса** `ssh.mode: 'tools' | 'agent'` (дефолт `tools`; env `SYNTH_SSH_MODE`,
   runtime-настройка, live, аудит `scope:'ssh'`; невалидное env — ошибка конфигурации).
2. **Модель ключа**: `usages: ('git'|'ssh')[]` (старые записи → `['git']`; пустой список не
   записывается), `allowHosts`/`allowPorts` — **только для `tools`**, `agentIds` — обязательная
   привязка для ssh. В режиме `agent` поля хостов/портов скрыты с пояснением.
3. **Единый гейт** `resolveSshAccess`: выбор ключа → `usages` → `agentIds` → (только `tools`)
   хост по `hostMatchesRule` и порт → `reveal()` **последним**. Второго места с `reveal()` нет.
4. **Секрет вызова**: `ExecSecret.mode: 'git' | 'agent'`. В `agent` на время вызова поднимается
   эфемерный `ssh-agent` (`ssh-add`, ключ и askpass удаляются с диска, `SSH_AUTH_SOCK` в env);
   завершение `SIGTERM`→`SIGKILL`, sweep по живости **владельца** (`owner.pid`).
5. **Выдача ключа**: `execute_shell`/фон/detach в режиме `agent` получают ключи роли (лимит 4,
   роль читается в момент вызова — сабагент не наследует ключ родителя), в plan-режиме — ничего.
6. **Адресные тулы** (`tools`): `ssh_exec` (argv без shell, `-F /dev/null`), `ssh_copy` (sftp-batch),
   `ssh_tunnel` (local/remote, listen `127.0.0.1`, `-D` отклоняется); план — отказ; в `agent` —
   `unavailable(policy)`.
7. **Фон**: `secrets[]` в `POST /exec/spawn`, протокол **6** (`features.sshAgent`, `features.secretsSpawn`),
   маршрутизация только на адреса с признаком, без тихого фоллбека.
8. **Окружение**: `ssh`/`scp`/`sftp`/`rsync` в инвентаре исполнителя (`EXTRA_TOOLCHAIN_BINARIES`),
   `rsync` — в hard deps образов (кроме `slim`); `ansible-core` в поставку не входит (venv проекта).

## Альтернативы

- **Только адресные тулы** — ломает существующие Ansible/скрипты, ограничение ради ограничения.
- **Долгоживущий `ssh-agent` на поде** — ключ живёт до рестарта, виден всем сессиям, отзыв не работает.
- **Ключ в `execute_shell` без режима** — адресный гейт перестаёт что-либо значить.
- **Тул-обёртка над Ansible** (генерируемый инвентарь) — плейбук исполняет произвольный код,
  граница фиктивна; режим `agent` решает задачу честнее.
- **`-i` в argv для тулов** — путь к ключу утекает в `ps`; вместо этого секрет `mode:'agent'`.

## Последствия и риски

- В режиме `agent` адресной фильтрации нет: граница — `authorized_keys` (`from=`, `restrict`,
  `permitopen=`, `command=`) и эфемерность ключа. Ключ при этом нельзя прочитать процессами.
- `ssh -A` (форвардинг агента) и prompt injection возможны, пока вызов жив; митигации — аудит,
  привязка к агенту, скоуп на вызов.
- Фон без TTL: агент живёт до `process_stop`; рестарт пода снимает и процесс, и ключ.
- `ssh_tunnel` проверяет целевой порт; порт подключения к ssh — вне проверки (асимметрия с
  `ssh_exec`), хост при этом остаётся в `allowHosts`.
- EN-версии `docs/en/EXECUTION.md` нет — расхождение зафиксировано как долг.

## Статус в коде

| Что | Где |
|---|---|
| Модель ключа, нормализация, режимы | `packages/shared/src/types/git.ts`, `types/host-pattern.ts`, `config/*` |
| Хранилища и API | `packages/core/src/storage/ssh-key-store.ts`, `server/routes/{ssh-keys,settings-ssh}.ts`, PG-миграция `031` |
| Гейт и выдача ключа | `packages/core/src/engine/ssh/{access,result}.ts`, `engine/tools/{ssh-exec,ssh-copy,ssh-tunnel}.ts`, `git/ssh-env.ts`, `execution/ssh-sweep.ts` |
| Протокол и секреты | `packages/executor/src/{protocol,secrets,background,client}.ts`, `packages/core/src/execution/*` |
| UI | `packages/ui/src/components/settings/SshKeysSettings.tsx`, `lib/api/settings-ssh.ts` |
| Тесты | `engine/ssh/access.test.ts`, `engine/tools/ssh-*.test.ts`, `git/ssh-env.test.ts`, `execution/ssh-sweep.test.ts`, `executor/src/*.test.ts` |

## История

- 2026-11-07 — принято из PROP-124; реализованы режимы `tools`/`agent`, гейт, эфемерный агент,
  фоновые секреты, три тула, миграция PG и UI.
- 2026-11-07 — по итогам аудита: жёсткое завершение агента, sweep по владельцу, запрет пустого
  `usages`, сохранение политики при переносе хранилища.
