# PROP-064: Встроенные в UI браузер и терминал

> **Статус:** 🧩 Предложение — Встроенные в UI браузер и терминал (PTY/WS, webview/iframe) с синхронизацией с агентом
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D19, «Встроенные в UI браузер и терминал»;
> идея пользователя 2026-09-16 + `Фичи.md` (Terminal)); состояние проверено по `packages/ui/` и `packages/core/`.
> **Связано:** [ADR-019](./adr-019-react-spa.md), [ADR-024](./adr-024-eventhub-transport.md),
> [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md), [ADR-029](./adr-029-granular-permissions.md),
> [ADR-036](./adr-036-llm-gateway.md), [PROP-047](./prop-047-memory-gbrain.md), [ADR-099](./adr-099-egress-tls-trust.md).

**Решение:** добавить в UI две встроенные панели, синхронизированные с агентом и проектом:

- **Терминал** — интерактивная shell-сессия, привязанная к проекту/сессии. Мост PTY ↔ UI через
  существующий WS-транспорт ([ADR-024](./adr-024-eventhub-transport.md)); рендер — терминальный
  эмулятор в браузере.
- **Браузер** — встроенный webview/iframe для просмотра страниц и документации, доступный **и
  человеку, и агенту** (агент может открыть страницу/вкладку, человек — увидеть результат).
- **Синхронизация с агентом**: агент открывает терминал/страницу, стримит вывод; действия агента
  видны в панели (и наоборот — общая сессия).

## Контекст

### Что уже есть

- **Терминала и браузера в UI нет.** Есть только иконки/метаданные:
  - `packages/ui/src/lib/projectMeta.ts:16` — ключ иконки `terminal: { icon: 'terminal-box', label: 'Terminal' }`;
  - `packages/ui/src/lib/toolIcons.ts:12,39` — `execute_shell: 'terminal-box'`, подпись `execute_shell: 'Shell'`.
- Терминальных эмуляторов/PTY-библиотек нет: `xterm`/`node-pty`/`ghostty`/`webview` в `packages/`
  не используются (единственное совпадение — комментарий про VS Code `webview` в
  `packages/ui/src/lib/typography.ts:33`, не относится к теме).
- Агент работает **вне UI**: shell — тулом `execute_shell` (`packages/core/src/engine/tools/shell.ts`,
  capability `shell`), веб — `web_fetch`/`web_search` (`packages/core/src/engine/tools/web.ts`).
- Правый панель-таб-контейнер есть (`packages/ui/src/components/panels/RightPanel.tsx`); в нём,
  например, вкладка `scheduler` — заглушка «в разработке». Это удобная точка для новых панелей.
- Мобильный адаптив и дроверы — [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md).
- Безопасность shell/веба — permissions [ADR-029](./adr-029-granular-permissions.md), guard/обфускация
  [ADR-036](./adr-036-llm-gateway.md), `engine/security/shell-guard.ts`, `protected-paths.ts`.

### Чего нет

- Панели терминала (PTY + эмулятор) — нет.
- Панели браузера (webview/iframe/прокси) — нет.
- Общей сессии «агент ↔ человек» в терминале/браузере — нет.

## Детали

### 1. Терминал

- **PTY-мост.** Решить, где поднимается PTY: на сервере (core, рядом с `execute_shell` и
  `project.workspace`, [ADR-075](./adr-075-project-workspace-provisioning.md)) или локально у клиента.
  Серверный вариант даёт единый shell-контекст с агентом; локальный — изоляцию и меньше рисков.
- **Транспорт.** Использовать существующий канал `EventHub`/`TransportClient` `/ws/events`
  ([ADR-024](./adr-024-eventhub-transport.md)) — новых каналов не плодить (инвариант №6). Поток вывода —
  потоковые события; ввод — сообщения клиента.
- **Эмулятор.** Выбор фронтенд-библиотеки (xterm.js-совместимая) — **новая зависимость**, требует
  согласования с пользователем (инвариант №13).
- **Безопасность.** Кто и что видит в терминале; гейтинг правами [ADR-029](./adr-029-granular-permissions.md)
  и режимами `plan`/`act`/`yolo`; не дублирует и не обходит `execute_shell`. Отдельно: каталог
  терминала — `project.workspace`, containment.

