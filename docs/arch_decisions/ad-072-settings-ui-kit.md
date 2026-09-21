# AD-072: Settings UI Kit — стандартная панель настроек

> **Статус:** ✅ Реализовано (коллекция `components/ui/settings/` — стандарт; все разделы настроек и админ-категории мигрированы, legacy-разметка удалена)
> **Дата:** 2026-09-21
> **Реализация:** Ф1 — коллекция `packages/ui/src/components/ui/settings/` (`SettingsPanel`/`Section`/`Field`/`Row`/`Actions`/`DefaultsBadge`, контролы, `useSettingsDraft`), тесты, barrel; мелкий фикс Tailwind (`overscroll-behavior-contain` → `overscroll-contain`). Ф4b — миграция админ-категорий и разделов, `SliderField` и `SegmentedControl` в Kit, удалён `components/settings/settings-layout.tsx` (`SettingsPage`/`SettingsCard`), `window.confirm` → `confirm()` в админ-панелях. Ф5 — доработка по фидбеку: единый слайдер на `.ui-range`, контрол `Tabs`, сворачивающаяся шапка и затенение скролла `SettingsPanel` на мобильных. Ф5b — фикс высоты сворачивания шапки (`min-h-0 overflow-hidden` у описания), сброс/отмена как часть контракта (Notifications/Chat/Profile/Routing), `RoutingSettings` на `useSettingsDraft`.
> **Парные документы:**
> - [AD-019](./ad-019-react-spa.md) «React 19 SPA с нуля» — базовые UI-примитивы (`components/ui/`);
> - [AD-044](./ad-044-mobile-adaptive-ui-pwa.md) «Адаптивный мобильный UI + PWA» — зоны, touch-first, мобильные правила;
> - [AD-070](./ad-070-system-prompt-composer.md) «SystemPromptComposer» — образец композиции/идемпотентности, из которого заимствован принцип «одна точка сборки»;
> - [AD-071](./ad-071-mcp-servers-prompt.md) «MCP-серверы» — первый крупный потребитель будущей миграции разделов настроек.

**Решение:** ввести единый UI-кит панели настроек `components/ui/settings/` как обязательный стандарт для всех разделов настроек и админ-панелей. Новые разделы собираются только из него; существующие мигрируются отдельными шагами.

---

## 1. Контекст и проблема

1. **Разъезжающаяся вёрстка.** Разделы настроек (`components/settings/`, `components/admin/`) собирались независимо: каждый сам верстает шапку, тело и футер. Отсюда асимметричные паддинги (`pr-2`), разная ширина контента (`max-w-2xl`/`max-w-3xl`/без ограничения), горизонтальный скролл и «не по центру» на десктопе.
2. **Недействительный Tailwind-класс.** `overscroll-behavior-contain` — не утилита Tailwind (`overscroll-behavior` + `contain` без дефиса), инертный шум в разметке. Правильно — `overscroll-contain`.
3. **Дублирование контракта черновика.** Сохранение/отмена/сброс реализуются в каждом разделе вручную; поведение `dirty`/`isDefault` и синхронизация с внешним значением повторяются с расхождениями.
4. **Дублирование редакторов списков.** `StringListEditor` в `SecuritySettings.tsx`, чипы паттернов и списки путей — одна и та же логика «добавить/удалить/править», но разными реализациями, часто переполняющими контейнер.

## 2. Решения

### 2.1. Принципы вёрстки (инварианты панели)

- **Один вертикальный скролл.** Скроллится только тело; шапка — `shrink-0` вне scroll-контейнера. Действия формы рендерятся в конце тела (внутри scroll-контейнера), фиксированный футер не используется.
- **Фиксированная шапка.** `header` не участвует в прокрутке.
- **Ноль горизонтального скролла.** Тело — `overflow-x-hidden`; все вложенные блоки несут `min-w-0`, текст — `break-words`.
- **Центрирование `max-w-3xl`.** Шапка, тело и футер используют одну ширину (`mx-auto w-full max-w-3xl`), поэтому контент стоит по центру на широких экранах.
- **Симметричные паддинги.** Никаких `pr-2`/асимметрий — отступы задаются контейнером целиком.
- **Сетки — с базовым `grid-cols-1`.** Многоколоночные сетки начинаются с одной колонки на теле и расширяются на `sm`+.

### 2.2. Состав коллекции `components/ui/settings/`

