/**
 * Общая заглушка портов PostgreSQL-драйвера (ADR-097, волна 3b).
 *
 * Пока доменный порт не реализован поверх SQL, драйвер отдаёт `notImplementedPort`
 * (прокси, любой доступ к методу которого бросает
 * `PostgresStorageNotImplementedError` с именем порта). Это даёт:
 *   - контрактную поверхность `StorageContext` целиком (прокси отдаёт любой метод);
 *   - понятную ошибку вместо `undefined is not a function`;
 *   - один общий элемент для всех четырёх групп портов (`sessions`/`principals`/
 *     `events`/`content`), который волна реализации заменяет по мере готовности.
 *
 * Методы кэшируются (стабильные ссылки на функцию), символьные ключи не трогаем.
 */

import { PostgresStorageNotImplementedError } from '../errors.js';

export function notImplementedPort<T>(port: string): T {
  const methods = new Map<PropertyKey, () => never>();
  const proxy = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (typeof prop === 'symbol') return undefined;
        let method = methods.get(prop);
        if (!method) {
          method = () => {
            throw new PostgresStorageNotImplementedError(
              `Порт '${port}' ещё не реализован в PostgreSQL-драйвере (ADR-097, волна реализации портов).`,
            );
          };
          methods.set(prop, method);
        }
        return method;
      },
    },
  );
  return proxy as T;
}
