# План дальнейших работ

## Этап 5: Проверка обновлений (`synth update`)

Модуль проверки обновлений из npm — чтобы запущенный экземпляр Synth мог узнать о новой версии и обновиться.

### 5.1 Модуль `update-checker.ts` в `@synth/core`

```typescript
// packages/core/src/update-checker.ts
interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  checkedAt: string;
}
```

- HTTP-запрос к `https://registry.npmjs.org/@itphx/synth/latest`
- Кэш результата в `$SYNTH_DATA_DIR/update-check.json` (TTL 6 часов)
- Эндпоинт `GET /api/v2/updates/check` — возвращает `UpdateInfo`
- Эндпоинт `POST /api/v2/updates/apply` — запускает `npm install -g @itphx/synth@latest`, стримит прогресс через SSE

### 5.2 CLI-команда `synth update`

```bash
synth update              # проверить обновления
synth update --apply      # установить с подтверждением
synth update --apply -y   # установить без подтверждения
```

- Проверка через `checkForUpdates()`
- Вывод текущей и новой версии
- `child_process.spawn('npm', ['install', '-g', '@itphx/synth@latest'])` с наследованием stdio
- Предложение перезапустить `synth serve`

### 5.3 Уведомление в CLI при запуске

При старте `synth serve` / `synth chat` — асинхронная проверка:
```
⚠ Доступна новая версия 0.2.0 (текущая: 0.1.2). Выполните `synth update --apply`.
```

### 5.4 UI-компонент `UpdateNotification`

- Баннер/тост в SPA: «Доступна версия vX.Y.Z. Обновить?»
- Запрос к `/api/v2/updates/check` при загрузке UI
- Кнопка «Установить» → вызов `/api/v2/updates/apply` с индикатором прогресса

## Этап 6: Интеграция с GitVerse MCP для агентов Synth

### 6.1 MCP-конфигурация gitverse в Synth

Добавить `gitverse` MCP-сервер в стандартный набор инструментов агентов через `config.yaml`:

```yaml
mcp:
  servers:
    gitverse:
      type: http
      url: https://mcp.gitverse.ru
      headers:
        Authorization: "Bearer ${GV_TOKEN}"
```

Токен — из env var `GV_TOKEN` или конфигурации.

### 6.2 Действия агентов через GitVerse MCP

После подключения агентам станут доступны 37 инструментов:
- Создание PR, работа с файлами, управление релизами
- Запуск CI/CD, просмотр логов
- Чтение содержимого репозиториев

## Этап 7: Автоматический CHANGELOG

### 7.1 Генерация при релизе

- Скрипт `scripts/changelog.sh` уже создан, работает в dry-run
- Нужно добавить коммит CHANGELOG.md в репозиторий при реальном релизе
- Формат: группировка по feat/fix/refactor/docs/chore

## Этап 8: Self-update в Docker

- Docker-образ может сам обновиться через `docker pull`
- Или пересоздать контейнер через docker-compose
- Мониторинг новых образов в `registry.gitverse.ru/itphx/synth`
