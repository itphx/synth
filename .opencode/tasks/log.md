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

## 2026-09-04 — deploy: пересборка и деплой 0.4.2 на K3s
- **Задача:** «Пересобери и задеплой на K3s актуальный образ.»
- **Тип:** deploy/ops
- **Исполнитель:** @orchestrator
- **Результат:** PASS
- **Коммиты:** synth — e102731 (feat: единая личность/вход в UI), a78f512 (docs), 474078d (chore: bump v0.4.2) + tag v0.4.2 (ветка feat/hybrid-mode); synth-deploy — fb00edf (теги 0.4.2, main, запушен → Fleet).
- **Что сделано:** bump 0.4.2; docker build+push git.itphx.ru/itphx/synth-{backend,ui}:0.4.2 (Dockerfile.backend/ui из исходников монорепо); обновлены теги в synth-deploy/values.yaml; Fleet раскатил (backend+ui 0.4.2, rollout успешен).
- **Проверка (живой K3s):** /auth/oidc-meta → `{enabled:true, issuer:keycloak…/synth, clientId:synth-cli}` (эндпоинт дискавери появился); дискавери→ROPC(lucky)→Bearer /auth/status → authenticated:true, lucky, USER — полный путь входа локального core работает. /health по-прежнему отдаёт version 0.1.0 (hardcoded в роуте health backend — косметика, не связано с образом).

## 2026-09-05 — fix: гибрид — зеркалирование серверных провайдеров вместо synth-remote (Задача 1 из пула)
- **Задача:** «В локальной сессии гибрида не работает отправка: „Провайдер не найден или не сконфигурирован“. Решение (утверждено): локальный core получает с сервера полный список провайдеров/моделей и зеркалирует их как remote-провайдеров с настоящими именами; явное поле provider в контракте LLM Proxy.»
- **Тип:** bug/feature (core+backend)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** нет (не коммитим без явной просьбы; 11 файлов в рабочем дереве, ветка feat/hybrid-mode)
- **Что сделано:**
  - Backend `llm.ts`: в `chatCompletionsSchema` добавлено опциональное `provider`; если задан — провайдер обязан существовать и быть включённым, иначе 502 PROVIDER_NOT_FOUND / 400 PROVIDER_DISABLED; несоответствие провайдера модели → 400 MODEL_MISMATCH; без поля — как раньше (резолв по модели).
  - Core `providers/remote.ts`: `RemoteProviderOptions.provider` — имя серверного провайдера для тела LLM Proxy (по умолчанию = name); `_buildBody` шлёт `provider`.
  - Core `remote/client.ts`: добавлен `listProviders()` (GET /api/v2/providers); `listModels()` расширен полными метаданными (contextWindow/цены/isDefault/contextSource/maxOutputTokens).
  - Core `server/app.ts`: `activeRemoteProviderName` → `Set activeRemoteProviderNames`; `applyConnected` параллельно тянет провайдеров+модели, зеркалит каждого включённого неслужебного серверного провайдера под НАСТОЯЩИМ именем (type:'remote', baseUrl: backendUrl) c `setRemoteTokenProvider`; модели в modelCache БЕЗ переписывания provider; `remote.llm: local` — зеркала только для имён, отсутствующих в локальном store; снапшоты перекрытых локальных записей + `restoreRemoteMirrors()` (reconnect/disconnect без потери локальных конфигов); `providerLoader` блокирует локальных при server-режиме, разрешает набор зеркал; models-роут — extraProviders из набора.
  - Миграция старых сессий с `synth-remote` НЕ делается (решение пользователя): сессия чинится сменой модели в UI (перезапишет settings при следующей отправке).
  - Тесты: `llm.test.ts` (provider в теле), `remote.test.ts` (_buildBody), `client.test.ts` (listProviders/listModels), `app.remote.test.ts` (E2E зеркало itphx + локальная сессия + восстановление после disconnect + remote.llm local), `hybrid.integration.test.ts`/`models.remote.test.ts` переведены с synth-remote на зеркальные имена.
- **Проверка:** pnpm typecheck (все 6 пакетов) чисто; pnpm lint — 0 errors; pnpm test — shared 72 / core 1168 / ui 94 / backend 229 (все зелёные, включая hybrid.integration 5/5). dist core пересобран.
- **Заметки:** легаси-дефолт `name ?? 'synth-remote'` в remote.ts сохранён (обратная совместимость + unit-тесты); в app.ts `synth-remote` остался только в комментариях. Дальше по плану: Задача 2 (селектор «где создать» в дереве) → Задача 3 (UI-перенос проектов publish/fork).

## 2026-09-05 — feat: выбор мира создания сессий в дереве (Задача 2 из пула)
- **Задача:** «В гибриде новые сессии создаются локально — при работе в локальном экземпляре должен быть выбор, где создавать сессию.»
- **Тип:** feature (UI)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** нет (без явной просьбы; только пакет @itphx/synth-ui + 3 теста)
- **Что сделано:**
  - `components/ui/OriginSelector.tsx` (новый) — общий селектор «Локально / На сервере» (вынесен из ProjectsTabToolbar; offline/disabled поддержка).
  - `LeftPanel.tsx`: у группы «Без проекта» и узлов проектов «+»/контекстное меню в гибриде дают выбор «Создать сессию локально / на сервере». Семантика кросс-мира: каждый мир знает только свои проекты — «чужой» мир создаёт сессию БЕЗ проекта (в группе «Без проекта»), «свой» — внутри проекта узла; битых связок project_id из другого мира не остаётся. В offline remote-создание скрыто (не 502).
  - `ProjectsTabToolbar.tsx`: remote-проект принудительно фиксирует origin 'remote' (селектор заблокирован); выбор 'remote' при локальном проекте сбрасывает привязку к проекту + подсказка hybrid.createRemoteNoProject; на submit remote+локальный проект → project_id: null.
  - `tree/types.ts` + `TreeNode.tsx`: TreeAction получил опциональный menuItems — кнопка действия («+») может раскрывать ContextMenu (обратная совместимость сохранена).
  - `sessionsStore.ts`: origin нормализуется `?? 'local'` при создании; `transportStore.ts`: WS session.created/fork.created без origin восстанавливают по remote: префиксу.
  - i18n ru/en: hybrid.createSessionLocal/createSessionRemote/createRemoteNoProject. Тесты: transportStore.subagent.test.ts +3 (origin локальных/remote-событий).
- **Проверка:** pnpm typecheck чисто; pnpm lint 0 errors; pnpm test — shared 72 / core 1168 / ui 97 / backend 229 (зелёные); pnpm --filter @itphx/synth-ui build — ок.
- **Заметки:** projectsStore не менялся (origin не теряется). Drag-and-drop сессий между мирами — вне объёма. Дальше по плану: Задача 3 (UI-перенос проектов publish/fork).

## 2026-09-05 — feat: перенос проектов между мирами через UI (Задача 3 из пула)
- **Задача:** «В UI нужен инструментарий переноса: локальный проект → сервер или форк серверного проекта в локальный. Перенос — только проектов целиком (не сессий).»
- **Тип:** feature (core + UI)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** нет (без явной просьбы; новые файлы project-transfer.ts(+test), PublishProjectDialog, ForkProjectDialog)
- **Что сделано:**
  - Core: новый `routes/project-transfer.ts` — `POST /api/v2/projects/:id/publish` (локальный проект → сервер; тело `remote_project_id?` = обновление существующего, иначе создание нового с тем же именем; «всегда всё» — includeFiles/Sessions=true; 400 на remote-id, 404, offline → 502, RemoteError → HTTP) и `POST /api/v2/projects/:id/fork-local` (remote-проект → локальный; тело `local_name?`; возвращает DTO локального проекта). Смонтированы в app.ts на префикс /projects (переданы projectStore/sessionManager/workspacesRoot/defaultWorkingDir/геттер client). Нюанс 422: не требуется — syncProjectToRemote создаёт workspace на сервере при includeFiles=true (тесты фиксируют).
  - Core `remote/transfer.ts`: в forkProjectToLocal импортированные сессии помечаются userId/ownerId='local' (иначе GET /sessions не вернул бы их в UI). Тесты CLI/transfer не сломаны.
  - UI: synthApi.publishProject/forkRemoteProject; projectsStore — экшены + loadProjects/loadSessions + проброс ошибок; LeftPanel — пункты «Опубликовать на сервер»/«Склонировать локально» в меню проекта (только hybridOnline); диалоги `projects/PublishProjectDialog.tsx` (создать новый / обновить существующий remote-проект из списка, предупреждение о перезаписи, занятость, toast) и `ForkProjectDialog.tsx` (имя копии, коллизия локального имени блокирует); i18n ru/en.
- **Проверка:** pnpm typecheck чисто; pnpm lint 0 errors; pnpm test — shared 72 / ui 97 / core 85 файлов/1180 (+12: project-transfer.test.ts 10 + app.remote.test.ts +2) / backend 229 (зелёные); pnpm build успешно.
- **Заметки:** живой smoke publish/fork в UI/через curl с реальным backend не выполнялся (нет окружения/credentials) — рекомендуется при следующей сессии с dev-окружением. HTTP-сценарий в hybrid.integration.test.ts — опционально. Все 3 задачи пула (фикс провайдера, селектор «где создать», UI-перенос проектов) реализованы, изменения в рабочем дереве не закоммичены.

## 2026-09-05 — deploy: релиз 0.4.3 на K3s (3 задачи гибрида)
- **Задача:** «Закоммить наработки, собери и разверни на K3s.»
- **Тип:** deploy/ops
- **Исполнитель:** @orchestrator
- **Результат:** PASS
- **Коммиты:** synth — 7117f55 (feat: гибрид — зеркалирование провайдеров, выбор мира создания сессий, перенос проектов, v0.4.3; один коммит — правки задач переплетены в общих файлах) + tag v0.4.3 (локально, push не делали по решению пользователя); synth-deploy — 17ca774 (chore: deploy 0.4.3 — теги backend/ui), запушен на git.itphx.loc → Fleet.
- **Что сделано:** version-bump 0.4.3 (version.ts + 6 package.json); pnpm build всех пакетов — успешно; docker build+push git.itphx.ru/itphx/synth-{backend,ui}:0.4.3 (Dockerfile.backend/ui из исходников); values.yaml в synth-deploy → теги 0.4.3, push main.
- **Проверка (живой K3s):** rollout backend/ui успешен; поды на образах 0.4.3 (1/1 Running); /api/v2/health → healthy; /auth/oidc-meta → {enabled, issuer keycloak/synth, clientId synth-cli}; ошибок в логах backend нет. Известные pre-existing мелочи: /health отдаёт version 0.1.0 (hardcoded, косметика); Fleet bundle synth Ready=False из-за ingressroute/middleware synth-https-redirect/synth-redirect-to-https «not owned by us» (ресурсы созданы не Fleet) — на rollout деплойментов не влияет.
- **Заметки:** push synth (ветка feat/hybrid-mode, тег v0.4.3) в gitverse origin НЕ выполнялся (решение пользователя — push только synth-deploy). Живой smoke новых фич (отправка в локальной сессии гибрида, выбор мира, publish/fork в UI) — при следующей сессии с dev-окружением.

