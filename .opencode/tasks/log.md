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

## 2026-11-04 — чистка рабочего дерева: удалён каталог `worktrees/`, `ws-default` оставлен

- **Задача:** удалить `ws-default` и `worktrees`, если в них больше нет необходимости. **Тип:** обслуживание рабочего дерева (не код). **Исполнитель:** оркестратор.
- **Удалено:** `/worktrees/ui-chat-tails` — git-worktree репозитория `synth` на ветке `feat/ui-chat-tails`. Проверки: рабочее дерево чисто (только потерянный бит executable у `scripts/hybrid.sh`/`scripts/offline-images.sh`, содержимое не менялось), 0 коммитов сверх `master` (`rev-list master..HEAD` = 0, ветка в `--merged master`), вершина `9c6cea74` достижима из `master`. Ссылок в `data/`, сессиях/проектах БД, opencode-хранилище и логах задач нет, процессов на каталоге нет, `opencode.worktree_list` пуст. Выполнено `git worktree remove --force` → `git worktree prune` → пустой `worktrees/` удалён → `git branch -d feat/ui-chat-tails`.
- **Оставлено:** `ws-default/` (корень проекта) — это **действующий** дефолтный рабочий каталог инстанса: `data/settings.json → workspace = /home/eof/dev/Synth/ws-default`; в нём работают сессии без проекта (каталог пуст). `data/workspaces/ws-default/` — workspace проекта «ws-default» (владелец `mpfw2fw1-…`, содержит `audio/file_10.oga`), данные проекта, не трогались.
- **Проверки:** `git -C synth worktree list` — только основной чекаут; `synth/.git/worktrees` отсутствует; рабочее дерево репозитория не изменилось (кроме ранее существовавшего mode-change `scripts/build.sh`). **Коммит:** не требовался.
