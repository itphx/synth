# Журнал задач оркестратора

## 2026-08-31 — feat: гибридный режим (локальный synth ↔ сервер K3s) — T1–T8
- **Задача:** «Реализовать гибридный режим: локальный synth подключается к серверу в K3s; доступны локальные и удалённые проекты; LLM централизован.»
- **Тип:** feature
- **Исполнитель:** @orchestrator → @fixer (8 задач)
- **Результат:** PASS
- **Коммит:** см. коммиты ветки feat/hybrid-mode (T1–T8)
- **Что сделано:** конфиг `remote` (shared); RemoteBackendClient + OIDC device flow + credentials (core/remote); CLI `serve --connect`/`connect`/`disconnect`/`project publish|fork` (core+synth); агрегация миров с `origin` и namespace `remote:<id>` (core server); UI (OriginBadge, HybridStatusIndicator, подтверждения, селектор мира); LLM Proxy `POST /api/v2/llm/chat/completions` (backend, Gateway AD-036); RemoteProvider + запрет локальных провайдеров; RemoteEventBridge (SSE→EventBus→UI); publish/fork с переносом проекта+сессий+файлов (e2e подтверждён).
- **Проверка:** pnpm test — shared 72 / core 1081 / ui 92 / backend 201; typecheck+lint чисто; e2e publish→fork на dev-backend (история сообщений и todos перенесены).
- **Требования:** docs/HYBRID.md (ветка feat/hybrid-mode).

## 2026-09-01 — bug: провайдер не найден (K3s) — рассинхронизация кеша провайдеров/моделей
- **Задача:** «Провайдер omn.itphx.loc добавлен в K3s-инстанс через админку, но при отправке сообщения — ошибка "Провайдер не найден" (502 PROVIDER_NOT_FOUND).»
- **Тип:** bug
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** нет (не коммитим без явной просьбы; изменения в рабочем дереве)
- **Причина:** providerCache/modelCache в backend заполняются только при старте (app.ts:317-327); API-роуты POST/DELETE /providers и /models пишут только в JsonStore, не обновляя кеш. LLM Proxy резолвит провайдера только из кеша → новый провайдер невидим до рестарта пода (GET /providers читает с диска, поэтому провайдер «виден», но не резолвится). Тот же дефект в standalone-core.
- **Исправление:** backend + core — createProviderRoutes/createModelRoutes теперь принимают кеши и синхронизируют их при создании/обновлении/удалении провайдера и модели (в т.ч. POST /models/fetch и set_as_default).
- **Изменённые файлы:** packages/backend/src/app.ts, routes/providers.ts, routes/models.ts, routes/models.test.ts; packages/core/src/server/app.ts, routes/providers.ts, routes/models.ts, routes/models.remote.test.ts; новые тесты providers.test.ts (backend+core), models.cache.test.ts (core).
- **Проверка:** pnpm test — shared 72 / core 1097 / backend 220 / ui 94; typecheck+lint чисто.
- **Рантайм (K3s):** rollout restart deploy/synth-backend — кеш заполнился из PVC; тестовый запрос к POST /api/v2/llm/chat/completions с моделью omn.itphx.loc/qwen3.8:27b-256k прошёл успешно (ответ «Да.»), PROVIDER_NOT_FOUND ушёл.
- **Важно:** фикс в коде ещё не задеплоен в K3s (образ backend 0.4.1). Для постоянного эффекта без рестартов: закоммитить → релиз (GitVerse CI) → обновить tag в synth-deploy/values.yaml → Fleet. Пока действует только перезапуск пода.

## 2026-09-01 — feat: скрипт запуска гибрида (scripts/hybrid.sh)
- **Задача:** «Как запустить synth локально в гибридном режиме и подключить к развёрнутому инстансу в K3s? Сделай скрипт, адрес сервера передавать параметром.»
- **Тип:** feature (новый скрипт, существующий код не менялся)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** нет (не коммитим без явной просьбы; файл в рабочем дереве)
- **Что сделано:** `scripts/hybrid.sh` — запуск `node packages/synth/dist/cli.js serve --connect <URL> --oidc-issuer ... --oidc-client-id synth`; адрес сервера — позиционный параметр (default `https://synth.k3s.itphx.loc`); опции `--issuer/--client-id/--token/--api-key/--port/--data-dir/--no-build/--build`; экспорт `NODE_EXTRA_CA_CERTS` на `../synth-deploy/certs/itphx-ca.crt` (иначе Node/undici → SELF_SIGNED_CERT_IN_CHAIN); health-check сервера; проверка занятого порта; сборка пакетов (по умолчанию shared+core+synth, ui — только если нет dist, `--build` — всё); авто-генерация локального API-ключа; device flow/--token; foreground-запуск с пересылкой SIGINT/SIGTERM.
- **Проверка:** `bash -n` OK; `--help` (exit 0); smoke-тест `--no-build --port 4399 --token dummy` — сервер поднялся, `GET /api/v2/hybrid/status` → `{"enabled":true,"connected":true,"backendUrl":"https://synth.k3s.itphx.loc"}`; graceful shutdown по SIGINT/SIGTERM; порт освобождается; ошибки: неизвестная опция, порт занят, сервер недоступен, CA не найден (warn).
- **Использование:** `./scripts/hybrid.sh [OPTIONS] [SERVER_URL]` (в обычном режиме — device flow через Keycloak; для smoke без интерактива — `--token <key>`).

