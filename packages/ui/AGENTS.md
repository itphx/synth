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

## Тема и экран входа

- Последняя использованная тема хранится в `lib/theme/theme-persistence.ts`: cookie `synth_theme*` (приоритет при чтении; доступна pre-paint-скрипту `index.html`) + legacy-ключи localStorage (`theme`, `themeMode`, `selectedThemeId`, `selectedThemeVariant`, `splashBgLight/Dark`). Значения — `encodeURIComponent`, `path=/; SameSite=Lax; Max-Age=1 год`, `Secure` только на https.
- Boot: `ThemeSystemContext.buildInitialPreferences` читает `readThemePersistence()` (раньше — мёртвая ветка `readStorePrefs()`, т.к. `useUIStore.partialize` не сохраняет тему); эффект записи localStorage зеркалит тему в cookie через `writeThemePersistence(...)`.
- После логина побеждает профиль: `DefaultsSync` (авторизован) берёт `prefs.theme/themeMode` из `GET /auth/profile` и записывает их в cookie/localStorage тем же эффектом.
- `DefaultsSync` (гость) тему/режим **не** сбрасывает; `authStore.logout()` не чистит ключи темы — экран входа остаётся в последней теме.
- Экран входа (`components/auth/LoginForm.tsx`) — карточка кита: `bg-card` + `ring-1 ring-foreground/10` + `shadow-xl`, радиус `rounded-xl` (концентрично с полями `rounded-lg`).
- Наклонное освещение экрана входа (свет из верхнего-левого угла): brand-градиент логотипа диагональный, у верхнего радиального градиента фона (`.login-screen`, `styles/index.css`) origin смещён влево (`at 30% 0%`, интенсивность 12%/60%), у блика верхней кромки карточки (`bg-gradient-to-r from-transparent via-primary/70 via-30% to-transparent`) стоп `via` — на 30%. Нижний правый (`at 100% 100%`, 10%/55%) — тихий ambient. Ореол за логотипом (`bg-primary/20 blur-2xl`, контейнер `relative isolate`) сохранён.
- Brand-градиент логотипа (`SynthLogo variant="brand"`) — диагональный `x1=0,y1=0,x2=1,y2=1` (из верхнего-левого в нижний-правый); сам `SYNTH_LOGO_PATH` вынесен в `lib/theme/logo-path.ts` (импортируется в `SynthLogo.tsx` и используется favicon-ом, без дублирования).
- Favicon вкладки красится в `--primary` текущей темы: `lib/theme/favicon.ts` (`applyThemedFavicon`) вызывается в layout-эффекте `ThemeSystemContext` (`cssGenerator.apply`), подменяя `href` у `link[rel="icon"]` на data-URI-SVG. `public/favicon.svg` — статический фолбэк до загрузки JS; PNG-иконки PWA/manifest не темизируются.

## Карта src/

| Зона | Что там |
|---|---|
| `components/layout/` | Каркас и хром: `Sidebar`, `Header`, `CenterPanel`, `CenterTabs`, `MobileDrawer`, баннеры, `BackendConnection`, `AuthGate`-обвязка |
| `components/panels/` | Левые/правые панели и вкладки (`LeftPanel`, `RightPanel`, `*Tab`) |
| `components/chat/` | Чат: сообщения, стриминг, файловые вкладки, tool-рендер, саб-агенты |
| `components/settings/` + `components/admin/` | Настройки и админ-панели (провайдеры, модели, безопасность, routing, события) |
| `components/auth/` | `AuthGate`, логин (в т.ч. гибридный) |
| `components/ui/` | Примитивы: dialog, popover, select, tooltip, toggle, `SynthLogo`, `EntityIconPicker` (пикер иконки/цвета сущностей), `EntityEditDialog` (единое центральное окно редактирования проекта/сессии) |
| `components/icon/` | `Icon` + реестр `icons.ts` — единственная точка иконок |
| `components/{tree,projects,logviewer}/` | Деревья, проекты, просмотр логов |
| `stores/` | Zustand-сторы (см. «Соглашения») |
| `lib/api/` | HTTP-слой (`synthApi`, `client`) и транспорт (`transport`) |
| `lib/i18n/` | Провайдер, стор, словари, резолвер ключей |
| `lib/` | Утилиты, устройство, масштаб UI, форматирование, темы, `entityIcon` (резолвер иконки/цвета сущностей) |
| `hooks/`, `contexts/`, `styles/`, `types/` | Хуки, React-контексты, Tailwind + CSS-переменные, локальные типы |

Крупнейшая зона — `components/chat/`; её правки обычно тянут `stores/chatStore.ts` (≈800 строк), `transportStore` и i18n-резолвер.

## Точки расширения

**Новый center-tab = ровно 3 правки** (тип-система не даст забыть):
1. тип в `CenterTabType` (`stores/useUIStore.ts:28`) и при необходимости поля в `CenterTab.data` (`:30`);
2. иконка в `TAB_ICONS` (`components/layout/CenterTabs.tsx:25`);
3. `case` в `renderTabContent` (`components/layout/CenterPanel.tsx:35`).

**Новая вкладка панели**: `RIGHT_TABS` (`components/panels/RightPanel.tsx:14`) / `LEFT_TABS` (`components/panels/LeftPanel.tsx:30`). Role-gating — по образцу `secrets` (`RightPanel.tsx:31-34`): вкладка добавляется условно + эффект-нормализация, если активной стала недоступная. Схлопывание подписей в иконки при переполнении даёт `useAdaptiveIcons` (`LeftPanel.tsx:1700`, `RightPanel.tsx:47`) — он измеряет `span[data-tab-label]`, поэтому подпись вкладки оборачивать в этот маркер.

