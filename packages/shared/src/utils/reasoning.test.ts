import { describe, it, expect } from 'vitest';
import { appendReasoningBlock, type ReasoningBlock } from './reasoning.js';

describe('appendReasoningBlock', () => {
  it('1: пустой/пробельный текст не меняет состояние и не мутирует вход', () => {
    const blocks: ReasoningBlock[] = [{ text: 'a', iteration: 0 }];
    const empty = appendReasoningBlock(blocks, '', 0);
    const blank = appendReasoningBlock(blocks, '   ', 1);

    expect(empty).toEqual(blocks);
    expect(blank).toEqual(blocks);
    // Вход не мутирован.
    expect(blocks).toEqual([{ text: 'a', iteration: 0 }]);
  });

  it('2: пустой список → первый блок', () => {
    expect(appendReasoningBlock([], 'думаю', 0)).toEqual([{ text: 'думаю', iteration: 0 }]);
  });

  it('3: точный дубль последнего блока не добавляется', () => {
    const blocks: ReasoningBlock[] = [{ text: 'думаю', iteration: 0 }];
    expect(appendReasoningBlock(blocks, 'думаю', 0)).toEqual([{ text: 'думаю', iteration: 0 }]);
  });

  it('4: продолжение заменяет последний блок, в том числе при смене итерации', () => {
    const blocks: ReasoningBlock[] = [{ text: 'думаю', iteration: 0 }];
    const same = appendReasoningBlock(blocks, 'думаю дальше', 0);
    const nextIteration = appendReasoningBlock(same, 'думаю дальше и ещё', 1);

    expect(same).toEqual([{ text: 'думаю дальше', iteration: 0 }]);
    expect(nextIteration).toEqual([{ text: 'думаю дальше и ещё', iteration: 1 }]);
    expect(nextIteration).toHaveLength(1);
  });

  it('5: более короткий вариант (рестарт/повтор) состояние не меняет', () => {
    const blocks: ReasoningBlock[] = [{ text: 'думаю дальше', iteration: 0 }];
    expect(appendReasoningBlock(blocks, 'думаю', 1)).toEqual([{ text: 'думаю дальше', iteration: 0 }]);
  });

  it('6: текст, уже встречавшийся среди блоков, не дублируется', () => {
    const blocks: ReasoningBlock[] = [
      { text: 'первое', iteration: 0 },
      { text: 'второе', iteration: 1 },
    ];
    expect(appendReasoningBlock(blocks, 'первое', 2)).toEqual(blocks);
  });

  it('7: новое рассуждение добавляется отдельным блоком', () => {
    const blocks: ReasoningBlock[] = [{ text: 'первое', iteration: 0 }];
    expect(appendReasoningBlock(blocks, 'второе', 1)).toEqual([
      { text: 'первое', iteration: 0 },
      { text: 'второе', iteration: 1 },
    ]);
  });

  it('не мутирует вход при замене/добавлении', () => {
    const blocks: ReasoningBlock[] = [{ text: 'a', iteration: 0 }];
    appendReasoningBlock(blocks, 'ab', 0);
    appendReasoningBlock(blocks, 'b', 1);
    expect(blocks).toEqual([{ text: 'a', iteration: 0 }]);
  });

  it('реальный кейс: попытка упала, началась заново с пустого текста → блок один', () => {
    // Провайдер шлёт reasoning кумулятивно: чанк содержит весь текст попытки.
    let blocks: ReasoningBlock[] = [];
    for (const chunk of ['Дума', 'Думаю', 'Думаю дальше']) {
      blocks = appendReasoningBlock(blocks, chunk, 0);
    }
    expect(blocks).toEqual([{ text: 'Думаю дальше', iteration: 0 }]);

    // Попытка упала: аккумулятор сброшен (stream.retry → resetStreamAttempt),
    // новая попытка снова начинает рассуждение с нуля.
    blocks = [];
    for (const chunk of ['Дум', 'Думаю', 'Думаю иначе']) {
      blocks = appendReasoningBlock(blocks, chunk, 1);
    }

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ text: 'Думаю иначе', iteration: 1 });
  });
});
