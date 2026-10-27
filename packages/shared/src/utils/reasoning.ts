// Накопление блоков рассуждений (reasoning) модели

/** Блок рассуждений: текст и итерация Tool Use, к которой он относится. */
export interface ReasoningBlock {
  text: string;
  iteration: number;
}

/**
 * Накопить блок рассуждений: текст от провайдера кумулятивный, поэтому
 * продолжение заменяет последний блок, точный дубль не добавляется.
 *
 * Порядок правил важен: «продолжение того же рассуждения» (`startsWith`)
 * проверяется раньше дедупа — иначе каждый следующий кумулятивный чанк давал бы
 * новый блок, а рестарт попытки (текст снова с нуля) — блок-дубль.
 *
 * Вход не мутируется: изменённые ветки возвращают новый массив.
 */
export function appendReasoningBlock(
  blocks: readonly ReasoningBlock[],
  text: string,
  iteration: number,
): ReasoningBlock[] {
  // 1. Пустой/пробельный текст состояния не меняет.
  if (!text || !text.trim()) return [...blocks];

  // 2. Первый блок.
  if (blocks.length === 0) return [{ text, iteration }];

  const last = blocks[blocks.length - 1]!;

  // 3. Тот же текст — ничего не меняем.
  if (text === last.text) return [...blocks];

  // 4. Продолжение того же рассуждения (в т.ч. при смене итерации) — заменяем
  //    последний блок, а не добавляем новый.
  if (text.startsWith(last.text)) {
    return [...blocks.slice(0, -1), { text, iteration }];
  }

  // 5. Пришёл более короткий вариант — рестарт/повтор той же попытки, состояние
  //    уже содержит более полный текст.
  if (last.text.startsWith(text)) return [...blocks];

  // 6. Такой текст уже есть среди блоков — точный дубль не добавляем.
  if (blocks.some((block) => block.text === text)) return [...blocks];

  // 7. Новое рассуждение.
  return [...blocks, { text, iteration }];
}