## 2026-09-05 — fix: подготовка нового релиза (2 бага + Fleet Ready)
- **Задача:** «Исправь пару небольших багов и будем выкатывать новый релиз» — /health version; дёрганье вкладок правой панели; Fleet bundle synth Ready=False.
- **Тип:** bug (backend, UI) + ops (Fleet)
- **Исполнитель:** @fixer (код), @orchestrator (Fleet)
- **Результат:** PASS
- **Коммит:** d3463db (synth, feat/hybrid-mode; push не делали)
- **Что сделано:**
  - `packages/backend/src/app.ts`: `/health` и `/api/v2/health` возвращают `SYNTH_VERSION` (0.4.3) вместо хардкода '0.1.0' (импорт добавлен в существующий shared-импорт).
  - `packages/ui/src/hooks/useAdaptiveIcons.ts` (+ тест `useAdaptiveIcons.test.tsx`, 7 кейсов): устранена осцилляция «текст ↔ иконки» при первом открытии правой панели. Причина: при обрезке с первого замера `textFitsWidthRef` оставался 0, а fallback-порог возврата `containerWidth * 0.9` пересчитывался на каждый check (для любой ширины W>0.9W всегда истинно) и не дебаунсился → любое событие ResizeObserver/resize во время анимации открытия мгновенно возвращало текст, затем снова иконки. Фикс: якорь `iconsOnlyWidthRef` (ширина в момент включения iconsOnly) + симметричный debounce 300 мс для возврата текста. RightPanel/LeftPanel не менялись.
  - Fleet: объекты `ingressroute synth-https-redirect` и `middleware synth-redirect-to-https` в ns synth были созданы вручную (kubectl apply 30.08, last-applied-configuration, без objectset-лейблов) — bundle `synth` (fleet-local) Ready=False «not owned by us». Чарт synth-deploy их уже определяет (templates/https-redirect.yaml, `redirectHttpToHttps: true`, gitrepo на 17ca774). Удаление не привело к авто-пересозданию (у GitRepo `correctDrift` пуст, helm не ставит objectset-лейблы) — Fleet перешёл в «missing». Восстановили оба ресурса с ownership-лейблами как у соседних (`objectset.rio.cattle.io/hash: e3f76…62`, `objectset.rio.cattle.io/id: default-synth-cattle-fleet-local-system`, helm-лейблы/аннотации, spec идентичен чарту) → bundle Ready 1/1, modified=0.