**Новая левая вкладка с тулбаром**: toolbar выбирается по `leftPanelTab` в `App.tsx:140-143` (`ProjectsTabToolbar`/`FilesTabToolbar`/`GitTabToolbar`) — добавить свой `case`, иначе шапка панели останется пустой.

**Контекст-ориентированные вкладки Files/Git.** Обе вкладки строятся как закреплённый блок «Текущий проект» (авто-раскрыт) + сворачиваемые «Другие проекты ({count})»; активный проект — хук `useActiveProject` (`hooks/useActiveProject.ts`: чат → `project_id` сессии, file/commit-таб → `projectId` вкладки). Ключ сворачивания блока «другие» — `OTHER_PROJECTS_COLLAPSE_KEY` (`stores/useUIStore.ts`). Тумблер «Только текущий проект» — `ProjectScopeToggle` (`components/panels/ProjectScopeToggle.tsx`, persist `useUIStore.onlyActiveProject`, disabled без валидного workspace у текущего проекта); в разметке помечен `data-project-scope-toggle`. При включённом тумблере expand/collapse-all действует только на видимые проекты — учитывать это в новых тулбарах. Обновление дерева — `filesStore.refreshProject` (точечно перечитывает загруженные каталоги и инкрементит `revisionByProject`), `refreshDirs` (точная инвалидация только родительских каталогов из `fs.changed` со `scope:'file'`, ошибка перечитывания каталога удаляет его ключ) и его debounce-обёртка `scheduleRefresh` (вызывается из `fs.changed`; коалесинг `all`-событий и «последняя операция по пути» для `op`). Файловые `fs.changed` инкрементят `fileRevisions[projectId::path]` и ведут `deletedFiles` (op `delete` → пометка, `write`/`mkdir` → снятие, `move` → без изменений; `markDeletedFile` — детект по факту: чтение вернуло 404/`NOT_FOUND`, например после `execute_shell rm`/`git_checkout`, где `op` нет); `FileEditorTab` по росту ревизии перечитывает открытый файл, при расхождении показывает баннер `file.changedOnDisk`, при удалении — состояние `file.deletedOnDisk` с кнопкой `file.reload`. Перенос/переименование (`filesStore.moveEntry`) перемапливает префиксные ключи поддерева в `treesByProject`/`expandedDirs`/`fileRevisions`/`deletedFiles`/`draftContents` (включая переписывание `entry.path` в кэшированных листингах; без `removeSubTree`; перечитываются только родители src/dst), а вкладки viewer/editor переводит `useUIStore.remapFileTabs` — открытые редакторы переезжают прозрачно; при ремапе коллизия id разрешается в пользу перемапленной вкладки (чужая удаляется). Перемап вынесен в `filesStore.remapPath`; перенос из shell (`execute_shell mv`/`git mv`) приходит как `fs.changed` с `op:'move'`/`from`/`to` — транспорт (`transportStore`) синхронно до debounce вызывает `remapPath` → `remapFileTabs` → `scheduleRefresh`, чтобы редактор не потерял черновик. Черновики (`filesStore.draftContents`, ключ `${projectId}::${path}`, runtime-only, экшены `setDraft`/`clearDraft`) восстанавливаются `FileEditorTab` и переживают переключение вкладок и перенос между проектами; межпроектный перенос DnD идёт серверным `POST /fs/move` с `targetProjectId` (файлы и каталоги; черновики переносятся вместе с поддеревом). Диалог переноса (`LeftPanel`) первым пунктом показывает корень workspace (`''` → `/`, title `file.workspaceRoot`), далее — каталоги, подгруженные рекурсивным листингом (`synthApi.listDirectory(projectId, '', showHidden, 10)`, `maxDepth` до 10; кэш по проекту на время сессии диалога, пока идёт загрузка — индикатор; при ошибке — fallback на каталоги загруженных веток дерева). Целевой путь и его потомки из списка исключаются. Закрытие вкладки viewer/editor с несохранёнными изменениями (`editingState === 'dirty'`) подтверждается через `confirm()` (title `center.closeTab`, message `file.unsavedChanges`, variant `warning`); `useUIStore.closeTab` при закрытии очищает черновик (`filesStore.clearDraft`), чтобы он не «залипал».

**Новый раздел настроек**: элемент `CATEGORIES` (`components/settings/SettingsModal.tsx:35`) с `labelKey` + `icon`. Админ-раздел помечается `roles[]` (`:32`); по первому такому элементу рисуется граница (`adminBoundaryIndex`, `:70`). Ключ `labelKey` добавлять в **оба** словаря.

**Новый store**: `create<T>()(...)`, при необходимости `persist` (образец `stores/useUIStore.ts:130-131`). Пользовательские настройки — только через `persist`; runtime-флаги (дроверы, `centralNarrow`, наведение) не персистятся. Селекторы — `useStore(s => s.x)`; в экшенах/вне React — `useStore.getState()`. Подтверждения — `confirm()` (`lib/confirm.ts:9`) + `confirmStore`, не `window.confirm`.

**Новый метод API** (ADR-095): метод добавляется в доменный модуль `lib/api/<домен>.ts` (типы/DTO — рядом с доменом) и попадает в публичный объект `synthApi` через barrel `lib/api/synthApi.ts`; общие `BASE_URL = '/api/v2'`, `fetchJSON`, `encodeFilePath` — в `lib/api/base.ts`. Полный состав `synthApi` фиксирует контрактный тест `lib/api/synthApi.contract.test.ts`. Прямой `fetch` из компонентов/сторов — нарушение.

## Соглашения