| Элемент | Назначение |
|---|---|
| `SettingsPanel` | Каркас: `title`/`description`/`actions`/`footer`, `footerVariant`, `contentClassName` |
| `SettingsSection` | Карточка-секция (`title`/`description`/`actions`) |
| `SettingsField` | Вертикальный лейбл + описание + контрол + ошибка |
| `SettingsRow` | Строка «лейбл слева — контрол справа» (на теле колонка) |
| `SettingsActions` | Ряд `Reset`/`Save`/`Cancel` с disabled-состояниями |
| `DefaultsBadge` | Пилюля «По умолчанию» |
| `controls/TextField`, `NumberField`, `SliderField`, `TextArea`, `SelectField`, `ToggleField`, `ListField`, `SegmentedControl`, `Tabs` | Управляемые контролы |
| `useSettingsDraft` | Контракт черновика (см. §2.3) |
| `index.ts` | Barrel **только** этой коллекции; общий `components/ui/index.ts` не трогается |

Все пользовательские строки — через `useI18n().t()`; лейблы `SettingsActions`/`ListField` по умолчанию берутся из `common.save`/`common.cancel`/`common.reset`/`common.add`/`common.delete`/`common.empty`, пилюля — `settings.kit.defaultsBadge`. Цвета — только токены темы.

### 2.3. Контракт черновика `useSettingsDraft`

- `draft` инициализируется из `value`;
- при внешнем изменении `value`: `saved = value`, `draft` обновляется **только пока `!dirty`** (правки пользователя не затираются);
- `dirty = !equals(draft, saved)`; дефолтный `equals` — глубокое сравнение `JSON.stringify`;
- `isDefault = defaultValue != null && equals(draft, defaultValue)`;
- `save()` — no-op при `!dirty`/`saving`, вызывает `onSave(draft)`, при успехе обновляет `saved`/`draft` возвращённым значением (или текущим `draft`), при ошибке возвращает `false` и снимает `saving`;
- `revert()` — `draft = saved`; `resetToDefault()` — `draft = defaultValue`.

### 2.4. Футер: `footer` / `footerVariant` — возможность, а не стандарт

- Пропы `footer` и `footerVariant` (`fixed`/`sticky`) сохранены как возможность Kit, но **нигде не используются**: `fixed` (по умолчанию) рендерил бы футер **вне** scroll-тела (`shrink-0 border-t bg-background mt-4`), `sticky` — в конце scroll-тела (`sticky bottom-0 bg-background/95 backdrop-blur border-t`).
- Стандарт: `SettingsActions` рендерятся **в конце содержимого** панели, последним элементом children внутри scroll-тела (после последней `SettingsSection`), как в `DefaultsPanel`/`ToolsDisabledSettings`/`RoutingSettings`. Разделов с `footer`/`footerVariant` нет.

### 2.5. Мобильные правила

- На теле действия шапки уходят под заголовок (`flex-col` → `sm:flex-row`).
- Ряды `SettingsRow` и пары «контрол + кнопка» в `ListField` переносятся (`flex-wrap`), кнопки — `shrink-0`, поля — `flex-1 min-w-0`.
- `NumberField` на теле — `w-full`, с `sm` — `sm:w-24`.
- Ряд действий (`SettingsActions`) с `flex-wrap`, чтобы кнопки не обрезались.

### 2.6. Связь с `Button` и AD-070

- Действия собираются из `Button` (`@/components/ui/button`): `primary` — Save, `ghost` — Cancel, `danger` — Reset (destructive отделён `mr-auto`).
- Как AD-070 задаёт единую точку сборки system prompt, AD-072 задаёт единую точку сборки панели настроек: один каркас, один контракт черновика, один набор контролов. Отклонения допустимы только через `className`/`contentClassName`, а не копированием разметки.

### 2.7. Мелкий фикс

`overscroll-behavior-contain` → `overscroll-contain` во всех файлах `packages/ui/src` (settings, admin, logviewer) — недействительный класс не давал эффекта.

### 2.8. Доработки по фидбеку (Ф5)