## 2026-09-01 — bug: device flow гибрида падал с unauthorized_client (confidential-клиент synth)
- **Задача:** «Запуск гибрида падает: RemoteError "Сервер авторизации вернул некорректный ответ (нет device_code/user_code/verification_uri)".»
- **Тип:** bug
- **Исполнитель:** @fixer (+ @orchestrator: Keycloak-сторона)
- **Результат:** PASS
- **Коммит:** нет (не коммитим без явной просьбы; изменения в рабочем дереве)
- **Причина:** клиент `synth` в Keycloak — confidential (`publicClient: false`), RFC 8628 требует client-аутентификацию; `device-flow.ts` слал только `client_id` → Keycloak возвращал `{"error":"unauthorized_client","error_description":"Invalid client or Invalid client credentials"}`, а код молча заменял это generic-сообщением «нет device_code». Плюс дефолтный client-id в скрипте указывал на `synth`.
- **Решение:** в Keycloak (realm `synth`) создан **public-клиент `synth-cli`** (`publicClient: true`, `oauth2.device.authorization.grant.enabled: true`, standard flow/direct access off) — проверено: device endpoint отдаёт device_code/user_code, token poll → authorization_pending без секрета. Веб-клиент `synth` (confidential) не тронут.
- **Исправление (код/доки):** `device-flow.ts` — `startDeviceFlow` теперь показывает `body.error`/`error_description` из ответа сервера вместо generic-сообщения; новый unit-тест в `device-flow.test.ts`; `scripts/hybrid.sh` — дефолт `CLIENT_ID=synth-cli` (+help); `AGENTS.md` и `README.md` — client-id для CLI/device flow → `synth-cli`.
- **Проверка:** pnpm test — shared 72 / core 1098 / ui 94 / backend 220 (все зелёные); typecheck+lint чисто; живой тест на реальном Keycloak: неверный client_id → `ERR: AUTH - Сервер авторизации не выдал device-код: invalid_client — Invalid client or Invalid client credentials (проверьте client_id и тип клиента)`; корректный `synth-cli` → deviceCode/userCode получены; `bash -n` и `--help` (default: synth-cli) OK.
- **Использование:** `./scripts/hybrid.sh` теперь проходит device flow (откроется verification URI + код для подтверждения).

## 2026-09-01 — feat: единая идентичность в гибриде (T1–T7)
- **Задача:** «Локальный Synth — клиент к серверу: вход адрес+логин+пароль, личность/профиль/тема/роли с сервера, админ-возможности (настройки, аудит) как на сервере.»
- **Тип:** feature
- **Исполнитель:** @fixer (3 батча) + @tester (UI-смоук) + @orchestrator (Keycloak, верификация)
- **Результат:** PASS
- **Коммит:** нет (не коммитим без явной просьбы; изменения в рабочем дереве)
- **Решение (обсуждено с пользователем):** гибрид остаётся (локальный мир + сервер), вход логин/пароль (ROPC) + кнопка «вход через браузер» (device flow), админ-роуты проксируются на сервер, офлайн — локальный мир живёт/серверное деградирует.
- **Keycloak:** на public-клиенте `synth-cli` включён `directAccessGrantsEnabled` (ROPC); проверено живым запросом — ROPC `grant_type=password` возвращает access+refresh, роли в токене.
- **Что сделано:**
  - T1 ROPC-логин: `passwordGrant` (device-flow.ts), `RemoteSession.loginWithPassword` (session.ts) — credentials + user через backend `/auth/status`.
  - T2 cookie v2 `synth_session` = JSON `{v:2,kind:'server'|'local',user}` (auth/local.ts): `setServerUserCookie`, совместимость с v1.
  - T3 логин-форма: поле «Адрес сервера» (подставляется из hybrid/status), логин/пароль, кнопка «Вход через браузер»; авто-логин при валидных credentials (UI открывается сразу авторизованным).
  - T4 профиль: `GET/PUT /auth/profile` проксируются на сервер; тема/предпочтения из серверного профиля.
  - T5 прокси: `server/proxy.ts` — audit/users/admin/logs/gateway/context/llm/providers/models → сервер (Bearer-токен, status/query/body, SSE; 502 OFFLINE). settings/mcp/sessions/projects/fs — локальные.
  - T6 device flow из UI: `POST /auth/device-start` + `/auth/device-check` (модалка со ссылкой/кодом в UI).
  - T7 тесты+доки: auth/local.test.ts, remote/session.test.ts, routes/auth.test.ts (new), app.proxy.test.ts (new), app.remote.test.ts (WS), UI i18n ru/en.
  - WS-фикс: `/ws/events` теперь принимает cookie-сессию v2 (не только Bearer==apiKey) — UI подключается по WS без SSE-fallback.