### Примитивы и иконки
- UI-примитивы — в `components/ui/`. Barrel `components/ui/index.ts` намеренно частичный (только `SynthLogo`, `ContextMenu`, `Popover`); остальное импортируется прямыми путями — это норма, не «чинить» реэкспортами.
- Тумблер (`components/ui/Toggle.tsx`) — единый канон курсора: обычный — `cursor-pointer`; `pending` (идёт сохранение, сохраняем сразу) — `cursor-progress` + лёгкое затемнение, без атрибута `disabled`; `disabled` (реально недоступно: system/project, нет прав) — `cursor-default` + `opacity-40` **без** `cursor-not-allowed`, причина показывается текстом рядом. Зафиксировано в `Toggle.test.tsx`.
- Коллекция настроек — `components/ui/settings/` (`SettingsPanel`/`Section`/`Field`/`Row`/`Actions`, контролы `TextField`/`NumberField`/`SliderField`/`TextArea`/`SelectField`/`ToggleField`/`ListField`/`KeyValueField`/`SegmentedControl`/`Tabs`, хук `useSettingsDraft`) — обязательный стандарт (ADR-072). Все разделы настроек и админ-категории мигрированы; legacy `components/settings/settings-layout.tsx` (`SettingsPage`/`SettingsCard`) удалён — новых импортов оттуда быть не должно.
- Панель настроек: один вертикальный скролл (скроллится только тело, шапка — `shrink-0`), `min-w-0`/`break-words` для текста, базовая сетка `grid-cols-1`, центрирование `max-w-3xl`, симметричные паддинги (без `pr-2`); порядок в шапке — `title` (+ `actions`) → `description` → `meta` (счётчики идут **ниже** описания, ADR-072); действия (`SettingsActions`) — **в конце содержимого**, не фиксированным футером (у `SettingsPanel` нет footer-пропов). В `SettingsActions` кнопка Reset цветная (`outline-primary`) только когда текущие значения отличаются от дефолтных; при дефолтных (`isDefault`) — серая (`outline-muted`) и неактивна; Save/Cancel активны только при несохранённых изменениях (`dirty`).
- Иконки — только `<Icon name="..." />` из `components/icon/Icon.tsx` (реестр `icons.ts`). Не тащить svg/`@remixicon` напрямую (единственное исключение — `SynthLogo.tsx`); неизвестное имя не в `iconMap` → `Icon` вернёт `null`.
- Иконки/подписи инструментов — `lib/toolIcons.ts` (`getToolIcon`, `getToolDisplayName`); новый тул добавлять в `TOOL_ICON_MAP`, а не маппинг inline в компоненте.
- Иконка/цвет проекта и сессии — только через `lib/entityIcon.ts` (`resolveIconName`/`resolveIconColor`) и общий пикер `components/ui/EntityIconPicker.tsx` (ключи реестра + палитра CSS-переменных, без загружаемых картинок). Реестры ключей и маппинги — `lib/projectMeta.ts` из shared (`PROJECT_ICON_KEYS`/`PROJECT_COLOR_KEYS`); в UI их не дублировать.
- Пикер используется внутри `components/ui/EntityEditDialog.tsx` — единого центрального окна редактирования проекта/сессии (имя; у проекта — ещё описание; иконка + цвет). Открывается из контекстного меню дерева (проект/сессия) и по клику на имя/иконку во вкладках «Сессия» (`SessionSettingsTab`) и «Проект» (`ProjectTab`); один экземпляр монтируется в `App.tsx` через `stores/entityEditStore`. Сохранение — черновик + кнопка Save (`useSettingsDraft` + `SettingsActions`); «Отмена» всегда активна и закрывает окно без сохранения. Отдельные поповеры/диалоги иконки/цвета и компонент `EntityIconTrigger` удалены. Инлайн-переименование в дереве — по-прежнему быстрый путь и доступно как для сессий, так и для проектов (мобильный фикс: `stopPropagation` на пунктах в `components/ui/contextMenu.tsx`). Иконка выводится инлайн (`<Icon>`): дерево, табы, шапка, панели.
- Резолвер — единственная точка перевода серверного значения в имя реестра `Icon`/CSS-переменную; неизвестное даёт `undefined` (компонент подставляет фоллбек). У закрытых сессий (нет таба и не активны) иконка серая (`text-muted-foreground`), у открытых — цвет сессии (без цвета — `text-primary`); у проектов иконка всегда цветная. Дефолтный цвет иконки сессии — `--primary` (акцент открытой сессии; `resolveSessionIconColor`/`DEFAULT_SESSION_ICON_COLOR`), в панели «Сессия» и табе сессии — тоже `--primary`, у проекта дефолт остаётся нейтральным.

### Чат: упоминания агентов
- Вызов агента через `@` (`components/chat/ChatInput.tsx`, `splitMessageWithTags`) сохраняет сам тег `@<agentId>` в тексте сообщения (иначе пользователю неясно, почему ответил другой агент); тег одновременно уходит как `agentRole` в `sendMessage`. Не вырезать тег из `part.text`.
- В пользовательских сообщениях `@<agentId>` известных агентов подсвечивается цветом агента (`AgentInfo.color` через `resolveColor`) — `components/chat/SecretPlaceholder.tsx` (`SecretPlainText`), реестр из `agentsStore`. Неизвестный агент или пустой реестр → обычный текст, без поломки вёрстки и переносов.

### Сохранение немедленных настроек панели
- Немедленное сохранение настройки правой панели (тумблер, селект, автосейв поля) — только через общий хук `usePanelSettingSave` (`hooks/usePanelSettingSave.ts`): `run({ key, run, onSuccess, onError, errorKey })`.
- Шаблон элемента: `pending` контрола по `isPending(key)` → единый success-тост `panel.saved` → при ошибке единый error-тост `panel.saveError` и **откат** контрола/формы к актуальному серверному состоянию. «Залипающих» оптимистичных значений быть не должно (`onError`/`onSuccess` возвращают состояние; для форм — `applyFormValues(formValuesFromSettings(...))`).
- `pending` — по конкретному контролу/сущности (`isPending(\`mcp:${name}\`)`), а не «всё сразу»; во время запроса контрол `pending`, но не `disabled` (повторы гасит обработчик через `isPending`).
- Повторные success-тосты подавляются окном троттлинга (`throttleMs`, по умолчанию ~1.5 с); error-тосты показываются всегда. Спец-ошибки (403 forbidden, 409 confirm-required) — через `errorKey` (строка или функция от ошибки) либо `silentError` + собственный тост. Общие формулировки — ключи `panel.saved`/`panel.saveError` (не плодить доменные синонимы).