- **Единый слайдер.** `controls/SliderField.tsx` — единственный слайдер в проекте; построен на CSS-классе `.ui-range` и CSS-переменной `--ui-range-fill` (заполнение трека вычисляется из `value`/`min`/`max`, зажимается в 0–100 %, без деления на ноль). Разметка: label слева, справа `input[type=range]` + значение (`font-mono tabular-nums min-w-[4ch] text-right`) + опциональная компактная кнопка сброса (`Icon name="refresh"`, `data-compact`). `aria-label` = `label`, `data-testid="slider-value"`. `stacked` (по умолчанию `true` на телефоне/планшете, `false` на десктопе) переключает колонку (`flex-1 min-w-0`) и строку (`w-24 sm:w-32`). `UiScaleSlider`/`UiScaleControl` — тонкие обёртки над Kit-слайдером (масштаб UI передаётся долей, подпись — проценты); `accent-primary` не используется.
- **`Tabs`** (`controls/Tabs.tsx`) — мобильно-устойчивый переключатель вкладок: контейнер `flex w-full min-w-0 items-stretch gap-1 rounded-lg bg-muted p-1`, вкладки `flex-1 min-w-0` с `break-words` (или `truncate` при `title`), активная — `bg-background text-foreground shadow-sm`. `variant="underline"` — подчёркивание активной без фона. При переполнении контейнер скроллится по X с затенением (`tab-scroll-container` + `data-scroll-shadow`).
- **Сворачивающаяся шапка `SettingsPanel`.** Проп `collapsibleHeader?: boolean` (по умолчанию `true`). Только на не-десктопе (`useDevice()`, `deviceType !== 'desktop'`) при `scrollTop > 8` описание скрывается (`grid-rows-[0fr]` + `opacity-0` + `overflow-hidden`, плавный `transition`, `motion-reduce:transition-none`), остаются заголовок и `actions`; при возврате наверх — разворачивается. На десктопе описание видно всегда. Шапка — `shrink-0` (не скроллится). Дочерний `<p>` описания несёт `min-h-0 overflow-hidden` — без этого grid-строка `0fr` не схлопывается ниже `min-content` (описание визуально исчезало, но высота шапки не уменьшалась).
- **Затенение скролла.** Тело панели — `settings-scroll-container` + `data-scroll-shadow` (`top`/`bottom`/`top-bottom`), как в `MessageList`. CSS — общие правила с `.chat-scroll-container` в `styles/design-system.css`, размер затенения переопределён (`--scroll-shadow-size: 1.5rem`); mask работает по alpha, поэтому темы не требуют отдельных правил. `ResizeObserver` подключается только при наличии (jsdom-safe).
- **Футер.** `footer`/`footerVariant` (`fixed`/`sticky`) — доступная возможность Kit, но **нигде не применяется** (не стандарт): во всех разделах действия формы рендерятся в конце содержимого, внутри scroll-тела.

### 2.9. Действия формы: сброс и отмена — часть контракта (Ф5b)

- **`SettingsActions`** — единственный ряд действий. Сброс (`onReset`, `variant="danger"`, отделён `mr-auto`) и отмена (`onCancel`, `variant="ghost"`) доступны и без Save: разделы с автосохранением (`NotificationSettings`, `ChatSettings`) используют только `onReset` с `align="start"`.
- **Сброс к дефолтам.** `useSettingsDraft.resetToDefault()` — для черновиков; вне `useSettingsDraft` — явный store-экшен (`resetCategories()` в `notificationStore`, `setIntermediateTextDisplay('inline')` в `useUIStore`).
- **Отмена.** Для форм без черновика (`ProfileSettings`) хранится снапшот загруженного состояния (`savedForm`), `onCancel` откатывает форму к нему и сбрасывает `error`/`success`; кнопка Cancel `disabled`, пока значимые поля (включая `avatar`) не изменились. После успешного сохранения снапшот обновляется, и Cancel снова `disabled`.
- **Routing.** Глобальные дефолты маршрутизации (`RoutingSettings`) переведены на `useSettingsDraft<RoutingDefaults>` (первичная загрузка — `loadRoutingDefaults()`, дефолт — `DEFAULT_ROUTING_DEFAULTS`, сохранение — `saveRoutingDefaults`); автосохранение в localStorage на каждое изменение убрано. `DictionarySection` сохраняет собственные Save/Cancel/Reset.
- **Индикатор несохранённых изменений** — ненавязчивая плашка `settings.kit.unsavedChanges` при `draft.dirty` (как `mcp.permissions.unsaved` в `McpSettings`).


## 3. Последствия

- **Плюсы:** единообразие и центрирование, отсутствие горизонтального скролла, переиспользуемый контракт черновика и контролов, снижение дублирования.
- **Итог миграции:** коллекция — единственная точка сборки раздела/админ-панели; legacy `components/settings/settings-layout.tsx` (`SettingsPage`/`SettingsCard`) удалён, `SegmentedControl` перенесён в `controls/SegmentedControl.tsx`; `window.confirm` в админ-панелях заменён на `confirm()` из `@/lib/confirm`.
- **Внедрение:** новые разделы — только на `components/ui/settings/`; отклонения допустимы через `className`/`contentClassName`, а не копированием разметки.
