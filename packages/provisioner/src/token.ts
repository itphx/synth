/**
 * Токен доступа к пулу (PROP-135).
 *
 * Вынесен из `provider.ts` в отдельный модуль, чтобы Kubernetes-провайдер
 * пользовался тем же генератором, не создавая циклического импорта с
 * `provider.ts` (фабрика провайдеров импортирует Kubernetes-провайдера).
 */

import { randomBytes } from 'node:crypto';

/**
 * Случайный токен пула (значение, не секрет provisioner'а).
 *
 * 32 байта CSPRNG → base64url: достаточно для bearer-токена исполнителя и
 * безопасно как символ пути/заголовка.
 */
export function generatePoolToken(): string {
  return randomBytes(32).toString('base64url');
}
