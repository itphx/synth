/**
 * ADR-126 §0/§2: контракты «поверхности ввода» — упоминания (`@`), скиллы
 * (`$`) и сниппеты (`#`).
 *
 * Модуль **browser-safe** (без `node:*`): типы читают и ядро (парсер
 * `engine/input-surface/parser.ts`), и UI (подсветка токенов в композере).
 * Разбор текста живёт в core — здесь только контракты (ADR-095: типы в shared).
 */

/** Вид упоминания сущности: файл, агент или пользователь. */
export type MentionKind = 'file' | 'agent' | 'user';

/**
 * Позиция токена в исходном тексте: 0-based, `end` — **exclusive**.
 * Индексы — в единицах UTF-16 (как индексы JS-строки), `text.slice` по ним
 * даёт ровно исходный токен.
 */
export interface MentionSpan {
  start: number;
  end: number;
}

/** Упоминание сущности (`@`). */
export interface InputMention {
  /**
   * Вид упоминания. На этапе лексики (`core/engine/input-surface/parser.ts`)
   * вид выводится по форме токена: путь (`/` или `.`) — `file`, иначе `agent`.
   * Окончательное разрешение (в т.ч. `@user`) — задача позднего резолвера
   * (ADR-126 §2).
   */
  kind: MentionKind;
  /** Нормализованный идентификатор: без префикса и без завершающей пунктуации. */
  id: string;
  /** Текст без префикса — как его набрал пользователь (может отличаться от `id`). */
  label: string;
  /** Границы токена в исходном тексте (включают префикс). */
  span: MentionSpan;
}

/** Явный вызов скилла (`$`). */
export interface SkillMention {
  /** Имя скилла (без префикса и без завершающей пунктуации). */
  id: string;
  /** Текст без префикса — как его набрал пользователь. */
  label: string;
  span: MentionSpan;
}

/** Ссылка на сниппет (`#`). */
export interface SnippetMention {
  /** Имя сниппета (без префикса и без завершающей пунктуации). */
  id: string;
  /** Текст без префикса — как его набрал пользователь. */
  label: string;
  span: MentionSpan;
}

/** Результат разбора пользовательского текста. */
export interface ParsedInput {
  /** Исходный текст без изменений: префиксы и экранирование сохранены. */
  text: string;
  /** Упоминания `@` в порядке появления. */
  mentions: InputMention[];
  /** Вызовы скиллов `$` в порядке появления. */
  skills: SkillMention[];
  /** Ссылки на сниппеты `#` в порядке появления. */
  snippets: SnippetMention[];
}

/** Род токена ввода. */
export type InputTokenKind = 'mention' | 'skill' | 'snippet';

/**
 * Плоский вид токена ввода (упоминание/скилл/сниппет в одном списке) — для
 * подсветки и чипов в композере UI.
 */
export interface InputToken {
  kind: InputTokenKind;
  id: string;
  label: string;
  span: MentionSpan;
}
