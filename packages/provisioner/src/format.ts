/**
 * Форматирование ошибок валидации (zod) — отдельный модуль.
 *
 * Вынесен из `protocol.ts`, чтобы `config.ts` и `protocol.ts` не зависели
 * друг от друга: `protocol.ts` использует схему профиля из `config.ts`
 * (`profileSpec` в теле `POST /v1/pools`), а `config.ts` разбирает ошибки
 * Zod-валидации env. Без разрыва цикла `protocol → config → protocol`
 * модуль инициализировался бы в порядке, при котором `profileSchema` ещё не
 * объявлен (TDZ) — падение на импорте.
 *
 * Текст ошибки — **никогда** не содержит токенов: provisioner не логирует и не
 * эхо-возвращает секреты.
 */

import { z } from 'zod';

/**
 * Человекочитаемое описание ошибок zod-валидации.
 *
 * Порядок и формулировки не являются контрактом: сообщение нужно оператору,
 * а не клиенту. Секретов в нём нет — только пути полей.
 */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}
