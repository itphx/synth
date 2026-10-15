# Внутренний аудит безопасности перед релизом

Обязательный шаг релиза: `release.yaml` → джоба **«Внутренний аудит безопасности»**
(`scripts/security-gate.mjs`), без её успеха сборка артефактов не запускается
(`build.needs: [lint-and-test, security-gate]`, а `changelog`/`publish-*`/`create-release`/
`publish-github` зависят от `build`).

**Исключений нет**: запись аудита для релизуемой версии обязательна и должна быть содержательной
(каждая проверка — со `command` и `result`). Bootstrap-порогов и waiver-статусов у проверок в
политике нет; осознанно принятые уязвимости/риски фиксируются в `exceptions[]` записи
(`owner` + `dueRelease`), но это не отменяет выполнения самих проверок.

Разделение ответственности:

| Слой | Кто | Что |
|------|-----|-----|
| Машинные проверки | CI (гейт) | secret-scan по дереву и истории, негативная матрица авторизации сессий, ратчет уязвимостей зависимостей, наличие и валидность записи аудита |
| Классы уязвимостей | роль **AUDITOR** (read-only, `edit/write: deny`) | authz/IDOR, containment путей и симлинки, SSRF/egress, секреты, инъекции, supply-chain, публичный контракт — по `AUDIT-CHECKLIST.md`, формат «команда → вывод» |
| Запись и коммит | релиз-менеджер | аудитор формирует содержание записи; файл вносится в ветку релиза до тега (роль read-only сама не пишет) |
| Решение о выкате | пользователь/релиз-менеджер | тег и запуск публикации; аудитор ничего не применяет |

## Артефакты

| Файл | Назначение |
|------|------------|
| `policy.json` | политика гейта: обязательные проверки, команды, пороги, переключатель ратчета, список кандидатов матрицы |
| `releases/<version>.json` | запись аудита релиза (**схема ниже**) |
| `releases/<version>.json.example` | заполняемый образец записи (машинные результаты уже вписаны; расширение `.example` — чтобы незаполненная запись не лежала в `releases/` как «почти готовая» и не красила docs-CI) |
| `TEMPLATE.json` | пустая запись с нуля |
| `AUDIT-CHECKLIST.md` | чек-лист роли-аудитора: «команда → результат» |

## Порядок релиза (важно)

```text
1. прогнать аудит      → node scripts/security-gate.mjs --version <ver> --skip-tests   (быстрые проверки)
                        + node scripts/security-gate.mjs --version <ver> --report tmp/security/evidence.json (полный, с vitest и pnpm audit)
2. записать результат  → docs/security/releases/<ver>.json (каждая проверка: status + command + result)
3. закоммитить         → «docs(security): запись аудита <ver>» в ветку релиза (master)
4. поставить тег       → v<ver>; CI-джоба security-gate перечитает запись из дерева тега и прогонит проверки заново
```

Запись должна быть **до тега**: гейт читает её из чекаута тега, а не «догоняет» после релиза.

**Первый релиз с гейтом (0.10.2) оформляется настоящей записью** — исключений для него нет:

```bash
# 1) взять образец с уже вписанными машинными результатами
cp docs/security/releases/0.10.2.json.example docs/security/releases/0.10.2.json
# 2) дозаполнить: checks.security-review (обзор диффа релиза), auditor.name, owner'ов исключений, ci_run
#    (плейсхолдеры <…> гейт печатает предупреждением, но пустые status/command/result — блокируют)
# 3) прогнать и закоммитить
node scripts/security-gate.mjs --version 0.10.2 --report tmp/security/evidence.json   # ожидаем exit 0
git add docs/security/releases/0.10.2.json && git commit -m "docs(security): запись аудита 0.10.2"
# 4) только теперь тег
git tag -a v0.10.2 -m "Release v0.10.2" && git push --follow-tags
```

До заполнения `security-review` гейт блокирует релиз — это и есть требуемый порядок
«прогнать аудит → записать результат → закоммитить → поставить тег».

## Схема записи аудита (`docs/security/releases/<version>.json`)

```jsonc
{
  "schema": "synth.security.audit/v1",
  "version": "0.10.2",              // обязательно: совпадает с тегом v<version>
  "commit": "abcdef1234…",           // sha коммита, на котором проводился аудит; гейт проверяет, что он предок релиза
  "date": "2026-10-16",              // дата аудита
  "auditor": { "name": "…", "role": "AUDITOR", "mode": "read-only" },  // role: ADMIN | LEAD | AUDITOR
  "status": "approved",              // approved | approved_with_exceptions | blocked
  "summary": "…",                    // что проверено, что нет и почему (для читателя через год)
  "checks": {                        // все requiredCheckIds из policy.json
    "secret-scan":  { "status": "pass", "command": "…", "result": "…", "date": "…" },
    "auth-matrix":  { "status": "pass", "command": "…", "result": "…", "date": "…" },
    "ci-baseline":  { "status": "pass", "command": "…", "result": "…", "date": "…" },
    "dependencies": { "status": "pass_with_exceptions", "command": "pnpm audit --json", "result": "…", "date": "…" },
    "security-review": { "status": "pass", "command": "docs/security/AUDIT-CHECKLIST.md §3", "result": "…", "date": "…" }
  },
  "exceptions": [                    // известные исключения (принятые уязвимости/риски) с обязательным follow-up
    { "id": "GHSA-…", "scope": "…", "justification": "…", "followUp": "…", "owner": "…", "dueRelease": "0.11.0" }
  ],
  "artifacts": { "evidence": "tmp/security/evidence.json", "ci_run": "…" }
}
```

