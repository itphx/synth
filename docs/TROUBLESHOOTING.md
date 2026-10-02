# Диагностика и решение проблем

> [!NOTE]
> Пользовательская диагностика — в портале документации:
> https://docs.synth.itphx.ru/help/troubleshooting/. Здесь остаются инженерные
> проблемы: публикация, CI, `dev.sh`, WS-фикс.

Проверенные симптомы, причины и решения из реального опыта. Если ваша проблема здесь не описана — проверьте логи (`tmp/*.log`) и откройте задачу.

## 1. GitVerse npm: 403 «no permission» при публикации `@itphx/synth`

**Симптом:** публикация `@itphx/synth` в `https://gitverse.ru/api/packages/itphx/npm/` завершается ошибкой 403 «no permission», при этом остальные 5 пакетов публикуются нормально.

**Причина:** поле `repository` в `packages/synth/package.json` (`{"type": "git", "url": "https://gitverse.ru/itphx/synth"}`). GitVerse при привязке пакета к репозиторию по `repository.url` проверяет права и отдаёт 403.

**Решение:** удалить поле `repository` из `package.json` (как у остальных пакетов). Проверка: публикация с `repository` → 403, без `repository` → 200.

## 2. npm unpublish: 403 «Granular access tokens that bypass two-factor authentication may not perform this action»

**Симптом:** попытка удалить опубликованную версию через `npm unpublish` отклоняется с 403.

**Причина:** политика npm 2026 — токены GAT с `bypass 2FA` больше не могут выполнять unpublish (см. [changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).

**Решение:** вместо удаления использовать deprecate — потребители увидят предупреждение при установке:

```bash
npm deprecate @itphx/synth@<version> "Используйте более новую версию"
```

## 3. Docker registry `registry.gitverse.ru` не резолвится

**Симптом:** `docker pull registry.gitverse.ru/...` / `docker push registry.gitverse.ru/...` падает с ошибкой резолвинга.

**Причина:** правильный адрес реестра — **`gitverse.ru`** (без префикса `registry.`). Устаревший дефолт `registry.gitverse.ru` исправлен в `publish.sh`/`build.sh` (`GITVERSE_DOCKER_REGISTRY`).

**Решение:** использовать `gitverse.ru/itphx/synth:<version>`.

## 4. `dev.sh` не выживает в фоне/CI (убивает потомков)

**Симптом:** `./scripts/dev.sh` запущенный из bash-инструмента/CI-скрипта завершается сразу или убивает дочерние процессы; `trap cleanup` срабатывает неожиданно.

**Причина:** `dev.sh` привязан к управляющему терминалу и при выходе родительской сессии завершает группу процессов (`kill -TERM -$pgid`). Для фонового запуска это не предназначенный режим.

**Решение:** запускать сервисы напрямую пакетными командами через `setsid`:

```bash
setsid pnpm --filter @itphx/synth-backend dev > tmp/backend.log 2>&1 &
setsid pnpm --filter @itphx/synth-ui dev > tmp/ui.log 2>&1 &
```

## 5. WS `/ws/events` не получает события после cookie-входа (standalone) — известное ограничение

**Симптом:** в standalone-режиме (`synth serve`) WebSocket `/ws/events` не подключается или не отдаёт события после входа через UI (cookie `synth_session`).

**Причина:** обработчик upgrade в `packages/core/src/server/app.ts` (метод `server.on('upgrade')`, проверка `Authorization`-заголовка перед подключением `/ws/events`) принимает только `Authorization: Bearer <api-key>` и не читает cookie `synth_session` (в отличие от HTTP-маршрутов, где cookie читается). Это **известное ограничение** текущей реализации, а не поломка.

**Решение:** использовать API-ключ в заголовке для WS-подключения, либо дождаться фикса в новой версии.

## 6. 403 «Permission denied» для защищённых путей

**Симптом:** агент не может прочитать/изменить файл, доступ к которому должен быть разрешён; в ответе `Permission denied` с текстом из системного контекстного файла.

**Причина:** работает защита защищённых путей (security, AD-037): системный список `definitions/protected-paths.json` + override-политика. По умолчанию защита включена (`security.protectedPaths.enabled: true`). Проверка идёт для всех файловых тулов и shell-команд; жёсткий deny выше `permission.rules`.

**Решение:** настроить политику защищённых путей:

- **Через API** (если доступен): `GET/PUT/DELETE /api/v2/settings/protected-paths` — override формата `{version: 1, add: [...], remove: [...]}`
- **Файлом:** `{dataDir}/security/protected-paths.json` (формат add/remove, version: 1)
- **Отключить защиту:** тумблер `security.protectedPaths.enabled` в секции «Безопасность» UI или `false` в `config.yaml`

## Где смотреть логи

| Сервис | Лог |
|--------|-----|
| backend | `tmp/backend.log` |
| UI | `tmp/ui.log` |
| core standalone | `tmp/core.log` |
| аудит LLM Gateway | `{dataDir}/audit/llm-gateway.jsonl` |
