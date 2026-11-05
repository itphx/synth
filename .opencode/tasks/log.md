# Журнал задач оркестратора

> Архив: `log.1.md` (по 2026-08-31), `log.2.md` (2026-08-31 — 2026-09-16), `log.3.md` (2026-09-17 — 2026-10-07), `log.4.md` (2026-10-07 — 2026-10-21), `log.5.md` (2026-10-22 — 2026-11-04).

- **CI на удалённом master:** после пушей слоя плагинов джоба **«Образы (сборка + smoke)»** падает на
  **инфраструктуре раннера**, а не на коде: внутри kaniko-шага `curl` к `registry.npmjs.org` не
  отвечает (таймаут 300 с на каждый MCP-пакет), затем раннер не может общаться со своим
  docker-демоном («docker daemon ping … context deadline exceeded») и убивает контейнер. Тот же
  Dockerfile с тем же кодом **локально собирается и проходит smoke-проверку** (именно эти образы
  развёрнуты в test: `synth-backend:0.12.1`, `synth-ui:0.12.1`, `synth-executor:0.12.1-full`).
  Остальные 12 джоб CI зелёные, включая `secret-scan`, контрактный suite на живой PostgreSQL и
  `helm lint`. Проверка перезапущена через ветку `feature/ci-images-retry` (master не перезапускался,
  чтобы не плодить пустые коммиты).

## 2026-11-05 — test: permission watch-all, fallback окна, build id PWA (деплой 0.13.3-14)

- **Задача:** (1) починить отказ «no connected user to approve»; (2) защитить PWA от застревания на старом шелле; (3) учитывать fallback окна контекста в авто-сжатии. **Тип:** bug fix / feature (core, backend, ui, сборка). **Исполнители:** @fixer ×3, оркестратор (деплой).
- **1. Permission.** `waitForDecision` проверял `EventBus.subscriberCount(sessionId)` (только per-session), а клиенты `ADMIN`/`LEAD`/service-key в managed подписаны глобально (`subscribeAll`) — счётчик всегда 0, `permission.asked` не публиковался, инструмент получал `(no connected user to approve)`. В БД test 152 таких tool-результата в 36 сессиях. Фикс: `subscribeAll(handler, { userFacing })` + `hasApprovalListeners(sessionId)` (per-session ИЛИ пользовательские глобальные; машинные webhooks/пайплайны/мост гибрида не считаются — headless-инстанс по-прежнему отвечает быстрым отказом). `userFacing: true` выставлен в core SSE/WS и backend `EventHub._subscribeClientToAll`. Тесты: bus/approval/run-cycle/hub.
- **2. PWA.** Обновление определялось только по semver (`health.version` vs `SYNTH_VERSION`), а имя кэша SW версионировалось только версией: передеплой той же `0.13.3` невидим, старый шелл/карта чанков остаются (в логах nginx — запросы несуществующих assets → 404; лечилось только очисткой данных сайта). Фикс: `SYNTH_BUILD_ID` (commit sha, локально short sha[+-dirty]) в образах, `GET /health.build`, `__SYNTH_BUILD_ID__` в бандле UI и в имени кэша (`synth-shell-<version>-<buildId>`); `PwaUpdatePrompt` при расхождении build id сбрасывает кэши, делает `registration.update()` и одну перезагрузку (существующий guard от цикла), semver-сравнение — фоллбек. Проброс: Dockerfile×3, synth-deploy `--build-arg`, скрипты сборки/публикации, `release.yaml`.
- **3. Fallback окна.** У модели с `contextWindow: 0` (`deepseek-flash`, `contextSource: unknown`) авто-триггеры не включались вовсе, хотя UI показывал оценку ≈200k (сессия `mw2jxrpy…`: 202 654 токена, 98% «оценки», компактизация не срабатывала). Фикс: `DEFAULT_CONTEXT_WINDOW = 200_000` в `@itphx/synth-shared` (единый источник с UI), `ContextOptimizer._effectiveContextWindow` в `shouldCompress` (compaction, summarization/tokens) и `shouldApplySlidingWindow` (tokens); лимиты транскрипта/бюджеты не тронуты. Пороги при окне 0: 170k/100k/160k.
- **Проверки:** `pnpm typecheck` 9/9, `pnpm lint` 0 errors, `pnpm test` — shared 997, core 8932, sdk 39, ui 3457, backend 756, executor 217, memory 191, postgres 106 (все зелёные; известный env-флейк `git-proxy-env` не воспроизводился). `pnpm build` зелёный.
- **Коммиты:** `8440bfae` (permissions), `b7c86454` (context), `234a1a3a` (pwa) в `synth`; `a27d4a5` в `synth-deploy` (build-arg + пиннинги).
- **Деплой test:** образы `synth-backend:0.13.3`, `synth-ui:0.13.3` (build `234a1a3a`), чарт `0.13.3-14`; Fleet применил `synth-test` (revision 154) и `synth-test-allinone` (revision 61). Версия приложения не менялась (0.13.3), изменён только номер сборки. Проверено: `/health` → `build: 234a1a3a`, `/sw.js` → `CACHE_BUILD = 234a1a3a`, в образе core есть `hasApprovalListeners`/`_effectiveContextWindow`, в бандле UI — build id. Executor не пересобирался (push упал на 502 Gitea, код исполнителя не менялся; тег `0.13.3-full` в реестре есть).
- **Остаток:** живая проверка ask-флоу (нужен реальный `ask` при подключённом UI) и срабатывания компактизации при следующем ходе в `mw2jxrpy…`; установленная PWA подтянет новую сборку сама (sw.js изменился → waiting → авто-SKIP_WAITING), но одно ручное переоткрытие ускорит.

