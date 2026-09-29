# AD-079: Локальный home-каталог (`--home`) и независимые локальные инстансы

> **Статус:** ✅ Реализовано
> **Дата:** 2026-09-29
> **Источник:** согласовано 2026-09-29 (следствие проблем изоляции standalone/hybrid)

**Решение:** ввести единый параметр локального инстанса `--home <dir>` (env `SYNTH_HOME`) — базовый каталог, относительно которого резолвятся все локальные пути: конфиг, данные, реестр профилей и credentials. Раскладка **плоская**:

```
<home>/
  config.yaml          # вместо ~/.config/synth/config.yaml
  data/                # dataDir: sessions/ projects/ providers/ models/ agents/ context/ auth/ secrets/ workspaces/
  profiles.json        # вместо ~/.config/synth/profiles.json
  credentials.json     # вместо ~/.config/synth/credentials.json
```

Приоритет путей (расширяет инвариант AD-023 «CLI > env > config > defaults»):
**явные флаги (`--data-dir`, `--config`, `--profiles`, `--credentials`) > `--home` > `SYNTH_HOME` > XDG-дефолты (`~/.config/synth`, `~/.local/share/synth`)**. Без `--home`/`SYNTH_HOME` поведение не меняется — обратная совместимость.

## Контекст

- Сейчас `--data-dir` изолирует только runtime-данные (`storage.dataDir`), но **не** конфиг и **не** мета-файлы: путь config резолвит `findConfigPath()` (`packages/shared/src/config/resolve.ts`), а `profiles.json`/`credentials.json` жёстко зашиты через `homedir()` — `packages/core/src/profiles.ts` (`getProfilesPath`), `packages/core/src/remote/credentials.ts` (`defaultCredentialsPath`).
- Асимметрия: путь credentials **настраиваемый** (`remote.credentialsPath`), путь profiles — **нет** (только программный параметр у функций, продакшн им не пользуется).
- Практическое следствие (исходный баг): `scripts/standalone.sh` запускает `synth serve` без переопределений, CLI подхватывает `lastProfile` из общего `~/.config/synth/profiles.json` и standalone стартует как гибрид. Полностью изолировать инстанс без подмены `HOME` нельзя.
- Требование: на одной машине **независимо** и одновременно запускать standalone и hybrid (разные config/data/profiles/credentials), а также иметь герметичный тестовый запуск.

## Решение

### Параметр и раскладка

- `--home <dir>` доступен на `serve` и на локальных командах (`synth connect`, `project publish|fork`, `secrets rotate`); env `SYNTH_HOME`.
- Пути выводятся от home: config → `<home>/config.yaml`; dataDir → `<home>/data`; profiles → `<home>/profiles.json`; credentials → `<home>/credentials.json`.
- Home принимается в обоих deploy-режимах (`user`/`dev`; для `docker`/`server` — только явным флагом, дефолты не меняются).
- Порт из home **не** выводится: порт — процессный параметр (`--port`). Для одновременного запуска инстансов используются разные home и порты.

### Резолвинг

- Новый `resolveHome()` в `packages/shared/src/config/resolve.ts`; резолверы путей (`defaultConfigPath`, `resolveDataDir`, новый `resolveProfilesPath`/`resolveCredentialsPath`) учитывают home.
- `packages/core/src/profiles.ts` и `packages/core/src/remote/credentials.ts` принимают путь инъекцией (не `homedir()`).
- `createStandaloneApp` получает `profilesPath` рядом с существующим `remoteCredentialsPath`; `getHybridState` использует его.
- Новые флаги `--profiles <path>` / `--credentials <path>` — для точечных переопределений поверх home.

### Скрипты

- `scripts/standalone.sh` → `--home tmp/standalone/home --port <свой>`.
- `scripts/hybrid.sh` → `--home <свой home> --port <свой>`.
- Логи/сборка — как сейчас.

## Реализация

- `packages/shared/src/config/resolve.ts`: `resolveHome(explicitHome?, env?)`; home-параметр (`home?`) у `resolveDataDir`, `resolveWorkspacesRoot`, `resolveDefaultWorkspace`, `findConfigPath`, `defaultConfigPath`, `ensureFirstRun`; новые `resolveProfilesPath(home?)` и `resolveCredentialsPath(home?)`.
- `packages/shared/src/config/loader.ts`: `LoadConfigOptions.home` — при заданном home конфиг читается строго из `<home>/config.yaml`.
- `packages/core/src/profiles.ts`: `getProfilesPath(home?)` → `resolveProfilesPath`; `packages/core/src/remote/credentials.ts`: `defaultCredentialsPath(home?)` → `resolveCredentialsPath`.
- `packages/core/src/server/app.ts`: `StandaloneConfig.profilesPath`, используется в `getHybridState`/`rememberServer`.
- CLI (`packages/synth/src/cli.ts`, `packages/core/src/main.ts`): флаги `--home`/`--profiles`/`--credentials` на `serve`/`connect`/`disconnect`/`project publish|fork`/`secrets rotate`.
- Скрипты: `scripts/standalone.sh` — home по умолчанию `tmp/standalone/home`; `scripts/hybrid.sh` — опция `--home`, без неё сохранено прежнее XDG-поведение (чтобы не терять существующие данные пользователя).

`docs/CONFIGURATION.md` и `docs/DEVELOPMENT.md` отражают приоритеты путей и флаги.

## Последствия

- Полная независимость инстансов: разные home → разные config/data/profiles/credentials; одновременный запуск без взаимного влияния.
- Герметичность тестов/CI без подмены `HOME`.
- Выровнена асимметрия profiles/credentials (оба настраиваемы).
- Личный сценарий «один home, два режима запуска» (см. AD-080) и сценарий изоляции (разные home) поддерживаются одновременно.

## Ограничения

- Плоская раскладка не совместима с XDG-раскладкой автоматически: если часть файлов уже лежит в `~/.config/synth`, перенос на `--home` — ручной (миграции в объёме AD-079 нет).
- `--home` не вводит разделение «конфиг/данные/кеш» (единый корень); при необходимости детальнее — точечные флаги.
- Деплой `docker`/`server` продолжает использовать свои дефолты (`/etc/synth`, `/var/synth/data`) без явного `--home`.

## Связи

- [AD-023](./ad-023-configuration.md) — приоритеты и единая точка чтения конфига; AD-079 добавляет home-уровень.
- [AD-045](./ad-045-hybrid-server-profiles.md) — реестр профилей/credentials и «единый dataDir»; AD-079 делает их пути home-относительными и настраиваемыми.
- [AD-080](./ad-080-managed-hybrid-modes.md) — режимы запуска и идентичность; использует home одного инстанса.
- [AD-042](./ad-042-hybrid-mode.md) — гибридный режим; независимые инстансы позволяют держать hybrid и standalone раздельно.
- [AD-081](./ad-081-hybrid-policy-leak-protection.md) — политики гибрида, включая локальную панель настроек.
