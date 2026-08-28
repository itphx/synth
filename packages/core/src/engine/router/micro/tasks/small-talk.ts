/**
 * Обработчик small_talk (AD-035).
 * Приветствия/прощания/благодарности → готовый ответ.
 */
import type { MicroResult } from '../types.js';
import { t as sm, type SystemMessageKey } from '../../../system-messages.js';

export function handleSmallTalk(modelResult: MicroResult): MicroResult {
  // Если уже есть ответ от модели — используем его
  if (modelResult.answer) return modelResult;

  // Генерируем ответ на основе label. Канонический текст — из словаря
  // SystemMessages (en, LLM-канал); локализация — через i18nKey (UI-канал).
  const label = modelResult.label || 'greeting';
  const keys: Record<string, { key: SystemMessageKey; variants: string[] }> = {
    greeting: {
      key: 'micro.greeting',
      variants: [sm('micro.greeting'), 'Hello! Nice to see you. What shall we do?', "Hi! I'm Synth, your AI assistant. What needs to be done?"],
    },
    farewell: {
      key: 'micro.farewell',
      variants: [sm('micro.farewell'), 'Bye! Have a nice day!'],
    },
    thanks: {
      key: 'micro.thanks',
      variants: [sm('micro.thanks'), "Anytime! Anything else?"],
    },
  };

  const entry = keys[label] ?? keys.greeting!;
  const choices = entry.variants;
  const answer = choices[Math.floor(Math.random() * choices.length)]!;

  return {
    ...modelResult,
    answer,
    i18nKey: entry.key,
  };
}
