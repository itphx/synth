# ADR-076: Реестр git-репозиториев и доступ (SSH)

> **Статус:** ✅ Реализовано (2026-09-24, ветка `feat/adr-075-workspace-provisioning`)
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
- **Маскировка ключей** в промпте/логах (ADR-036).

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
6. **SSH-менеджер**: модель `SSHKey`, шифрование персистентным секретом, CRUD API, UI, подстановка `GIT_SSH_COMMAND`, маскировка (ADR-036), явная ошибка на SSH без ключа.

## Реализация (2026-09-24)

Реализовано в `@itphx/synth-shared`, `@itphx/synth-core`, `@itphx/synth-backend`, `@itphx/synth-ui`.

### 1. Shared (`@itphx/synth-shared`)

- `GitRepoConfig` расширен (`id?`/`name?`/`url?`/`type?`/`defaultBranch?`/`sshKeyId?`/`lastFetch?`, обязательный `path`); схема `gitRepoConfigSchema`; `normalizeGitRepoConfig(raw)` (`string` → `{ path }`, невалидное → `null`); `repos` в `projectCreate/Update` — union `string[] | GitRepoConfig[]` (legacy).
- `SSHKey` / `SSHKeyMeta` (`Omit<SSHKey,'privateKey'|'passphrase'>`), `SSHKey.agentIds: string[]` — общий ключ на несколько агентов; схемы `sshKeyCreateSchema`/`sshKeyUpdateSchema` (partial).
- Схемы git-роутов: `gitReposRegisterBodySchema`, `gitReposRemoveBodySchema`, `gitReposFetchBodySchema`; `gitInitBodySchema`/`gitCloneBodySchema` + `name?`/`sshKeyId?`.
- Конфиг `security.secretKey` (default `''`) + env `SYNTH_SECRET_KEY`; резолвер `resolveSecretKey` (env > `config.security.secretKey` > `''`).
- Удалено мёртвое `AgentDefinition.sshKeys`.
- i18n-ключи (контракт ADR-041): `sshkey.not_found|name_exists|encryption_unavailable|decrypt_failed`, `git.ssh_key_required|repo_path_invalid|repo_exists`, `projectctx.repo_destination|repo_name|repo_url|repo_type|repo_default_branch|repo_ssh_key|repo_last_fetch`.

### 2. Core: крипто и хранилище ключей

- `security/crypto.ts` — AES-256-GCM; формат токена `enc:v1:<b64 iv(12 Б)>:<b64 authTag(16 Б)>:<b64 ciphertext>`; plaintext без префикса читается как есть (back-compat).
- `resolveMasterKey` — приоритет `opts.secretKey` → env `SYNTH_SECRET_KEY` → файл `{dataDir}/secrets/master.key`. Материал — base64 (ровно 32 Б) или 64 hex; иначе типизированная ошибка `encryption_unavailable` (молчаливое обрезание недопустимо). Файл создаётся при первом запуске: каталог `0700`, файл `0600`, атомарная запись tmp→rename; кэш промиса на процесс (`clearMasterKeyCache` для тестов). Для ротации дополнительно экспортированы `masterKeyFilePath()`, `readMasterKeyFile()` (чтение файла **без** генерации) и `decodeMasterKey()`.
- `storage/ssh-key-store.ts` — `SSHKeyStore` поверх `JsonStore` (подкаталог `secrets/ssh-keys`). Секреты шифруются at-rest; `list`/`get`/`listForAgent` возвращают только `SSHKeyMeta`; `reveal(id)` расшифровывает секреты **только для подстановки в git**. `create`/`update` (case-insensitive уникальность имени, частичное обновление без обязательной замены ключа), `delete`, `linkAgent`/`unlinkAgent` (идемпотентно). Типизированные ошибки `SSHKeyStoreError` маппятся в `sshkey.*`. Для ротации мастера: `listRaw()` (сырые записи с зашифрованными секретами — админский метод, **не** отдаётся через API) и `rotateMasterKey(oldKey, newKey, {dryRun})` с preflight (abort с `preflight_failed`, если поле не расшифровывается ни новым, ни старым ключом), перешифровкой/апгрейдом plaintext и атомарной записью (`skipped`, если запись уже под новым ключом).

### 3. Core: git-сервис и роуты

