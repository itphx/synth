/**
 * ADR-101 (Pipeline Engine): санитизация данных, попадающих в прогон и журнал.
 *
 * Инвариант 13 (корневой `AGENTS.md`): секреты не пишутся в журналы и
 * документацию открытым текстом. Поэтому в прогон/журнал попадает только
 * **значимая часть** payload'а триггера и данных шага:
 * - ключи, похожие на секреты, вырезаются;
 * - ограничены глубина вложенности, длина строк и размер массивов.
 *
 * Константы и поведение — **как в legacy-трекере**
 * (`engine/events/pipeline-tracker.ts`, ADR-089): тот же regex секретов и те же
 * лимиты. Файл трекера не трогаем (ADR-100 → ADR-101: трекер уходит в
 * замену), поэтому константы повторены здесь явно; при замене трекера (Э5)
 * значения нужно сверить.
 */
import type { PipelineRunTrigger } from '@itphx/synth-shared';

/**
 * Ключи payload'а, значения которых **не** попадают в прогон/журнал
 * (секреты и креды).
 */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|apikey|authorization|credential|private[-_]?key|cookie|session[-_]?key|signature)/i;

/** Максимальная глубина вложенности payload'а. */
const MAX_PAYLOAD_DEPTH = 4;

/** Максимум элементов массива в payload'е. */
const MAX_PAYLOAD_ARRAY = 50;

/** Максимальная длина строкового значения в payload'е. */
const MAX_PAYLOAD_STRING = 1000;

/**
 * Очистка значения payload'а (секреты, глубина, длина, размер массива).
 *
 * Не-объектные значения, которые нечего чистить (число/булево/null),
 * сохраняются как есть; функции и символы отбрасываются.
 */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_PAYLOAD_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, MAX_PAYLOAD_ARRAY)) {
      const sanitized = sanitizeValue(item, depth + 1);
      if (sanitized !== undefined) items.push(sanitized);
    }
    return items;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeValue(item, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

/**
 * Очистка объекта payload'а: возвращает `undefined`, если после очистки не
 * осталось ни одного значимого поля.
 */
export function sanitizeRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeValue(value, 0);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return undefined;
  const record = sanitized as Record<string, unknown>;
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Санитизированный триггер прогона: payload очищен, остальные поля сохранены.
 *
 * Санитизированный триггер — **единственный** источник данных прогона: он
 * лежит в записи прогона, по нему разрешаются пути (`trigger.payload.*`) и
 * по нему же прогон возобновляется после HITL-паузы. Поэтому прогон
 * воспроизводим: данные шага не «уплывают» между запуском и возобновлением.
 */
export function sanitizeTrigger(trigger: PipelineRunTrigger): PipelineRunTrigger {
  const payload = sanitizeRecord(trigger?.payload);
  return {
    ...trigger,
    ...(payload ? { payload } : {}),
  };
}

/** Обрезка длинной строки (прогон/журнал не должен раздуваться). */
function truncate(text: string): string {
  return text.length > MAX_PAYLOAD_STRING ? `${text.slice(0, MAX_PAYLOAD_STRING)}…` : text;
}
