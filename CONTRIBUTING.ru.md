# Как участвовать в Synth

Спасибо за интерес к Synth! Разработка ведётся открыто на
[GitVerse](https://gitverse.ru/itphx/synth); [GitHub](https://github.com/itphx/synth) —
публичное зеркало (см. [Пул-реквесты](#пул-реквесты-и-dco) ниже).

Участвуя, вы соглашаетесь с нашим [Кодексом поведения](./CODE_OF_CONDUCT.md).
О проблемах безопасности **не** открывайте публичный issue — см. [SECURITY.md](./SECURITY.md).

> English version: [CONTRIBUTING.md](./CONTRIBUTING.md).

## Требования

- **Node.js 22+**
- **pnpm 11+** (`corepack enable` или `npm install -g pnpm@latest`)
- Git

## Первый запуск

```bash
git clone https://gitverse.ru/itphx/synth synth
cd synth
pnpm install
./scripts/dev.sh        # backend :5000 + UI :5002
```

Полное описание dev-окружения и скриптов — в [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Проверки перед PR

Каждое изменение должно проходить из корня репозитория:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Для правок документации и архитектурных решений дополнительно:

```bash
pnpm adr:check                       # индекс и целостность ADR/PROP
node scripts/docs-link-check.mjs     # относительные ссылки в docs/ и README/AGENTS
```

Не отключайте и не переписывайте тесты, чтобы они «позеленели». Если тест неправильный —
объясните в PR, почему.

## Именование ветвей

- `feat/*` — новая функциональность
- `fix/*` — исправление ошибок
- `refactor/*` — перестройка без изменения поведения
- `docs/*` — только документация
- `chore/*` — инструменты, CI, зависимости

## Сообщения коммитов

[Conventional Commits](https://www.conventionalcommits.org/) с **описанием на
русском** (рабочий язык проекта):

```text
feat: добавлен эндпоинт списка провайдеров
fix: исправлена обработка пустых сессий
refactor: упрощён ChatOrchestrator
docs: обновлён AGENTS.md
test: добавлены тесты для SessionStore
```

При необходимости указывайте область: `fix(storage): …`.

## Стиль кода

- TypeScript strict; файлы — `kebab-case.ts` (`session-manager.ts`).
- Классы/интерфейсы `PascalCase`, функции `camelCase`, константы `UPPER_SNAKE_CASE`.
- Порядок импортов: Node builtins → внешние пакеты → `@itphx/synth-shared` → локальные модули.
- Форматирование задаётся Prettier и ESLint — прогоняйте их перед коммитом.
- Соблюдайте архитектурные соглашения из [`AGENTS.md`](./AGENTS.md) (корневой) и
  пакетных `packages/<pkg>/AGENTS.md`.

## Архитектурные решения (ADR / PROP)

Неочевидные, трудно обратимые или сквозные решения фиксируются как **ADR**
(принято) или **PROP** (предложение) в каталоге
[`docs/arch_decisions/`](./docs/arch_decisions/). Перед добавлением прочтите правила
в [docs/ARCH_DECISIONS.md](./docs/ARCH_DECISIONS.md). Если правка затрагивает
существующее решение — сосла́йтесь на него в описании PR.

## Пул-реквесты и DCO

- **PR на GitHub приветствуются.** Каноничная разработка ведётся на GitVerse,
  поэтому мейнтейнер рассматривает и **переносит** принятые изменения (cherry-pick)
  в основной репозиторий.
- Каждый коммит должен быть **подписан** (Developer Certificate of Origin, DCO):

  ```bash
  git commit -s -m "fix: …"
  ```

  Это добавляет трейлер `Signed-off-by: Имя <email>`, подтверждая, что вы имеете
  право передать изменение под лицензией проекта (MIT).

- Держите PR сфокусированными и небольшими; заполните шаблон пул-реквеста и опишите,
  как вы проверяли изменение.

## Секреты

Никогда не коммитьте секреты (токены, ключи, пароли). Секреты живут в `secrets/`, вне
git. В репозитории есть конфиг [`.gitleaks.toml`](./.gitleaks.toml), gitleaks
запускается в CI. Не вставляйте реальные учётные данные в коммиты, issue и
документацию — только плейсхолдеры.

## Лицензия

Участвуя, вы соглашаетесь, что ваш вклад распространяется под
[лицензией MIT](./LICENSE).
