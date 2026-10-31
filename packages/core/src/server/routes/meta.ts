// ADR-118 §8: `GET /api/v2/meta` — возможности инстанса.
//
// Роут **без аутентификации** (как `GET /health`): это публичная информация
// о протоколе инстанса, по ней клиент сверяет свою модель сообщений с
// серверной (fail-closed: несовпадение → отказ подключения, а не тихая
// деградация — ADR-118 «Гибрид и многопользовательский режим»).
import { Hono } from 'hono';
import { MESSAGE_MODEL_VERSION } from '@itphx/synth-shared';
import type { InstanceCapabilities } from '@itphx/synth-shared';
import { SYNTH_VERSION } from '@itphx/synth-shared/version';

/**
 * ADR-118 §8: возможности инстанса.
 *
 * - `messageModel` — версия модели сообщений/потока;
 * - `eventSeq` — события нумеруются глобально в пределах инстанса
 *   (`BusEvent.eventSeq`);
 * - `replay` — доступен догон по журналу событий (`Last-Event-ID` / `?since`);
 * - `version` — версия инстанса.
 */
export function instanceCapabilities(): InstanceCapabilities {
  return {
    messageModel: MESSAGE_MODEL_VERSION,
    eventSeq: true,
    replay: true,
    version: SYNTH_VERSION,
  };
}

/**
 * Фабрика роутов возможностей инстанса (`GET /api/v2/meta`).
 * Монтируется в core как `app.route('/api/v2', createMetaRoutes())`.
 */
export function createMetaRoutes(): Hono {
  const app = new Hono();

  app.get('/meta', (c) => c.json(instanceCapabilities()));

  return app;
}
