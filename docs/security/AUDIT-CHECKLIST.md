# Чек-лист роли-аудитора перед релизом

Роль **AUDITOR** — read-only (`edit/write: deny`): аудитор ничего не применяет, не публикует, не
тегирует и **не создаёт файлов**. Запись аудита аудитор формирует как **содержание** (по формату
роли: `Command run` / `Output observed` / `Expected vs Actual` / `Result`), а файл
`docs/security/releases/<version>.json` вносит в ветку релиза релиз-менеджер.

Правило формата: каждая строка — **команда + наблюдаемый результат** (не «прочитал и одобрил»).
`PASS` без приведённой команды и вывода запрещён. Waiver-статусов нет: проверку нельзя «извинить» —
если она не выполнена, запись неполная и **гейт блокирует релиз**.

## 0. Подготовка

```bash
git fetch --tags && git status --short                 # дерево чисто (учтите чужие незакоммиченные правки)
git rev-parse HEAD                                     # sha, который пойдёт в запись (commit)
node scripts/security-gate.mjs --version <version> --skip-tests   # быстрые проверки: policy/record/secret-scan/ratchet
node --version && pnpm --version                       # Node 22+, pnpm 11+
```

Результат: зафиксированы версия, sha аудита, состояние дерева, предварительный вердикт гейта.

## 1. Секреты (дерево + история)

```bash
node scripts/secret-scan.mjs --mode worktree,commits,blobs --report tmp/security/secret-scan.json
node scripts/secret-scan.mjs --list-allowlists          # что подавляется и почему
```

Ожидаемо: `ЧИСТО — находок нет`, `findings_count: 0`, `suppressed_count` — только подтверждённые
фикстуры (7 на 0.10.2), каждая с описанием в `.gitleaks.toml`. Просканировано: рабочее дерево +
вся история (`commits`: добавленные строки; `blobs`: уникальные объекты).
Репозиторий зеркалируется на GitHub — **история считается публичной**.
Находка → проверить, реальный ли это секрет: реальный — ротация и блокировка релиза (см. `SECURITY.md`),
ложный — точечная запись в `.gitleaks.toml` (`path` + конкретный маркер, не файл целиком).

## 2. Негативная матрица авторизации сессий

```bash
grep -n "IDOR" packages/backend/src/routes/sessions-access.test.ts packages/backend/src/routes/*idor*.test.ts
pnpm --filter @itphx/synth-backend exec vitest run src/routes/sessions-access.test.ts
```

Ожидаемо: файлы матрицы на месте, `Tests N passed`, N ≥ `policy.authMatrix.minTests` (8).
Проверяемый инвариант: **чужой `USER` не читает и не меняет чужую сессию** (отказ), владелец /
`ADMIN` / `LEAD` — доступ, посторонний — отказ. Код отказа (403/404) сверяйте с текущей политикой
видимости — важно, что отказано, а не конкретная цифра.

Дополнительно, если дифф релиза трогает авторизацию:

```bash
pnpm --filter @itphx/synth-backend exec vitest run src/auth/guards.test.ts src/routes/fs-auth.integration.test.ts
git diff --stat <prev-tag>..HEAD -- 'packages/*/src/**/auth*' 'packages/*/src/**/permission*' 'packages/*/src/server/**'
```

Помните про главный принцип роли: **инвариант, а не список**. Если проверка живёт в хендлере, а не
на границе (prefix-middleware/guard/единый хелпер) — это находка, даже если сегодня она корректна.

## 3. Обзор изменений релиза (человеческий класс-обзор)

```bash
git log --oneline <prev-tag>..HEAD | head -50
git diff --stat <prev-tag>..HEAD -- packages/*/src
git diff <prev-tag>..HEAD -- .gitverse/ docker/ charts/ '**/Dockerfile*'
```

Пройти 7 вопросов и записать ответы в `checks.security-review.result`:

