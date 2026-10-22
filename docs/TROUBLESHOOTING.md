# Диагностика и решение проблем

> 🌐 [English](./en/TROUBLESHOOTING.md) · **Русский**

> [!NOTE]
> Пользовательская диагностика — в портале документации:
> https://docs.synth.itphx.ru/help/troubleshooting/. Здесь остаются инженерные
> проблемы: публикация, CI, `dev.sh`, WS-фикс.

Проверенные симптомы, причины и решения из реального опыта. Если ваша проблема здесь не описана — проверьте логи (`tmp/*.log`) и откройте задачу.

## 1. GitVerse npm: 403 «no permission» при публикации `@itphx/synth`

**Симптом:** публикация `@itphx/synth` в `https://gitverse.ru/api/packages/itphx/npm/` завершается ошибкой 403 «no permission», при этом остальные шесть пакетов публикуются нормально.

**Причина:** поле `repository` в `packages/synth/package.json` (`{"type": "git", "url": "https://gitverse.ru/itphx/synth"}`). GitVerse при привязке пакета к репозиторию по `repository.url` проверяет права и отдаёт 403.

**Решение:** удалить поле `repository` из `package.json` (как у остальных пакетов). Проверка: публикация с `repository` → 403, без `repository` → 200.

## 2. npm unpublish: 403 «Granular access tokens that bypass two-factor authentication may not perform this action»

**Симптом:** попытка удалить опубликованную версию через `npm unpublish` отклоняется с 403.