Правила, которые проверяет гейт (машинно):

1. `schema`, `version` (строго равна релизу), `date` (ISO), `auditor.name` и `auditor.role`
   (`ADMIN`/`LEAD`/`AUDITOR`), `commit` (7–40 hex и **предок** релизуемого коммита).
2. `status`: `blocked` — блокирует; `approved_with_exceptions` требует непустой `exceptions[]`.
3. Каждая проверка из `requiredCheckIds` присутствует, имеет статус
   `pass` | `pass_with_exceptions` **и заполненные `command` + `result`** (пустые — ошибка:
   проверка без команды и наблюдаемого результата не считается выполненной).
4. Каждое исключение заполнено целиком: `id`, `scope`, `justification`, `followUp`, `owner`, `dueRelease`.
5. Плейсхолдеры вида `<…>` не блокируют, но печатаются предупреждением — личность аудитора и номер
   run'а машинно проверить нельзя (это осознанный процесс-контроль, см. «Остаточные риски»).

Записи для версий до внедрения гейта не создаются: аудит задним числом — фикция, а не аудит.

## Уязвимости зависимостей: два состояния ратчета

Гейт не требует «ноль уязвимостей» — он не даёт незаметно ухудшиться состоянию:

| Профиль (`policy.dependencies.profile`) | Пороги | Когда действует |
|---|---|---|
| `pre-upgrade` (историческое) | `critical ≤ 3`, `high ≤ 42`, `failOnDirect: true` | до апгрейдов `@modelcontextprotocol/sdk ≥ 1.31.0` и `simple-git 4.x`; профиль не активен |
| `post-upgrade` (**сейчас**, с 2026-10-15) | `critical 0`, `high 39`, `failOnDirect: true` | после апгрейдов `@modelcontextprotocol/sdk 1.29.0 → 1.32.1`, `simple-git 3.36.0 → 4.0.2` (+ транзитивный `proxy-addr 2.0.7 → 2.0.8`). Пороги — факт по `pnpm audit --json` (critical 0, high 39, moderate 48, low 12, прямых 0): сняты 3 critical (proxy-addr, simple-git, @simple-git/argv-parser) и 3 high (сам sdk + два simple-git), остаток high — транзитивные патч-уровня |

Переключатель — `policy.dependencies.profile` (поле `profileSwitch` описывает, **кто** и **когда**
его двигает). Ослабление/усиление ратчета видно в диффе и не может быть сделано незаметно.
`pnpm audit` в `ci.yaml` остаётся **report-only** (второй шаг — видимая дельта к baseline);
блокирует только релизный гейт.

## Локальный прогон (до тега)

```bash
# быстрые проверки (policy/record/secret-scan/ratchet)
node scripts/security-gate.mjs --version 0.10.2 --skip-tests

# полный гейт как в CI (нужны pnpm/node_modules): + негативная матрица через vitest
node scripts/security-gate.mjs --version 0.10.2 --report tmp/security/evidence.json

# локально, когда версия ещё не выбиралась тегом (в CI этот флаг не используется)
node scripts/security-gate.mjs --from-package --skip-tests

# только secret-scan / записи
node scripts/secret-scan.mjs --mode worktree,commits,blobs
node scripts/security-gate.mjs --lint-records
```

Версия определяется **fail-closed**: `--version` (в CI — вывод `version-bump` при `workflow_dispatch`)
→ `--ref refs/tags/vX.Y.Z` (в CI — `${{ gitverse.ref }}` при push тега) → `--from-package` (только
локально). Если версии нет или ref не тег — `exit 2`: релиз с неопределённой версией не собирается
(тихого фоллбэка на `packages/synth/package.json` нет намеренно — в CI он проверил бы не ту версию).

## Остаточные риски (осознанные)

* **Личность аудитора** машинно не подтверждается: в CI нет понятия «кто именно», поэтому запись
  заполняется человеком, а факт роли — процесс-контроль (роль AUDITOR read-only).
* **Ревью диффа** (`security-review`) не автоматизируется: чек-лист делает его воспроизводимым,
  но не машино-проверяемым; пустой `result` этой проверки — блокировка релиза.
* **Подмена записи**: запись — обычный файл в репозитории; защита процессная (ревью в PR/master),
  не техническая. Усиление — подписи коммитов/внешнее хранение (PROP-037, PROP-094).
* **Ратчет зависимостей** зависит от состояния advisory-базы: новая публичная уязвимость в уже
  зафиксированной версии транзитивной зависимости сдвинет счётчик и заблокирует релиз до апгрейда
  или явного исключения. Это цель политики; ослабление — только правкой `baseline` в `policy.json`.
  Дрейф базы наблюдался прямо в ходе подготовки (moderate/low 13 → 12 за один сеанс), поэтому ратчет
  опирается только на `critical`/`high`, а `moderate`/`low` в записи — информационные.
* **`tmp/` не сканируется** (гитигнор, в истории этого репозитория путей `tmp/**` нет — проверено).
  Секрет, положенный в `tmp/`, в git не попадёт и в CI-скан не входит; если практика изменится
  (появятся коммиты в `tmp/`), исключение из `secret-scan.mjs` надо пересмотреть.