| # | Класс / вопрос | На что смотреть |
|---|----------------|-----------------|
| 1 | Новые внешние входы | события `POST /api/v2/events`, webhooks, MCP-серверы, шлюзы, schedules |
| 2 | Авторизация / IDOR | `requireAuth`/`requirePermission`/`requireScope`, видимость сессий и проектов (`session-visibility.ts`), service-key `allowedProjects`, binding-key |
| 3 | Containment путей | file/shell/git-тулы, FS-роуты, `repo_path`, protected-paths; лексических `startsWith` мало (симлинки) |
| 4 | SSRF / egress | webhooks (`network.ts`), web-инструменты, MCP-клиент, LLM-провайдеры, приватные диапазоны/IPv4-mapped IPv6/редиректы |
| 5 | Секреты и ключи | at-rest шифрование (мастер-ключ), логи без секретов, `secrets/` вне git, ротация (ADR-076) |
| 6 | Supply-chain и артефакты | `pnpm audit` (п.4), в образы не попадают `secrets/`/`.env`/dev-ключи, теги без `latest` |
| 7 | Доки vs факт | утверждения об аудите/секретах соответствуют пайплайну (обещание скана, которого нет, — находка) |

## 4. Уязвимости зависимостей (ратчет)

```bash
pnpm install --frozen-lockfile
pnpm audit --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).metadata.vulnerabilities))'
```

Ожидаемо для активного профиля ратчета (`post-upgrade`, с 2026-10-15): `critical 0`, `high 39`,
прямых уязвимых модулей 0. Канонические пороги — `policy.dependencies.profiles[policy.dependencies.profile].baseline`.
Новые critical/high → апгрейд до `patched_versions`, либо исключение в записи (`exceptions[]` с
`owner` и `dueRelease`), либо **блокировка релиза**.

```bash
pnpm audit --audit-level=high          # человекочитаемо; в ci.yaml — report-only
node scripts/security-gate.mjs --only dependencies --skip-tests   # ровно то, что проверяет гейт
```

Апгрейды `@modelcontextprotocol/sdk ≥ 1.31.0` (`1.32.1`) и `simple-git 4.x` (`4.0.2`) внесены 2026-10-15 —
профиль ратчета в `policy.json` переключён на `post-upgrade`, `baseline` уточнён фактом
(`critical 0`, `high 39`). Меняя пороги, правьте `policy.dependencies.profile`/`profiles` (историю
состояний оставляйте в `profiles`).

## 5. Baseline CI

```bash
# GitVerse: последний прогон ci.yaml на коммите релиза — все джобы success,
# кроме «Аудит зависимостей (report-only)» (её предмет — п.4)
```

Записать в `checks.ci-baseline.result` номер run'а и статус джоб. Красные джобы вне `report-only` →
блокировка (сначала фикс, потом тег).

## 6. Запись аудита (заполняет аудитор, вносит релиз-менеджер)

1. взять `docs/security/TEMPLATE.json` — или, если для версии есть образец
   `docs/security/releases/<version>.json.example` (машинные результаты уже вписаны),
   `cp docs/security/releases/<version>.json.example docs/security/releases/<version>.json` —
   и заполнить **все** проверки: `status` + `command` + `result` (+ `date`), включая `security-review`;
2. заполнить `exceptions[]` целиком (`id`, `scope`, `justification`, `followUp`, `owner`, `dueRelease`);
3. проверить локально:

```bash
node scripts/security-gate.mjs --version <version> --report tmp/security/evidence.json   # ожидаем exit 0
node scripts/security-gate.mjs --lint-records                                            # все записи валидны
```

Ожидаемо: `Итог: N pass, 0 fail — гейт ПРОЙДЕН` и `tmp/security/evidence.json` с отпечатками
(`record.sha256`, `policy_fingerprint`, `head`). После этого релиз-менеджер коммитит запись
**до тега**; CI-джоба `security-gate` перечитает её из дерева тега и прогонит проверки заново.

## 7. После публикации (пост-релиз)

- дописать `artifacts.ci_run` (номер run'а тега);
- сверить артефакты выката с записью (образы/теги без `latest`, чарт, npm-версия) — команды в
  `docs/PUBLISHING.md`;
- закрыть/перенести исключения по их `dueRelease`; перенос — правкой записи отдельным коммитом
  с причиной.

## Чего аудитор НЕ делает

- не применяет изменения (тег, публикация, реестры, `helm upgrade` — релиз-менеджер);
- не создаёт и не правит файлы, не коммитит (роль read-only: `edit: deny`, `write: deny`);
- не подменяет `@tester`: регрессии — тестировщик, классы уязвимостей и релизный гейт — аудитор;
- не ставит `PASS` без команды и вывода и не подгоняет ожидание под факт;
- не ослабляет гейт под результат: `minTests`, `baseline`, список файлов матрицы, секрет-правила —
  только явным изменением политики с обоснованием.
