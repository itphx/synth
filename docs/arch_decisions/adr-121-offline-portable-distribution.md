# ADR-121: Portable offline-дистрибутивы — pinned Node и ripgrep, SHA256SUMS

> **Статус:** ⚠️ Частично — portable-архивы с закреплённым Node 22 и ripgrep, установщики/снятие/selftest и контрольные суммы собираются; остаток — нативные `.deb/.rpm/.msi/.pkg`, подписи/нотаризация, «один артефакт» на платформу и стабильные (не best-effort) джобы.
> **Дата:** 2026-11-04
> **Источник:** PROP-101 (файл удалён после принятия).
> **Связано:** [ADR-038](./adr-038-npm-packages.md) (npm-пакеты и тонкая CLI-обёртка), [ADR-078](./adr-078-runtime-dependency-availability.md) (деградация без `git`/`rg`/`sh`), [ADR-079](./adr-079-local-home-independent-instances.md) (локальный home), [ADR-091](./adr-091-backup-restore-transfer.md)/[ADR-092](./adr-092-instance-lifecycle-maintenance.md) (обслуживание инстанса).

## Контекст

Штатных способов запуска два, и оба требуют пререквизита окружения: `npm i -g @itphx/synth` (system
Node) или Docker. В закрытом контуре нет ни доступа к npm-реестру, ни гарантированного Node/Docker —
нужен **portable-артефакт**, который разворачивается без сети и без установки рантайма. При этом
единого бинарника нет: `@itphx/synth-core`/`shared`/`ui` остаются external (ADR-038), ассеты
резолвятся из `node_modules`, а `git`/`sh` на Windows нативно не снимаются (ADR-078).

## Решение

1. **Portable offline-архивы, а не нативные инсталляторы (первый этап).** `scripts/offline-bundle.mjs`
   собирает `tar.gz`/`zip`: приложение (hoisted `pnpm deploy`) + **закреплённый Node 22** + **ripgrep**
   + обёртки запуска + установщики/снятие + `manifest.json`/`files.sha256`; рядом с архивом —
   верхнеуровневый `SHA256SUMS`. Сборка детерминирована через `SOURCE_DATE_EPOCH`.
2. **Платформы.** `linux-x64`, `linux-arm64` (собирается только явно), `darwin-x64`/`darwin-arm64`,
   `win-x64`; `all` — без linux-arm64. Windows arm64 в матрице нет. Скрипты — `scripts/offline/`
   (`install.sh`/`install.ps1`, `uninstall.*`, `selftest.sh`, `start/stop-synth.ps1`).
3. **Offline-образы — отдельный контур.** `scripts/offline-images.sh` готовит Docker-образы/архивы
   для закрытого контура; в релизе джобы offline-сборок объявлены **best-effort** (нет Docker-демона —
   релиз продолжается без них).
4. **flatpak/snap не берём.** Synth — локальный сервер, а не desktop-GUI: песочницы ломают доступ к
   произвольному workspace, `sh`/`git`/`rg` и SSH-ключам; классические режимы обнуляют песочницу.
5. **Канон остаётся npm/Docker.** Portable-артефакт — дополнительный канал для закрытого контура, а
   не замена npm-пакетам; обновление — через пакетный менеджер/новый архив, не самообновлением.
6. **Остаток.** Нативные `.deb/.rpm/.msi/.pkg` (и AppImage), подписи Authenticode/Developer ID и
   нотаризация, «один артефакт» на платформу вместо набора файлов, перевод best-effort джоб в
   обязательные — не реализованы.

## Альтернативы

- **Единый бинарник на все ОС.** Невозможен без переупаковки рантайма и сборки под каждую платформу;
  portable-архив с bundled Node решает задачу дешевле.
- **Только npm/Docker.** Не работает в закрытом контуре без Node и без сети.
- **flatpak/snap.** Отвергнуты из-за песочницы и desktop-ориентированных порталов.

## Последствия

- Пользователь закрытого контура получает запуск без установки Node и ripgrep; `git`/`sh` остаются
  внешними (деградация тулов по ADR-078, не падение старта).
- Размер артефакта растёт на Node и rg, зато снимается главный пререквизит.
- Пока нет подписей/нотаризации, ОС может показывать предупреждения; нативные пакеты и «один файл»
  остаются следующим этапом.

## Статус в коде

| Что | Где |
|---|---|
| Сборка portable-архивов | `scripts/offline-bundle.mjs` (Node 22 + ripgrep, `manifest.json`, `files.sha256`, `SHA256SUMS`) |
| Установка/снятие/проверка | `scripts/offline/{install.sh,install.ps1,uninstall.sh,uninstall.ps1,selftest.sh,smoke-test.sh,start-synth.ps1,stop-synth.ps1}` |
| Offline-образы | `scripts/offline-images.sh` |
| CI | `.gitverse/workflows/release.yaml` — джобы `offline-bundles` и `offline-images` (best-effort) |
| Команды | `package.json` — `offline:bundle`, `offline:images`, `offline:smoke` |

## История

- 2026-11-04 — предложение PROP-101 принято как ADR; зафиксированы portable-канал и остаток.
