/**
 * Обработчик small_talk (AD-035).
 * Приветствия/прощания/благодарности → готовый ответ.
 */
import type { MicroResult } from '../types.js';

export function handleSmallTalk(modelResult: MicroResult): MicroResult {
  // Если уже есть ответ от модели — используем его
  if (modelResult.answer) return modelResult;

  // Генерируем ответ на основе label
  const answers: Record<string, string[]> = {
    greeting: [
      'Привет! Чем могу помочь?',
      'Здравствуйте! Рад вас видеть. Что будем делать?',
      'Привет! Я Synth, ваш AI-ассистент. Что нужно сделать?',
    ],
    farewell: [
      'До свидания! Обращайтесь, если понадоблюсь.',
      'Пока! Хорошего дня!',
    ],
    thanks: [
      'Пожалуйста! Рад помочь.',
      'Всегда пожалуйста! Что-то ещё?',
    ],
  };

  const label = modelResult.label || 'greeting';
  const choices = answers[label] ?? answers.greeting!;
  const answer = choices[Math.floor(Math.random() * choices.length)]!;

  return {
    ...modelResult,
    answer,
  };
}