**Причина:** политика npm 2026 — токены GAT с `bypass 2FA` больше не могут выполнять unpublish (см. [changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).

**Решение:** вместо удаления использовать deprecate — потребители увидят предупреждение при установке:

```bash
npm deprecate @itphx/synth@<version> "Используйте более новую версию"
```

## 3. Docker registry `registry.gitverse.ru` не резолвится

**Симптом:** `docker pull registry.gitverse.ru/...` / `docker push registry.gitverse.ru/...` падает с ошибкой резолвинга.

**Причина:** правильный адрес реестра — **`gitverse.ru`** (без префикса `registry.`). Устаревший дефолт `registry.gitverse.ru` исправлен в `publish.sh`/`build.sh` (`GITVERSE_DOCKER_REGISTRY`).

**Решение:** использовать `gitverse.ru/itphx/synth:<version>`.

## 4. `dev.sh` не выживает в фоне/CI (убивает потомков)

**Симптом:** `./scripts/dev.sh` запущенный из bash-инструмента/CI-скрипта завершается сразу или убивает дочерние процессы; `trap cleanup` срабатывает неожиданно.

**Причина:** `dev.sh` привязан к управляющему терминалу и при выходе родительской сессии завершает группу процессов (`kill -TERM -$pgid`). Для фонового запуска это не предназначенный режим.

**Решение:** запускать сервисы напрямую пакетными командами через `setsid`:

```bash
setsid pnpm --filter @itphx/synth-backend dev > tmp/backend.log 2>&1 &
setsid pnpm --filter @itphx/synth-ui dev > tmp/ui.log 2>&1 &
```

## 5. WS `/ws/events` и cookie-вход (standalone) — исправлено

**Было (устаревшее ограничение):** в standalone-режиме (`synth serve`) WebSocket `/ws/events` не подключался после входа через UI: обработчик upgrade принимал только `Authorization: Bearer <api-key>` и не читал cookie-сессию.

**Сейчас:** обработчик upgrade в `packages/core/src/server/app.ts` (метод `server.on('upgrade')` для `/ws/events`) принимает и валидный Bearer API-ключ (CLI/API-клиенты), и cookie-сессию через `auth.getCurrentUser` — браузерный UI подключается по cookie без отдельного заголовка. Вопрос закрыт.

## 6. 403 «Permission denied» для защищённых путей

**Симптом:** агент не может прочитать/изменить файл, доступ к которому должен быть разрешён; в ответе `Permission denied` с текстом из системного контекстного файла.

**Причина:** работает защита защищённых путей (`packages/core/src/engine/security/protected-paths.ts`): системный список `definitions/protected-paths.json` + override-политика (роут `GET/PUT/DELETE /api/v2/settings/protected-paths`, `packages/core/src/server/routes/settings.ts`). По умолчанию защита включена (`security.protectedPaths.enabled: true`). Проверка идёт для всех файловых тулов и shell-команд; жёсткий deny выше `permission.rules`.

**Решение:** настроить политику защищённых путей:

- **Через API** (если доступен): `GET/PUT/DELETE /api/v2/settings/protected-paths` — override формата `{version: 1, add: [...], remove: [...]}`
- **Файлом:** `{dataDir}/security/protected-paths.json` (формат add/remove, version: 1)
- **Отключить защиту:** тумблер `security.protectedPaths.enabled` в секции «Безопасность» UI или `false` в `config.yaml`

## 7. TLS/сертификаты (исходящие соединения и PostgreSQL)

Единый источник доверия TLS/CA в Synth — секция `security.tls` (ADR-099). Все исходящие соединения (LLM-провайдеры, MCP, webhooks, гибрид, OIDC/JWKS, загрузка иконок/обновлений, `web_fetch`) и TLS к PostgreSQL берут CA/клиентские сертификаты оттуда.

### `self-signed certificate in certificate chain` / `DEPTH_ZERO_SELF_SIGNED_CERT`

**Симптом:** запрос к LLM/MCP/OIDC/вебхуку падает с ошибкой проверки сертификата (`self-signed certificate in certificate chain`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `unable to verify the first certificate`).

**Причина:** сервер (корпоративный прокси/шлюз, self-host IdP) подписан внутренним CA, которого нет в системном хранилище, а `security.tls` не задан.

**Решение:** задайте доверенный CA (для git-канала нужен именно файл):

```yaml
security:
  tls:
    caFile: /etc/synth/tls/ca.crt      # или caPem — сам PEM (взаимоисключающ с caFile)
```

или env `SYNTH_TLS_CA_FILE=/etc/synth/tls/ca.crt` (`caPem` — `SYNTH_TLS_CA_PEM`). Для mTLS добавьте `certFile`/`keyFile` (`SYNTH_TLS_CERT_FILE`/`SYNTH_TLS_KEY_FILE`). Битый/отсутствующий файл — fail-closed (понятная ошибка на старте, не тихий фоллбэк).

**Почему `NODE_EXTRA_CA_CERTS` — не решение для самого процесса Synth:** переменная влияет только на стандартный транспорт Node и **не** является конфигурацией Synth; при заданном `security.tls` Synth ставит собственный глобальный undici-dispatcher (`initTlsTrust`), который её не учитывает. Штатный путь — `security.tls`; `NODE_EXTRA_CA_CERTS` остаётся лишь совместимостью для дочерних процессов.

### `The server does not support SSL connections`

**Симптом:** PostgreSQL-драйвер при старте падает с `The server does not support SSL connections`.

**Причина:** задан `storage.postgres.sslmode` (`require`/`verify-full`), а сервер БД TLS не поддерживает (или `pg_hba.conf` его не разрешает).

**Решение:** включите TLS на сервере БД либо уберите `sslmode` (или `sslmode: disable`) — но помните, что `disable` отключает и проверку сертификата.

### «TLS-параметры в DSN запрещены (обнаружено: …)»

**Симптом:** драйвер отвергает `storage.postgres.dsn` с сообщением про запрещённые TLS-параметры.

**Причина:** в DSN есть `sslmode`/`sslrootcert`/`sslcert`/`sslkey`/… — `pg` накладывает DSN поверх конфига (`Object.assign`) и молча перекрывает `ssl`-опции (вплоть до отключения TLS), поэтому они запрещены.

**Решение:** уберите TLS-параметры из DSN и задайте их там, где им место:

```yaml
storage:
  postgres:
    dsn: postgres://synth@db.internal:5432/synth   # без ?sslmode=…
    sslmode: verify-full                             # disable | require | verify-full
security:
  tls:
    caFile: /etc/synth/tls/ca.crt                    # CA для verify-full
```

### Проблемы git-over-https (клон/фетч с корпоративным CA)

**Симптом:** `project_repo_clone`/`git fetch` по https падает с ошибкой проверки сертификата.

**Причина:** git не доверяет CA сервера. Env-канал (`GIT_SSL_CAINFO`) недоступен: `git-service.ts` санитайзит окружение (`sanitizeGitEnv`/`allowEnvironment`).

**Решение:** задайте CA **файлом** через `security.tls.caFile` — git-канал передаёт его пер-вызовом (`git -c http.sslCAInfo=<path>`). `caPem` (PEM без файла) git-каналу недоступен — нужен именно `caFile`.

## 8. Исполнитель недоступен (split-топология)

**Симптомы:**

- control plane (backend) не стартует: в логе `remote execution is unavailable: …` или `исполнитель недоступен: fetch failed`; либо агентские команды падают с `EUNREACHABLE`;
- `docker compose --profile split up` — backend вrestart'ится, `synth-executor` не стартует: `[executor] обязательная переменная SYNTH_EXECUTOR_TOKEN не задана — исполнитель не стартует (fail-closed)`;
- исполнитель жив, но команды падают с `EWORKSPACE` / `cwd_outside_workspace`.

**Диагностика (по порядку):**

1. **Жив ли исполнитель и что он сообщает о себе:**

   ```bash
   docker compose --profile split exec synth-executor wget -qO- http://127.0.0.1:5100/health
   docker compose --profile split exec synth-executor wget -qO- \
     --header="Authorization: Bearer $SYNTH_EXECUTOR_TOKEN" http://127.0.0.1:5100/capabilities
   ```

   `/capabilities` отдаёт версию протокола и состав toolchain'а (`git`, `rg`, `python3`) — по нему видно, какой образ исполнителя запущен.

2. **Токен.** Без корректного bearer-токена исполнитель отвечает `401` (это нормально). Проверить пару «файл ↔ значение»:

   ```bash
   # значение, которое видит исполнитель (должно совпадать с содержимым файла)
   docker compose --profile split exec synth-executor printenv SYNTH_EXECUTOR_TOKEN
   # файл, который читает control plane
   docker compose --profile split exec synth-backend-split cat /etc/synth/executor/token
   ```

   Значения обязаны совпадать посимвольно. Control plane читает токен **только из файла** (`SYNTH_EXECUTION_TOKEN` — это путь, а не значение; инвариант 13).

3. **Режим и адрес.** `SYNTH_EXECUTION_MODE=remote` — переключатель запуска (инвариант 24): смена режима требует рестарта процесса, а не runtime-настройки. `SYNTH_EXECUTION_REMOTE_URL` должен указывать на **адрес исполнителя** (`http://synth-executor:5100` в compose, `http://<pod>:5100` в K3s), а не на control plane.

4. **Файл токена существует.** Если `.executor-token` не создан, Docker создал на его месте **каталог** — control plane читает его как файл и падает. Проверка: `docker compose --profile split exec synth-backend-split ls -l /etc/synth/executor/token` (ожидается regular file).

5. **Workspace совпадает.** Путь workspace у control plane и исполнителя должен быть одинаковым (`/var/synth/data/workspaces` в обоих). Иначе `cwd` не попадает в workspace исполнителя → `EWORKSPACE`.

6. **Поведение при недоступности.** По умолчанию `SYNTH_EXECUTION_FAIL_MODE=fail` — команда **не** выполняется локально (fail-closed). `inline-fallback` — осознанный обход изоляции (команда уйдёт в control plane); в managed-контуре его включать не стоит.

**Сквозная проверка:** `./scripts/e2e-executor.sh` поднимает настоящие control plane и исполнитель и проверяет маршрутизацию, fail-closed и 401 — см. [DEVELOPMENT.md](./DEVELOPMENT.md#сквозной-тест-control-plane--исполнитель).

## Где смотреть логи

| Сервис | Лог |
|--------|-----|
| backend | `tmp/backend.log` |
| UI | `tmp/ui.log` |
| core standalone | `tmp/core.log` |
| аудит LLM Gateway | `{dataDir}/audit/llm-gateway.jsonl` |
