# ADR-137: Изоляция исполнителя — non-root, сеть и файловая система

> **Статус:** ⚠️ Частично — реализовано: все runtime-образы non-root (`uid 1000`), unprivileged UI,
> `readOnlyRootFilesystem` + writable `emptyDir`, ownership initContainer, fail-closed проверка записи
> в `dataDir`, сетевые классы `none|restricted|full`, сборка образов только на remote builder'е
> (без `docker.sock`/`--privileged`). Остаток: образы gateway-addons по тому же правилу, gVisor/
> rootless buildah (opt-in), e2e на кластере.
> **Дата:** 2026-11-13
> **Источник:** PROP-137 (файл удалён после принятия).
> **Связано:** [ADR-135](./adr-135-execution-contour.md) (контур исполнения и профили),
> [ADR-136](./adr-136-shell-trust.md) (доверие shell), [ADR-099](./adr-099-egress-tls-trust.md)
> (egress), [ADR-134](./adr-134-instance-service-systemd-user.md) (userspace-сервис);
> спецификация — [docs/EXECUTION.md](../EXECUTION.md) §10, конфиг/чарт — [docs/CONFIGURATION.md](../CONFIGURATION.md)
> §«Сетевые классы пулов» и §«Сборка образов: remote builder», миграция прав — [docs/MAINTENANCE.md](../MAINTENANCE.md).

## Контекст

Изоляции агентских команд внутри процесса не существует — жёсткая граница достигается **только**
средствами контейнера исполнителя. Образы работали root'ом, корневая ФС была writable, сеть пула не
ограничивалась классом, а образы `devops`/`full` несли docker CLI с доступом к демону. Внутрипроцессные
«ограничения» shell границей не считаются (ADR-136) — значит требования к контейнеру должны быть
контрактом, а не рекомендацией.

## Решение

1. **Non-root — обязательное требование.** Все runtime-образы: backend-флейворы (core/dev/devops/
   browser/full/slim), executor (core/dev/devops/browser/full), provisioner, UI — `USER 1000`;
   `runAsNonRoot: true`, `runAsUser: 1000`, `fsGroup: 1000`. Root допустим **только** на этапе сборки
   образа. UI — unprivileged nginx: `pid`/temp/cache в `/tmp`, entrypoint-шаблоны в writable
   `/etc/nginx/conf.d`, порт **8080** (Service 80→8080). Compose задаёт `user:` явно.
2. **Файловая система.** `readOnlyRootFilesystem` по профилю (`exec`/`browser` — да, `devops` — по
   потребности; дефолт provisioner'а — `true`) с writable `emptyDir` на `/tmp` и `/home/synth`; запись
   в `/app`, `/usr/local`, `/opt/synth` запрещена, `plugins.runtimeInstall` при read-only запрещён.
   `npm -g` — с `NPM_CONFIG_PREFIX=$HOME/.local` и `$HOME/.local/bin` в `PATH` команд исполнителя;
   персистентности HOME при idle-остановке нет (для разовых задач — `npx`/`pnpm dlx`).
3. **Инициализация прав и `dataDir`.** `fsGroup: 1000` + `fsGroupChangePolicy: OnRootMismatch` покрывает
   PVC; отключаемый ownership-initContainer (`*.ownershipInitContainer.enabled`, по умолчанию `false`) —
   только для hostPath/NFS, где `fsGroup` не применяется (Pod Security Standards `restricted` запрещает
   root-initContainer — это осознанный компромисс). При старте — **fail-closed проверка записи в
   `dataDir`** с точной командой `chown` в тексте ошибки; для bind-mount с чужим uid — scoped
   `safe.directory` для workspace.
4. **Сетевые классы профилей — `none | restricted | full`.** Класс — подпись пода `synth.io/network`,
   политику рендерит чарт (`executor.networkClasses.enabled`), одинаково для статического пула и
   динамических пулов provisioner'а. `none` — egress запрещён полностью, включая DNS; `restricted` —
   DNS + allowlist (`networkClasses.restrictedEgress`); `full` — без ограничений. При включённых классах
   старая `executor.networkPolicy` **не** рендерится (union политик ослабил бы `none`/`restricted`).
   Неизвестный класс — ошибка рендера (fail-closed). App-level egress (ADR-099) на shell и браузер
   **не действует** — единственный сетевой контроль здесь NetworkPolicy/egress-прокси.
5. **Runtime-изоляция.** `runtimeClass: gvisor` для browser-профиля (рекомендуется) и опционально для
   `exec`; seccomp `RuntimeDefault`; `capabilities.drop: [ALL]`; `allowPrivilegeEscalation: false`;
   `restartPolicy: Never` у подов пулов. Запрещены `docker.sock`, `--privileged`, hostPath наружу,
   hostNetwork.
6. **Сборка образов — только remote builder.** В образах `devops`/`full` есть docker CLI, но нет демона
   и `docker.sock`; `--privileged` и hostPath-демон запрещены. Builder задаётся env пула
   (`DOCKER_HOST`/`BUILDKIT_HOST`, `DOCKER_TLS_VERIFY`/`DOCKER_CERT_PATH` — только путь; сертификаты —
   Secret/файлы, инвариант 13), доступ — через external credentials проекта (ADR-105), не через секреты
   профиля. Rootless buildah — отдельный opt-in профиль (subuid/subgid, `/dev/fuse`, userns), не дефолт.
   Сам builder — внешняя инфраструктура, чарт его не разворачивает.

## Альтернативы

- **Оставить root в образах ради простоты** — отклонено: root в поде обнуляет смысл split-контура и
  нарушает Pod Security Standards.
- **Writable rootfs** — отклонено: агентские команды могли бы менять toolchain образа, что делает
  поведение невоспроизводимым.
- **Изоляция shell внутри процесса (seccomp-обёртки, парсинг)** — отклонено: границей не является
  (ADR-136), даёт ложное чувство защиты.
- **Собирать образы внутри пода** — отклонено: требует `docker.sock`/`--privileged` и ломает изоляцию.

## Последствия

- **Плюсы:** единый контракт изоляции для всех пулов; права предсказуемы, PVC-миграция описана;
  сетевой класс — свойство профиля, а не отдельная настройка пода.
- **Минусы:** non-root требует правки прав на томах и образа; Chromium под non-root требует userns или
  `--no-sandbox` (для browser-профиля рекомендуется gVisor); `restricted`/`none` ломают git/npm внутри
  пула без allowlist; `restrictedEgress` — ручная настройка.
- **Остаток:** образы gateway-addons по тому же правилу non-root не доведены; gVisor и rootless
  buildah — opt-in, не проверены на живом кластере; e2e на кластере (поды, RBAC, NetworkPolicy) —
  за оркестратором.

## История

- 2026-11-13 — принято из PROP-137 (реализация Ф1–Ф4 и Ф5); файл предложения удалён.
