# AD-087: Gateway для подключения к мессенджерам (поглощён AD-086)

> **Статус:** ⛔ Поглощён
> **Дата:** 2026-10-01
> **Поглощён:** 2026-10-08 → [AD-086](./ad-086-extensibility-plugins-editions.md) «Расширяемость Synth: плагины,
> editions, вклад в mainline и внешние сервисы-надстройки».
> **Связано:** [AD-089](./ad-089-external-events-automation.md), [AD-030](./ad-030-hooks-agent-events.md),
> [AD-052](./ad-052-public-api-platform.md), [AD-076](./ad-076-git-repo-registry-ssh.md).

**Решение:** тема «Gateway для подключения к мессенджерам» **перенесена в [AD-086](./ad-086-extensibility-plugins-editions.md)**.
Общий шаблон внешних add-on сервисов шире, чем один gateway, поэтому gateway оформляется как его **первый частный
случай** (Telegram). Этот файл оставлен как указатель (tombstone), чтобы прежние ссылки не терялись.

## Что унаследовано в AD-086 / AD-089

| Из gateway-черновика | Куда перешло |
|---|---|
| Адаптеры-коннекторы с общим интерфейсом (`send`/`receive`/`edit`/`attach`) | [AD-086](./ad-086-extensibility-plugins-editions.md), раздел «Внешние сервисы-надстройки» + Telegram gateway |
| Binding «чат/тред ↔ сессия/проект» | [AD-089](./ad-089-external-events-automation.md), сущность `Binding` (режимы `bound`/`ephemeral`/`queue`) |
| Транспорт webhook и/или long-polling | [AD-086](./ad-086-extensibility-plugins-editions.md) (первый случай) + [AD-089](./ad-089-external-events-automation.md) (приём событий) |
| Маппинг идентичности (пользователь мессенджера → профиль/RBAC) | [AD-089](./ad-089-external-events-automation.md), поле `identity` у `Event` |
| Дедуп / идемпотентность | [AD-089](./ad-089-external-events-automation.md), `dedupKey` |
| Вложения | [AD-085](./ad-085-multimodal-input.md) (по ссылке из `Event`) |
| Секреты ботов at-rest | [AD-076](./ad-076-git-repo-registry-ssh.md) (мастер-ключ) |

## Связи

- [AD-086](./ad-086-extensibility-plugins-editions.md) — принимающий AD: общий шаблон add-on'ов и Telegram gateway.
- [AD-089](./ad-089-external-events-automation.md) — Event/Binding/Router: как события мессенджера превращаются в работу сессии.
- [AD-030](./ad-030-hooks-agent-events.md) — hook-шина и Plugin SDK как фундамент событийной обработки.
- [AD-052](./ad-052-public-api-platform.md) — приём webhook'ов на публичном API.
- [AD-076](./ad-076-git-repo-registry-ssh.md) — хранение секретов ботов at-rest.
