# AD-072: Settings UI Kit — стандартная панель настроек

> **Статус:** ⚠️ Частично (коллекция `components/ui/settings/` создана и является стандартом; существующие разделы настроек ещё не мигрированы — внедрение отдельными шагами)
> **Дата:** 2026-09-21
> **Реализация:** Ф1 — коллекция `packages/ui/src/components/ui/settings/` (`SettingsPanel`/`Section`/`Field`/`Row`/`Actions`/`DefaultsBadge`, контролы, `useSettingsDraft`), тесты, barrel; мелкий фикс Tailwind (`overscroll-behavior-contain` → `overscroll-contain`).
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

- **Один вертикальный скролл.** Скроллится только тело; шапка и `fixed`-футер — `shrink-0` вне scroll-контейнера.
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
| `controls/TextField`, `NumberField`, `TextArea`, `SelectField`, `ToggleField`, `ListField` | Управляемые контролы |
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

### 2.4. Футер: `fixed` vs `sticky`

- `fixed` (по умолчанию) — футер рендерится **вне** scroll-тела (`shrink-0 border-t bg-background mt-4`), всегда виден.
- `sticky` — футер рендерится **в конце** scroll-тела внутри центрированной обёртки как `sticky bottom-0 bg-background/95 backdrop-blur border-t`.

### 2.5. Мобильные правила

- На теле действия шапки уходят под заголовок (`flex-col` → `sm:flex-row`).
- Ряды `SettingsRow` и пары «контрол + кнопка» в `ListField` переносятся (`flex-wrap`), кнопки — `shrink-0`, поля — `flex-1 min-w-0`.
- `NumberField` на теле — `w-full`, с `sm` — `sm:w-24`.
- Футер с `flex-wrap`, чтобы кнопки не обрезались.

### 2.6. Связь с `Button` и AD-070

- Действия собираются из `Button` (`@/components/ui/button`): `primary` — Save, `ghost` — Cancel, `danger` — Reset (destructive отделён `mr-auto`).
- Как AD-070 задаёт единую точку сборки system prompt, AD-072 задаёт единую точку сборки панели настроек: один каркас, один контракт черновика, один набор контролов. Отклонения допустимы только через `className`/`contentClassName`, а не копированием разметки.

### 2.7. Мелкий фикс

`overscroll-behavior-contain` → `overscroll-contain` во всех файлах `packages/ui/src` (settings, admin, logviewer) — недействительный класс не давал эффекта.

## 3. Последствия

- **Плюсы:** единообразие и центрирование, отсутствие горизонтального скролла, переиспользуемый контракт черновика и контролов, снижение дублирования.
- **Минусы/риски:** миграция существующих разделов — отдельные шаги; до завершения в кодовой базе сосуществуют старый `SettingsPage`/`SettingsCard` (`components/settings/settings-layout.tsx`) и новая коллекция.
- **Внедрение:** новые разделы — только на `components/ui/settings/`; старые мигрируются по одному, без массового рефакторинга «заодно».