### Стили
- Tailwind + `cn()` (`lib/utils.ts:4`). Условные классы — через `cn`, не конкатенацию строк.
- Цвета — только CSS-переменные (`var(--primary)`, `text-foreground`), не hex/oklch-литералы в разметке; темизация — `ThemeSystemProvider` + `styles/design-system.css`.
- Типографика — `SEMANTIC_TYPOGRAPHY` (`lib/typography.ts:1`), обязана совпадать с CSS-переменными `styles/design-system.css` (комментарий `must match SEMANTIC_TYPOGRAPHY`, `:15`). Расхождение — молчаливая деградация размеров.
- Вкладки правой панели строятся только через `PanelTab` (`components/panels/PanelTab.tsx`): скролл — внутри вкладки (`p-3`, `space-y-4` между секциями), футер с действиями — через проп `footer` (фиксирован, не скроллится), внешний скролл в `RightPanel` отключён. Внутри секции ритм задаёт родитель (`InfoSection` — 8px); ad-hoc `mt-*`/`mb-*` для вертикальных интервалов не использовать.

### Zustand
- `create<T>()(...)` — курринг обязателен для типов; импорт `{ create } from 'zustand'`.
- `persist` — для пользовательских настроек (образец `stores/useUIStore.ts:131`): `partialize` + `merge` только для сериализуемых полей. `Set`/`Map` в JSON не переживут — конвертировать (см. `collapsedProjects`).
- Не замыкаться в экшенах на хуки — `useStore.getState()`.

### API и i18n
- API v2 — только через `synthApi` (`lib/api/synthApi.ts` — barrel; доменные модули — `lib/api/<домен>.ts`, база `BASE_URL`/`fetchJSON`/`encodeFilePath` — `lib/api/base.ts`); `/auth` — `lib/api/client.ts` (`BASE_URL = '/auth'`, `:75`). Ошибки бросаются как `Error` — ловить и показывать через i18n.
- Строки — только `useI18n().t('ключ')`, не хардкодить. `messages/en.ts` — базовый словарь, `messages/ru.ts` — ленивая загрузка (`import()`); ключ добавлять в оба. Плюрализация — ICU-подобным синтаксисом прямо в значении словаря: `'{count, plural, one {# сервер} few {# сервера} many {# серверов}}'` (ru — формы `one`/`few`/`many`, en — `one`/`other`). `#` внутри формы — само число, также работают обычные `{param}`-плейсхолдеры. `t(key, { count })` сам выбирает форму по локали (правила — `lib/i18n/plural.ts`, `pluralCategory`); если формы нужной категории нет — fallback `other → many → one → few → zero → two`.
- Движковые ключи синхронизируются с `@itphx/synth-shared/i18n` по контракту ADR-041; проверка автоматическая — `messages/engine-keys.test.ts`.
- Системные сообщения ядра несут `metadata.i18n = { key, params }`: для отображения использовать `resolveI18n`/`isValidI18nMeta`/`useResolveI18n` (`lib/i18n/`), а не собирать строку в UI.

### Транспорт
- Единственный `TransportClient` (`lib/api/transport.ts:23`) + `stores/transportStore.ts` (`:626`). События обрабатывать через стор; не открывать второй WebSocket/EventSource (ADR-024).
- `fs.changed` — мутирующий тул ядра изменил workspace: стор вызывает `filesStore.scheduleRefresh` (debounce) и debounce-refresh реестра Git (`scheduleGitRefresh`). `session.moved` — сессия перенесена между проектами (в т.ч. `project_create`/`project_attach` агентом): патч `project_id`, refresh сессии, `loadProjects` и `filesStore.refreshProject`.
- `event.routed` (ADR-089) — внешнее событие материализовано в сессию: полный refresh сессии (`refreshSessionFromApi`); изменения приходят отдельными событиями очереди/сообщений.

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

## Скиллы и команды (ADR-046)