- **Проверка:** pnpm test — shared 72 / core 1134 / ui 94 / backend 220 (все зелёные; флаки WS-тест при полном параллельном прогоне — по-пакетно ок); typecheck+lint чисто (0 errors).
- **Живая проверка (реальный Keycloak, core :4398, УЗ lucky):** авто-логин → главный экран без формы; форма логина с адресом сервера; ROPC вход; неверный пароль → «Не удалось войти: Неверный логин или пароль»; «Вход через браузер» → already_authenticated → перелогин; `/auth/me`/`/auth/profile` → lucky (роль USER); `/api/v2/audit` → 403 от сервера (не 404 локального); `/api/v2/providers` → серверные провайдеры; WS → 101 с cookie.
- **Осталось/заметки:** проверить, что после reauthenticate UI-цикл «вход через браузер» стабилен (перезапуск UI после последнего фикса не досмотрен @fixer из-за лимита шагов, QA подтвердил базовый сценарий); `GET /auth/locales` → 404 (нет в standalone core) — некритично.

## 2026-09-01 — feat: вход в гибриде без Keycloak-ритуала (runtime-подключение, дискавери)
- **Задача:** «После запуска открыть веб-интерфейс и ввести адрес сервера, логин и пароль. Никаких ссылок в консоли, кодов, Keycloak. Адрес: если передан параметром/env — в UI не запрашиваем, иначе запрашиваем. Без сервера не работаем.»
- **Тип:** feature
- **Исполнитель:** @fixer (батчи A–F) + @tester (QA) + @orchestrator
- **Результат:** PASS
- **Коммит:** нет (не коммитим без явной просьбы; 45 файлов в рабочем дереве)
- **Что сделано:**
  - Batch A: backend `GET /auth/oidc-meta` (публичный: issuer + cliClientId; секрет не отдаётся); конфиг `oidc.cliClientId` (default `synth-cli`) в zod-схеме + ручном AuthConfig + app-config (env SYNTH_OIDC_CLI_CLIENT_ID).
  - Batch B: `RemoteConnection` (core/src/remote/connection.ts) — runtime-менеджер: discoverOidc (GET /auth/oidc-meta, fallback на deps.defaultIssuer/defaultClientId), connectByPassword (ROPC), connectFromSaved (без device flow), connectWithApiKey, disconnect; 14+ тестов.
  - Batch C+D: core переведён на runtime-подключение: app.ts создаёт RemoteConnection, хелперы applyConnected/disconnectRemote (инъекция remote-провайдера, блокировка локальных провайдеров, RemoteEventBridge start/stop); hybrid/status, proxy, auth-роуты и роуты sessions/projects/fs/queue/messages читают ТЕКУЩЕЕ подключение (геттеры); старт `serve --connect` НЕ блокируется device flow (тихий connectFromSaved после listen, connectWithApiKey при --token); cli.ts/main.ts без ensureAuthenticated.
  - Batch E+F: UI LoginForm — адрес сервера показывается только если не задан при старте (serverConfigured), иначе только логин/пароль; кнопка «Вход через браузер» и device-модалка УБРАНЫ из UI (клиентские методы удалены); hybrid/status + auth/status: serverConfigured/serverLoginAvailable/oidc_enabled; hybrid.sh — без молчаливого дефолта URL (адрес: аргумент/env SYNTH_SERVER_URL, иначе вводится в UI), без device-подсказок; доки (AGENTS.md, README, docs/HYBRID.md) — новый UX.
- **Проверка:** pnpm test — shared 72 / core 1160 / ui 94 / backend 224 (зелёные; флаки WS при полном параллельном прогоне — по-пакетно ок); typecheck+lint чисто (0 errors). QA в браузере (Playwright): форма ровно 3 поля без «вход через браузер»; вход lucky → главный экран, connected:true; неверный пароль → «Не удалось войти: Неверный логин или пароль»; logout → форма; авто-логин в новом контексте по сохранённым credentials — PASS.
- **Живая проверка:** core без --connect (только --oidc-issuer/--oidc-client-id): /auth/status oidc_enabled:true; /hybrid/status serverConfigured:false; POST /auth/login {server, lucky} → 200 (дискавери упал в fallback на флаги, т.к. боевой K3s ещё без /auth/oidc-meta) → connected:true; core с --connect: авто-логин по saved credentials, serverConfigured:true.
- **Важно:** боевой K3s (образ 0.4.1) НЕ содержит /auth/oidc-meta — для полностью динамического входа в произвольный сервер нужен редеплой backend (новый образ с Batch A). Пока работает fallback на --oidc-issuer/--oidc-client-id (в hybrid.sh есть дефолты itphx). CLI `synth connect` (device flow) и backend /auth/device-* оставлены для обратной совместимости/автоматизации, из UI не вызываются.
- **Заметки:** /auth/locales → 404 в standalone (UI запрашивает — некритично); logout не удаляет credentials.json (авто-логин при следующем открытии — by design); ошибка формы логина без role=alert (a11y, некритично).
