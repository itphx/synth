# AD-077: Инструментальное окружение исполнения (git/python/rg)

> **Статус:** ⏳ Не реализовано
> **Источник:** согласовано 2026-09-23 (обсуждение проблем эксплуатации managed-Synth)

**Решение:** инструменты, нужные агентским тулам, должны гарантированно присутствовать в окружении исполнения. В **dev/standalone** они берутся с хоста (там уже есть); в **managed-контейнере** — через **tools-образ + volume в тот же pod**. Полноценный sandbox-сервис с exec-API и изоляцией — отдельно, в рамках D5/AD-050.

## Решение

| Среда | Источник git/python/rg |
|---|---|
| **dev / standalone / hybrid-local** | Хостовые бинари (уже установлены) |
| **managed (K8s)** | Tools-образ + volume, смонтированный в **тот же pod**, бинари в `PATH` |

- **MVP:** `apk add git ripgrep python3 py3-pip` прямо в `docker/Dockerfile.backend` и `docker/Dockerfile` (сборка идёт root'ом). Быстро закрывает проблему, ценой размера образа.
- **Целевое:** отдельный образ **`synth-tools`** (alpine + `git`/`rg`/`python3`); `initContainer` наполняет volume; volume монтируется в backend; бинари в `PATH`. **Без `docker.sock` и без RBAC** — никакого подъёма подов из backend.
- **JS-fallback для `grep_files`**: при отсутствии `rg` — JS-реализация (по образцу `glob`); `git` **обязателен нативный**; `python3` — для `execute_shell` и stdio-MCP.
- **Изоляция/исполнение чужого кода** — не здесь: уходит в **D5/AD-050** (Runner, sandbox-сервис с exec-API).

## Что уже есть

| Факт | Где |
|---|---|
| Образы на `node:22-alpine`, **ни одного `apk add`**; нет git/python/rg | `docker/Dockerfile`, `docker/Dockerfile.backend`, `docker/Dockerfile.ui` |
| `execute_shell` исполняется в процессе backend/core через `sh -c`, наследует env | `packages/core/src/engine/tools/shell.ts:~43-52` |
| git-тулы — `execFile('git')`; `grep_files` — `execFile('rg')`; backend GitService — на simple-git | `packages/core/src/engine/tools/git.ts:~15-17`; `packages/core/src/engine/tools/search.ts:~48`; `packages/backend/src/lib/git-service.ts` |
| Backend в K8s: `runAsUser: 1000`, `runAsNonRoot`, `allowPrivilegeEscalation: false`, нет `docker.sock`/`hostPath`/Role/RoleBinding → поды поднимать не может | `charts/synth/values.yaml:~76-79,120`; `synth-deploy` values.yaml |
| Runner — заглушка, флаг `--runner` не используется, адаптеров нет | `packages/runner/src/main.ts` (37 стр., `TODO: реализация раннера`) |
| `glob` уже на JS; при отсутствии `rg` — локализованная ошибка `search.rg_not_installed` | `packages/core/src/engine/tools/fs-read.ts`; `packages/core/src/engine/tools/search.ts:~77` |

## Дельта

1. **MVP-пакеты** в `docker/Dockerfile.backend` и `docker/Dockerfile` (`git`, `ripgrep`, `python3`, `py3-pip`).
2. **Целевой `synth-tools`**: отдельный образ + `initContainer` → volume → монтирование в backend, бинари в `PATH`.
3. **JS-fallback `grep_files`** при отсутствии `rg` (для окружений без tools-volume).
4. **Документация**: требования к инструментам, размер образа, troubleshooting.

## Открытые вопросы

- **PVC vs `initContainer` image**: переиспользуемый PVC или эфемерный `emptyDir`, наполняемый tools-образом на старте пода.
- **Всегда ли нужен `python`**: нужен для `execute_shell`/stdio-MCP, но тянет размер; опциональность.
- **Размер образа**: держать tools-слой отдельно (target) или «толстый» backend; влияние на pull-time и registry.
- **MCP stdio**: какие runtime'ы требуются запускаемым MCP-серверам (node/python/uvx), как доставлять их в tools-volume.

## Зависимости

- **AD-022** — Runner-архитектура (stateless-движки).
- **AD-038** — сборка/публикация образов (npm/Docker/Helm).
- **AD-042** — гибрид (где исполняется managed vs локально).
- **D5 / AD-050** (Runner) — туда уходит изоляция и exec-API; AD-077 даёт инструменты, но не заменяет sandbox.
- **AD-075/AD-076** — `mkdir`/`git`/`ssh` должны быть доступны в целевом окружении.

## Связи

- [AD-022](./ad-022-typescript-stack-runner.md) «Единый TypeScript стек + Runner-архитектура».
- [AD-038](./ad-038-npm-packages.md) «Монорепо как набор публикуемых npm-пакетов».
- [AD-075](./ad-075-project-workspace-provisioning.md) «Окружение проекта: рабочий каталог».
- [AD-076](./ad-076-git-repo-registry-ssh.md) «Реестр git-репозиториев и доступ (SSH)».
- [docs/PUBLISHING.md](../PUBLISHING.md) — сборка Docker/Helm.

## Порядок реализации

1. **MVP**: `apk add git ripgrep python3 py3-pip` в `Dockerfile.backend`/`Dockerfile`; сквозная проверка git-тулов и `grep_files` в managed.
2. **JS-fallback `grep_files`**: убрать жёсткую зависимость от `rg`.
3. **`synth-tools`**: отдельный образ + `initContainer`-volume в Helm-чарт (`charts/synth/`), монтирование в backend.
4. **Документация**: требования, размер, диагностика отсутствующих бинарей.
5. Согласовать изоляцию/exec-API с **D5/AD-050**; не дублировать sandbox здесь.