- `git/git-service.ts` — перенесён из backend (`simple-git` стал зависимостью core): `cloneRepo`/`initRepo`/`scanWorkspace`/`getRepoStatus`/`getLog`/`getCommitDetail`, плюс ADR-076 `fetchRepo` (опц. remote + env) и `removeLocal` (только после проверки containment, корень workspace удалять нельзя). Env-поддержка (`withEnv` объединяет `process.env`, а не заменяет его) для SSH.
- `git/ssh-env.ts` — `isSshUrl` (`git@`/`ssh://`), `createSshEnv`: temp-файл `0600` в каталоге `0700` (`mkdtemp`), базовый `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"`, идемпотентный `cleanup`. Ключ **без** passphrase → `-o BatchMode=yes` без askpass; ключ **с** passphrase → создаётся askpass-скрипт `0700` и env `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` (см. §8). Сбой подготовки (FS/permissions) → `SshEnvError('env_failed')`.
- `server/routes/git.ts` (`createGitRoutes(auth, projectStore, workspacesRoot, opts)`): `POST /scan`, `POST /repos/init|clone|register|remove|fetch`, `GET /log|commit`. `init`/`clone` **регистрируют** запись в `project.repos` (`registerRepo` — upsert по `id`/`path`); `clone` при пустом `path` выводит имя из URL (`deriveRepoName`), обновляет `lastFetch`. `opts`: `sshKeyStore`, `writeGuard` (дефолт — no-op, т.к. `requireAuth` уже навешан), `authorizeProject` (managed RBAC).
- `server/routes/ssh-keys.ts`: flat `createSshKeyRoutes` (`GET/POST /`, `GET/PATCH/DELETE /:id`) + nested `createAgentSshKeyRoutes` (`GET/POST /agents/:agentId/ssh-keys`, `DELETE /:keyId` = **отвязать**, не удалять). Ответы всегда `SSHKeyMeta` (маскировка по умолчанию), `reveal` в API не вызывается.
- Монтирование в core (`server/app.ts`): `/api/v2/git` (с `sshKeyStore`), `/api/v2/ssh-keys`, `/api/v2/agents/:agentId/ssh-keys` (guards по умолчанию). `REMOTE_PROXY_PREFIXES` += `/api/v2/git`, `/api/v2/ssh-keys`; добавлен `REMOTE_PROXY_PATTERNS` = `[/^\/api\/v2\/agents\/[^/]+\/ssh-keys(?:\/|$)/]` — nested GET/POST/DELETE проксируются в гибриде (как flat `/ssh-keys` и `/git`), а прочие подпути `/api/v2/agents` (`/all`, `/:id`, `/:id/enabled`) остаются локальными. `matchesProxyPrefix` учитывает префиксы и паттерны (матчер экспортирован).
- Публичные экспорты (`src/index.ts`): `SSHKeyStore`/`SSHKeyStoreError`, `createGitRoutes`, `createSshKeyRoutes`/`createAgentSshKeyRoutes`.

### 4. Core: тулы

- `runGit(args, cwd, signal?, env?)` — опц. env объединяется с `process.env`.
- Необязательный `repo_path` во **всех** git-тулах: `resolveRepoCwd` резолвит путь относительно `project.workspace` с containment (абсолютный/`..` → ошибка `git.repo_path_invalid`); legacy `path` сохранён.
- `engine/tools/git-ssh.ts` — `resolveRepoGitEnv(ctx, cwd)`: по cwd находит запись `project.repos` и при заданном `sshKeyId` готовит `GIT_SSH_COMMAND`; инъекция в `git_push`/`git_pull` (errors — i18n-ключи `sshkey.*`). Оркестратор прокидывает `sshKeyStore`/`workspacesRoot` в `extra`.
- `list_repos` отдаёт записи реестра (`projectctx.repo_*`: `destination`/`name`/`url`/`type`/`defaultBranch`/`sshKeyId`/`lastFetch` + git-детект), иначе — скан workspace (legacy).
- Тулы управления реестром: `project_repo_clone`/`project_repo_init` (клон/init + регистрация записи), `project_repo_add` (регистрация существующего каталога, без сети), `project_repo_fetch` (fetch + `lastFetch`), `project_repo_remove` (снятие из реестра, локальный каталог не удаляется). Проект берётся из сессии, containment — `GitService.resolveRepoPath`, изменения сохраняются `ProjectStore.save` и публикуются событием `project.updated`.
- `resolveSshEnvById(sshKeyStore, sshKeyId)` (`engine/tools/git-ssh.ts`) — SSH-окружение по явному ключу; общий хелпер HTTP-роутов (`/api/v2/git`) и тулов клона/fetch.
- Resumed-саб-агенты (`task-resume.ts`) получают в tool-extra те же проектные зависимости (`projectStore`/`workspacesRoot`/`sshKeyStore`/`gitService`) — проектные и сетевые git-тулы доступны и после resume.

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

