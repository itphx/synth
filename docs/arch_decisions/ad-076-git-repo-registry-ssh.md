# AD-076: Реестр git-репозиториев и доступ (SSH)

> **Статус:** ⏳ Не реализовано
> **Источник:** согласовано 2026-09-23 (обсуждение проблем эксплуатации managed-Synth)

**Решение:** проект может иметь **несколько** git-репозиториев. Клонирование/инициализация **регистрируют** запись в `project.repos`; клон возможен в произвольный подкаталог **внутри** `project.workspace`; cwd git-инструментов — выбранный репозиторий. Доступ к приватным репозиториям — через **SSH-ключи per-agent**, шифруемые at-rest **персистентным секретом**.

## Решение

### Реестр репозиториев

Запись расширяет `GitRepoConfig`:

```ts
interface GitRepoConfig {
  id?: string;
  name: string;
  url: string;
  type: 'https' | 'ssh';
  path: string;              // относительный ВНУТРИ project.workspace (допускает вложенность)
  defaultBranch?: string;
  sshKeyId?: string;
  lastFetch?: string;
}
```

- `clone`/`init` **регистрируют** запись в `project.repos` (сейчас клон не трогает проект — см. «Что уже есть»).
- UI показывает **destination** (куда склонировано) и умеет удалять/пересканировать.
- `list_repos` перечисляет **все** репозитории проекта.
- **cwd git-инструментов = выбранный репозиторий**; нужен способ выбора — параметр тула (`repo_path`) либо селектор в UI.

### API

- `/api/v2/git` получает **паритет в core** + **проксирование в гибриде**. Сейчас префикса нет ни в core, ни в `REMOTE_PROXY_PREFIXES` → 404 в standalone/hybrid.

### SSH

- Ключи **per-agent**: модель `SSHKey` (`id`/`name`/`type`/`private_key`/`passphrase`/`created_at`).
- **Шифрование at-rest персистентным секретом** — env/K8s Secret или файл `0600` в `dataDir`. **Не machine-id** (в контейнере он нестабилен).
- CRUD API + UI в разделе агентов.
- Подстановка `GIT_SSH_COMMAND="ssh -i <tempkey>"` в `clone`/`push`/`pull`/`fetch`.
- SSH-URL **без ключа** → явная ошибка (не молчаливый фейл).
- **Маскировка ключей** в промпте/логах (AD-036).

## Что уже есть

| Факт | Где |
|---|---|
| Реальное клонирование (simple-git), клон в `{workspacesRoot}/{project.workspace}/{path|имя}` | `packages/backend/src/lib/git-service.ts:~131-145` |
| Роуты git — только `requireAuth`, **без записи в проект** | `packages/backend/src/routes/git.ts:~28-109` |
| `GitRepoConfig = { path, defaultBranch? }` — без `url/name/type/sshKeyId` | `packages/shared/src/types/index.ts:~696-700` |
| UI: Git-вкладка; кнопки scan/clone/init; после clone/init **нет `updateProject`**; рассинхрон `string[]` vs `GitRepoConfig[]`; destination нигде не показан | `packages/ui/src/components/panels/LeftPanel.tsx:~1279-1767`, `:1419-1421`, `:1485-1633` |
| `list_repos`/git-тулы жёстко от `project.workspace` | `packages/core/src/engine/tools/project-context.ts:~208-266`, `:27-38`; `packages/core/src/engine/tools/git.ts:~15-17` |
| `/api/v2/git` нет в core и нет в `REMOTE_PROXY_PREFIXES` → 404 в standalone/hybrid | `packages/core/src/server/proxy.ts:~17-27` |
| Мёртвое поле `AgentDefinition.sshKeys: string[]` — пишется, но не читается и не отдаётся API | `packages/shared/src/types/index.ts:~874` |
| Security denylist `~/.ssh/*` — это защита, не выдача ключей | `packages/core/definitions/protected-paths.json` |
| Прототип t11: SSH-менеджер (Fernet+PBKDF2, но machine-id), CRUD `/admin/agents/<agent>/ssh-keys`, `GIT_SSH_COMMAND`, реестр репозиториев с `required_agent`/`ssh_key_id`, клон в `{project}/repos/` | `~/dev/aic/t11/synth/app/ssh_key_manager.py` (222 стр.), `routes.py:~3067-3184`, `git_ops.py`, `git_clone_service.py:~49-67`, `git_repo_manager.py` (332 стр.) |

## Дельта

1. **Тип и схемы**: расширить `GitRepoConfig`; удалить/переиспользовать мёртвое `AgentDefinition.sshKeys`.
2. **Регистрация clone/init** в `project.repos` + RBAC по проекту (не только `requireAuth`).
3. **UI**: показ destination, удаление/пересканирование, видимый реестр; убрать рассинхрон `string[]` ↔ `GitRepoConfig[]`.
4. **cwd-per-repo**: параметр выбора репозитория в git-тулах; `list_repos` — все записи.
5. **Паритет/proxy `/git`**: core-фабрика + `REMOTE_PROXY_PREFIXES`.
6. **SSH-менеджер**: модель `SSHKey`, шифрование персистентным секретом, CRUD API, UI, подстановка `GIT_SSH_COMMAND`, маскировка (AD-036), явная ошибка на SSH без ключа.

## Открытые вопросы

- **Route-неймспейс ключей**: `/api/v2/agents/:id/ssh-keys` vs `/api/v2/ssh-keys` vs `/admin/...`.
- **Где хранить ключи**: `{dataDir}/secrets/` vs `{dataDir}/agents/`; формат (JSON + FileStore AD-005 vs отдельный store).
- **Как ключ доставляется в managed-контейнер**: монтирование секрета, temp-файл `0600` в поде, K8s Secret.
- **Как агент выбирает репозиторий**: поле в сессии, `repo_path` в каждом туле, активный репозиторий проекта.
- **Автоиндексация**: сканировать workspace при старте/после clone и подтягивать неучтённые репозитории.

## Зависимости

- **AD-005** — хранение (JSON, атомарная запись) для ключей/реестра.
- **AD-023** — конфиг (путь к секрету, источник шифрования).
- **AD-029** — permissions на git-write и SSH-операции.
- **AD-036** — маскировка секретов в промпте/логах.
- **AD-042** — проксирование `/git` и SSH в гибриде.
- **AD-075** — `path` репозитория резолвится внутри `project.workspace`.
- Сверять с прототипом `~/dev/aic/t11` (только чтение).

## Связи

- [AD-014](./ad-014-project-container.md) «Проект как контейнер» — `project.repos`.
- [AD-075](./ad-075-project-workspace-provisioning.md) «Окружение проекта: рабочий каталог».
- [AD-077](./ad-077-runtime-toolchain.md) «Инструментальное окружение исполнения» — нативный `git`/`ssh` обязателен.
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — обфускация и аудит.

## Порядок реализации

1. **Тип + схемы** `GitRepoConfig`; исправить `AgentDefinition.sshKeys`.
2. **Регистрация clone/init** в `project.repos`; паритет и проксирование `/git`.
3. **cwd-per-repo** и `list_repos`; UI destination/удаление/пересканирование.
4. **SSH-менеджер**: модель, шифрование, CRUD API, подстановка `GIT_SSH_COMMAND`.
5. **UI ключей** в разделе агентов; маскировка и явные ошибки.
6. Тесты: clone с ключом/без, маскировка, RBAC, паритет core↔backend.