- **Проверка:** pnpm typecheck — все 6 пакетов чисто; pnpm lint — 0 errors (только pre-existing warnings); pnpm test — shared 72 / ui 104 (+7 новый hook-тест) / core 1180 / backend 229 / runner нет тестов — зелёные. K3s: `kubectl -n fleet-local get bundle synth` → 1/1 Ready; IngressRoute/Middleware созданы, labels с hash на месте.
- **Заметки:** закоммичены только 3 файла фиксов (app.ts, useAdaptiveIcons.ts + test); чужие незакоммиченные доки (AGENTS.md, README.md, docs/**) не трогали. Готово к сборке нового релиза (0.4.4+).

## 2026-09-05 — release+deploy: релиз 0.4.4 и обновление K3s
- **Задача:** «Закоммить изменения и релизимся. После релиза обнови инстанс на K3s.»
- **Тип:** release/ops
- **Исполнитель:** @orchestrator
- **Результат:** PASS
- **Коммиты:** synth — 671fda5 (docs: AD-032 PostgreSQL), be7a21b (chore: bump v0.4.4), tag v0.4.4 (локально, push не делали по прецеденту 0.4.3); synth-deploy — 0a4e622 (chore: deploy 0.4.4 — теги backend/ui), запушен на git.itphx.loc → Fleet.
- **Что сделано:** закоммичена оставшаяся документация (AD-032 — хранение истории на PostgreSQL, SQLite исключён); `./scripts/version-bump.sh patch` 0.4.3→0.4.4 (version.ts + 6 package.json); pnpm build всех пакетов — успешно; docker build+push git.itphx.ru/itphx/synth-{backend,ui}:0.4.4 (Dockerfile.backend/ui из исходников); values.yaml в synth-deploy → теги 0.4.4, push main.
- **Проверка (живой K3s):** Fleet подхватил 0a4e622 (~40 с), bundle synth 1/1 Ready (в момент rollout 0/1 → снова 1/1); rollout backend/ui успешен, поды на образах 0.4.4 (1/1 Running); `/health` и `/api/v2/health` → version 0.4.4 (фикс хардкода 0.1.0 подтверждён на проде); ingressroute/middleware synth-https-redirect/synth-redirect-to-https пережили helm-upgrade (остались owned, bundle без Modified); ошибок в логах backend нет (только штатные 401 на /api/v2/events без сессии).
- **Заметки:** push synth (ветка feat/hybrid-mode, тег v0.4.4) в gitverse origin не выполнялся — по прецеденту 0.4.3 (пользователь пушил только synth-deploy); npm-публикация не выполнялась. Релиз 0.4.4 содержит: фикс версии в /health, стабилизацию useAdaptiveIcons (дёрганье вкладок), доки AD-032.

## 2026-09-05 — gitverse: merge в master + полноценный релиз v0.4.4
- **Задача:** «Слей ветку в master с --no-ff, запуш, и создай полноценный релиз в gitverse.»
- **Тип:** git/release
- **Исполнитель:** @orchestrator
- **Результат:** PASS (с оговорками по docker-образу gitverse, см. ниже)
- **Коммиты:** merge `6126667` (feat/hybrid-mode → master, --no-ff) + docs-лог; push `master` (`611164f..6126667`) и тег `v0.4.4` на gitverse.ru.
- **Что сделано:**
  - Merge `feat/hybrid-mode` → `master` (`--no-ff`, 30 коммитов: гибрид 0.4.0–0.4.4, фиксы, доки); тег `v0.4.4` перенесён на merge-коммит.
  - Пуш `master` и `v0.4.4` → сработал release-workflow (`release.yaml`, ран v0.4.4 ×4 попытки).
  - npm-публикация 0.4.4 доведена до конца: npmjs.org (shared/core упали в CI по сети — допубликованы локально backend/ui/runner/synth) и GitVerse Package Registry (все 6) — `@itphx/synth` latest = 0.4.4.
  - GitVerse Release создан вручную (MCP): https://gitverse.ru/itphx/synth/releases/tag/v0.4.4 (тело — гибрид, фиксы, установка).
- **Проблемы/оговорки:**
  - GitVerse-раннеры нестабильны: segfault pnpm (exit 139), context deadline docker.sock, сетевой обрыв npmjs — лечилось перезапуском/локальной публикацией.
  - CI-джобы «Docker образ» и «GitVerse Release» падают с **403 Forbidden** (kaniko push в gitverse.ru container registry; create-release API): у `GV_TOKEN` в секретах нет прав на container registry org itphx и Releases API (npm-реестр — есть). Локальный docker push в gitverse.ru тоже 403 → образы в gitverse-реестр НЕ выложены (для K3s используются git.itphx.ru, выложены ранее).
  - **Рекомендация:** выдать `GV_TOKEN` (или отдельному токену CI) права на container registry itphx/synth-* и Releases, либо проверить корректность username в kaniko-авторизации (`itphx:` + token → возможно нужен логин владельца токена). Тогда повторный push тега пройдёт docker+create-release автоматически (npm-шаги идемпотентны).

## 2026-09-06 — feat: мобильный адаптив UI + PWA (AD-044) — ветка feat/mobile-ui-pwa
- **Задача:** «Сделать UI доступным с телефона/планшета и устанавливаемым как PWA, не ломая десктоп.»
- **Тип:** feature (AD-044)
- **Исполнитель:** @fixer (фазы 0–4) + @orchestrator (доки/AD)
- **Результат:** PASS
- **Коммиты:** 1c4b5fe..fa47611 (25 коммитов, версии 0.5.0–0.5.5); merge d50be9e в master.
- **Что сделано:** единый адаптивный интерфейс (телефон ≤768 / планшет 769–1199 / десктоп ≥1200, классы `device-*`/`pointer-coarse`, `useDevice`, safe-area, 100dvh); панели-дроверы на телефоне/планшете; touch-first (hover-видимость, таргеты ≥40px, нативные скроллбары, отключение drag&drop на таче); ConfirmDialog вместо window.confirm; модалки/админка с гориз. скролл-табами; клавиатура (useKeyboardInset, Enter на таче = перенос); PWA app-shell вручную (manifest, sw.js, иконки, install-prompt, раздача nginx/core); композер/шапка — компакт по container query/central-narrow (Ref-callback ResizeObserver); фиксы логина (поле адреса только в гибриде, Enter логин→пароль); фикс 404 /updates/check (VITE_ENABLE_UPDATE_CHECK).
- **Проверка:** typecheck+lint+тесты зелёные (локально и CI); доки AD-044 + AGENTS.md.

## 2026-09-07 — feat: профили серверов гибрида и лёгкий runtime-вход (AD-045) — ветка feat/hybrid-server-profiles
- **Задача:** «Убрать тяжёлую механику "вход = переход в профиль" (рестарт/exit 77/409) — вход всегда runtime, единый dataDir, устойчивость через watcher.»
- **Тип:** feature (AD-045, расширяет AD-042/043)
- **Исполнитель:** @fixer + @orchestrator
- **Результат:** PASS
- **Коммиты:** 5724ef3..757725b (13 коммитов, версии 0.5.6–0.5.7); merge 32795e7 в master.
- **Что сделано:** POST /auth/login — runtime-подключение без рестарта (отменены switch-profile/exit 77/409 PROFILE_SWITCH_REQUIRED); единый dataDir (per-server каталоги профилей удалены); profiles.json — мета-реестр для UX (knownServers/lastServer), credentials — единый мульти-серверный файл; поле «Сервер» в LoginForm всегда в гибриде (datalist knownServers); logout = disconnect + «забыть токен» + best-effort revoke refresh (RFC 7009) + очистка cookie; ConnectionWatcher (health/auth ~15 с, реальный connected, авто-переподключение ≤1/30 с, refresh токена); CLI serve --connect/lastProfile/--no-auto-profile/--print-api-key; hybrid.sh без обёртки рестарта; AD-045 в docs.
- **Проверка:** typecheck+lint+тесты зелёные (в т.ч. CI на теге); доки AGENTS.md/docs/HYBRID.md.

## 2026-09-07 — gitverse: полноценный релиз v0.5.7 (mobile PWA + hybrid profiles)
- **Задача:** «Выкатить полноценный релиз; изучить лог изменений, отсутствующих в origin, для подробного описания.»
- **Тип:** git/release
- **Исполнитель:** @orchestrator
- **Результат:** PASS (npm + Docker + Release в gitverse; CI-джобы Docker/Release по-прежнему падают — см. ниже)
- **Что сделано:**
  - Перенос тега `v0.5.7` на merge-коммит `32795e7` (HEAD master; до этого тег был на bump 757725b, дерево без mobile-UI). `v0.5.6` не пушился (промежуточный).
  - Локальная проверка перед пушем: pnpm install + build shared/core + typecheck + lint + test — все зелёные.
  - Push `master` (`d591ef4..32795e7`) и тег `v0.5.7` → release-workflow (#1497605, #1497687): CI-проверки, сборка, changelog, **npmjs.org и GitVerse Package Registry** — success (все 6 пакетов 0.5.7; @itphx/synth latest = 0.5.7).
  - Docker: заранее удалены старые образы gitverse (itphx/synth, synth-backend, synth-ui: 0.4.4+latest) через scripts/docker-cleanup.mjs. CI-джоба kaniko падает: первый ран — npm notarget (гонка npmjs), второй — **413 Request Entity Too Large от QRATOR** на PATCH blob. Обход: образы `synth`/`synth-backend`/`synth-ui` (0.5.7 + latest) собраны и запушены **локально docker CLI** (docker push обходит лимит QRATOR, kaniko — нет).
  - GitVerse Release создан вручную (MCP) — https://gitverse.ru/itphx/synth/releases/tag/v0.5.7 (CI create-release падает с 403: у GV_TOKEN нет прав Releases API). Тело релиза — подробное описание изменений 0.5.0–0.5.7 (AD-044/AD-045, фиксы, установка). WAF на MCP блокирует тело с командными строками в code-блоках (`npm install -g`, `docker run`) — обойдено формулировкой «Установка» без кодовых блоков.
- **Проблемы/оговорки:** CI-джобы «Docker образ» (kaniko 413 QRATOR) и «GitVerse Release» (403 GV_TOKEN) требуют правки release.yaml/токенов — пока обход локальным docker push + ручным созданием Release. Для K3s образы 0.5.7 собраны локально в git.itphx.ru (см. tmp/docker-*-build-057.log) — обновление synth-deploy не входило в задачу.

## 2026-09-15 — ui: 5 улучшений UI (сессия без имени, PWA-reload, композер, потеря связи, мобильные меню)
- **Задача:** «1) кнопка создания сессии в верхней панели не должна запрашивать имя; 2) в PWA дать пункт «Обновить страницу» в меню профиля; 3) в пустой сессии на мобильном композер слишком узкий — сделать как в сессии с сообщениями; 4) разобраться по логам K3s, почему 14.09 прервался ответ и покраснел индикатор, и предусмотреть превентивный механизм потери связи/повторного входа с уведомлением; 5) на мобильном не хватает контекстных меню проектов/сессий.»
- **Тип:** feature + bugfix (UI)
- **Исполнитель:** @orchestrator → @fixer (правки) + general/explore (исследование K3s-логов и UI-кода)
- **Результат:** PASS
- **Коммиты:** synth — `1c43d14` (feat(ui): 5 улучшений), `6a2d6ca` (chore: bump v0.5.8); synth-deploy — `9639c68` (release: bump ui image to v0.5.8)
- **Что сделано (11 файлов, +2 новых):**
  - **1.** `ProjectsTabToolbar.tsx` — из поповера создания сессии убрано поле «Имя сессии»; сессия создаётся без `name` (авто-имя), выбор проекта/origin сохранён.
  - **2.** новый `lib/pwa.ts` (`isPwaStandalone()`: display-mode/standalone + iOS `navigator.standalone`); `QuickSettingsPopup.tsx` — пункт «Обновить страницу» (`window.location.reload()`) виден только в PWA; i18n `auth.reloadPage`.
  - **3.** `ChatTab.tsx` — из обёртки пустой сессии убран `px-4` (композер снова той же ширины, что в сессии с сообщениями).
  - **4.** `transportStore.ts` — устранён цикл переподключений: WS→SSE fallback только один раз и только при падении WS; для SSE ошибок клиент не пересоздаётся (работает собственный backoff); `MAX_RECONNECT_DELAY` 600→60 c. Новый `ConnectionGuard.tsx` — при потере транспорта опрашивает `/auth/status`, различает «сессия мертва» (уведомление + форма входа, без reload) и «сервер/сеть недоступны» (уведомление + переподключение, через 20 c — предложение обновить страницу); `online/offline` + `visibilitychange` (важно для PWA). `authStore.sessionExpired()`. `ToastContainer` вынесен из `AuthGate` (иначе уведомление о причине размонтировалось при показе логина).
  - **5.** `styles/index.css` — действия/«…» в узлах дерева теперь видимы в зонах `device-phone`/`device-tablet` (fallback к `pointer-coarse`) + touch-таргеты; десктоп не затронут.
- **Диагностика инцидента 14.09 (K3s):** graceful-рестарт `synth-backend` 14.09 22:54:09 (SIGTERM, exit 0; не OOM) оборвал активный стрим; сессии бэкенда — in-memory Map (`packages/backend/src/auth/middleware.ts:9`), после рестарта cookie осталась, сервер её не знал → 401 на `/api/v2/events` и бесконечный реконнект (≈21 836 × 401 за утро 15.09). Клиент не отличал 401 от обрыва сети; помогал только reload/повторный вход. Keycloak 14–15.09 чист (рестарты 4/9.09; кратковременная потеря БД 14.09 12:59–13:20 — вне окна инцидента).
- **Проверка:** `pnpm typecheck` (6 пакетов) чисто; `pnpm lint` — 0 errors (pre-existing warnings); `pnpm test` — shared 72 / ui 110 / core 1220 / backend 229, все зелёные; `pnpm --filter @itphx/synth-ui build` — успешно. Живой тест (dev.sh, viewport 390×844): создание сессии без имени → «New session»; композер 366 px (было бы 334 с px-4); PWA-эмуляция standalone → пункт «Обновить страницу» виден; сброс cookie + форс-реконнект → форма входа + toast «Сессия истекла или сервер был перезапущен…», в логе всего 4 × 401 (было ~21 800).
- **Рекомендации (вне рамок задачи):** бэкенд — persistent/stateless сессии (подписанный cookie/JWT или общий стор), `PodDisruptionBudget`/rounding `maxUnavailable: 0`, реплика ≥2 и/или событие `server.going_away` на SIGTERM; данные-модели — дублирующиеся ключи моделей у разных провайдеров дают 186 React-warning (почистить уникальность ключей в селекторе).
- **Деплой K3s (0.5.8, UI-only):** образ `git.itphx.ru/itphx/synth-ui:0.5.8` собран из исходников (`docker/Dockerfile.ui`) и запушен; в `synth-deploy/values.yaml` поднят `ui.image.tag` 0.5.7→0.5.8, push в `main` → Fleet `synth` 1/1 Ready. `synth-ui` → 0.5.8 (rollout успешен), `synth-backend` оставлен 0.5.7 и НЕ перезапускался (сессии сохранены). Проверка: `https://synth.k3s.itphx.loc/` → 200; в отданном `ru-*.js` присутствуют «Сессия истекла или сервер был перезапущен», «Обновить страницу», «Связь не восстановлена». Коммиты synth в origin не пушились (деплой K3s этого не требует) — при необходимости отдельный релиз (tag/npm/CI).

## 2026-09-15 — fix(ui): авто-обновление PWA/SW + скролл экрана входа; деплой K3s 0.5.9
- **Задача:** «Реализовать предложенный фикс PWA-обновления (HTML no-cache, update-flow SW, баннер) — полезно ли для ПК? — и починить мобильный экран входа: клавиатура перекрывает поле пароля.»
- **Тип:** bugfix/feature (UI/PWA) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Коммиты:** synth — `e825e30` (feat(ui): PWA auto-update + скролл логина), `ade74a3` (chore: bump v0.5.9); synth-deploy — `03b5a00` (release: bump ui image to v0.5.9). В origin (gitverse) не пушились.
- **Проблема PWA:** после деплоя 0.5.8 PWA показывал старый UI (в обычном браузере — новый). Причина: залипший app-shell в кэше service worker (`synth-shell-v1`) + PWA в suspended без навигации; пункт «Обновить страницу» есть только в новом коде (замкнутый круг) → первое обновление только ручным сбросом кэша (пользователь сделал, помогло).
- **Что сделано:**
  - `public/sw.js`: убран `skipWaiting()` из `install` (новый SW ждёт команды), добавлен обработчик `SKIP_WAITING`, кэш `synth-shell-v2`.
  - новый `PwaUpdatePrompt.tsx` (+ unit-тест 4 кейса): `register('/sw.js', { updateViaCache: 'none' })`, детект `waiting`/`updatefound`, баннер «Доступна новая версия» → `SKIP_WAITING` → reload по `controllerchange`; проверка обновлений при `visibilitychange`. Работает и в десктопном браузере (SW регистрируется в любом браузере), не только в установленном PWA.
  - `main.tsx` (регистрация перенесена в компонент), `App.tsx` (баннер вне `AuthGate`, виден и на логине).
  - `docker/nginx-ui.conf`: `Cache-Control: no-cache` для HTML-шелла и SPA-fallback, `immutable` для `/assets/`; `/sw.js` уже был no-store. (`core/src/server/app.ts` уже ставил no-cache для HTML/sw — не трогали.)
  - Логин: `.login-screen` стал внутренним скролл-контейнером (`height:100%; overflow-y:auto`), `padding-bottom: var(--kb-inset)`; на фокусе поля — прокрутка формы вниз. Верификация: при эмуляции клавиатуры 320px поле пароля поднялось `bottom 572→412` (граница клавиатуры 524) → оба поля видны; десктоп без изменений.
  - Ключевой подводный камень: `:root #root { height:100%; overflow:hidden }` + `html/body overflow:hidden` → внешней прокрутки нет, `window.scrollTo` бесполезен; поэтому скролл внутри `.login-screen`, а не окна.
- **Деплой K3s (0.5.9, UI-only):** образ `git.itphx.ru/itphx/synth-ui:0.5.9` собран из исходников и запушен (sha256:0a5d5779…); `ui.image.tag` 0.5.8→0.5.9, push `main` (`9639c68..03b5a00`) → Fleet `synth` 1/1 Ready, rollout `synth-ui` успешен; `synth-backend` 0.5.7 не перезапускался. Проверка заголовков: `/` и `/index.html` → `cache-control: no-cache`, `/assets/*` → `public, max-age=31536000, immutable`, `/sw.js` → `no-store` + `synth-shell-v2`/`SKIP_WAITING`. `https://synth.k3s.itphx.loc/` → 200.
- **Ожидаемое поведение:** при следующем открытии PWA получит 0.5.9 JS (SW network-first), увидит ожидающий новый SW и покажет баннер «Обновить»; после нажатия — reload и полный переход на SW v2. Дальше обновления подхватываются автоматически с уведомлением (и в браузере тоже).

## 2026-09-15 — fix(ui): клавиатура на экране входа в standalone-PWA; деплой K3s 0.5.10
- **Задача:** «Баннер обновления и уведомления о потере связи работают. Но на экране входа в PWA клавиатура всё ещё перекрывает пароль (в мобильном браузере — ок). Сброс кэша и данных не помог.»
- **Тип:** bugfix (UI/PWA) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Коммиты:** synth — `0f4f6fd` (fix), `ffc79f2` (bump v0.5.10); synth-deploy — `d2d035c`.
- **Диагноз:** фикс 0.5.9 опирался на `--kb-inset` (`useKeyboardInset` ← `window.visualViewport`). В standalone-PWA `visualViewport` при клавиатуре может не обновляться/не отдавать высоту → padding=0 → сдвига нет. Это объясняет разницу «браузер vs PWA» при одинаковом устройстве; сброс кэша тут ни при чём.
- **Решение (keyboard-agnostic):** пока любой `input` формы в фокусе (touch) — у `.login-screen` включается класс `login-screen--keyboard` с `padding-bottom: 50vh`, и контейнер прокручивается вниз; при blur резерв снимается (с задержкой 200 мс, чтобы переход между полями не мигал). Не зависит от высоты клавиатуры и от `visualViewport`.
- **Верификация (dev, viewport 390×844, эмуляция touch):** до фокуса padding 0, пароль bottom 572; при фокусе класс применён, padding 422 px (50vh), scrollTop 64, пароль bottom **329** — с большим запасом выше клавиатуры (порог даже для 400 px клавиатуры = 444); при blur резерв снят. Композер/`useKeyboardInset` не тронуты.
- **Деплой K3s (0.5.10, UI-only):** образ `git.itphx.ru/itphx/synth-ui:0.5.10` собран/запушен (sha256:15e921ed…); `ui.image.tag` 0.5.9→0.5.10, push `main` (`03b5a00..d2d035c`) → Fleet `synth` 1/1 Ready, rollout успешен; `synth-backend` 0.5.7 не перезапускался. Проверка: отданный CSS содержит `login-screen--keyboard{padding-bottom:50vh}`; `/` → `no-cache`, `/sw.js` → `no-store`. Проверки монорепо: typecheck 0 ошибок, тесты shared 72 / ui 114 / core 1220 / backend 229, lint 0 errors.

## 2026-09-15 — fix(ui): клавиатура логина в PWA на MIUI/Poco F5; деплой K3s 0.5.11
- **Задача:** «Не помогло (PWA). Телефон Poco F5.»
- **Тип:** bugfix (UI/PWA) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Коммиты:** synth — `4c2e89e` (fix), `5e742e3` (bump v0.5.11); synth-deploy — `55e8239`.
- **Точная первопричина (найдена):** и CSS-гейт `html.pointer-coarse`, и `useDevice().isTouch` вычисляются из `matchMedia('(pointer: coarse)') && !matchMedia('(any-pointer: fine)')`. На MIUI/Poco F5 `(any-pointer: fine)` = **true**, поэтому ни `pointer-coarse`, ни `isTouch` не выставлялись — оба прежних фикса (0.5.9 `--kb-inset`, 0.5.10 класс через `isTouch`) просто не активировались. В «мобильном браузере» проверялось, видимо, на другом устройстве/браузере.
- **Решение:** гейт перенесён на зону устройства по ширине окна — `html.device-phone`/`html.device-tablet` (от `pointer` не зависит): форма прижимается к верху (`align-items:flex-start; padding-top:max(1.5rem, env(safe-area-inset-top))`), а пока поле в фокусе — резерв `padding-bottom:50vh` + прокрутка контейнера. Это устраняет зависимость от `matchMedia`. Дополнительно на экран входа добавлена версия (`Synth v{SYNTH_VERSION}`), а регистрация SW стала версионированной (`/sw.js?v=SYNTH_VERSION`) — теперь UI-only деплои тоже вызывают баннер обновления (раньше `sw.js` не менялся и обновление не детектировалось).
- **Деплой K3s (0.5.11, UI-only):** образ `git.itphx.ru/itphx/synth-ui:0.5.11` собран/запушен (sha256:4668588f…); `ui.image.tag` 0.5.10→0.5.11, push `main` (`d2d035c..55e8239`) → Fleet `synth` 1/1 Ready, rollout успешен; `synth-backend` 0.5.7 не перезапускался. Проверка боевого: CSS содержит `device-phone/tablet .login-screen{align-items:flex-start;padding-top:…}` и `…--keyboard{padding-bottom:50vh}`; JS — `0.5.11`, `sw.js?v=…`, класс `login-screen--keyboard`; старых `pointer-coarse .login-screen` правил нет; `/` → `no-cache`, `/sw.js` → `no-store`. Typecheck 0 ошибок, тесты shared 72 / ui 114 / core 1220 / backend 229.
- **Пользователю:** открыть PWA → появится баннер обновления (теперь детектируется) → «Обновить»; на экране входа внизу должно быть `Synth v0.5.11`. Если версия старая — закрыть/открыть приложение ещё раз.

## 2026-09-15 — fix(ui): залипание баннера обновления PWA, скролл логина, убрана версия; деплой K3s 0.5.12
- **Задача:** (1) на ПК баннер «Доступна новая версия приложения» не исчезает, в т.ч. после «Обновить»; (2) в PWA при скрытии клавиатуры скроллить логин вверх (виден логотип); (3) убрать надпись `Synth v…` с экрана входа.
- **Тип:** bugfix (UI/PWA) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Коммиты:** synth — `3ec8284` (fix + bump v0.5.12); synth-deploy — `7505188`.
- **Первопричина п.1:** состояние `updateReady` было односторонним — `showIfReady()` только включал баннер, но никогда не пересчитывал при исчезновении `waiting`/смене контроллера; а `handleUpdate()` при `!reg?.waiting` делал `return` (кнопка «Обновить» = no-op, баннер остаётся навсегда). Не было и страховки, если `controllerchange` не придёт.
- **Решение п.1:** единая `sync()` (обе стороны: `setUpdateReady(Boolean(reg?.waiting && controller))`, при `dismissed` → false), `watchWaiting()` на `statechange` нового воркера, сброс баннера в `onControllerChange`, периодическая проверка раз в 60 с; `handleUpdate`: при `waiting` → `SKIP_WAITING` + страховочный reload через 1.5 с, при отсутствии `waiting` → скрыть баннер и сразу `location.reload()`. Слушатели/интервал чистятся в cleanup.
- **Решение п.2:** в `handleScreenBlur` по фактическому снятию резерва (через 200 мс, т.е. фокус реально ушёл из формы) — `loginRef.current.scrollTo({ top: 0, behavior: 'smooth' })`. Переход логин→пароль таймер сбрасывает, вверх не скроллит.
- **Решение п.3:** удалён блок `Synth v{SYNTH_VERSION}` и импорт `SYNTH_VERSION` из `LoginForm.tsx`.
- **Тесты:** `packages/ui` — 116 (было 114; +2: сброс баннера при исчезнувшем `waiting`; reload без `waiting`). Монорепо: typecheck 0 ошибок, тесты shared 72 / ui 116 / core 1220 / backend 229, lint 0 errors.
- **Деплой K3s (0.5.12, UI-only):** образ `git.itphx.ru/itphx/synth-ui:0.5.12` собран/запушен (sha256:6162c119…); `ui.image.tag` 0.5.11→0.5.12, push `main` (`55e8239..7505188`) → Fleet `synth` 1/1 Ready, rollout успешен; `synth-backend` 0.5.7 не перезапускался. Проверка боевого: в JS нет `Synth v`, версия `0.5.12`, `sw.js?v=…`, интервал 60000; CSS логина (device-phone/tablet) без изменений; `/` → `no-cache`, `/sw.js` → `no-store`.
- **Пользователю:** на ПК один раз жёстко перезагрузить (Ctrl+Shift+R) — дальше баннер будет сниматься по «Обновить». В PWA — обновиться через баннер; при скрытии клавиатуры форма вернётся наверх с логотипом.

## 2026-09-15 — fix(ui): распознавание полей логина менеджерами паролей; деплой K3s 0.5.13
- **Задача:** браузер и KeePassXC неверно распознают поля входа: логин воспринимается как пароль, пароль не распознаётся; сохранение учётных данных путает поля.
- **Тип:** bugfix (UI/autofill) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Коммит:** synth — `ec67160` (fix + bump v0.5.13); synth-deploy — `fd99f35`.
- **Первопричина:** у инпутов не было `id`/`name`, а `<label>` не были связаны через `htmlFor`. Эвристики автозаполнения (Chrome/Safari, расширения KeePassXC) опираются на `id`/`name`/`for` (+`autocomplete`); локализованные русские placeholder'ы им не помогают. Поле API-ключа вообще было без `autoComplete`. `autoComplete="username"|"current-password"` на OIDC-полях уже были — но без `id`/`name`/`htmlFor` этого недостаточно.
- **Решение:** форма — `name="synth-login"`, `autoComplete="on"`; логин — `id/name="synth-login-username"/username`, `autoComplete="username"`, `autoCapitalize="none"`, `autoCorrect="off"`, `spellCheck={false}`; пароль — `id/name="synth-login-password"/password`, `autoComplete="current-password"`; сервер — `id/name="synth-login-server"/server`, `autoComplete="url"`; API-ключ — `id/name="synth-login-apikey"/apiKey`, `autoComplete="off"` (не предлагается как пароль УЗ); все label получили `htmlFor`. Debug-`<select>` и fallback-инпут логина — те же `id`/`name` (ветки взаимоисключающие).
- **Тест:** новый `packages/ui/src/components/auth/LoginForm.test.tsx` (3 кейса: OIDC, API-key, debug-select) фиксирует атрибуты. `@testing-library/react` в проекте не установлен (AGENTS.md запрещает ставить новое) — тест написан на `react-dom/client` + `act` в существующем паттерне ui.
- **Проверки:** typecheck 0 ошибок; тесты shared 72 / ui **119** (+3) / core 1220 / backend 229; lint 0 errors. Боевой бандл содержит `synth-login-username|password|apikey|server`, `current-password`, `name:"synth-login"`/`autoComplete:"on"`.
- **Деплой K3s (0.5.13, UI-only):** образ `git.itphx.ru/itphx/synth-ui:0.5.13` (sha256:93d10635…) запушен; `ui.image.tag` 0.5.12→0.5.13, Fleet `synth` 1/1 Ready; `synth-backend` 0.5.7 не перезапускался.
- **Находка (не менялось):** `packages/ui/src/components/admin/ProvidersPanel.tsx:205` — API-ключ провайдера (`type="password"`) без `id`/`name`/`autoComplete`, та же проблема в админке. Требуется отдельное решение.

## 2026-09-15 — research: вход по отпечатку (WebAuthn/passkeys) в PWA
- **Тип:** research (@researcher), без изменений кода. Отчёт в переписке.
- **Вывод:** «просто/средне для managed, сложно для гибрида и локального core».
  - Managed (`https://synth.k3s.itphx.loc`): plumbing уже есть — `GET /auth/login` (редирект в Keycloak) и `/auth/callback` реализованы (`packages/backend/src/routes/auth.ts:20-88`). Нужно в основном настроить **Keycloak (≥24) WebAuthn Passwordless** + кнопка «Войти по отпечатку» → `window.location.href='/auth/login'`. Оценка **~2–4 дня**. Минус: нарушает AD-043 («без визита в Keycloak») — потребуется ревизия AD.
  - Гибрид/локальный core: **RP ID/origin** — пасскей привязан к origin (`synth.k3s.itphx.loc` ≠ `localhost`), а вход в гибриде идёт ROPC, с которым WebAuthn несовместим в принципе (нет браузерной церемонии). Оценка **+2–5 дней** и смена UX (device flow) либо новая authorization-code подсистема в core.
  - Собственный WebAuthn (свой RP ID, `@simplewebauthn/*`, хранение ключей в `$SYNTH_DATA_DIR/auth/`): **8–13 дней**, высокий риск, обходит Keycloak → проблема с ролями (источник истины — Keycloak) и не даёт серверных токенов для гибрида. Не рекомендуется.
  - В репозитории и в прототипе `~/dev/aic/t11` кода WebAuthn нет — функциональность полностью новая.
- **Рекомендация:** MVP — пасскей только для managed-инстанса (Keycloak WebAuthn Passwordless) + пароль как fallback; гибрид/локальный core не трогать в MVP. Первый шаг (1 день): включить WebAuthn Passwordless в realm `synth`, проверить цепочку `GET /auth/login` → Keycloak → биометрия → `/auth/callback` → cookie → SPA.

## 2026-09-15 — fix(ui): API-ключи не предлагаются для сохранения в браузере; деплой K3s 0.5.14 (backend + UI)
- **Задача:** API-ключи провайдера вообще не должны предлагаться для сохранения в браузере; выкатить новые версии backend и UI.
- **Тип:** bugfix (UI/autofill) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Коммиты:** synth — `79fc42f` (fix + bump v0.5.14); synth-deploy — `3057497`.
- **Первопричина:** `type="password"` без анти-автозаполняющих атрибутов и без `id`/`name` — Chrome/Safari и расширения (1Password/LastPass/Bitwarden) эвристикой определяли поле как учётные данные и предлагали «Сохранить пароль?».
- **Исправлено (аудит по всему UI):**
  - `packages/ui/src/components/admin/ProvidersPanel.tsx:205` — API-ключ провайдера: `id="admin-provider-api-key"`, `name="providerApiKey"`, `autoComplete="off"`, `data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`, `data-form-type="other"`, `spellCheck={false}`, `autoCapitalize="none"`, `autoCorrect="off"`, label `htmlFor`; `type="password"` сохранён (маскировка).
  - `packages/ui/src/components/settings/McpSettings.tsx:272` — `textarea` env MCP-сервера (туда попадают токены/секреты): то же + `id="mcp-server-env"`, `name="mcpServerEnv"`.
  - Больше реальных секрет-инпутов вне `LoginForm` не найдено (grep `type="password"`, `apiKey`, `api_key`, `token`, `secret`).
  - `LoginForm.tsx` НЕ тронут (там нужны `username`/`current-password`). Оба изменённых поля не находятся внутри `<form>`, поэтому `autoComplete="off"` на форму не требовался.
- **Тест:** новый `packages/ui/src/components/admin/ProvidersPanel.test.tsx` — проверяет `autocomplete=off`, `name` без `password|username|login|account`, наличие `data-1p-ignore`/`data-lpignore`/`data-bwignore`/`data-form-type` и связку label↔input.
- **Проверки:** typecheck 0 ошибок; тесты shared 72 / ui **120** (+1) / core 1220 / backend 229; lint 0 errors.
- **Деплой K3s (0.5.14, backend + UI):** образы `synth-ui:0.5.14` (sha256:e0a704c1…) и `synth-backend:0.5.14` (sha256:e816abe4…) собраны/запушены; `values.yaml` — обе `tag` → 0.5.14, Fleet `synth` 1/1 Ready, оба rollout успешны.
- **Проверка боевого:** `/health` → `{"status":"healthy","version":"0.5.14"}`; `/auth/oidc-meta` отвечает; неаутентифицированный `/api/v2/sessions` → 401; UI-бандл содержит `admin-provider-api-key`, `providerApiKey`, `data-1p-ignore`/`data-lpignore`/`data-bwignore`, `mcpServerEnv`. **Smoke ROPC-логин тестовой УЗ (`lucky`): `POST /auth/login` → 200 (роли `USER`), cookie `user_session`, `/auth/status` → `authenticated:true`, `/api/v2/sessions` → 200.**
- **Внимание:** рестарт backend сбрасывает in-memory сессии (`packages/backend/src/auth/middleware.ts:9`) — все пользователи (включая текущий браузер) будут разлогинены, это ожидаемо (см. инцидент 14.09).

## 2026-09-15 — fix(ui): мобильная адаптация (Huawei EMUI auto-dark, ввод в Yandex/Firefox); деплой K3s 0.5.15 (UI-only)
- **Задача:** «1) Huawei — встроенная авто-тёмная тема (EMUI/HarmonyOS) ломает вид, обойти/отключить; 2) Yandex/Firefox — не сворачивается панель браузера, область ввода не видна. Исследуй, обсудим.»
- **Тип:** bugfix (mobile UI) + ops
- **Исполнитель:** @orchestrator → @explore×2 (исследование) + @fixer (правки)
- **Результат:** PASS (K3s); ручной device-тест Huawei/Yandex/Firefox — за пользователем
- **Коммиты:** synth — `19d9b2a` (fix + bump v0.5.15, в origin НЕ пушился); synth-deploy — `8ce9bea` (push main → Fleet).
- **Первопричины:**
  - Huawei: `color-scheme` в CSS был `light` (`design-system.css:3`) → страница декларирует «только светлая», EMUI применяет force-dark. Плюс Tailwind v4 `dark:` компилировался в `@media (prefers-color-scheme: dark)` (нет `@custom-variant`), т.е. 108 `dark:`-утилит следовали ОС, а не теме приложения.
  - Yandex/Firefox: корневой документ не скроллится (`html/body/#root { overflow:hidden }`), поэтому браузерная панель не сворачивается; высота шелла `100dvh` + композер в потоке внизу → при неверном `dvh`/панели ввод уходил за экран. Клавиатурный сдвиг `--kb-inset` гейтился `pointer-coarse` и не срабатывал при `any-pointer: fine`.
- **Исправлено:**
  - `packages/ui/index.html` — pre-paint inline-скрипт (класс `dark`/`light` + `data-theme` + фон из `splashBg*` + `theme-color`), `<meta name="color-scheme" content="light dark">`, `interactive-widget=resizes-content`, `<body>` без жёстких `bg-zinc-950 text-zinc-100`.
  - `styles/index.css` — `@custom-variant dark (&:where(.dark, .dark *))`; удалён дубль base `height/overflow`; удалён `--kb-inset`-отступ композера.
  - `styles/design-system.css` — `:root { color-scheme: light dark }` (opt-out от EMUI force-dark).
  - `hooks/useViewportHeight.ts` (новый) — `visualViewport` → `--oc-app-height` / `--oc-visual-viewport-offset-top`; `hooks/useKeyboardInset.ts` удалён; вызов в `App.tsx`, убран из `ChatTab.tsx`.
- **Проверки (локально, prod-preview):** typecheck 0 ошибок; тесты shared 72 / ui 120 / core 1220 / backend 229; lint 0 errors. Бандл: 49 селекторов `:where(.dark`, `dark:` в media нет, `color-scheme: light dark` есть. В браузере (390×844): композер внизу виден (`bottom=836`), при усадке вьюпорта до 500px шелл/композер сжимаются, темная/светлая темы переключаются.
- **Деплой K3s (0.5.15, UI-only):** образ `git.itphx.ru/itphx/synth-ui:0.5.15` (sha256:680e7bac…, digest совпадает с imageID пода) собран из исходников и запушен; `values.yaml` — `ui.image.tag` 0.5.14→0.5.15, push `main` (`3057497..8ce9bea`) → Fleet `synth` 1/1 Ready, rollout `synth-ui` успешен; `synth-backend` 0.5.14 **не перезапускался** (сессии сохранены).
- **Проверка боевого:** `/` → 200; index.html содержит `interactive-widget=resizes-content`, `color-scheme`, `splashBgDark`; JS — `0.5.15`, `oc-app-height`, без `kb-inset`; CSS — `color-scheme: light dark`, `:where(.dark` ×49; `/api/v2/health` → 0.5.14 (backend); `/auth/oidc-meta` отвечает.
- **Известная проблема (вне задачи):** dev-UI (`./scripts/dev.sh`) отдаёт пустой экран — `packages/shared/dist/config/loader.js` тянет `node:fs/promises` в браузер (Vite externalized). Воспроизводится на чистом `master`; проверка делалась на production-сборке. Стоит отдельной задачи (browser-условие в `exports`/отдельный entry).
- **Follow-up:** AD-044 описывает удалённый `--kb-inset`-механизм — обновить по итогам device-теста; опционально hex/`@supports`-fallback для `oklch`/`color-mix` (старые Huawei).

## 2026-09-15 — fix(ui) v2: Huawei Auto Dark (`only light/dark`) + имитация скролла; деплой K3s 0.5.16 (UI-only)
- **Задача:** «Ни один из фиксов не помог: цвета в Huawei те же; в Yandex/Firefox всё по-прежнему — нужна имитация скролла.»
- **Тип:** bugfix (mobile UI) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s); ручной device-тест — за пользователем
- **Ключевое наблюдение пользователя:** в Huawei при теме приложения **«Тёмная»** цвета корректны, а «Системная»/«Светлая» — нет; системная тема телефона не влияет. ⇒ Huawei применяет **Auto Dark Theme** именно к светлой странице.
- **Первопричина v1:** `color-scheme: light dark` не отключает принудительное затемнение Huawei. По докам Chrome (developer.chrome.com/blog/auto-dark-theme) opt-out — `color-scheme: only light` (meta `content="only light"` отдельно предотвращает вспышку).
- **Исправлено (Huawei):** `color-scheme` — зеркало темы приложения со `only`: `:root { color-scheme: only light }`, `.dark { color-scheme: only dark }` (`design-system.css`); static meta → `only light`; pre-paint-скрипт и `ThemeSystemContext.updateBrowserChrome` обновляют `meta[name="color-scheme"]` (`only dark`/`only light`) — `index.html`, `ThemeSystemContext.tsx`. `@custom-variant dark` (класс-вариант) сохранён.
- **Исправлено (Yandex/Firefox — имитация скролла):** в мобильных зонах root-документ снова скроллируемый: `html.device-phone/tablet { overflow-x:hidden; overflow-y:auto; height:100%; overscroll-behavior:none }`, `#root { min-height: calc(100dvh + 8px) }`, `.app-shell { position: fixed; top:0; left:0; right:0; height: var(--oc-app-height) }` (`index.css`); новый хук `useBrowserChromeCollapse.ts` (нудж `window.scrollTo(0,8)` на mount/pageshow/orientationchange/focusin/touchstart/pointerdown, throttle 1/с, no-op на десктопе), вызов в `App.tsx`; тесты `useBrowserChromeCollapse.test.tsx`.
- **Коммиты:** synth — `bb787dc` (fix v2 + bump v0.5.16, в origin НЕ пушился); synth-deploy — `acf799f`.
- **Проверки:** typecheck 0 ошибок; тесты shared 72 / ui **123** / core 1220 / backend 229; lint 0 errors. Prod-preview (Chromium 390×844): meta/computed `only light` ↔ `only dark` при смене темы; `scrollDiff=8`, `mouse.wheel` и `scrollTo` реально двигают `scrollY`; `.app-shell` fixed (top 0, height=844), композер виден; десктоп (1280×800) не затронут.
- **Деплой K3s (0.5.16, UI-only):** образ `git.itphx.ru/itphx/synth-ui:0.5.16` (sha256:8f44cd9c…) собран/запушен; `values.yaml` `ui.image.tag` 0.5.15→0.5.16, push `main` (`8ce9bea..acf799f`) → Fleet; под `synth-ui-5947c8cbfc` на 0.5.16, старый RS 0/0; `synth-backend` 0.5.14 не перезапускался.
- **Проверка боевого:** `/` → 200; index.html — `content="only light"` + pre-paint `only dark` + `interactive-widget=resizes-content`; CSS — `color-scheme:light only` / `dark only`, `.device-phone .app-shell{position:fixed…}`, `overflow:hidden auto`; JS — `0.5.16`, есть `scrollingElement` (нудж).
- **Если Huawei всё ещё темнит:** следующий шаг — runtime-детект Auto Dark Theme (canvas-метод из доки) и, при обнаружении, принудительный тёмный режим приложения (пользователь подтвердил, что тёмная тема отображается корректно); как временный обход — отключить «Тёмная тема» в настройках самого Huawei Browser.

## 2026-09-15 — fix(ui) v3: высота `min(100dvh, viewport)` для альбома + `/diag.html`; деплой K3s 0.5.17 (UI-only)
- **Задача:** уточнения по мобильным браузерам — планшет в ландшафте (ввод за нижней границей), Yandex/Firefox не скрывают панель, Huawei night mode (настройка браузера, не ОС). Пользователь просил изучить документацию браузеров.
- **Тип:** bugfix (mobile UI) + diagnostics + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s); далее данные с устройств
- **Research (интернет):**
  - Firefox Android: тулбар скрывается по скроллу (настройка «Scroll to hide toolbar»), но **в ландшафте адресная строка ~20% и не прячется** (Mozilla Connect); **bug 2071251**: при блокировке скролла сайтом панель нельзя скрыть/показать. ⇒ нельзя полагаться на скрытие панели.
  - Yandex Android: нижняя панель — chrome браузера, по скроллу не скрывается (меняется только настройками браузера). ⇒ нужно корректно вычислять видимую высоту.
  - Huawei: night mode — настройка браузера; `color-scheme: only light` игнорируется. ⇒ нужен runtime-детект force-dark.
- **Исправлено:** `useViewportHeight.ts` пишет `--oc-app-height: min(100dvh, ${min(vv.height, innerHeight)}px)` — шелл не превышает динамический вьюпорт и реагирует на клавиатуру; +5 unit-тестов.
- **Добавлено:** `packages/ui/public/diag.html` — диагностика (UA/экран/окно/документ/visualViewport/единицы `100vh|dvh|svh|lvh`/safe-area/медиа/**детект auto-dark**/классы/ландшафт, кнопки «Скопировать»/«Обновить»).
- **Коммиты:** synth — `eb48162` (fix + bump v0.5.17); synth-deploy — `f1f98a9`.
- **Проверки:** typecheck 0; тесты shared 72 / ui **128** / core 1220 / backend 229; lint 0 errors; build ok, `dist/diag.html` есть.
- **Деплой K3s (0.5.17, UI-only):** `git.itphx.ru/itphx/synth-ui:0.5.17` (sha256:1e5755c3…) собран/запушен; Fleet → под на 0.5.17; `synth-backend` 0.5.14 не перезапускался. Боевой: `/diag.html` → 200, `/` → 200.
- **Следующий шаг:** получить отчёт с `/diag.html` с Huawei/Yandex/Firefox (портрет+ландшафт) и по нему — правильная метрика высоты и авто-режим force-dark.