## 2026-11-04 — чистка рабочего дерева: удалён каталог `worktrees/`, `ws-default` оставлен

- **Задача:** удалить `ws-default` и `worktrees`, если в них больше нет необходимости. **Тип:** обслуживание рабочего дерева (не код). **Исполнитель:** оркестратор.
- **Удалено:** `/worktrees/ui-chat-tails` — git-worktree репозитория `synth` на ветке `feat/ui-chat-tails`. Проверки: рабочее дерево чисто (только потерянный бит executable у `scripts/hybrid.sh`/`scripts/offline-images.sh`, содержимое не менялось), 0 коммитов сверх `master` (`rev-list master..HEAD` = 0, ветка в `--merged master`), вершина `9c6cea74` достижима из `master`. Ссылок в `data/`, сессиях/проектах БД, opencode-хранилище и логах задач нет, процессов на каталоге нет, `opencode.worktree_list` пуст. Выполнено `git worktree remove --force` → `git worktree prune` → пустой `worktrees/` удалён → `git branch -d feat/ui-chat-tails`.
- **Оставлено:** `ws-default/` (корень проекта) — это **действующий** дефолтный рабочий каталог инстанса: `data/settings.json → workspace = /home/eof/dev/Synth/ws-default`; в нём работают сессии без проекта (каталог пуст). `data/workspaces/ws-default/` — workspace проекта «ws-default» (владелец `mpfw2fw1-…`, содержит `audio/file_10.oga`), данные проекта, не трогались.
- **Проверки:** `git -C synth worktree list` — только основной чекаут; `synth/.git/worktrees` отсутствует; рабочее дерево репозитория не изменилось (кроме ранее существовавшего mode-change `scripts/build.sh`). **Коммит:** не требовался.

## 2026-11-04 — испытание бета-публикации (первый реальный прогон)

