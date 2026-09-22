# @itphx/synth-ui

Пакет `@itphx/synth-ui` — единый React 19 SPA (чат, панели, админка), собирается Vite и раздаётся статикой. Это **не библиотека**: `exports` отдаёт только `./package.json`, `files: ["dist"]`, а `@itphx/synth` резолвит `dist/` по npm-пути (`packages/synth/src/cli.ts:99`) — импортировать `@itphx/synth-ui/*` из кода нельзя. Общие инварианты, команды, стиль и мобильные конвенции — в корневом [`AGENTS.md`](../../AGENTS.md); здесь только локальные правила пакета.

## Место и точка входа

- Вход — `src/main.tsx`: `I18nProvider` → `ThemeSystemProvider` → `App` (порядок провайдеров важен).
- `initializeLocale()` и `initDeviceClasses()` вызываются до `createRoot` (`src/main.tsx:10-11`); `initDeviceClasses()` вешает классы `device-*`/`pointer-coarse` на `<html>`.
- `App.tsx` собирает каркас: `Sidebar`/`MobileDrawer` + `LeftPanel`/`CenterPanel`/`RightPanel`, глобальные `SettingsModal`, `LogsModal`, `ConfirmDialog`, `ToastContainer`, `PwaUpdatePrompt`.
- Алиас `@/` → `src/` (vite/tsconfig/vitest). Dev-прокси `/api`, `/ws`, `/auth`, `/admin` → backend (`vite.config.ts:27-32`), порт 5002, backend по умолчанию `VITE_BACKEND_URL`/`:5000` (`:6-7`).
- Роутера нет: экран определяется состоянием `useUIStore` (center-tabs + вкладки панелей), URL его не отражает — не вводить react-router и не кодировать экран в `pathname`.
- `DefaultsSync` (`App.tsx:38-82`) при инициализации авторизации подтягивает серверные preferences (`profileService`) и масштаб UI; локальные дефолты действуют только до загрузки пользователя.
- `ResizeObserver` в `App.tsx:97-118` вешает `html.central-narrow` при ширине центральной колонки < 800px; на этот класс реагирует CSS (`styles/index.css:290+`). Логику не дублировать в компонентах — читать класс/`centralNarrow` из стора.
- UI-строки/события/ошибки приходят с backend тем же контрактом, что у core/backend — не изобретать свои форматы.

## Карта src/

| Зона | Что там |
|---|---|
| `components/layout/` | Каркас и хром: `Sidebar`, `Header`, `CenterPanel`, `CenterTabs`, `MobileDrawer`, баннеры, `BackendConnection`, `AuthGate`-обвязка |
| `components/panels/` | Левые/правые панели и вкладки (`LeftPanel`, `RightPanel`, `*Tab`) |
| `components/chat/` | Чат: сообщения, стриминг, файловые вкладки, tool-рендер, саб-агенты |
| `components/settings/` + `components/admin/` | Настройки и админ-панели (провайдеры, модели, безопасность, routing) |
| `components/auth/` | `AuthGate`, логин (в т.ч. гибридный) |
| `components/ui/` | Примитивы: dialog, popover, select, tooltip, toggle, `SynthLogo` |
| `components/icon/` | `Icon` + реестр `icons.ts` — единственная точка иконок |
| `components/{tree,projects,logviewer}/` | Деревья, проекты, просмотр логов |
| `stores/` | Zustand-сторы (см. «Соглашения») |
| `lib/api/` | HTTP-слой (`synthApi`, `client`) и транспорт (`transport`) |
| `lib/i18n/` | Провайдер, стор, словари, резолвер ключей |
| `lib/` | Утилиты, устройство, масштаб UI, форматирование, темы |
| `hooks/`, `contexts/`, `styles/`, `types/` | Хуки, React-контексты, Tailwind + CSS-переменные, локальные типы |

Крупнейшая зона — `components/chat/`; её правки обычно тянут `stores/chatStore.ts` (≈800 строк), `transportStore` и i18n-резолвер.

## Точки расширения

**Новый center-tab = ровно 3 правки** (тип-система не даст забыть):
1. тип в `CenterTabType` (`stores/useUIStore.ts:28`) и при необходимости поля в `CenterTab.data` (`:30`);
2. иконка в `TAB_ICONS` (`components/layout/CenterTabs.tsx:25`);
3. `case` в `renderTabContent` (`components/layout/CenterPanel.tsx:35`).

**Новая вкладка панели**: `RIGHT_TABS` (`components/panels/RightPanel.tsx:14`) / `LEFT_TABS` (`components/panels/LeftPanel.tsx:30`). Role-gating — по образцу `secrets` (`RightPanel.tsx:31-34`): вкладка добавляется условно + эффект-нормализация, если активной стала недоступная. Схлопывание подписей в иконки при переполнении даёт `useAdaptiveIcons` (`LeftPanel.tsx:1700`, `RightPanel.tsx:47`) — он измеряет `span[data-tab-label]`, поэтому подпись вкладки оборачивать в этот маркер.

