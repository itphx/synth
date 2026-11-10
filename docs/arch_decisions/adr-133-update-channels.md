# ADR-133: Каналы обновлений и проверка обновлений

> **Статус:** ✅ Реализовано
> **Дата:** 2026-11-11
> **Связано:** [ADR-023](./adr-023-configuration.md), [ADR-038](./adr-038-npm-packages.md),
> [ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md),
> [ADR-099](./adr-099-egress-tls-trust.md), [ADR-121](./adr-121-offline-portable-distribution.md).

## Контекст

`synth update` (ADR-092) умеет проверять, устанавливать и откатывать пакет по `--to`, но знает ровно
один источник — `registry.npmjs.org`, а проверка обновлений (`update-checker.ts`) живёт с TTL 6 ч,
без каналов и без учёта пре-релизов; `POST /api/v2/updates/apply` ставит `@itphx/synth@latest` и
пишет SSE-поток установки. Бета-канал при этом уже существует как поставка: `publish-beta.sh`
публикует все 8 пакетов одного релиза в npm-реестр Gitea (`X.Y.Z-beta.<ts>.<sha>`, dist-tag
`beta`/`next`, `latest` не двигается). Пользователь беты не может ни узнать о новой бете, ни
перейти на стабильную версию осознанно: «последняя версия» для него — всегда `latest` из npmjs.
Отдельного флага/файла-маркера «я на бете» нет, а заводить его — лишнее состояние, которое
расходится с фактом установки.

## Решение

1. **Канал выводится из установленной версии, а не хранится.** `-beta.` в `SYNTH_VERSION` ⇒ `beta`,
   иначе `stable`; override — секция конфига `updates.channel: auto|stable|beta` (env
   `SYNTH_UPDATES_CHANNEL`). Файл-маркер установки отклонён: состояние дублировало бы версию и
   рассинхронизировалось бы при ручном `npm i -g`.
2. **Источники — по каналу.** `stable` — `updates.stableRegistry` (default
   `https://registry.npmjs.org`), `beta` — `updates.betaRegistry` (default
   `https://git.itphx.ru/api/packages/itphx/npm/`). Читаются dist-tags (`latest` / `beta`) обычным
   GET метаданных пакета: реестр беты публичен на чтение, токен (`GITEA_NPM_TOKEN`) нужен только
   публикации. Закрытый контур, где npm требует read-токен из `.npmrc`, — условие установки пакета,
   а не проверки обновлений.
3. **Автопроверка выключена по умолчанию.** `updates.check: false` (env `SYNTH_UPDATES_CHECK`),
   интервал `updates.intervalHours` (24). Кэш — по каналам в `{dataDir}/update-check.json`: успех
   живёт `intervalHours`, ошибка — 1 ч; офлайн — тихо, без ошибок в UI. Явная проверка работает
   всегда и кэш игнорирует: `synth update --check`, `GET /api/v2/updates/check?force=1`, кнопка в UI.
4. **Только уведомление, никакой автоустановки** (`notify`). Установка — явное действие:
   `npm install -g @itphx/synth@<version> --registry <реестр канала>` — и только при user-level
   prefix (`npm prefix -g` внутри `$HOME`); иначе отказ с инструкцией (root-установку не трогаем).
5. **Сравнение версий — prerelease-aware** (`compareVersions`, ADR-092). Переход `beta → stable` —
   понижение: помечается как откат и требует подтверждения, а не «обновления».
6. **Цепочка применения.** apply → если `restartMode !== disabled` → `POST
   /api/v2/maintenance/restart` (graceful shutdown, exit 75) → супервизор поднимает новый процесс;
   UI и CLI ждут смены пары `(startedAt, version)` из `/health`, а не «успеха npm».
7. **Egress — только через `egressFetch`** (ADR-099: доверие TLS/CA и прокси — один слой).
   Admission-гейт: вне standalone-поставки (Docker/Helm/managed) self-update запрещён — `409`, иначе
   контейнер «обновил» бы себя до перезапуска пода и потерял бы версию образа.
8. **UI.** Блок «Обновления» в разделе «Панель управления» (`DashboardPanel`): канал, тумблер
   автопроверки (по умолчанию off), «Проверить», «Обновить» + чекбокс рестарта.

## Реализация

- **Конфиг:** секция `updates` (`packages/shared/src/config/{types,defaults,env-overrides}.ts`), env
  `SYNTH_UPDATES_*`, runtime-тумблер `PUT /api/v2/settings/updates` (`storage/runtime-settings.ts`,
  `server/routes/settings-updates.ts`).
- **Ядро:** `update-checker.ts` (каналы, dist-tags, кэш по каналам `version:2`, ошибка 1 ч,
  prerelease-aware `parseVersion`/`compareVersions`), `maintenance/update.ts` (`--check/--channel/--registry`,
  preflight user-level prefix), `maintenance/self-update.ts` (admission), `update-scheduler.ts`
  (фоновая проверка при `updates.check`, тик перечитывает runtime-настройку).
- **API:** `GET /api/v2/updates/check`, `POST /api/v2/updates/apply` (SSE, `restartScheduled`,
  409 `UPDATE_UNSUPPORTED`), `GET/PUT/DELETE /api/v2/settings/updates`; в managed — ADMIN на чтение и
  запись (граница роутера, `route-access-census`).
- **UI:** блок «Обновления» в `DashboardPanel` (`UpdatesCard`, `lib/api/updates.ts`), канал/тумблер
  (off), «Проверить», «Обновить» + чекбокс рестарта, ожидание пары `(startedAt, version)`.
- **Проверка:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (core 10 151, shared 1 043, ui 3 909,
  backend 842, executor 247, storage-postgres 114, plugin-memory 191, sdk 48) — зелёные; smoke на
  standalone: каналы stable/beta (npmjs и Gitea без токена), settings-тумблер, `--restart-mode process`
  + exit 75 под systemd, UI-блок в обоих состояниях (обновление есть/нет).
- **Остаток:** реальная установка беты из Gitea на машине пользователя проверяется при следующей
  публикации (реестр публичен на чтение; запись — с токеном).

## Альтернативы

- **Канал, запечённый в билд** (как в opencode) — не подходит: у нас 8 пакетов одного релиза, а
  канал должен переключаться без пересборки и без второго артефакта.
- **dist-tag как аргумент `--to`** (`--to beta`) — нет: устанавливается только точная версия,
  иначе «что поставилось» непроверяемо и откат не адресуем.
- **Режим `auto` (самообновление)** — отклонён: непредсказуемость и потеря контроля у владельца
  инстанса (ADR-121: обновление — через пакетный менеджер, не самообновлением).
- **Проверка без кэша** — отклонена: автопроверка при каждом старте/тике даёт лишние запросы к
  реестрам и шум в офлайне.

## Последствия

- Обновление перестаёт быть «всегда npmjs»: откат `beta → stable` — штатный сценарий с
  подтверждением; текущая `POST /updates/apply` (SSE, `@latest`) заменяется явной версией канала.
- Появляется зависимость от доступности Gitea-реестра у бета-пользователей; недоступность — тихая
  деградация (ошибка в кэше на 1 ч), явная проверка вернёт ошибку.
- `update-check.json` меняет форму (кэш по каналам) — старый одиночный кэш читается как `stable`.
- Self-update доступен только standalone; Docker/Helm/managed обновляются образом/выпуском.

## История

- 2026-11-11 — создан (задача: сервис systemd + каналы обновлений)
- 2026-11-11 — реализовано: конфиг/ядро/API/UI, тесты и smoke (статус ✅)