### 2. Браузер

- **Варианты реализации:** webview (Tauri/Electron — сейчас UI — браузерный SPA,
  [ADR-019](./adr-019-react-spa.md)), `iframe`, либо **серверный прокси** (страница тянется сервером,
  при необходимости с обезличиванием; согласуется с сетевым слоем
  [ADR-099](./adr-099-egress-tls-trust.md) и guard'ом [ADR-036](./adr-036-llm-gateway.md)).
- Для SPA-сборки без нативного хоста `iframe` ограничен `X-Frame-Options`/CSP многих сайтов →
  реалистичен серверный прокси.
- **Синхронизация с агентом**: агент открывает страницу/вкладку (например, документацию из памяти
  [PROP-047](./prop-047-memory-gbrain.md) или результат `web_fetch`), человек видит её в панели.

### 3. Синхронизация и общее состояние

- Панели — часть `project`/`session`-контекста (вкладки, состояние открытия).
- Возможен общий «браузер-контекст»: агент и человек видят один и тот же URL/вывод.

## Статус реализации в коде

**Не реализовано, кода нет.** Проверено по репозиторию (`packages/**`, без `dist/`/`node_modules/`):

- Компонентов/панелей терминала и браузера в `packages/ui/src` нет (поиск `Terminal`, `Browser`,
  `xterm`, `node-pty`, `ghostty`, `webview`, `iframe`).
- Есть только иконка/метаданные `terminal` (`projectMeta.ts:16`) и маппинг `execute_shell`
  (`toolIcons.ts:12`).
- Агентский shell и веб — вне UI: `execute_shell`, `web_fetch`, `web_search`
  (`packages/core/src/engine/tools/`).
- Транспорт для стриминга есть ([ADR-024](./adr-024-eventhub-transport.md)), но потоковых
  терминальных/браузерных событий нет.
- Мёртвый терминальный слой архива форка (`archive/synth-frontend/**`, ghostty-web) не переносится
  ([ADR-019](./adr-019-react-spa.md)).

## Открытые вопросы

- PTY на сервере (core) или локально у клиента?
- Безопасность shell в UI: кто и что видит, как гейтится правами?
- webview (Tauri/Electron) vs `iframe` vs серверный прокси?
- Как согласуется с `execute_shell`/`web_fetch` — один движок или разные?
- Терминальные/браузерные события — расширение существующих событий или новые типы в `EventHub`?
- Нужен ли браузерный прокси со стриппингом/обезличиванием ([ADR-036](./adr-036-llm-gateway.md),
  [ADR-099](./adr-099-egress-tls-trust.md))?
- Какие фронтенд-зависимости добавляем (xterm.js и т. п.) — согласовать.
- Поведение на телефоне/планшете ([ADR-044](./adr-044-mobile-adaptive-ui-pwa.md)): терминал на мягкой
  клавиатуре, браузер в дровере?

## Связи

- [ADR-019](./adr-019-react-spa.md) «React 19 SPA» — архитектура UI, вкладки/панели.
- [ADR-024](./adr-024-eventhub-transport.md) «EventHub + TransportClient» — единый транспорт, стриминг
  вывода/событий (новых каналов не плодить).
- [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) «Мобильный UI + PWA» — адаптив панелей, дроверы,
  touch-first.
- [ADR-029](./adr-029-granular-permissions.md) «Гранулярные permissions» — гейтинг терминала/браузера.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — guard/обфускация, безопасность shell/веба.
- [PROP-047](./prop-047-memory-gbrain.md) «Память Synth» — «открыть в браузере» для памяти/документации.
- [PROP-065](./prop-065-ui-docs-plan-todo.md) «Просмотр документации, планов и ToDo в UI» — соседний
  UI-viewer; браузер и docs-viewer пересекаются по рендеру документов.
- [ADR-099](./adr-099-egress-tls-trust.md) «Единый egress-слой» — общий сетевой egress для браузерного
  прокси.
- [ADR-075](./adr-075-project-workspace-provisioning.md) «Окружение проекта» — каталог терминала
  (`project.workspace`).
- [packages/ui/AGENTS.md](../../packages/ui/AGENTS.md) — UI-конвенции и панели.