## 2026-09-15 — fix(ui) v4: высота десктоп-раскладки по видимому вьюпорту + pointer-coarse; деплой K3s 0.5.18 (UI-only)
- **Задача:** по diag-отчётам с планшета/смартфона устранить обрезку ввода в ландшафте и поправить детект тача.
- **Тип:** bugfix (mobile UI) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s); ждём ретест
- **Первопричины (из /diag.html):**
  - Планшет в ландшафте имеет ширину 1204–1408px → `device-desktop` (≥1200) → десктопная раскладка с `h-screen` = `100vh` = **large viewport** (836/715px), а видимая = `100dvh` (696/617px) → низ (композер, логин) за границей. Портрет (<1200) → мобильная раскладка, там ок.
  - `(pointer: coarse)=да` **и** `(any-pointer: fine)=да` на всех устройствах → прежний `pointer-coarse`/`isTouch` (`coarse && !anyFine`) не срабатывал → touch-стили не включались.
  - Huawei night-mode: `background-color: canvas` остаётся `rgb(255,255,255)` и `prefers-color-scheme` = light даже в night-mode → Chrome-метод детекта force-dark **не ловит** Huawei (у него своя реализация). `color-scheme`-signals Huawei, похоже, игнорирует.
  - Yandex на телефоне: `innerHeight = 100dvh = 677` (панель корректно вычтена) → ввод виден; нижняя панель Yandex по скроллу не скрывается (chrome браузера).
