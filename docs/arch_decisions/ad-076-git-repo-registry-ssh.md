# AD-076: Реестр git-репозиториев и доступ (SSH)

> **Статус:** ✅ Реализовано (2026-09-24, ветка `feat/ad-075-workspace-provisioning`)
> **Источник:** согласовано 2026-09-23 (обсуждение проблем эксплуатации managed-Synth)

**Решение:** проект может иметь **несколько** git-репозиториев. Клонирование/инициализация **регистрируют** запись в `project.repos`; клон возможен в произвольный подкаталог **внутри** `project.workspace`; cwd git-инструментов — выбранный репозиторий. Доступ к приватным репозиториям — через **SSH-ключи per-agent**, шифруемые at-rest **персистентным секретом**.

## Решение

### Реестр репозиториев

Запись расширяет `GitRepoConfig`:

```ts
interface GitRepoConfig {
  id?: string;
  name?: string;
  url?: string;
  type?: 'https' | 'ssh';
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

- Ключи **per-agent**: модель `SSHKey` (`id`/`name`/`type`/`private_key`/`passphrase`/`agent_ids`/`created_at`).
- **Шифрование at-rest персистентным секретом** — env/K8s Secret или файл `0600` в `dataDir`. **Не machine-id** (в контейнере он нестабилен).
- CRUD API + UI в разделе агентов.
- Подстановка `GIT_SSH_COMMAND="ssh -i <tempkey>"` в `clone`/`push`/`pull`/`fetch`.
- SSH-URL **без ключа** → явная ошибка (не молчаливый фейл).
- **Маскировка ключей** в промпте/логах (AD-036).

## Что уже есть (исходное состояние, до реализации)

| Факт | Где |
|---|---|
| Реальное клонирование (simple-git), клон в `{workspacesRoot}/{project.workspace}/{path\|имя}` | `packages/backend/src/lib/git-service.ts` (удалён) |
| Роуты git — только `requireAuth`, **без записи в проект** | `packages/backend/src/routes/git.ts` (удалён) |
| `GitRepoConfig = { path, defaultBranch? }` — без `url/name/type/sshKeyId` | `packages/shared/src/types/index.ts` |
| UI: Git-вкладка; кнопки scan/clone/init; после clone/init **нет `updateProject`**; рассинхрон `string[]` vs `GitRepoConfig[]`; destination нигде не показан | `packages/ui/src/components/panels/LeftPanel.tsx` |
| `list_repos`/git-тулы жёстко от `project.workspace` | `packages/core/src/engine/tools/project-context.ts`, `packages/core/src/engine/tools/git.ts` |
| `/api/v2/git` нет в core и нет в `REMOTE_PROXY_PREFIXES` → 404 в standalone/hybrid | `packages/core/src/server/proxy.ts` |
| Мёртвое поле `AgentDefinition.sshKeys: string[]` — пишется, но не читается и не отдаётся API | `packages/shared/src/types/index.ts` |
| Security denylist `~/.ssh/*` — это защита, не выдача ключей | `packages/core/definitions/protected-paths.json` |
| Прототип t11: SSH-менеджер (Fernet+PBKDF2, но machine-id), CRUD `/admin/agents/<agent>/ssh-keys`, `GIT_SSH_COMMAND`, реестр репозиториев с `required_agent`/`ssh_key_id`, клон в `{project}/repos/` | `~/dev/aic/t11/synth/app/ssh_key_manager.py`, `routes.py`, `git_ops.py`, `git_clone_service.py`, `git_repo_manager.py` |

## Дельта

1. **Тип и схемы**: расширить `GitRepoConfig`; удалить/переиспользовать мёртвое `AgentDefinition.sshKeys`.
2. **Регистрация clone/init** в `project.repos` + RBAC по проекту (не только `requireAuth`).
3. **UI**: показ destination, удаление/пересканирование, видимый реестр; убрать рассинхрон `string[]` ↔ `GitRepoConfig[]`.
4. **cwd-per-repo**: параметр выбора репозитория в git-тулах; `list_repos` — все записи.
5. **Паритет/proxy `/git`**: core-фабрика + `REMOTE_PROXY_PREFIXES`.
6. **SSH-менеджер**: модель `SSHKey`, шифрование персистентным секретом, CRUD API, UI, подстановка `GIT_SSH_COMMAND`, маскировка (AD-036), явная ошибка на SSH без ключа.

## Реализация (2026-09-24)

Реализовано в `@itphx/synth-shared`, `@itphx/synth-core`, `@itphx/synth-backend`, `@itphx/synth-ui`.

### 1. Shared (`@itphx/synth-shared`)

- `GitRepoConfig` расширен (`id?`/`name?`/`url?`/`type?`/`defaultBranch?`/`sshKeyId?`/`lastFetch?`, обязательный `path`); схема `gitRepoConfigSchema`; `normalizeGitRepoConfig(raw)` (`string` → `{ path }`, невалидное → `null`); `repos` в `projectCreate/Update` — union `string[] | GitRepoConfig[]` (legacy).
- `SSHKey` / `SSHKeyMeta` (`Omit<SSHKey,'privateKey'|'passphrase'>`), `SSHKey.agentIds: string[]` — общий ключ на несколько агентов; схемы `sshKeyCreateSchema`/`sshKeyUpdateSchema` (partial).
- Схемы git-роутов: `gitReposRegisterBodySchema`, `gitReposRemoveBodySchema`, `gitReposFetchBodySchema`; `gitInitBodySchema`/`gitCloneBodySchema` + `name?`/`sshKeyId?`.
- Конфиг `security.secretKey` (default `''`) + env `SYNTH_SECRET_KEY`; резолвер `resolveSecretKey` (env > `config.security.secretKey` > `''`).
- Удалено мёртвое `AgentDefinition.sshKeys`.
- i18n-ключи (контракт AD-041): `sshkey.not_found|name_exists|encryption_unavailable|decrypt_failed`, `git.ssh_key_required|repo_path_invalid|repo_exists`, `projectctx.repo_destination|repo_name|repo_url|repo_type|repo_default_branch|repo_ssh_key|repo_last_fetch`.

### 2. Core: крипто и хранилище ключей

- `security/crypto.ts` — AES-256-GCM; формат токена `enc:v1:<b64 iv(12 Б)>:<b64 authTag(16 Б)>:<b64 ciphertext>`; plaintext без префикса читается как есть (back-compat).
- `resolveMasterKey` — приоритет `opts.secretKey` → env `SYNTH_SECRET_KEY` → файл `{dataDir}/secrets/master.key`. Материал — base64 (ровно 32 Б) или 64 hex; иначе типизированная ошибка `encryption_unavailable` (молчаливое обрезание недопустимо). Файл создаётся при первом запуске: каталог `0700`, файл `0600`, атомарная запись tmp→rename; кэш промиса на процесс (`clearMasterKeyCache` для тестов).
- `storage/ssh-key-store.ts` — `SSHKeyStore` поверх `JsonStore` (подкаталог `secrets/ssh-keys`). Секреты шифруются at-rest; `list`/`get`/`listForAgent` возвращают только `SSHKeyMeta`; `reveal(id)` расшифровывает секреты **только для подстановки в git**. `create`/`update` (case-insensitive уникальность имени, частичное обновление без обязательной замены ключа), `delete`, `linkAgent`/`unlinkAgent` (идемпотентно). Типизированные ошибки `SSHKeyStoreError` маппятся в `sshkey.*`.

### 3. Core: git-сервис и роуты

- `git/git-service.ts` — перенесён из backend (`simple-git` стал зависимостью core): `cloneRepo`/`initRepo`/`scanWorkspace`/`getRepoStatus`/`getLog`/`getCommitDetail`, плюс AD-076 `fetchRepo` (опц. remote + env) и `removeLocal` (только после проверки containment, корень workspace удалять нельзя). Env-поддержка (`withEnv` объединяет `process.env`, а не заменяет его) для SSH.
- `git/ssh-env.ts` — `isSshUrl` (`git@`/`ssh://`), `createSshEnv`: temp-файл `0600` в каталоге `0700` (`mkdtemp`), `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"`, идемпотентный `cleanup`. `passphrase` → явная `SshEnvError('passphrase_unsupported')`.
- `server/routes/git.ts` (`createGitRoutes(auth, projectStore, workspacesRoot, opts)`): `POST /scan`, `POST /repos/init|clone|register|remove|fetch`, `GET /log|commit`. `init`/`clone` **регистрируют** запись в `project.repos` (`registerRepo` — upsert по `id`/`path`); `clone` при пустом `path` выводит имя из URL (`deriveRepoName`), обновляет `lastFetch`. `opts`: `sshKeyStore`, `writeGuard` (дефолт — no-op, т.к. `requireAuth` уже навешан), `authorizeProject` (managed RBAC).
- `server/routes/ssh-keys.ts`: flat `createSshKeyRoutes` (`GET/POST /`, `GET/PATCH/DELETE /:id`) + nested `createAgentSshKeyRoutes` (`GET/POST /agents/:agentId/ssh-keys`, `DELETE /:keyId` = **отвязать**, не удалять). Ответы всегда `SSHKeyMeta` (маскировка по умолчанию), `reveal` в API не вызывается.
- Монтирование в core (`server/app.ts`): `/api/v2/git` (с `sshKeyStore`), `/api/v2/ssh-keys`, `/api/v2/agents/:agentId/ssh-keys` (guards по умолчанию). `REMOTE_PROXY_PREFIXES` += `/api/v2/git`, `/api/v2/ssh-keys`.
- Публичные экспорты (`src/index.ts`): `SSHKeyStore`/`SSHKeyStoreError`, `createGitRoutes`, `createSshKeyRoutes`/`createAgentSshKeyRoutes`.

### 4. Core: тулы

- `runGit(args, cwd, signal?, env?)` — опц. env объединяется с `process.env`.
- Необязательный `repo_path` во **всех** git-тулах: `resolveRepoCwd` резолвит путь относительно `project.workspace` с containment (абсолютный/`..` → ошибка `git.repo_path_invalid`); legacy `path` сохранён.
- `engine/tools/git-ssh.ts` — `resolveRepoGitEnv(ctx, cwd)`: по cwd находит запись `project.repos` и при заданном `sshKeyId` готовит `GIT_SSH_COMMAND`; инъекция в `git_push`/`git_pull` (errors — i18n-ключи `sshkey.*`). Оркестратор прокидывает `sshKeyStore`/`workspacesRoot` в `extra`.
- `list_repos` отдаёт записи реестра (`projectctx.repo_*`: `destination`/`name`/`url`/`type`/`defaultBranch`/`sshKeyId`/`lastFetch` + git-детект), иначе — скан workspace (legacy).

### 5. Backend

- Локальные `routes/git.ts` и `lib/git-service.ts` удалены, `simple-git` из зависимостей убран.
- `/api/v2/git` — core-фабрика с `authorizeProject` = увладелец/EDITOR/LEAD/ADMIN (`canEditProjectContent` из `routes/projects.ts`); `scan/log/commit` — только `requireAuth`.
- `/api/v2/ssh-keys` и `/api/v2/agents/:agentId/ssh-keys` — core-фабрики, `writeGuard: auth.requireAdmin` (чтение — `requireAuth`). `SSHKeyStore` строится на общем `dataDir`, `secretKey: resolveSecretKey(...)`.

### 6. UI

- Git-вкладка (`LeftPanel.tsx` → `GitTab`, `stores/gitStore.ts`, `synthApi`): реестр с `destination`/`type`/`url`/`ssh-key`/`lastFetch`; fetch/remove (`ConfirmDialog` + `deleteLocal`); clone с полями `name`/`path` и селектором SSH-ключа; init с `name`/`path`; scan → register (рассинхрон `string[]` устранён).
- Секция настроек «SSH-ключи» (`components/settings/SshKeysSettings.tsx`) в категории «Агенты» (`admin/AgentsPanel.tsx`): CRUD, привязка к агентам, редактирование без обязательной замены ключа, `ConfirmDialog`, обработка ошибок `sshkey.*`. i18n ru/en.

### 7. Данные

```text
$SYNTH_DATA_DIR/secrets/master.key            # 0600, каталог 0700 (если не задан env/config)
$SYNTH_DATA_DIR/secrets/ssh-keys/<id>.json    # SSHKey, секреты зашифрованы enc:v1:
```

### 8. Тесты

- `typecheck` 6/6, `lint` 0 errors; тесты shared 155 · core 2120 · ui 774 · backend 372.
- Перенесены/добавлены: `crypto.test.ts`, `ssh-key-store.test.ts`, `git-service.test.ts`, `ssh-env.test.ts`, `server/routes/git.test.ts`, `server/routes/ssh-keys.test.ts`, `engine/tools/git-ssh.test.ts`, backend `routes/git.test.ts`/`ssh-keys.test.ts`, UI `GitTab.test.tsx`/`SshKeysSettings.test.tsx`/`synthApi.ssh-keys.test.ts`.

## Решено (ранее открытые вопросы)

- **Route-неймспейс ключей** — оба: flat `/api/v2/ssh-keys` (полный CRUD) и nested `/api/v2/agents/:agentId/ssh-keys` (список/создание с привязкой; `DELETE :keyId` — отвязка).
- **Где хранить ключи/формат** — `{dataDir}/secrets/ssh-keys/`, отдельный `SSHKeyStore` поверх `JsonStore` (AD-005), а не `AgentDefinition`. Ключ привязан к нескольким агентам через `agentIds: string[]`.
- **Доставка ключа** — temp-файл `0600` в `0700`-каталоге + `GIT_SSH_COMMAND`; персистентный ключ — env `SYNTH_SECRET_KEY` / `config.security.secretKey` / файл `{dataDir}/secrets/master.key`.
- **Выбор репозитория** — параметр `repo_path` во всех git-тулах (containment внутри `project.workspace`); `list_repos` читает реестр.
- **Шифрование** — AES-256-GCM (`enc:v1:`), не machine-id.
- **Автоиндексация** — не реализована: scan остаётся явным действием; неучтённые репозитории добавляются через `POST /git/repos/register`.

## Известные ограничения

- **Ключи с passphrase не поддерживаются**: `ssh` не читает passphrase из окружения, поэтому `createSshEnv` бросает явную ошибку (`passphrase_unsupported`); API-операции с таким ключом → `400`. Тихая деградация аутентификации исключена намеренно.
- **Nested `/agents/:id/ssh-keys` в гибриде не проксируется**: в `REMOTE_PROXY_PREFIXES` только flat `/api/v2/ssh-keys`; `/api/v2/agents` в гибриде — локальный. Nested-запросы обслуживает локальный core, а не удалённый backend.
- **`plan_write` без tool-RBAC** — остаток AD-075 (строгий гейт ломает план-воркфлоу на неатрибутированных сессиях).
- **Ротация мастер-ключа вне объёма**: смена `SYNTH_SECRET_KEY`/`master.key` не перешифровывает существующие записи (старые секреты станут нечитаемыми).
- В `git`-тулах `repo_path` резолвится в пределах `project.workspace`; `git_push`/`git_pull` подставляют SSH только для репозитория, найденного в реестре (для остальных — ambient `ssh`).

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

## Порядок реализации (выполнено 2026-09-24)

1. **Тип + схемы** `GitRepoConfig`; удалено `AgentDefinition.sshKeys`. ✅
2. **Регистрация clone/init** в `project.repos`; паритет и проксирование `/git`. ✅
3. **cwd-per-repo** и `list_repos`; UI destination/удаление/пересканирование. ✅
4. **SSH-менеджер**: модель, шифрование, CRUD API, подстановка `GIT_SSH_COMMAND`. ✅
5. **UI ключей** в разделе агентов; маскировка и явные ошибки. ✅
6. Тесты: clone с ключом/без, маскировка, RBAC, паритет core↔backend. ✅
