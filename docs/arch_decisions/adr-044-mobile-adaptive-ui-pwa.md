# ADR-044: Адаптивный мобильный UI + PWA

> **Статус:** ✅ Реализовано (0.5.0)
> **Дата:** 2026-09-06

**Решение:** сделать UI доступным с телефона/планшета и устанавливаемым как PWA,
**не ломая существующий десктоп-интерфейс**. Принят **единый адаптивный интерфейс**
(не отдельное мобильное дерево): те же компоненты, три зоны по ширине окна,
мобильное поведение гейтится CSS-классами на `<html>`. PWA — **ручной app-shell**
(статический манифест + минимальный service worker), без новых npm-зависимостей.

**Контекст:** интерфейс был полностью desktop-only: три колонки с фиксированными
px-ширинами, действия видны только по hover, чат-колонка `max-w-[50vw]`, нет
`@media` и PWA-обвязки. Продуктовое требование — «работает с телефона (часто
смотрю/отвечаю) и ставится на главный экран».

## Ключевые решения

| № | Вопрос | Решение |
|---|--------|---------|
| 1 | Подход | **Единый адаптивный интерфейс** — один App, три зоны; не отдельное мобильное дерево |
| 2 | Зоны | телефон ≤768px / планшет 769–1199px / десктоп ≥1200px; десктоп-зона не изменяется |
| 3 | Детекция | `matchMedia` + классы на `<html>`: `device-phone/tablet/desktop`, `pointer-coarse`; хуки `useDevice()`/`useMediaQuery` (useSyncExternalStore) |
| 4 | Изоляция десктопа | весь мобильный CSS/поведение гейтится классами `device-*`/`pointer-coarse` — десктоп-путь не трогаем |
| 5 | Раскладка на телефоне | чат на весь экран; левая/правая панели — **оверлей-дроверы** (`MobileDrawer`), управление из мобильного хедера; `ResizeHandle` скрыт |
| 6 | Нижняя навигация | **нет** — чат на всю высоту, навигация в верхнем баре и дроверах |
| 7 | Состояние панелей | мобильное (`mobileLeftOpen`/`mobileRightOpen`) не персистится в десктопные ширины (отдельный слой) |
| 8 | Touch-first | hover-действия доступны на таче (CSS под `html.pointer-coarse`), touch-таргеты ≥40px, нативные скроллбары на таче, нативный drag&drop отключён на таче |
| 9 | Подтверждения | `window.confirm` → `ConfirmDialog`; для zustand-сторов — глобальный confirm-сервис (`lib/confirm.ts` + `stores/confirmStore.ts`), рендер в `App` |
| 10 | Модалки/админка | `SettingsModal`/`LogsModal` на телефоне: категории → горизонтальные скролл-табы; табличные админ-панели (ModelsPanel) — горизонтальный скролл |
| 11 | Клавиатура | `useKeyboardInset` подписывается на `visualViewport` → CSS-переменная `--kb-inset` → `padding-bottom` композера; Enter на таче = перенос строки, на fine-pointer — отправка; IME учтён |
| 12 | PWA | **ручной app-shell**: статический `manifest.webmanifest` + минимальный `sw.js` (runtime-кэш шела; `/api,/ws,/auth,/admin,/health` не кэшируются; навигация network-first → офлайн-заглушка) |
| 13 | Иконки | 192/512/maskable/apple — сгенерированы из логотипа (`font` `rsvg-convert`/ImageMagick) в `public/icons/` |
| 14 | Инсталл | `usePwaInstall` + `PwaInstallButton` (`beforeinstallprompt`) — кнопка в мобильном хедере; регистрация SW только в prod |
| 15 | Раздача | `docker/nginx-ui.conf.template` (шаблон nginx; адрес backend'а — из `SYNTH_BACKEND_URL`): MIME `.webmanifest` + `no-cache` для `/sw.js`, `/manifest.webmanifest`; `packages/core/src/server/app.ts`: MIME `.webmanifest` + `no-cache` для sw/manifest |

## Особенности реализации

### Каркас адаптивности
- `packages/ui/src/lib/device.ts` — `BREAKPOINTS`, `initDeviceClasses()` (классы на `<html>`), `getDeviceType()`, `isCoarsePointer()` (SSR/jsdom-guard).
- `packages/ui/src/hooks/useMediaQuery.ts` — `useSyncExternalStore` на `matchMedia`.
- `packages/ui/src/hooks/useDevice.ts` — `useDevice()` → `{ deviceType: 'phone'|'tablet'|'desktop', isTouch }`.
- `isTouch = (pointer: coarse) && !(any-pointer: fine)` — «сенсор без точного указателя»; совпадает с классом `html.pointer-coarse`.
- Safe-area: `--synth-safe-area-top/right/bottom/left` из `env(safe-area-inset-*, 0px)`; высоты на `100dvh` (`--synth-app-height`).

### Раскладка
- `App.tsx` выбирает `<MobileDrawer>`-ветку по `deviceType !== 'desktop'`; десктопная ветка — прежний JSX.
- `MobileDrawer` — оверлей: fixed, полная высота, slide-in слева/справа, backdrop (клик/Esc закрывает), ширина `min(360px, 86vw)`, `inert` при закрытии.
- Мобильный хедер (`Header.tsx`): [☰ левая панель] [заголовок] […] [правая панель].
- Чат-колонка `max-w-[50vw]` → класс `chat-column` (CSS-переменные): phone — почти вся ширина, tablet — до 48rem, desktop — как было.
- Композер `w-4/5` → `chat-composer` (phone/tablet — почти вся ширина + нижний safe-area).

### Touch-first
- CSS `@media (hover: none) and (pointer: coarse)` / `html.pointer-coarse` в `styles/index.css`:
  - действия строк дерева/сообщений/вкладок/стикеров — всегда видимы (`group-hover:*` переопределены);
  - touch-таргеты ≥40px (кнопки хедера/дроверов/дерева/модалок);
  - нативные скроллбары вместо кастомного overlay-ползунка.
- `LeftPanel`/`TreeNode`: `draggable` отключён на таче (`isTouch`), drag-обработчики гейтятся.

### Подтверждения
- `lib/confirm.ts` — `confirm(opts): Promise<boolean>` (вызывается из zustand-сторов).
- `stores/confirmStore.ts` — `{ open, options, onResolve }` + `openConfirm/closeConfirm`.
- `App.tsx` рендерит глобальный `<ConfirmDialog>`. `window.confirm` в `packages/ui/src` удалён.

### Клавиатура
- `hooks/useKeyboardInset.ts`: `inset = max(0, innerHeight - (visualViewport.height + visualViewport.offsetTop))` → `--kb-inset` на `<html>`.
- `html.pointer-coarse .chat-composer { padding-bottom: var(--kb-inset, 0px) }` (safe-area уже в `margin-bottom` — без двойного отступа).
- Enter: touch → перенос строки, fine-pointer → отправка; `e.nativeEvent.isComposing` (IME) не отправляет.

### PWA
- `public/manifest.webmanifest` — `display: standalone`, `start_url: "./"`, theme/background `#09090b`, иконки 192/512/maskable/apple.
- `public/sw.js` — `synth-shell-v1`: install precache `'/'` + `skipWaiting`; activate `clients.claim` + чистка старых кэшей; fetch — пропуск не-GET/cross-origin/`/api,/ws,/auth,/admin,/health`; навигация network-first → офлайн-заглушка; статика cache-first (stale-while-revalidate).
- `index.html` — `<link rel="manifest">`, `theme-color`, `apple-touch-icon`, `apple-mobile-web-app-capable/status-bar-style/title`, `viewport-fit=cover`.
- Регистрация SW только в `import.meta.env.PROD`.

### Раздача
- `docker/nginx-ui.conf.template` (шаблон nginx, `envsubst`; адрес backend'а — из `SYNTH_BACKEND_URL`): `location = /manifest.webmanifest { default_type application/manifest+json; add_header Cache-Control "no-cache"; }` и `location = /sw.js { ... no-cache, no-store, must-revalidate }`.
- `packages/core/src/server/app.ts`: `MIME_TYPES['.webmanifest'] = 'application/manifest+json'`; `Cache-Control: no-cache` для `.html`, `.webmanifest` и `sw.js`.

### Фиксы логина (в рамках этой работы)
- Поле «Адрес сервера» показывается **только** при `oidcEnabled && hybridEnabled && !serverConfigured` (эндпоинт `/hybrid/status` есть только в standalone-core; на managed-бэкенде 404 → поле скрыто).
- Enter в поле «Логин» → фокус на «Пароль»; Enter на заполненном пароле → `form.requestSubmit()` (мобильная клавиатура не прячет поле пароля).

## Ключевые файлы
- `packages/ui/src/lib/device.ts`, `hooks/useMediaQuery.ts`, `hooks/useDevice.ts`
- `packages/ui/src/components/layout/{MobileDrawer,Header}.tsx`
- `packages/ui/src/App.tsx`
- `packages/ui/src/components/chat/{MessageList,ChatInput,ChatTab}.tsx`
- `packages/ui/src/styles/index.css` (мобильные + touch-правила), `styles/design-system.css`
- `packages/ui/src/hooks/useKeyboardInset.ts`
- `packages/ui/src/lib/confirm.ts`, `stores/confirmStore.ts`
- `packages/ui/src/components/settings/SettingsModal.tsx`, `components/logviewer/LogsModal.tsx`, `components/admin/ModelsPanel.tsx`
- `packages/ui/src/hooks/usePwaInstall.ts`, `components/layout/PwaInstallButton.tsx`
- `packages/ui/public/{manifest.webmanifest, sw.js, icons/*}`
- `packages/ui/index.html`
- `docker/nginx-ui.conf.template`, `packages/core/src/server/app.ts`