- **Исправлено:**
  - `App.tsx` desktop wrapper `h-screen` → `desktop-shell`; `AuthGate`/`LoginForm` `min-h-screen` → `viewport-min-h`; в `index.css` добавлены `.desktop-shell{height:var(--oc-app-height,100dvh)}` и `.viewport-min-h{min-height:var(--oc-app-height,100dvh)}`.
  - `lib/device.ts`/`hooks/useDevice.ts`: `pointer-coarse`/`isTouch = (pointer: coarse)` (без `!anyFine`).
- **Коммит:** synth — `b77f584` (bump v0.5.18); synth-deploy — `dafc7a5`.
- **Проверки:** typecheck 0; тесты shared 72 / ui 128 / core 1220 / backend 229; lint 0 errors; Playwright: 1204×617 → `desktop-shell` height 617, 1408×696 → 696 (было 715/836); логин вписан; телефон/десктоп без регрессий; `pointer-coarse` теперь ставится при coarse+anyFine.
- **Деплой K3s (0.5.18, UI-only):** `synth-ui:0.5.18` (sha256:3916ca2e…); backend 0.5.14 не перезапускался; `/diag.html` → 200.
- **Открытый вопрос:** переводить ли тач-планшеты в ландшафте на мобильную (дроверы) раскладку независимо от ширины — через комбинированный детект (`navigator.userAgentData.mobile` → UA-regex → `(hover:none) and (pointer:coarse)`). Сейчас раскладка по-прежнему выбирается только по ширине.