### 8. SSH-ключи с passphrase (askpass)

- При наличии `passphrase` `createSshEnv` (`git/ssh-env.ts`) создаёт в temp-каталоге `0700` исполняемый askpass-скрипт (`0700`), отдающий passphrase через `base64 -d` (без зависимости от кавычек/спецсимволов); env получает `SSH_ASKPASS` и `SSH_ASKPASS_REQUIRE=force`, а `GIT_SSH_COMMAND` — без `BatchMode=yes`, с `-o NumberOfPasswordPrompts=1` (защита от зависания).
- Для ключей без passphrase поведение прежнее (`BatchMode=yes`, без askpass). Код ошибки подготовки — `SshEnvErrorCode = 'env_failed'`; наружу отдаётся i18n-ключ `sshkey.env_failed` (`engine/tools/git-ssh.ts`; `server/routes/git.ts` — вместо сырого текста; shared + core `system-messages` en + UI ru/en).
- **Остаточные риски:** passphrase лежит base64 в temp-файле `0700` на время git-вызова (эквивалент temp-копии ключа; каталог удаляется `cleanup`, при крахе процесса может остаться в `os.tmpdir()`); e2e с реальным sshd не проводился (проверены askpass-скрипт и форма env); askpass зависит от GNU-совместимого `base64 -d`.

### 9. Ротация мастер-ключа (`synth secrets rotate`)

- `security/rotate.ts`: `rotateSecretsMasterKey(opts)` + `MasterKeyRotationError` (коды `master_key_missing`/`key_conflict`/`key_file_read_failed`/`invalid_key`). Старый ключ — из явного материала (`--old-key`/`--old-key-file`) → env `SYNTH_SECRET_KEY`/`config.security.secretKey` → файл `{dataDir}/secrets/master.key` (файла нет → понятная ошибка `master_key_missing`, **не** генерация). Новый ключ — явный либо `randomBytes(32)`. После успеха перезаписывает `master.key` (`0600`, каталог `0700`, tmp→rename) и сбрасывает `clearMasterKeyCache()`. Предупреждает, если эффективный ключ задан через env/config (файл будет проигнорирован при старте).
- CLI `synth secrets rotate` — в **обоих** CLI (`packages/core/src/main.ts` и публичном `packages/synth/src/cli.ts`): опции `--data-dir --config --old-key --old-key-file --new-key --new-key-file --dry-run --yes`. Без `--yes` (и без `--dry-run`) — отказ с exit 1; exit 1 при ошибке/preflight-abort. Сводка `total/rotated/upgraded/skipped`. Команда не является HTTP API.
- **Остаточные риски:** в токене нет key-id/версии (при ротации перебор new→old); split-state при падении между записями/до перезаписи `master.key` (повторный прогон идемпотентен); приоритет env/`config.security.secretKey` над файлом — при заданном env/config ключ нужно обновить и там.

### 10. Тесты

- `typecheck` 6/6, `lint` 0 errors; тесты shared 155 · core 2144 · ui 774 · backend 372.
- Перенесены/добавлены: `crypto.test.ts`, `ssh-key-store.test.ts`, `git-service.test.ts`, `ssh-env.test.ts`, `server/routes/git.test.ts`, `server/routes/ssh-keys.test.ts`, `engine/tools/git-ssh.test.ts`, backend `routes/git.test.ts`/`ssh-keys.test.ts`, UI `GitTab.test.tsx`/`SshKeysSettings.test.tsx`/`synthApi.ssh-keys.test.ts`.
- Дополнено остатками ADR-075/ADR-076: `plan.test.ts` (RBAC `plan_write`), `manager.test.ts` (атрибуция `createSession`/`forkSession`), `app.proxy.test.ts` (+4 кейса nested `/agents/:id/ssh-keys`), `ssh-env.test.ts` (askpass), `rotate`/`ssh-key-store` (ротация).