- **Store/API.** `stores/skillsStore.ts` — реестр скиллов + деталь, команды, bundles, instance-настройки (disabled/policy + дефолты), CRUD, загрузка/ошибки, счётчики вызовов. Методы `synthApi`: skills (`getSkills/getSkill/createSkill/updateSkill/deleteSkill/getSkillFiles/getSkillFile/putSkillFile/deleteSkillFile/reloadSkills`), `getCommands`, CRUD `/skill-bundles`, scope (`getSessionSkills/updateSessionSkills/getSessionSkillsEffective`, `getProjectSkills/updateProjectSkills`, `getSkillsSettings/updateSkillsSettings/resetSkillsSettings`).
- **Настройки** (`components/settings/`): user-раздел «Скиллы» (`SkillsUserSettings`) — просмотр реестра/тела `SKILL.md`/supporting-файлов, недоверенные — только метаданные + бейдж, без CRUD; admin «Скиллы» (`SkillsAdminSettings` + `SkillEditorForm`) — CRUD `SKILL.md`+файлы, две оси гейтов (мастер `disabled` + `disabledForNewProjects`), policy; admin «Команды» (`CommandsSettings`) — список команд (kind/scope/available + диагностика `shadowed`/`collision`) и CRUD bundles. Категории `skills` (user) и `skillsAdmin`, `commands` (ADMIN) — в `CATEGORIES` (`SettingsModal.tsx`).
- **Правая панель.** Тумблеры скиллов по образцу MCP: `SessionSettingsTab` (`getSessionSkills`/`updateSessionSkills { name, enabled }`, тумблер заблокирован при `disabledReason` `system`/`project`) и `ProjectTab` (`ProjectSkillsBlock`, «Доступен» = hard-gate проекта / «Включён по умолчанию» = сид новых сессий, гейт owner/LEAD/admin, 403 — аккуратным уведомлением).
- **Двумерная модель вкл/выкл (скиллы и MCP).** Единая семантика: **система** — мастер `disabled`/`enabled` (выкл → недоступно нигде) + дефолт для новых проектов (`disabledForNewProjects` у скиллов, `enabledByDefault` у MCP); **проект** — `enabled` (hard-gate: выкл → недоступно в сессиях проекта, включая старые) + `defaultOn` (сид новых сессий); **сессия** — один тумблер «включён здесь». База — opt-in. Причины в эффективных списках: скиллы `session`/`system`/`project`, MCP `system_disabled`/`project_disabled`/`session_optout`/`not_default`. `StatsTab` показывает и причины, и источник (`stable`/`session`/`project`).
- **Статистика.** `StatsTab` — секция «Скиллы» (scope/уровень, available, enabled сессии, unavailableReason, trusted, вклад токенов, source; размеры `skills.catalog`/`skills.catalog.session` из `manifest.entries`) и «Команды» — счётчики `skill.invoked`/`command.invoked` из `skillsStore`. События обрабатываются в `transportStore` (не открывать свой транспорт, ADR-024).
- **`/`-автокомплит.** `components/chat/CommandAutocomplete.tsx` + `ChatInput`: источник `GET /api/v2/commands`, навигация ArrowUp/Down/Enter/Tab/Escape, клик, подстановка `/name ` (не отправка), тач-таргеты (ADR-044).
- ⚠️ **Инвариант импортов shared.** Для runtime/value-импортов из `@itphx/synth-shared` использовать **только subpath**: `@itphx/synth-shared/types`, `/schemas`, `/i18n`, `/version`. Value-импорт из **корня** `@itphx/synth-shared` тянет `config/loader` → `node:fs` в браузерный бандл и роняет всё приложение (реальный инцидент commit 2; `import type` из корня безопасен — стирается компилятором). Проверять при добавлении любых констант/функций из shared в UI.

## Промпт и статистика (ADR-070)

- **`StatsTab`** (`components/panels/StatsTab.tsx`, правая панель «Статистика») — read-only; данные из
  `GET /api/v2/sessions/:id/prompt` и `GET /api/v2/sessions/:id/stats`.
- **«Состав промпта»** — таблица записей манифеста в реальном порядке отправки (тир
  `stable`/`context`/`volatile`, блок по i18n-ключу `promptBlock.*`, `Симв.`/`~Токенов`/`Статус`,
  provenance), строки «Всего символов/~токенов» и «Статический префикс», строка «Описание инструментов»
  (`tools`), hit/miss последнего хода (`promptMeta` → `promptHit`/`promptMiss`). Секция «История» —
  раскрывающаяся таблица state-сообщений по типам + исключённые (`disabled`/`hidden`/`info`)/вложения/
  число секретов.
- **Cache-статистика** — «Кэш чтение»/«Кэш запись»/«Попадание в кэш» (`cache_hit_rate` сессии либо
  расчёт `cache_read_tokens / input_tokens`); у последнего ответа — разбивка стоимости.
- **Агенты/пользователи и сабагенты** — таблицы «Статистика агентов»/«пользователей» (сообщения,
  токены, «Сабагентов»/«Токенов сабагентов», «в т.ч. сабагенты»); сумму сессии даёт `sessionStats`,
  включая саб-агентов; у агентов нет «Скорость»/«Длительность». Live-обновление — по активному стриму
  и `streamFinishTick`; единый вид (иконка+имя в цвет сущности, колонки «Кэш»/«%», общий поповер).

## Git и SSH-ключи (ADR-076)

- **Git-вкладка** (`components/panels/LeftPanel.tsx` → `GitTab`, `stores/gitStore.ts`): реестр `project.repos` с `destination`/`type`/`url`/`ssh-key`/`lastFetch`; `scan → register`, `clone`/`init` с полями `name`/`path` и селектором SSH-ключа, `fetch`, `remove` (через `ConfirmDialog`, опц. `deleteLocal`). Методы — `synthApi.*GitRepo*`.
- **SSH-ключи** (`components/settings/SshKeysSettings.tsx`, встраивается в админ-категорию «Агенты» `admin/AgentsPanel.tsx`): CRUD per-agent ключей, привязка к агентам (`agentIds`), редактирование без обязательной замены ключа. Поля «Тип» нет (дублировало имя) — в shared `SSHKey.type?`/`sshKeyCreateSchema.type?` сохранены для обратной совместимости, UI их не задаёт и не показывает. API `synthApi.*SshKey*` отдаёт только `SSHKeyMeta` (без `privateKey`/`passphrase`); ошибки — ключи `sshkey.*` (в т.ч. `sshkey.env_failed`), i18n ru/en. Ключи с `passphrase` поддерживаются (git-операция — через askpass).

## Внешние события (ADR-089)