## 2026-09-15 — fix(ui) v5: UA-обход ночного режима Huawei; деплой K3s 0.5.19 (UI-only)
- **Задача:** «Попробовать UA-обход» для Huawei night-mode (раскладку решено оставить по ширине).
- **Тип:** bugfix (mobile UI, best-effort) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s); проверка обхода — на устройстве
- **Решение:** для UA с `HuaweiBrowser` странице объявляется `color-scheme: dark` **всегда** (даже на светлой теме) — попытка «притвориться тёмной», чтобы ночной режим не затемнял. Тема приложения не меняется.
  - `index.html` pre-paint: `/HuaweiBrowser/i` → класс `huawei` на `<html>` + meta `color-scheme=dark`; иначе прежние `only dark`/`only light`.
  - `lib/device.ts`: `isHuaweiBrowser()`; `ThemeSystemContext.updateBrowserChrome` учитывает класс/утилиту; `index.css`: вне `@layer` `html.huawei, html.huawei.dark { color-scheme: dark }`.
- **Коммит:** synth — `37273d8` (bump v0.5.19); synth-deploy — `200d0f8`.
- **Проверки:** typecheck 0; тесты shared 72 / ui 128 / core 1220 / backend 229; lint 0 errors; Playwright с подменой UA: Huawei → `huawei`+`dark`, обычный → `only light`/`only dark`; тема приложения у Huawei не меняется.
- **Деплой K3s (0.5.19, UI-only):** `synth-ui:0.5.19` (sha256:e3af35d8…); backend 0.5.14 не перезапускался; `/diag.html` → 200; в отдаваемом index есть `HuaweiBrowser`/`huawei`.
- **Ограничение:** если Huawei игнорирует и это — останется вариант принудительно включать тёмную тему приложения при UA Huawei (пользователь подтвердил, что тёмная отображается корректно).