**Новая левая вкладка с тулбаром**: toolbar выбирается по `leftPanelTab` в `App.tsx:140-143` (`ProjectsTabToolbar`/`FilesTabToolbar`/`GitTabToolbar`) — добавить свой `case`, иначе шапка панели останется пустой.

**Новый раздел настроек**: элемент `CATEGORIES` (`components/settings/SettingsModal.tsx:35`) с `labelKey` + `icon`. Админ-раздел помечается `roles[]` (`:32`); по первому такому элементу рисуется граница (`adminBoundaryIndex`, `:70`). Ключ `labelKey` добавлять в **оба** словаря.

**Новый store**: `create<T>()(...)`, при необходимости `persist` (образец `stores/useUIStore.ts:130-131`). Пользовательские настройки — только через `persist`; runtime-флаги (дроверы, `centralNarrow`, наведение) не персистятся. Селекторы — `useStore(s => s.x)`; в экшенах/вне React — `useStore.getState()`. Подтверждения — `confirm()` (`lib/confirm.ts:9`) + `confirmStore`, не `window.confirm`.

**Новый метод API**: метод в объект `synthApi` (`lib/api/synthApi.ts:251`) + типы рядом; `BASE_URL = '/api/v2'` уже задан (`:5`). Прямой `fetch` из компонентов/сторов — нарушение.

## Соглашения

### Примитивы и иконки
- UI-примитивы — в `components/ui/`. Barrel `components/ui/index.ts` намеренно частичный (только `SynthLogo`, `ContextMenu`, `Popover`); остальное импортируется прямыми путями — это норма, не «чинить» реэкспортами.
- Коллекция настроек — `components/ui/settings/` (`SettingsPanel`/`Section`/`Field`/`Row`/`Actions`, контролы `TextField`/`NumberField`/`SliderField`/`TextArea`/`SelectField`/`ToggleField`/`ListField`/`SegmentedControl`/`Tabs`, хук `useSettingsDraft`) — обязательный стандарт (AD-072). Все разделы настроек и админ-категории мигрированы; legacy `components/settings/settings-layout.tsx` (`SettingsPage`/`SettingsCard`) удалён — новых импортов оттуда быть не должно.
- Панель настроек: один вертикальный скролл (скроллится только тело, шапка — `shrink-0`), `min-w-0`/`break-words` для текста, базовая сетка `grid-cols-1`, центрирование `max-w-3xl`, симметричные паддинги (без `pr-2`); порядок в шапке — `title` (+ `actions`) → `description` → `meta` (счётчики идут **ниже** описания, AD-072); действия (`SettingsActions`) — **в конце содержимого**, не фиксированным футером (проп `footer`/`footerVariant` доступен в `SettingsPanel`, но не используется).
- Иконки — только `<Icon name="..." />` из `components/icon/Icon.tsx` (реестр `icons.ts`). Не тащить svg/`@remixicon` напрямую (единственное исключение — `SynthLogo.tsx`); неизвестное имя не в `iconMap` → `Icon` вернёт `null`.
- Иконки/подписи инструментов — `lib/toolIcons.ts` (`getToolIcon`, `getToolDisplayName`); новый тул добавлять в `TOOL_ICON_MAP`, а не маппинг inline в компоненте.

### Стили
- Tailwind + `cn()` (`lib/utils.ts:4`). Условные классы — через `cn`, не конкатенацию строк.
- Цвета — только CSS-переменные (`var(--primary)`, `text-foreground`), не hex/oklch-литералы в разметке; темизация — `ThemeSystemProvider` + `styles/design-system.css`.
- Типографика — `SEMANTIC_TYPOGRAPHY` (`lib/typography.ts:1`), обязана совпадать с CSS-переменными `styles/design-system.css` (комментарий `must match SEMANTIC_TYPOGRAPHY`, `:15`). Расхождение — молчаливая деградация размеров.

### Zustand
- `create<T>()(...)` — курринг обязателен для типов; импорт `{ create } from 'zustand'`.
- `persist` — для пользовательских настроек (образец `stores/useUIStore.ts:131`): `partialize` + `merge` только для сериализуемых полей. `Set`/`Map` в JSON не переживут — конвертировать (см. `collapsedProjects`).
- Не замыкаться в экшенах на хуки — `useStore.getState()`.

