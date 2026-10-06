# UI Kit — роли поверхностей и правила оформления

> Dev-документ (архитектурные соглашения для разработчиков UI). Пользовательская
> документация — на портале [docs.synth.itphx.ru](https://docs.synth.itphx.ru/).
> Правила обязательны при правке разметки `packages/ui`: цвета — только
> CSS-переменные/токены темы, без hex/oklch-литералов и хардкода Tailwind-палитры.

## Сводка sweep (инвентаризация → результат)

Замеры по `packages/ui/src` без тестовых файлов.

| Метрика | Исходно | После sweep-1..4 | После sweep-2 |
|---|---|---|---|
| видов `bg-*` | 104 | **76** | **65** |
| хардкод-палитра `bg-*` (вхождения) | ~40 | **16** | **3** |
| хардкод-палитра `text-*` (вхождения) | ~185 | — | **11** |
| хардкод-палитра `border-*` (вхождения) | ~23 | — | **2** |
| ad-hoc альфы (`bg-interactive-hover/50`, `bg-muted/30`, …) | множество | устранены | 0 |

**Sweep-1..4** (роли поверхностей): 104 → 76 видов `bg-*`, хардкод-палитра
`bg-*` ≈ 40 → 16 вхождений; ad-hoc альфы сведены к ролям; плавающие слои
переведены на `bg-popover` + `text-popover-foreground`. Роли `panel`
(`bg-muted` / `bg-secondary` / `bg-sidebar`) и коллизия `card`↔`popover` описаны
ниже.

**Sweep-2** (точечный, семантика; этот проход):

- уровни логов (`logviewer/logFormat.ts`) — `sky/emerald/amber/red/green-100..900`
  и парность `dark:` → `status-info|success|warning|error` (фон `/15`, текст);
- статусные иконки/состояния (`layout/Header.tsx`, `chat/FileViewerTab.tsx`,
  `chat/CommitDetailTab.tsx`) → `text-status-*`;
- легенда метрик (`panels/StatsTab.tsx`, 32 вхождения) → фиксированные слоты
  палитры темы `--palette-N` (инлайн-стиль), а не Tailwind-палитра;
- ссылки (`panels/ReferencesTab.tsx`) → `status-info` (hover сохранён);
- ручка ресайза (`layout/ResizeHandle.tsx`) → `hover:bg-primary`;
- плейсхолдеры секретов (`chat/SecretPlaceholder.tsx`) → `--palette-13`
  (скрыт) / `--palette-3` (раскрыт).

Итог: 16 вхождений хардкод-палитры (3 `bg-` + 11 `text-` + 2 `border-`) остались
осознанно — см. «Осознанно оставленные хардкод-цвета».

## Контракт ролей поверхностей

Финальный контракт: любая непрозрачная поверхность выбирается из таблицы, а не
из Tailwind-палитры; семантика (статусы/метрики) — из токенов `status-*`/слотов
`--palette-N`.

| Роль | Где применяется | CSS-переменная | Tailwind-класс |
|------|-----------------|----------------|----------------|
| **page** | фон приложения/экрана | `--surface-background` | `bg-background` / `bg-surface-page` |
| **panel** | боковые панели, секции-обёртки | `--surface-muted` | `bg-sidebar` / `bg-muted` / `bg-surface-panel` |
| **card** | карточки, контентные секции | `--surface-elevated` | `bg-card` / `bg-surface-card` |
| **inset** | вложенный блок, строка списка, пустое состояние | `--surface-subtle` | `bg-surface-inset` |
| **menu** | меню, поповер, дропдаун, выпадающий список | `--surface-raised` | `bg-popover` / `bg-surface-menu` |
| **input** | поля ввода | `--input` | `bg-input` |

Семантические алиасы (`--color-surface-*` в `@theme inline`,
`packages/ui/src/styles/design-system.css`) позволяют писать `bg-surface-inset`,
`bg-surface-menu`, `bg-surface-card` и т. д. — это предпочтительная форма для новых
мест; `bg-card`/`bg-popover` остаются каноническими для примитивов.

### Пятая поверхность — `raised`

Тема получает независимую поверхность `surface.raised` / `surface.raisedForeground`
для роли **menu** (плавающие слои). CSS-контракт: `--surface-raised` /
`--surface-raised-foreground`; `--popover` → `var(--surface-raised)`,
`--popover-foreground` → `var(--surface-raised-foreground)`.

`raised` добавлен как **опциональное** поле типа `SurfaceColors`: если тема его не
задаёт, `cssGenerator` подставляет фоллбек на `elevated` / `elevatedForeground`
(поведение до появления поля не меняется). Так новые темы можно раскатывать
постепенно.

### Плавающий слой: поверхность + тень, рамка вне контракта

Плавающий слой (меню, поповер, дропдаун, тултип, контекстное меню) определяется
**ролью `menu` + тенью**: `bg-popover` (`--surface-raised`) + `text-popover-foreground`
+ `shadow-lg`. **Рамка в контракт не входит.** `border` может присутствовать как
опциональное усиление (канон примитивов — `border border-border`), но:

- он не является определяющим признаком слоя — разделение даёт поверхность+тень;
- ему не задают собственный ролевой цвет (`border-sidebar-border` и т. п.) —
  только `border-border`;
- его отсутствие не делает слой «неправильным», использование без
  поверхности/тени — делает (слой сольётся с контентом).

## Правила

1. **Не плодить ad-hoc поверхности** с произвольными альфами
   (`bg-interactive-hover/50`, `bg-muted/30`, `bg-surface-subtle/50`, …). Нужна
   поверхность — выбрать роль из таблицы выше.
2. **Семантика — только `status-*` токены.** Успех/ошибка/предупреждение/инфо —
   `bg-status-success|warning|error|info` и одноимённые `text-*`/`border-*`
   (можно с альфой `/15` для плашек). Не использовать `emerald/amber/yellow/blue/
   purple/red/…` из палитры Tailwind.
3. **Серии/идентичности — слоты `--palette-N`.** Категориальные цвета (метрики,
   цвета сущностей, идентичность секрета) берутся из палитры темы
   (`--palette-1..16`, `palette.colors`) — инлайн-стилем либо Tailwind-арбитрарным
   `text-[color:var(--palette-N)]`. Один и тот же объект/метрика всегда получает
   один и тот же слот во всех местах.
4. **Вложенное на карточке — `inset`, плавающее — `menu`.** Вложенный блок/строка
   внутри `bg-card` берёт `bg-surface-inset`; меню/поповер — `bg-popover`
   (поверхность `raised`), тень `shadow-lg` (см. правило о рамке выше), чтобы не
   сливаться с карточкой.
5. **Пустые состояния и строки списков** — `inset` + рамка: `rounded-lg border
   border-border bg-surface-inset` с muted-текстом (при необходимости — иконка).
   Не рисовать «прозрачный rect с рамкой» (`border border-dashed` без фона) — такая
   заглушка не читается на разных поверхностях.
6. **Вкладки** — единый паттерн: контейнер на `panel`, активная вкладка — светлее
   фона (`bg-card text-foreground`), неактивные — `text-muted-foreground
   hover:bg-interactive-hover`. Ориентир — `ui/settings/controls/Tabs.tsx`;
   `RightPanel` следует тому же виду.

## Плавающие слои (рецептура, реализовано)

Глубина плавающего слоя задаётся **тенью-как-рамкой**, а не сплошной `border`.
Контейнер несёт тонкий ореол `ring-1 ring-foreground/10` по контуру тени плюс
саму тень; сплошная рамка при этом не используется.

| Часть рецептуры | Значение |
|---|---|
| Ореол-рамка | `ring-1 ring-foreground/10` |
| Поверхность | `bg-popover` + `text-popover-foreground` (роль `menu`) |
| Тень: меню/поповер/селект/контекст-меню, в т.ч. `ModelSelector`, `AgentModeSelector`, `ReasoningLevelSelector`, `MentionPopup`, `CommandAutocomplete` | `shadow-lg` |
| Тень: тултип | `shadow-md` |
| Тень: диалог | `shadow-xl` (поверхность диалога — `bg-background`) |
| Радиусы | концентрические: контейнер `rounded-xl` + `p-1`, пункты внутри `rounded-lg` (разница радиусов = паддинг контейнера) |
| Разделители | компонент `Divider` (`components/ui/Divider.tsx`): в плавающем слое `tone="raised"` + `inset` (линия не касается краёв), на обычных поверхностях `tone="default"` (= `bg-border`) |

Карточка входа (`components/auth/LoginForm.tsx`) следует рецепту
плавающего слоя, но на поверхности **card** (`bg-card`): `rounded-xl` +
`ring-1 ring-foreground/10` + `shadow-xl`; внутренние поля — `rounded-lg`
(концентрические радиусы), акцентная полоска сверху — `rounded-t-xl`.

**Разделители.** Любой разделитель — компонент `Divider`
(`components/ui/Divider.tsx`), а не ad-hoc `border-t`/`border-b` и не самостоятельный
`<hr>`. В плавающем слое (`bg-popover`) — `tone="raised"`
(`bg-popover-foreground/25`) + `inset`, чтобы линия не касалась краёв контейнера;
отступ подбирается по контейнеру (внутри `p-1` меню — `mx-2`). На обычных
поверхностях — `tone="default"` (`bg-border`), без `inset`, если линия должна делить
контейнер целиком.

Затронутые компоненты: `components/ui/contextMenu.tsx`,
`components/ui/popover.tsx`, `components/ui/select.tsx`,
`components/ui/dialog.tsx`, `components/ui/tooltip.tsx`,
`chat/ModelSelector.tsx`, `chat/AgentModeSelector.tsx`,
`chat/ReasoningLevelSelector.tsx`, `chat/MentionPopup.tsx`,
`chat/CommandAutocomplete.tsx`.

## Блоки настроек (AD-072)

Двухуровневый контракт «секция → пункт»: фон пункта всегда отличается от фона
секции.

| Элемент | Роль | Классы |
|---|---|---|
| `SettingsSection` (`components/ui/settings/SettingsSection.tsx`) | группа (surface **elevated**) | `rounded-xl border border-border/60 bg-card p-4 space-y-3` |
| `SettingsItem` (`components/ui/settings/SettingsItem.tsx`) | пункт (surface **subtle**) | `rounded-lg border border-border bg-surface-inset p-3` |

Правила:

- **«фон пункта ≠ фон секции»** — внутри `bg-card` пункт всегда `bg-surface-inset`
  (не `bg-card` и не `bg-popover`).
- **Не вкладывать секции друг в друга** — вложенную группу выносить отдельной
  `SettingsSection`; одинаковые поверхности подряд не ставить.
- **Интерактивные строки** (checkbox/radio, hover-выбор) обязаны иметь
  `bg-surface-inset` — например
  `flex … rounded-lg border border-border/60 bg-surface-inset … cursor-pointer`;
  заблокированная строка — тот же фон + `border-dashed … opacity-* cursor-not-allowed`.

Эталоны: `NotificationSettings` (`SettingsSection` + `SettingsItem`/`ToggleField`),
`ToolsDisabledSettings` (строки чекбоксов, в т.ч. disabled), `CommandsSettings`
(списки/строки).

## Подавление transition при смене темы

`ThemeCssGenerator.apply` (`packages/ui/src/lib/theme/cssGenerator.ts`) перед
применением новых CSS-переменных гасит анимации, иначе смена темы «плывёт» —
перекраска всех поверхностей анимируется.

Порядок:

1. снять прежний элемент `#theme-transition-suppress`, если остался;
2. вставить
   `<style id="theme-transition-suppress">*,*::before,*::after{transition:none!important}</style>`;
3. форсировать reflow (`void document.body?.offsetHeight`);
4. применить переменные темы;
5. снять подавление через два кадра (`requestAnimationFrame` → `requestAnimationFrame` → `remove()`).

## Осознанно оставленные хардкод-цвета

Полный список намеренных исключений из правила «только токены темы». Каждое
место сопровождается причиной; при появлении канонического токена — переводить.

| Место | Цвета | Причина |
|---|---|---|
| `chat/SubagentPart.tsx`, `chat/SubagentResumeBar.tsx` | `text-purple-300/400/500/600`, `bg-purple-500/5|10`, `border-purple-500/20` | Идентичность **саб-агента** (фиолетовый — визуальный маркер дочерней сессии). Отдельного токена нет; `AgentInfo.color` здесь не применим (блок не про конкретного агента). При появлении канонического токена саб-агента — перевести. |
| `tree/TreeNode.tsx` | `text-orange-400` (`hasUnread`) | Авторский акцент «непрочитанного» узла дерева (сущность без сохранённого цвета). Не статус (`status-warning` несёт иную семантику) и не слот палитры сущности. Зафиксировано `TreeNode.test.tsx`. |
| `components/ui/dialog.tsx`, `chat/DebugModal.tsx`, `App.tsx` | `bg-black/40|50|70` (scrim) | Затемняющая подложка модалок/дровера: тема-независимый чёрный с альфой, а не поверхность. Замена на `bg-background/80` меняла бы вид в светлых темах. |
| Подсветка синтаксиса (редактор, markdown, tool-render) | `--syntax-*` / `syntax.*` | Не хардкод: цвета приходят из токенов темы `--syntax-*` (`cssGenerator.generateSyntaxColors`), но требуют независимой от UI-палитры семантики подсветки. Вне sweep. |

## Связанные места

- Типы темы: `packages/ui/src/types/theme.ts` (`SurfaceColors`, `palette`).
- Генератор CSS-переменных: `packages/ui/src/lib/theme/cssGenerator.ts`
  (`generateTailwindVariables`, `generateSurfaceColors`, `generateSyntaxColors`,
  `--palette-1..16`).
- Токены Tailwind: `packages/ui/src/styles/design-system.css` (`@theme inline`,
  `--color-surface-*`, `--color-status-*`).
- Резолвер палитры сущностей: `packages/ui/src/lib/projectMeta.ts`
  (`PROJECT_COLOR_MAP` → `var(--palette-N)`).
- Примитивы плавающих слоёв: `components/ui/popover.tsx` (menu),
  `components/ui/select.tsx` (menu), `components/ui/dialog.tsx` (scrim).
- Примитивы блоков настроек: `components/ui/settings/SettingsSection.tsx`,
  `components/ui/settings/SettingsItem.tsx` (AD-072).