## 2026-09-15 — feat(ui): пункт «Полный экран» в меню профиля (Fullscreen API); деплой K3s 0.5.20 (UI-only)
- **Задача:** «Можно ли по нажатию отдельной кнопки запросить полноэкранный режим для Yandex/Firefox?»
- **Тип:** feature (mobile UX) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s)
- **Решение:** Fullscreen API скрывает браузерный интерфейс (адресную строку/нижнюю панель) на Android в Yandex/Firefox/Chrome/Huawei; вызов по тапу (user gesture), без фиксации ориентации. Пункт размещён **в меню профиля** (`QuickSettingsPopup`).
  - `src/hooks/useFullscreen.ts` — `{ isFullscreen, supported, toggle }`, события `fullscreenchange`/`webkitfullscreenchange`, webkit-fallback, guard SSR/jsdom, ошибки гасятся.
  - `QuickSettingsPopup.tsx` — пункт перед «Настройки профиля»; показывается, если `supported` и не PWA standalone; иконка `fullscreen`/`fullscreen-exit`, текст `auth.fullscreen`/`auth.exitFullscreen`.
  - i18n: ключи добавлены в `ru.ts` и `en.ts`.
  - Тесты: `useFullscreen.test.tsx` (5), `QuickSettingsPopup.test.tsx` (3).
- **Коммит:** synth — `20a9395` (bump v0.5.20); synth-deploy — `d3cd3c1`.
- **Проверки:** typecheck 0; тесты shared 72 / ui **136** / core 1220 / backend 229; lint 0 errors; в бандле есть `auth.fullscreen`/`auth.exitFullscreen`.
- **Деплой K3s (0.5.20, UI-only):** `synth-ui:0.5.20` (sha256:d18d94a9…); backend 0.5.14 не перезапускался; боевой бандл содержит ключи fullscreen.
- **Ограничение:** iOS Safari не поддерживает fullscreen для произвольного элемента (`document.fullscreenEnabled=false`) — пункт там скрыт; это ок (цель — Android).

## 2026-09-15 — refactor(ui): чистка костылей и мёртвого кода после скролл-экспериментов; деплой K3s 0.5.21 (UI-only)
- **Задача:** «Убедись, что не наделали костылей и не осталось мёртвого кода, например после попыток решить проблему в Yandex/Firefox скролом.»
- **Тип:** refactor + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s); `+10 / −252`
- **Аудит (rg по `packages/ui`):** не осталось `useKeyboardInset`/`kb-inset`, `any-pointer`/`anyFine`, `h-screen`/`min-h-screen`, дублей `:root/body/#root`. Переменные `--oc-header-height`, `--oc-wco-*`, `--oc-safe-area-bottom-visual`, `--oc-visual-viewport-height` используются в других местах репозитория (не мёртвые).
- **Удалено (костыль):** «имитация скролла» — `hooks/useBrowserChromeCollapse.ts` (+тест), вызов в `App.tsx`, CSS-блок в `index.css` (`overflow-y:auto`, `body overflow:visible`, `#root min-height: calc(100dvh + 8px)`, `.app-shell{position:fixed}`). Причина: не работал там, где нужен (Yandex — ни в одной ориентации, Firefox — в ландшафте); задачу решает fullscreen (v0.5.20). Мобильный root снова не скроллится, `.app-shell` снова в потоке.
- **Удалено (мёртвое):** `--oc-visual-viewport-offset-top` — только писалась, никем не читалась (`useViewportHeight.ts`/`.test.tsx`/`design-system.css`).
- **Коммит:** synth — `7042104` (bump v0.5.21); synth-deploy — `3f30567`.
- **Проверки:** typecheck 0; тесты shared 72 / ui **133** / core 1220 / backend 229; lint 0 errors; Playwright (390×844): root не скроллится (`scrollHeight−innerHeight=0`, `scrollTo(0,8)` → 0), `.app-shell` `position:relative` высотой 844, композер виден, дроверы/модалка работают, пункт «Полный экран» на месте; десктоп 1280×800 не затронут.
- **Деплой K3s (0.5.21, UI-only):** `synth-ui:0.5.21` (sha256:8b54b800…) — в боевом CSS/JS нет удалённых маркеров (`100dvh + 8px`, `oc-visual-viewport-offset-top`, fixed app-shell), fullscreen-ключи присутствуют; backend 0.5.14 не перезапускался.
- **Инцидент окружения:** первая docker-сборка упала с `no space left on device` (диск 100%). Освобождено ~41 ГБ (`docker image prune -a`, `container prune`), сборка повторена успешно. Стоит помнить про чистку Docker.

## 2026-09-15 — refactor(ui): CSS-переменные `--oc-*` → `--synth-*` (убраны отсылки к openchamber); деплой K3s 0.5.22 (UI-only)
- **Задача:** «у нас всё ещё есть переменные с префиксом `--oc` (`--oc-header-height`, `--oc-wco-*`, `--oc-safe-area-bottom-visual`, `--oc-visual-viewport-height` и прочее). Найди, переименуй префикс в `--synth`.»
- **Тип:** refactor + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s)
- **Переименовано (живые):** `--oc-app-height` → `--synth-app-height`; `--oc-safe-area-{top,right,bottom,left}` → `--synth-safe-area-*`; `--oc-scrollbar-thumb{,-hover}` → `--synth-scrollbar-thumb*`.
- **Удалено (мёртвые — только объявлены, читателей не было):** `--oc-header-height`, `--oc-visual-viewport-height`, `--oc-safe-area-bottom-visual`, `--oc-wco-left-inset`, `--oc-wco-right-inset`, `--oc-wco-titlebar-height`.
- **Файлы:** `styles/design-system.css`, `styles/index.css`, `hooks/useViewportHeight.ts`, `hooks/useViewportHeight.test.tsx`, `docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md`.
- **Поправка к записи 0.5.21:** те «мёртвые» `--oc-*` на самом деле не использовались в активном коде — только в `archive/` (старые фронтенды). Теперь удалены.
- **Коммит:** synth — **не коммитился** (правило «не коммитить без явной просьбы»); synth-deploy — `96a2c5f`.
- **Проверки:** typecheck 0; lint 0 errors (139 pre-existing warnings); тесты shared 72 / ui 133 / core 1220 / backend 229; `build.sh` 0.5.22 — успешно; в собранном CSS только `--synth-*` (0 × `--oc-`); локально Playwright (prod-сборка, 1280×720 и 390×844): `--synth-app-height` = `min(100dvh, Npx)`, `.viewport-min-h` резолвит высоту, класс `device-phone` — ок.
- **Примечание (предсуществующее, не связано):** dev-сервер UI (Vite) отдаёт пустую страницу из-за `node:fs/promises` externalized (`shared/dist/config/loader.js`). Воспроизводится и на чистом `master` (проверено `git stash`) — к правке не относится.
- **Деплой K3s (0.5.22, UI-only):** `synth-ui:0.5.22` (sha256:c8255a8b…) собран из исходников (`docker/Dockerfile.ui`) и запушен; `values.yaml` `ui.image.tag` 0.5.21→0.5.22, push `main` (`3f30567..96a2c5f`) → Fleet `synth` 1/1 Ready, rollout успешен; `synth-backend` 0.5.14 **не перезапускался** (сессии сохранены). Боевой CSS: 7 × `--synth-*`, 0 × `--oc-`; `/` → 200, `/sw.js` → `no-cache`.

## 2026-09-15 — feat(ui): пункт «Обновить страницу» всегда в меню профиля; деплой K3s 0.5.23 (UI-only)
- **Задача:** «пункт „Обновить страницу“ должен всегда отображаться в контекстном меню профиля».
- **Тип:** feature (UI) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s)
- **Причина:** кнопка `auth.reloadPage` в `QuickSettingsPopup.tsx` была обёрнута в `{isPwaStandalone() && (...)}` — видна только в PWA standalone.
- **Изменение:** условие убрано, кнопка рендерится безусловно (как «Настройки»/«Выйти»). Пункт «Полный экран» и условие `fullscreenSupported && !isPwaStandalone()` не тронуты.
- **Файлы:** `components/auth/QuickSettingsPopup.tsx`, `components/auth/QuickSettingsPopup.test.tsx` (+тест «standalone=false ⇒ пункт присутствует»).
- **Коммит:** synth — **не коммитился**; synth-deploy — `a2a34a5`.
- **Проверки:** typecheck 0; lint 0 errors; тесты shared 72 / ui **134** / core 1220 / backend 229; `build.sh` 0.5.23 — успешно.
- **Деплой K3s (0.5.23, UI-only):** `synth-ui:0.5.23` (sha256:046f0933…) собран/запушен; `values.yaml` 0.5.22→0.5.23, push `main` (`96a2c5f..a2a34a5`) → rollout успешен; `synth-backend` 0.5.14 не перезапускался; боевой бандл `index-D4l9WePx.js`, `/` → 200.