### API и i18n
- API v2 — только через `synthApi` (`lib/api/synthApi.ts:5`); `/auth` — `lib/api/client.ts` (`BASE_URL = '/auth'`, `:75`). Ошибки бросаются как `Error` — ловить и показывать через i18n.
- Строки — только `useI18n().t('ключ')`, не хардкодить. `messages/en.ts` — базовый словарь, `messages/ru.ts` — ленивая загрузка (`import()`); ключ добавлять в оба. Плюрализация — ICU-подобным синтаксисом прямо в значении словаря: `'{count, plural, one {# сервер} few {# сервера} many {# серверов}}'` (ru — формы `one`/`few`/`many`, en — `one`/`other`). `#` внутри формы — само число, также работают обычные `{param}`-плейсхолдеры. `t(key, { count })` сам выбирает форму по локали (правила — `lib/i18n/plural.ts`, `pluralCategory`); если формы нужной категории нет — fallback `other → many → one → few → zero → two`.
- Движковые ключи синхронизируются с `@itphx/synth-shared/i18n` по контракту AD-041; проверка автоматическая — `messages/engine-keys.test.ts`.
- Системные сообщения ядра несут `metadata.i18n = { key, params }`: для отображения использовать `resolveI18n`/`isValidI18nMeta`/`useResolveI18n` (`lib/i18n/`), а не собирать строку в UI.

### Транспорт
- Единственный `TransportClient` (`lib/api/transport.ts:23`) + `stores/transportStore.ts` (`:626`). События обрабатывать через стор; не открывать второй WebSocket/EventSource (AD-024).

### Роли и доступ
- Роль — из `useAuthStore(s => s.user)?.roles`; UI лишь прячет недоступное, защита — на сервере. Примеры: `secrets` (ADMIN/AUDITOR, `RightPanel.tsx:31`), админ-разделы настроек (`roles[]`, `SettingsModal.tsx:32`).

### Уведомления и масштаб
- Toast + история + счётчики — `notifyMessage` (`hooks/useNotification.tsx`, standalone, вызывается и из сторов); не звать `toast` из react-toastify напрямую.
- Масштаб UI — `lib/uiScale.ts`: серверные дефолты + localStorage `synth-ui-scale`, мобильный дефолт 0.85 (`isMobileScaleDevice`). Не хардкодить масштаб в компонентах.

## Чего не делать

- Импортировать `@itphx/synth-ui/*` — пакет приватный, экспортирует только `package.json`.
- Делать `fetch`/`new WebSocket` в компонентах и сторах — только `synthApi`/`TransportClient`.
- Хардкодить цвета и размеры шрифта литералами — только CSS-переменные и `SEMANTIC_TYPOGRAPHY`.
- Добавлять svg или импортировать наборы иконок в обход `<Icon name>`.
- Использовать `window.confirm`/`alert` — `confirm()` + `ConfirmDialog`; звать `toast` в обход `notifyMessage`.
- Вводить react-router/URL-навигацию — навигация живёт в `useUIStore`.
- Персистить runtime-состояние и несериализуемые значения (`Set`, `Map`) без конвертации.
- Плодить второй транспорт, API-клиент или «глобальный стор на всё».
- Реэкспортировать в barrel `components/ui/index.ts` всё подряд — он намеренно частичный.

## Мобильный / PWA

- Полные конвенции (зоны ≤768 / 769–1199 / ≥1200, дроверы, touch-first, PWA-шелл) — в корневом `AGENTS.md` и [AD-044](../../docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md); здесь не дублируются.
- Локально: `initDeviceClasses()` (`lib/device.ts:38`) вешает классы на `<html>`; для логики использовать `useDevice()`/`useMediaQuery()` (`hooks/`), а не `window.innerWidth` вручную.
- Мобильный CSS гейтится `html.device-*`/`html.pointer-coarse`; JS-признак — `deviceType !== 'desktop'`.

## Тесты и сборка

- Тесты — колокейт с исходником: `src/**/*.test.{ts,tsx}` (`vitest.config.ts:16`), окружение jsdom.
- Из пакета: `pnpm test` (`vitest run`) / `pnpm test:watch`; из корня — `pnpm test`.
- Сборка `pnpm build` = `tsc -b && vite build`; typecheck `pnpm typecheck` (`tsc --noEmit`); lint `pnpm lint` (`eslint src/`). Порядок проверок — корневой `AGENTS.md`.
- В тестах не поднимать реальный транспорт/сеть — мокать `synthApi` и сторы.

## Куда смотреть

| Тема | Куда |
|---|---|
| Стек и структура SPA | [AD-019](../../docs/arch_decisions/ad-019-react-spa.md), [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) |
| Транспорт и события | [AD-024](../../docs/arch_decisions/ad-024-eventhub-transport.md) |
| Ошибки LLM / i18n | [AD-041](../../docs/arch_decisions/ad-041-llm-error-taxonomy.md) |
| Гибридный режим | [AD-042](../../docs/arch_decisions/ad-042-hybrid-mode.md) |
| Мобильный UI / PWA | [AD-044](../../docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md) |
| Общие инварианты, команды, порты | [корневой AGENTS.md](../../AGENTS.md) |
