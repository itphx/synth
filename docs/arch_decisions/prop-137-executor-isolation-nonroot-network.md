# PROP-137: Изоляция исполнителя: non-root, сеть и файловая система

> **Статус:** 🧩 Предложение — все runtime-образы работают non-root; сетевые классы профилей `none|restricted|full`; `readOnlyRootFilesystem`, `drop: ALL`, remote builder для образов
> **Решение до:** 2026-11-30
> **Дата:** 2026-11-12
> **Обсуждено:** 2026-11-11…12 — решения владельца зафиксированы в тексте; ожидает утверждения и отмашки на реализацию.
> **Источник:** обсуждение 2026-11-11…12 (аудит места исполнения тулов, модели доверия shell, изоляции исполнителя).
> **Связано:** [ADR-077](./adr-077-runtime-toolchain.md), [ADR-099](./adr-099-egress-tls-trust.md), [ADR-134](./adr-134-instance-service-systemd-user.md), [PROP-135](./prop-135-execution-topology-pools-profiles.md), [PROP-136](./prop-136-shell-trust-audit-command-policy.md)

## Решение (предложение)

Жёсткая изоляция достигается **только** средствами контейнера исполнителя: non-root, read-only rootfs, ограниченный набор capability, сетевой класс и (для браузера) `runtimeClass: gvisor`. Внутрипроцессные «ограничения» shell границей безопасности не считаются ([PROP-136](./prop-136-shell-trust-audit-command-policy.md)).

### Non-root

Все runtime-образы работают non-root (`USER 1000`, `runAsNonRoot: true` обязателен). Root допустим **только** на этапе сборки образа.

| Группа образов | Требование |
|---|---|
| backend-флейворы (core/dev/devops/browser/full/slim) | `USER 1000` |
| executor (core/dev/devops/browser/full) | `USER 1000` |
| ui | unprivileged nginx |
| gateway-addons | по тому же правилу |
| postgres | уже non-root |

Компромиссы, которые фиксируются явно:

- Chromium под non-root требует userns, иначе `--no-sandbox`; для browser-профиля рекомендуется gVisor;
- rootless buildah требует subuid/subgid и setuid `newuidmap` — по умолчанию **не используем** (см. «Сборка образов»).

### Файловая система

- `readOnlyRootFilesystem` по профилям: `exec`/`browser` — да; `devops` — по потребности;
- writable `emptyDir` на `/tmp` и `/home/synth`;
- проверить отсутствие записи в `/app`, `/usr/local`, `/opt/synth`; `plugins.runtimeInstall` при read-only запрещён;
- `npm -g` разрешён с `NPM_CONFIG_PREFIX=$HOME/.local`, `$HOME/.local/bin` добавляется в `PATH` окружения команд исполнителя;
- персистентности HOME при idle-остановке подов **нет** (решение владельца): установленные глобально CLI живут до остановки пода; для разовых задач — `npx`/`pnpm dlx`.

### Сеть

Классы профилей:

| Класс | Что разрешено |
|---|---|
| `none` | egress нет, даже DNS |
| `restricted` | DNS + allowlist реестров/git/прокси |
| `full` | без ограничений |

Реализация — NetworkPolicy по label (`synth.io/network=…`); allowlist применяется только в `restricted`. `full` доступен, только если явно разрешён в `project.executor.allowedProfiles`. App-level egress ([ADR-099](./adr-099-egress-tls-trust.md)) на shell и браузер **не действует** — единственный сетевой контроль здесь NetworkPolicy/прокси.

### Runtime

- `runtimeClass: gvisor` для browser-профиля (рекомендуется) и опционально для `exec`;
- seccomp `RuntimeDefault`; `drop: ALL`; `allowPrivilegeEscalation: false`;
- запрещены `docker.sock`, `--privileged`, hostPath наружу, hostNetwork.

### Сборка образов

Remote builder (`DOCKER_HOST`/buildkit) вместо сборки в поде; доступ к builder'у — через external credentials проекта ([ADR-105](./adr-105-external-credentials.md)), **не** через секреты профиля. Rootless buildah — отдельный opt-in профиль с документированными требованиями (subuid/subgid, `/dev/fuse`, userns), не дефолт.

### UI

Unprivileged nginx: `pid`/temp/cache — в `/tmp`, `/etc/nginx/conf.d` writable для entrypoint-шаблонов, порт 8080 (сервис 80→8080).

### Миграция прав

- `fsGroup: 1000` + `fsGroupChangePolicy: OnRootMismatch` уже покрывает PVC;
- отключаемый initContainer (`*.ownershipInitContainer.enabled`, **по умолчанию false**) — только для hostPath/NFS, где `fsGroup` не применяется; учитывать, что Pod Security Standards `restricted` запрещает root-initContainer;
- при старте — fail-closed проверка записи в `dataDir` с точной командой `chown`;
- для bind-mount с чужим uid — scoped `safe.directory` для workspace.

## Границы

Не входит: per-project монтирование и пулы ([PROP-135](./prop-135-execution-topology-pools-profiles.md)), shell-аудит ([PROP-136](./prop-136-shell-trust-audit-command-policy.md)), перенос плагинов ([PROP-138](./prop-138-plugin-tool-execution-contour.md)), интеграция gVisor как отдельный проект.

## Этапы

- **Ф1** — `USER 1000` во всех образах + `user:` в compose + проверка прав `dataDir`.
- **Ф2** — `readOnlyRootFilesystem` + emptyDir, сначала executor.
- **Ф3** — UI unprivileged.
- **Ф4** — сетевые классы и NetworkPolicy on by default.
- **Ф5** — remote builder.
- **Ф6** — browser/gVisor, rootless buildah opt-in.

## Влияние на документы

Будущий ADR (после реализации); `charts/synth/values.yaml` + README; `docs/MAINTENANCE.md` (миграция прав); `docs/CONFIGURATION.md`; `docker-compose.yml`; корневой `AGENTS.md` (инвариант non-root) — после реализации.

## История

- 2026-11-12 — документ создан: зафиксированы требования non-root, read-only rootfs, сетевые классы и способ сборки образов (обсуждение 2026-11-11…12).
