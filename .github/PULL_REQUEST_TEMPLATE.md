# Pull Request

## What changed / Что изменено

<!-- Describe the change. Опишите изменение: что и зачем. -->

## How it was verified / Как проверено

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] If docs/ADR were touched: `pnpm adr:check && node scripts/docs-link-check.mjs`

<!-- Add manual/dev verification notes. Добавьте заметки о ручной проверке. -->

## Checklist / Чек-лист

- [ ] Affected docs / ADR updated / Затронутые доки и ADR обновлены
- [ ] Commits are signed off (`git commit -s`, DCO) / Коммиты подписаны (`-s`, DCO)
- [ ] No secrets committed / Секреты не добавлены

<!--
RU (кратко): PR рассматривается мейнтейнером и переносится (cherry-pick) в основной
репозиторий GitVerse. Каждый коммит должен быть подписан `-s` (DCO).
См. CONTRIBUTING.md и CONTRIBUTING.ru.md. Проблемы безопасности — не здесь, см. SECURITY.md.
-->