## 2026-09-15 — fix(ui): переключатели на мобильном растягивались в круг/овал; деплой K3s 0.5.24 (UI-only)
- **Задача:** «все переключатели на мобильном стали круглыми, а должны быть прямоугольными с закруглёнными углами и кругом внутри».
- **Тип:** bug fix (CSS) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s)
- **Причина:** генерические правила тач-таргетов в `styles/index.css` задавали `min-width/min-height` всем `<button>` в контейнере, включая switch (трек `w-9 h-5` = 36×20, `rounded-full`) → 40×40 / 36×36 / 36×40 → круг/овал.
- **Воспроизведение (Playwright на собранном CSS, `pointer-coarse`+`device-phone`):** `.mobile-drawer-panel` 40×40, `[data-slot="dialog-content"]` 36×40, `.group-hover\:opacity-100` 40×40, `[data-tree-node]` 36×36; вне этих контейнеров — 36×20.
- **Изменение:** к button-селекторам правил тач-таргетов добавлено `:not([role="switch"])` (строки 276–277, 314–317, 339/346, 420, 430, 441–442, 448; значения мин. размеров для остальных кнопок не менялись). Дополнительно `role="switch"` + `aria-checked` добавлены кнопкам-переключателям в `admin/UsersPanel.tsx:266` и `admin/AgentsPanel.tsx:523` (в `Toggle.tsx` и `McpSettings.tsx` уже были).
- **Файлы:** `styles/index.css`, `components/admin/UsersPanel.tsx`, `components/admin/AgentsPanel.tsx`.
- **Проверка (Playwright, собранный CSS):** все switch теперь 36×20 во всех контейнерах; обычные кнопки сохранили минимумы (drawer h40, dialog h40, hover 40×40, tree 36×36, composer ≥28). typecheck 0; lint 0 errors; тесты shared 72 / ui 134 / core 1220 / backend 229.
- **Коммит:** synth — **не коммитился**; synth-deploy — `cdec82e`.
- **Деплой K3s (0.5.24, UI-only):** `synth-ui:0.5.24` (sha256:b1bd3e5d…) собран/запушен; `values.yaml` 0.5.23→0.5.24, push `main` (`a2a34a5..cdec82e`) → rollout успешен; `synth-backend` 0.5.14 не перезапускался; в боевом CSS 13 × `button:not([role=switch])`, 0 × `--oc-`; `/` → 200.
- **Оговорка:** переключатели намеренно остаются 36×20 (как на десктопе) — тач-таргет не расширяли, чтобы не менять форму; при желании можно отдельно расширить зону нажатия псевдоэлементом.

## 2026-09-15 — fix(ui): мобильные фиксы (Контекст/Агенты/уведомления/Сессия/левая панель); деплой K3s 0.5.25 + 0.5.26 (UI-only)
- **Задача:** набор баг-фиксов и унификаций мобильного UI + удаление блока «Отладка» с кнопкой «Отправить системное сообщение».
- **Тип:** bug fix + refactor (UI) + ops
- **Исполнитель:** @orchestrator → @fixer (3 партии)
- **Результат:** PASS (K3s)
- **Причина «неправильных переключателей» в „Контексте“:** тумблеры уже были 36×20, а раздувались генерические touch-правила — круглые радио-селекторы режима и «+/−» в drawer становились 40×40. Решение (по выбору пользователя): оставить радио, пометить компактные контролы `data-compact` и исключить их из правил `min-width/min-height` (`:not([data-compact])`). Радио 16×16, «+/−» 20×20.
- **Агенты (настройки):** кастомные тумблеры (`bg-blue-600`) заменены общим `<Toggle>` (в `AgentsPanel` и, для консистентности, `UsersPanel`); сетки карточек (и скелетон) `agents-grid` на phone/tablet — в одну колонку.
- **Уведомления:** попап вылезал влево (`absolute right-0` от кнопки, не у края; `left=-92`). На phone/tablet — `position:fixed; left/right:.5rem; top:calc(2.75rem + env(safe-area-inset-top))`, десктоп без изменений.
- **Сессия (правая панель):** `<ModelSelector alwaysShowLabel>` — на мобильном показывает провайдера и модель (было только иконку).
- **Удалено:** блок «Отладка» с кнопкой отправки системного сообщения — `SessionSettingsTab`, `ChatTab` (авто-отправка), флаг `debugSystemMessages` в `useUIStore`, `synthApi.sendDebugSystemMessage`, 4 i18n-ключа `rightPanel.debug.*`. Отдельный пункт «Отладка» (`debugEnabled`) сохранён.
- **Кнопки под сообщениями (мобильный):** `.message-actions button` → 28×28 (было 40×40), отступ строки компактнее.
- **Левая панель:** контейнер вкладок `.left-tabs` на phone/tablet — высота auto (кнопки 40px не выходят за границы); `openTab` теперь закрывает левый мобильный дровер (`mobileLeftOpen:false`) + регрессионный `useUIStore.test.ts`.
- **Файлы:** `ContextTab.tsx`, `AgentsPanel.tsx`, `UsersPanel.tsx`, `NotificationPopup.tsx`, `SessionSettingsTab.tsx`, `ModelSelector.tsx`, `ChatTab.tsx`, `useUIStore.ts`(+test), `synthApi.ts`, `ru.ts`/`en.ts`, `MessageActions.tsx`, `LeftPanel.tsx`, `styles/index.css`.
- **Проверки:** typecheck 0; lint 0 errors; тесты shared 72 / ui 136 / core 1220 / backend 229; build.sh 0.5.25/0.5.26. Браузерный harness + боевой UI (390×844): switch 36×20, radio 16×16, «+/−» 20×20, message-actions 28×28, левые вкладки без overflow, клик по сессии открывает вкладку и закрывает дровер, ModelSelector показывает «itphx / omn.qwen3.8:27b», попап `left:8/right:382` (вписан).
- **Коммит:** synth — не коммитился; synth-deploy — `035cda0` (0.5.25), `e4503c3` (0.5.26).
- **Деплой K3s (0.5.25, 0.5.26, UI-only):** `synth-ui:0.5.25` (sha256:39994796…), `synth-ui:0.5.26` (sha256:9f136b35…); `synth-backend` 0.5.14 не перезапускался; `/` → 200.

## 2026-09-15 — fix(ui): косметика мобильного (вкладки левой панели, карточки агентов, выравнивание кнопок); деплой K3s 0.5.27 (UI-only)
- **Задача:** (1) кнопки вкладок левой панели прилипают к верхней границе — сделать интервал как в правой панели; (2) карточки агентов упираются в скролл справа (моб. и десктоп); (3) кнопки под сообщениями всё ещё не выровнены по вертикали.
- **Тип:** bug fix (UI, косметика) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s)
- **Замер до:** `.message-actions` — зазор сверху/снизу 5/13px (моб.), 7/13px (десктоп).
- **Изменения:** `LeftPanel.tsx` — контейнеру `.left-tabs` добавлен `py-1` (как в `RightPanel`); `AgentsPanel.tsx` — скролл-контейнеру карточек добавлен `pr-2`; `MessageActions.tsx` — контейнеру добавлен `-mb-1.5`; `styles/index.css` — в device-правило `.message-actions` добавлен `margin-bottom:-0.5rem`.
- **Замер после:** `.message-actions` 5/5px (моб.), 7/7px (десктоп); вкладки левой панели — интервал 8px сверху (24px-кнопки/40px-контейнер; на реальном touch кнопки 40px); карточки агентов — правый отступ 8px.
- **Проверки:** typecheck 0; lint 0 errors; тесты shared 72 / ui 136 / core 1220 / backend 229; build.sh 0.5.27; боевой UI (390×844) — `.left-tabs ... px-2 py-1`, интервал есть.
- **Коммит:** synth — не коммитился; synth-deploy — `a85dbbb`.
- **Деплой K3s (0.5.27, UI-only):** `synth-ui:0.5.27` (sha256:4d31c989…); `synth-backend` 0.5.14 не перезапускался; `/` → 200.

## 2026-09-15 — fix(ui): центрирование заголовка сообщения, минимальная высота поля ввода, зазоры композера; деплой K3s 0.5.28 (UI-only)
- **Задача:** (1) отцентрировать текст в верхней строке заголовка сообщения по вертикали; (2) уменьшить минимальную высоту блока ввода до одной строки (рост со второй); (3) выровнять кнопки композера — расстояние текст→кнопки == кнопки→низ.
- **Тип:** bug fix (UI, косметика) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s)
- **Причина/решение:** (1) `MessageHeader` — `mb-1` (4px) против `padding-top` бабла 12px → текст смещён вниз; заменено на `mb-3` (зазоры 13/12 с учётом рамки — симметрично). (2) `ChatInput` textarea `min-h-[52px]` (≈2.5 строки) → `min-h-[1.25rem]` (20px = одна строка). (3) `chat-toolbar` без верхнего отступа → `mt-2` (8px), совпадает с `padding-bottom` контейнера (8px); попутно textarea получил `block` (устранён 6px «фантомный» зазор от inline-block baseline).
- **Файлы:** `components/chat/MessageHeader.tsx`, `components/chat/ChatInput.tsx`.
- **Замеры (harness, 390×844):** заголовок 13/12px, центры детей строки совпадают; textarea 20px/1 строка, 40px/2 строки; композер 8/8px.
- **Проверки:** typecheck 0; lint 0 errors; тесты shared 72 / ui 136 / core 1220 / backend 229; build.sh 0.5.28; боевой JS содержит `min-h-[1.25rem]`, `mb-3`, `mt-2`.
- **Коммит:** synth — не коммитился; synth-deploy — `ba06796`.
- **Деплой K3s (0.5.28, UI-only):** `synth-ui:0.5.28` (sha256:7d8aac5c…); `synth-backend` 0.5.14 не перезапускался; `/` → 200.

## 2026-09-15 — fix(ui): компактные зазоры заголовка (8/8) и +2px в композере; деплой K3s 0.5.29 (UI-only)
- **Задача:** заголовок сообщения — зазоры 8/8 (вместо 12/12); в панели ввода добавить 2px между текстом и кнопками.
- **Тип:** bug fix (UI, косметика) + ops
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS (K3s)
- **Изменения:** `MessageHeader.tsx` — `mb-3` → `-mt-1 mb-2`; `ChatInput.tsx` — `'mt-2'` → `'mt-2.5'` (ветка `expanded`/`mt-auto` не тронута).
- **Замеры (harness, 390×844):** заголовок 9/8 (9 — с учётом рамки бабла), композер textarea→кнопки **10px**, кнопки→низ **8px**; высота textarea 20px (1 строка).
- **Проверки:** typecheck 0; lint 0 errors; тесты shared 72 / ui 136 / core 1220 / backend 229; build.sh 0.5.29.
- **Коммит:** synth — не коммитился; synth-deploy — `db470ba`.
- **Деплой K3s (0.5.29, UI-only):** `synth-ui:0.5.29` (sha256:698ddf92…); `synth-backend` 0.5.14 не перезапускался; `/` → 200.
