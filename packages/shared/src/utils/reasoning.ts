// Накопление блоков рассуждений (reasoning) модели

/**
 * Блок рассуждений: текст и итерация Tool Use, к которой он относится.
 * `signature`/`redacted` — служебные данные Anthropic-протокола: подпись
 * thinking-блока и opaque-данные `redacted_thinking` (аддитивные поля,
 * остальные провайдеры их не заполняют).
 */
export interface ReasoningBlock {
  text: string;
  iteration: number;
  signature?: string;
  redacted?: string;
}

/** Служебная подпись блока (передаётся в `appendReasoningBlock`). */
export interface ReasoningBlockMeta {
  signature?: string;
  redacted?: string;
}

/**
 * Накопить блок рассуждений: текст от провайдера кумулятивный, поэтому
 * продолжение заменяет последний блок, точный дубль не добавляется.
 *
 * Порядок правил важен: «продолжение того же рассуждения» (`startsWith`)
 * проверяется раньше дедупа — иначе каждый следующий кумулятивный чанк давал бы
 * новый блок, а рестарт попытки (текст снова с нуля) — блок-дубль.
 *
 * Блок без текста, но с подписью/redacted (`signature: ""`, `redacted_thinking`)
 * — валидный и добавляется отдельным элементом: подпись принадлежит своему
 * блоку, терять её нельзя.
 *
 * Вход не мутируется: изменённые ветки возвращают новый массив.
 */
export function appendReasoningBlock(
  blocks: readonly ReasoningBlock[],
  text: string,
  iteration: number,
  meta?: ReasoningBlockMeta,
): ReasoningBlock[] {
  const hasMeta = meta !== undefined
    && (meta.signature !== undefined || meta.redacted !== undefined);

  // 1. Пустой/пробельный текст без метаданных состояния не меняет.
  if (!text || !text.trim()) {
    if (!hasMeta) return [...blocks];
    return [...blocks, { text: text ?? '', iteration, ...meta }];
  }

  // 2. Первый блок.
  if (blocks.length === 0) return [{ text, iteration, ...meta }];

  const last = blocks[blocks.length - 1]!;

  // 3. Тот же текст — ничего не меняем.
  if (text === last.text) return [...blocks];

  // 4. Продолжение того же рассуждения (в т.ч. при смене итерации) — заменяем
  //    последний блок, а не добавляем новый.
  if (text.startsWith(last.text)) {
    return [...blocks.slice(0, -1), { text, iteration, ...meta }];
  }

  // 5. Пришёл более короткий вариант — рестарт/повтор той же попытки, состояние
  //    уже содержит более полный текст.
  if (last.text.startsWith(text)) return [...blocks];

  // 6. Такой текст уже есть среди блоков — точный дубль не добавляем.
  if (blocks.some((block) => block.text === text)) return [...blocks];

  // 7. Новое рассуждение.
  return [...blocks, { text, iteration, ...meta }];
}