- **Раздел «События» — пользовательская часть** (`components/settings/EventsAdminSettings.tsx`; категория `eventsAdmin`, `labelKey: settings.category.events`, **без `roles`**): виден всем ролям, расположен среди user-категорий до админ-блока. Содержит реестр биндингов источник→сессия, правила маршрутизации (`EventRoutesSection`) и журнал решений Router (`EventJournalPanel`). API — `synthApi` (bindings/routes/journal/keys).
- **Роли (LEAD/ADMIN на мутации).** `useCanManageEvents()` (`hooks/useCanManageEvents.ts`) = роли содержат `ADMIN`/`LEAD`. USER/AUDITOR: раздел и журнал доступны только для просмотра — скрыты «Добавить», «Изменить», «Удалить», инлайн-тумблеры и секция API-ключей; enforcement — на сервере.
- **Селекты сущностей** (`components/settings/entity-selects.tsx`): `ProjectSelect`/`SessionSelect`/`AgentSelect` (значение — `id`, подпись — имя, выбранный ID — моно-строкой под селектом). `SessionSelect` грузит `synthApi.getSessions(projectId)` и на клиенте отбирает `session.project_id === projectId` (core-роут фильтр не гарантирует); справа кнопка «+» открывает общий `components/panels/SessionCreateDialog.tsx` — после создания список перезагружается и выбирается новая сессия. Этими селектами заменён свободный ввод в формах bindings (`EventsAdminSettings`), rules (`EventRoutesSection`) и schedules (`SchedulerTab`, где также `AgentSelect`/`ProjectSelect` для ephemeral).
- **Тултипы полей.** `FieldTooltip` (`components/ui/settings/FieldTooltip.tsx`) + проп `tooltip?` у `SettingsField`/`SettingsRow`/`TextField`/`TextArea`/`NumberField`/`SelectField`/`ToggleField` (иконка ⓘ + Radix `Tooltip`); проставлены всем полям форм bindings/rules/schedules/ключей и админ-раздела «Параметры событий». `TooltipProvider` в `App.tsx` оборачивает `SettingsModal`/`LogsModal`/`EntityEditDialog` (иначе тултипы вне лэйаута падают с «must be used within TooltipProvider»).
- **API-ключи привязки + curl** (`components/settings/EventBindingKeys.tsx`, только `canManage`): **секция первоклассная — всегда видна внутри карточки привязки** (без тумблера-иконки; счётчик ключей). `label` **обязательна и уникальна глобально по инстансу** (дубль → 409 `CONFLICT`, ошибка `errors.conflict.eventKeyLabel` под полем метки; пустая → `events.keys.labelRequired`); `description` опциональна; `expiresAt` — нативное поле даты (пусто — бессрочно); `rateLimitPerMinute` — опц. целое (пусто — глобальный дефолт, `0` — без лимита). Статусы: **активен / истёк (по сроку) / отозван** (бейджи; отозван приоритетнее истёкшего). Инлайн-редактор метки/описания/срока/лимита (`PATCH`, `null` сбрасывает поле), **отзыв** (`POST …/revoke`, мягкий, идемпотентный) и **удаление** — оба через `confirm()`. Однократный показ секрета (`key`) с копированием (`navigator.clipboard.writeText`) + read-only `<pre>` с тестовым `curl -X POST '<origin>/api/v2/events' -H 'Authorization: Bearer <key>' …` (созданный ключ подставляется реально, до создания — плейсхолдер `<key>`). Методы — `synthApi.getEventBindingKeys/createEventBindingKey/updateEventBindingKey/revokeEventBindingKey/deleteEventBindingKey`.
- **Админ-раздел «Параметры событий»** (`components/settings/EventsSettings.tsx`; категория `eventsConfig`, `labelKey: settings.category.eventsConfig`, `roles: ['ADMIN']` — за границей админ-блока): runtime-настройки обработки внешних событий через `synthApi.getEventsSettings/updateEventsSettings/resetEventsSettings` (`GET/PUT/DELETE /api/v2/settings/events`, мутации — ADMIN). Поля — `SettingsPanel`/`SettingsSection` + `ToggleField`/`SelectField`/`TextField`/`NumberField`/`ListField`/`KeyValueField`: мастер-выключатель `enabled`, `defaultMode` (bound/ephemeral), `ephemeralTtl`, `journalRetentionDays`, `allowedSources` (чипы), `unknownAgentTemplate` (drop/default-agent), **`keyRateLimitPerMinute`** (глобальный дефолт лимита запросов/мин на API-ключ привязки; `0` — без лимита), `decisionRouting` (ADR-084), **`autoBind`** (ADR-089 auto-bind: закрепление чата/треда за сессией), **`autoBindAgentTemplate`** (шаблон агента auto-bind-сессий) и **`identityMap`** (ADR-089: маппинг `chatKey`/`principalId` → пользователь инстанса; редактор пар ключ→значение, порядок строк сохраняется; при сохранении пары с пустым/пробельным ключом отбрасываются — сервер отклоняет пустые ключи 400). Черновик — `useSettingsDraft`, действия — `SettingsActions` (Save/Cancel активны только при `dirty`; Reset серый/неактивен при `isDefault`). Тип `EventsSettings` объявлен локально в `synthApi.ts`.
- **Фикс активной недоступной категории** (`SettingsModal.tsx`, `resolveActiveSettingsPage`): если сохранённый `settingsPage` больше не входит в доступные роли категории (смена пользователя/роли в одной SPA-сессии без перезагрузки), активной становится первая доступная категория — содержимое скрытого ADMIN-раздела не рендерится. Регрессия — `SettingsModal.activePage.test.tsx`.
- **Журнал дублируется в «Логи и аудит».** `EventJournalPanel` используется и в разделе «События» (кнопка «Открыть в „Логи и аудит"» → `useUIStore.setLogsPage('events')` + `setLogsDialogOpen(true)`), и как категория `events` в `components/logviewer/LogsModal.tsx` (гейт модала ADMIN/AUDITOR сохраняется). В записях отображаются опциональные `keyId`/`principalId`.


## Decision-модели (ADR-084)

- **Админ-раздел «Decision-модели»** (`components/settings/DecisionSettings.tsx`; категория `decisionConfig`, `labelKey: settings.category.decision`, `roles: ['ADMIN']` — за границей админ-блока): runtime-настройки decision-слоя через `synthApi.getDecisionSettings/updateDecisionSettings/resetDecisionSettings` (`GET/PUT/DELETE /api/v2/settings/decision`, мутации — ADMIN). Поля — `SettingsPanel`/`SettingsSection` + `ToggleField`/`ModelPairSelect`/`NumberField`: мастер `enabled`, основная пара `provider`+`model` и вторая необязательная пара эскалации `escalationProvider`+`escalationModel` (обе — `ModelPairSelect`; провайдеры фильтруются по типу `decision`/`systemone`, модели — по выбранному провайдеру; сторы — `useProvidersStore`, откуда берутся и `providers`, и `models`) и `confidenceThreshold`. Черновик — `useSettingsDraft`, действия — `SettingsActions` (Save/Cancel активны только при `dirty`; Reset серый/неактивен при `isDefault`). Типы `DecisionSettings`/`DecisionSettingsResponse` — локально в `synthApi.ts`.
- **Read-only статистика** (вторая `SettingsSection` того же компонента, вне черновика — отдельный `useState`/`useEffect`): снимок и сброс агрегатных метрик decision-каскада через `synthApi.getDecisionMetrics`/`resetDecisionMetrics` (`GET/DELETE /api/v2/settings/decision/metrics`; reset — через `confirm()`). Вывод: `calls`/`handled`/`fallback`/`escalated`, `attempts.primary`/`escalation`, статусы `rejected` и таблица `by_model` (calls/handled/latency avg/max). Кнопки «Обновить»/«Сбросить», ошибки — через `notify`/i18n. Тип `DecisionMetrics` — локально в `synthApi.ts`.
- **Per-session `decisionFirst`** (`components/panels/SessionSettingsTab.tsx`) — тумблер уровня decision-модели в микро-каскаде, рядом с микро/роутингом; пишется только при явном opt-out (`decisionFirst: false`), отсутствие ключа = включено (наследует глобальную настройку).
- **События.** Тумблер `decisionRouting` — в админ-разделе «Параметры событий» (`components/settings/EventsSettings.tsx`, ADR-089 × ADR-084; default off, opt-in: decision-классификация внешних событий при промахе правил, требует включённого decision-слоя).

## Сервисные ключи (ADR-052, этап I)

- **Админ-раздел «Сервисные ключи»** (`components/settings/ServiceKeysSettings.tsx`; категория `serviceKeys`, `labelKey: settings.category.serviceKeys`, `roles: ['ADMIN']` — за границей админ-блока): CRUD scoped-ключей инстанса через `synthApi.getServiceKeys/getServiceKey/createServiceKey/updateServiceKey/deleteServiceKey/revokeServiceKey` (`/api/v2/service-keys`; мутации — ADMIN, guard сервера). Список: `label`, `prefix`, статус (активен/истёк/отозван), роли, scopes, проектная проекция (`allowedProjects` → имена из `useProjectsStore`), `createdAt`/`lastUsedAt`/срок/лимит.
- **Создание**: обязательная уникальная `label` (дубль → 409 `CONFLICT` → `errors.conflict.serviceKeyLabel` под полем; пустая → `serviceKeys.labelRequired`), `description?`, роли/scopes/`allowedProjects?` — мульти-селект `MultiSelectField` (`components/ui/settings/controls/MultiSelectField.tsx`, чипы-переключатели). **Каталог scope'ов/ролей приходит с сервера** (`synthApi.getServiceKeyScopes()` → `GET /api/v2/service-keys/scopes`: точечные scopes + wildcard-семейства `<family>:*` + роли), в бандл не компилируется; **фоллбек** при ошибке загрузки (гибрид/старый сервер) — shared-константы `SERVICE_SCOPES`/`SERVICE_SCOPE_FAMILIES`/`GlobalRole` (форма работает). `rateLimitPerMinute?`, `expiresAt?` (нативное поле даты, конец дня). После создания — **однократный** показ секрета (`key`) + копирование + read-only curl (`buildServiceKeyCurl`, `/api/v2/projects`). Инлайн-редактор, мягкий отзыв (`POST …/revoke`, идемпотентно) и удаление — через `confirm()`. **Read-only для не-ADMIN**: сообщение `serviceKeys.readOnly`, без кнопок мутаций (список доступен). i18n — `serviceKeys.*` (ru/en).
- Типы `ServiceApiKey`/`ServiceApiKeyCreated`/`CreateServiceApiKeyInput`/`UpdateServiceApiKeyPatch` — из `@itphx/synth-shared` (type-only); значения `GlobalRole`/`SERVICE_SCOPES`/`SERVICE_SCOPE_FAMILIES` — из subpath `@itphx/synth-shared/types` (как фоллбек-каталог).

## Webhooks (ADR-052, этап II)

- **Админ-раздел «Webhooks»** (`components/settings/WebhooksSettings.tsx`; категория `webhooks`, `labelKey: settings.category.webhooks`, icon `send-plane`, `roles: ['ADMIN']` — за границей админ-блока, рядом с «Сервисные ключи»): CRUD подписок на исходящие события через `synthApi.getWebhookSubscriptions/getWebhookSubscription/createWebhookSubscription/updateWebhookSubscription/deleteWebhookSubscription/regenerateWebhookSecret/testWebhookSubscription/getWebhookDeliveries` (`/api/v2/webhooks`; мутации — ADMIN, guard сервера). Список: `label`, `url`, события (чипы; пустой список — набор по умолчанию `DEFAULT_WEBHOOK_EVENT_PATTERNS`), тумблер `enabled` (шлёт `PATCH {enabled}`), бейдж `lastStatus` + `lastDeliveryAt`, `createdAt`/`createdBy`/`secretPrefix`.
- **Создание**: обязательная уникальная `label` (дубль → 409 `CONFLICT` → `errors.conflict.webhookLabel` под полем; пустая → `webhooks.labelRequired`), `description?`, `url` (валидация — абсолютный `https`, подсказка про SSRF-политику; пусто → `webhooks.urlRequired`, невалидно → `webhooks.urlInvalid`), `events` — мульти-селект из дефолтного набора (`MultiSelectField`, ADR-052) + поле «свой паттерн» (валидатор `isWebhookEventPattern`; невалидный → `webhooks.form.patternInvalid`, дубль → `webhooks.form.patternDuplicate`), `enabled` (`ToggleField`). После создания/ротации — **однократный** показ signing-секрета (`secret`) + копирование + пример проверки подписи (`buildWebhookSignatureExample`: HMAC-SHA256, `X-Synth-Signature: t=<unix>,v1=<hex>`, тело `<t>.<raw body>`, окно 300 c). Инлайн-редактор, `regenerate` (ротация секрета, `confirm()`), `test` (тестовая доставка → запись журнала + тост), `delete` (`confirm()`, `ConfirmDialog`). **Read-only для не-ADMIN**: сообщение `webhooks.readOnly`, без кнопок мутаций (список доступен). i18n — `webhooks.*` (ru/en).
- **Журнал доставок** (`GET /:id/deliveries`, тумблер «Журнал доставок» в карточке): статус (ok/failed), `attempts`, `responseStatus`, `error`, время; при закрытии — сброс состояния.
- Типы `WebhookSubscription`/`WebhookSubscriptionCreated`/`WebhookDelivery`/`CreateWebhookSubscriptionInput`/`UpdateWebhookSubscriptionPatch` — из `@itphx/synth-shared` (type-only); значения `DEFAULT_WEBHOOK_EVENT_PATTERNS`/`isWebhookEventPattern` — из subpath `@itphx/synth-shared/types`.

## Идентичности профиля (ADR-089)

- **Секция «Идентичности»** в `components/settings/ProfileSettings.tsx` (Settings UI Kit, `SettingsSection`): список внешних аккаунтов профиля (`provider:externalId`, `displayName`/`username`, дата `linkedAt`), пустое состояние, ошибки; отвязка — кнопка с `confirm()` (`lib/confirm.ts`), после успеха строка удаляется локально. **Привязка (claim-flow, ADR-089):** поле одноразового кода + кнопка «Связать» → `synthApi.claimIdentity(code)` (`POST /me/identities/claim`), успех обновляет список, ошибки маппятся по статусу/коду (`404` → «код недействителен», `409` → «уже привязана», `400` → «укажите код»; повторный ввод сбрасывает сообщение), кнопка недоступна при пустом коде. Методы — `synthApi.getMyIdentities()` / `deleteMyIdentity(provider, externalId)` / `claimIdentity(code)` (`GET/DELETE/POST /api/v2/me/identities*`; RBAC — текущий пользователь). i18n-ключи `auth.identities*`/`auth.identityUnlink*`/`auth.identityLinkedAt`/`auth.identitiesLoadError`/`auth.identityUnlinkError`/`auth.identityClaim*` (ru/en).

## Мобильный / PWA

- Полные конвенции (зоны ≤768 / 769–1199 / ≥1200, дроверы, touch-first, PWA-шелл, баннер обновления) — в [ADR-044](../../docs/arch_decisions/adr-044-mobile-adaptive-ui-pwa.md) и кратко в корневом `AGENTS.md`; классами/баннером конкретно здесь не дублируются.
- Локально: `initDeviceClasses()` (`lib/device.ts:38`) вешает классы на `<html>`; для логики использовать `useDevice()`/`useMediaQuery()` (`hooks/`), а не `window.innerWidth` вручную.
- Мобильный CSS гейтится `html.device-*`/`html.pointer-coarse`; JS-признак — `deviceType !== 'desktop'`.
- `PwaUpdatePrompt` — баннер вне `AuthGate` (работает и на экране входа); источники — `SW.waiting` и `synthApi.getHealth().version !== SYNTH_VERSION`; проверка при монтировании, раз в 30 мин, по `visibilitychange` и на первом действии после простоя >1 ч; версия `sw.js` подставляется плагином `vite.config.ts` (`serviceWorkerVersionPlugin`) из `packages/shared/package.json`.

## Тесты и сборка

- Тесты — колокейт с исходником: `src/**/*.test.{ts,tsx}` (`vitest.config.ts:16`), окружение jsdom.
- Из пакета: `pnpm test` (`vitest run`) / `pnpm test:watch`; из корня — `pnpm test`.
- Сборка `pnpm build` = `tsc -b && vite build`; typecheck `pnpm typecheck` (`tsc --noEmit`); lint `pnpm lint` (`eslint src/`). Порядок проверок — корневой `AGENTS.md`.
- В тестах не поднимать реальный транспорт/сеть — мокать `synthApi` и сторы.

## Куда смотреть

| Тема | Куда |
|---|---|
| Стек и структура SPA | [ADR-019](../../docs/arch_decisions/adr-019-react-spa.md), [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) |
| Транспорт и события | [ADR-024](../../docs/arch_decisions/adr-024-eventhub-transport.md) |
| Ошибки LLM / i18n | [ADR-041](../../docs/arch_decisions/adr-041-llm-error-taxonomy.md) |
| Гибридный режим | [ADR-042](../../docs/arch_decisions/adr-042-hybrid-mode.md) |
| Мобильный UI / PWA | [ADR-044](../../docs/arch_decisions/adr-044-mobile-adaptive-ui-pwa.md) |
| Общие инварианты, команды, порты | [корневой AGENTS.md](../../AGENTS.md) |