- **Задача:** проверить новый функционал бета-сборки/публикации (`scripts/publish-beta.sh`, workflow `Beta packages`) на реальном реестре. **Тип:** infra / publish. **Исполнители:** оркестратор, @devops, @fixer.
- **Итог:** публикация работает. Финальная бета — `0.13.3-beta.20261104093532.447c9f82` (без `.dirty`), 8 пакетов в Gitea Package Registry, `dist-tags.beta` указывает на неё, `latest` отсутствует, smoke и независимая установка `npm i -g @itphx/synth@beta` со scope-npmrc — зелёные (бинарь отвечает, `--help` работает).
- **Прогон 1:** упал на первом `pnpm publish` с 404 — фронтовый прокси перед Gitea не пропускал encoded slash (`%2F`) в пути scoped-пакета (локальная особенность инфраструктуры, в документацию не вносится). Пользователь поправил конфиг прокси; после этого `%2f` доходит до Gitea.
- **Прогон 2:** 8/8 опубликованы, но упал smoke: в `scripts/publish-beta.sh` команда `npm i -g … --registry "$REGISTRY"` подменяла реестр для **всех** зависимостей (404 на `@hono/node-server`); та же неверная подсказка печаталась в итоге. Плюс `version.txt` писался после smoke.
- **Фикс:** коммит `447c9f82` — `--registry` убран из smoke/подсказки/dry-run (scope-реестр уже задан временным npmrc), `version.txt` пишется до smoke.
- **Прогон 3:** PASS по функционалу, но версия вышла `.dirty` — правильно, фикс был не закоммичен (`.dirty` = непустой `git status`).
- **Прогон 4:** PASS, версия чистая; build 45 с, публикация 5 с, smoke 13 с, всего ~2 мин. Замечено: метаданные реестра видны не сразу (лаг ~15–45 с, проверка видимости прошла с 3-й попытки).
- **Проверки:** `git status` пуст, все 8 `package.json` + `version.ts` = `0.13.3` (trap восстановил), в реестре 24 записи (3 беты × 8 пакетов).
- **Остаток:** три беты на пакет — две с `.dirty`; ретеншн `./scripts/beta-prune.sh --keep N` (по умолчанию план, удаление `--yes`) не запускался. Workflow `Beta packages` в CI не проверялся (существует только в непушнутых коммитах; `master` на 7 коммитов впереди `origin`).

## 2026-11-04 — standalone: реплика пользователя задваивалась в ленте

- **Задача:** репорт владельца — в standalone каждая user-реплика рисуется дважды, в истории (и для модели) сообщение одно. **Тип:** bug fix (ui/core). **Исполнитель:** @fixer.
- **Причина:** нарушен инвариант ADR-118 §3 в core-роуте `POST /sessions/:id/prompt`: `message.id` генерировался заново (`SessionRoutesOptions.promptMessageId`, дефолт `'generated'`), а `202 {messageId}`/`message.accepted`/`message.enqueued` несли клиентский `messageId`. `message.delivered` приходил с серверным id → UI не находил оптимистичный пузырь, догружал сообщение по id и добавлял второй. В managed (`promptMessageId: 'stream'`) id совпадали — поэтому баг был только в standalone.
- **Фикс:** сообщение всегда сохраняется с `id = streamId` (клиентский `messageId` либо выданный сервером), `acceptedMessageId = message.id` (единый источник истины для `202`/событий/`blob_refs`); опция `promptMessageId` удалена (backend-проводка тоже); клиентский id нормализуется `normalizeClientMessageId` (не строка/пусто/пробелы → серверный id), общая точка для standalone- и hybrid-ветки.
- **Тесты:** `packages/core/src/server/routes/sessions-prompt.test.ts` — +2 регресса (клиентский id = id в истории/списке/`GET /messages/:id`/`message.delivered`; мусорный `messageId` `'   '`/`''`/`42` → серверный id, всё согласовано). Core suite 8842 passed, backend 754 passed, typecheck/build/lint зелёные (1 флейк `git-proxy-env` от env `no_proxy` не связан).
- **Коммит:** не делался (нет явной просьбы). Правки в рабочем дереве: `packages/core/src/server/routes/sessions.ts`, `packages/backend/src/routes/sessions.ts`, `packages/core/src/server/routes/sessions-prompt.test.ts`.
- **Остаток:** доставить фикс в сборку на машине владельца (перезапуск/обновление не поможет — нужен новый билд); уже показанные дубли в открытой вкладке исчезнут после reload (в истории их нет).