## Решено (ранее открытые вопросы)

- **Route-неймспейс ключей** — оба: flat `/api/v2/ssh-keys` (полный CRUD) и nested `/api/v2/agents/:agentId/ssh-keys` (список/создание с привязкой; `DELETE :keyId` — отвязка).
- **Где хранить ключи/формат** — `{dataDir}/secrets/ssh-keys/`, отдельный `SSHKeyStore` поверх `JsonStore` (ADR-005), а не `AgentDefinition`. Ключ привязан к нескольким агентам через `agentIds: string[]`.
- **Доставка ключа** — temp-файл `0600` в `0700`-каталоге + `GIT_SSH_COMMAND`; персистентный ключ — env `SYNTH_SECRET_KEY` / `config.security.secretKey` / файл `{dataDir}/secrets/master.key`.
- **Выбор репозитория** — параметр `repo_path` во всех git-тулах (containment внутри `project.workspace`); `list_repos` читает реестр.
- **Регистрация репозиториев из чата** — `project_repo_clone`/`project_repo_init` из тулов регистрируют запись в `project.repos` так же, как HTTP-роут (`registerRepo` + `ProjectStore.save`, событие `project.updated`).
- **Шифрование** — AES-256-GCM (`enc:v1:`), не machine-id.
- **Автоиндексация** — не реализована: scan остаётся явным действием; неучтённые репозитории добавляются через `POST /git/repos/register`.

## Известные ограничения

- **Passphrase (askpass)**: passphrase лежит base64 в temp-файле `0700` на время git-вызова (эквивалент temp-копии ключа); каталог удаляется `cleanup`, но при крахе процесса может остаться в `os.tmpdir()`. E2e с реальным sshd не проводился (проверены askpass-скрипт и форма env). askpass зависит от GNU-совместимого `base64 -d`. Не-dry-run ротация/операции с ключом недоступны при `encryption_unavailable` (секрет не задан).
- **Ротация мастер-ключа**: в токене нет key-id/версии (при ротации перебор new→old); split-state при падении между записями/до перезаписи `master.key` (повторный прогон идемпотентен); при заданном env/`config.security.secretKey` ключ нужно обновлять и там (файл при старте игнорируется) — команда выводит предупреждение.
- **Легаси-сессии без атрибуции** (ADR-075): запись `plan`/`invariants`/`log` из сессии, созданной до фикса атрибуции, в проект с непустым `ownerId` → `project.write_forbidden`; бэкфилл не делался.
- В `git`-тулах `repo_path` резолвится в пределах `project.workspace`; `git_push`/`git_pull` подставляют SSH только для репозитория, найденного в реестре (для остальных — ambient `ssh`).

## Зависимости

- **ADR-005** — хранение (JSON, атомарная запись) для ключей/реестра.
- **ADR-023** — конфиг (путь к секрету, источник шифрования).
- **ADR-029** — permissions на git-write и SSH-операции.
- **ADR-036** — маскировка секретов в промпте/логах.
- **ADR-042** — проксирование `/git` и SSH в гибриде.
- **ADR-075** — `path` репозитория резолвится внутри `project.workspace`.
- Сверять с прототипом `~/dev/aic/t11` (только чтение).

## Связи

- [ADR-014](./adr-014-project-container.md) «Проект как контейнер» — `project.repos`.
- [ADR-075](./adr-075-project-workspace-provisioning.md) «Окружение проекта: рабочий каталог».
- [ADR-077](./adr-077-runtime-toolchain.md) «Инструментальное окружение исполнения» — нативный `git`/`ssh` обязателен.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — обфускация и аудит.

## Порядок реализации (выполнено 2026-09-24)

1. **Тип + схемы** `GitRepoConfig`; удалено `AgentDefinition.sshKeys`. ✅
2. **Регистрация clone/init** в `project.repos`; паритет и проксирование `/git`. ✅
3. **cwd-per-repo** и `list_repos`; UI destination/удаление/пересканирование. ✅
4. **SSH-менеджер**: модель, шифрование, CRUD API, подстановка `GIT_SSH_COMMAND`. ✅
5. **UI ключей** в разделе агентов; маскировка и явные ошибки. ✅
6. Тесты: clone с ключом/без, маскировка, RBAC, паритет core↔backend. ✅
