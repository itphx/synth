// ADR-118 §8: `GET /api/v2/meta` — возможности инстанса.
//
// Роут **без аутентификации** (как `GET /health`): это публичная информация
// о протоколе инстанса, по ней клиент сверяет свою модель сообщений с
// серверной (fail-closed: несовпадение → отказ подключения, а не тихая
// деградация — ADR-118 «Гибрид и многопользовательский режим»).
import { Hono } from 'hono';
import { MESSAGE_MODEL_VERSION } from '@itphx/synth-shared';
import type { AttachmentsConfig, InstanceCapabilities } from '@itphx/synth-shared';
import { SYNTH_VERSION } from '@itphx/synth-shared/version';

export interface MetaRoutesDeps {
  /**
   * ADR-115: эффективные настройки вложений (env > runtime > config >
   * defaults). Резолвер читается на каждый запрос — runtime-изменения видны
   * без рестарта.
   */
  getAttachments?: () => AttachmentsConfig;
  /**
   * PROP-125: возможности инстанса (аддитивно). `remoteMcp` — признак
   * поддержки `/api/v2/mcp/remote/*` и relay-режима; отсутствие поля у
   * старого backend'а — фича молча выключена.
   *
   * `users` — признак, что инстанс обслуживает `/api/v2/users*`
   * (управление пользователями): managed backend — всегда `true` (маршрут
   * смонтирован); core standalone (чистый) — `false` (маршрута нет,
   * проксировать нечего); core в гибриде — `true` ровно тогда, когда
   * удалённый backend подключён (тогда прокси перенаправляет запрос).
   * Отсутствие поля/признака = «фичи нет» (fail-closed).
   */
  getFeatures?: () => { remoteMcp?: boolean; users?: boolean } | undefined;
}

/**
 * ADR-118 §8: возможности инстанса.
 *
 * - `messageModel` — версия модели сообщений/потока;
 * - `eventSeq` — события нумеруются глобально в пределах инстанса
 *   (`BusEvent.eventSeq`);
 * - `replay` — доступен догон по журналу событий (`Last-Event-ID` / `?since`);
 * - `version` — версия инстанса;
 * - `attachments` — эффективные лимиты вложений (ADR-115, аддитивно) — только
 *   при заданном `deps.getAttachments`;
 * - `features` — возможности инстанса (PROP-125, аддитивно) — только при
 *   заданном `deps.getFeatures` и непустом результате. `features.users` —
 *   признак, что инстанс обслуживает `/api/v2/users*` (управление
 *   пользователями): managed — всегда; core standalone — нет; core в
 *   гибриде — есть, пока удалённый backend подключён и прокси
 *   перенаправляет запрос. Отсутствие признака = «фичи нет» (fail-closed).
 */
export function instanceCapabilities(deps: MetaRoutesDeps = {}): InstanceCapabilities {
  const capabilities: InstanceCapabilities = {
    messageModel: MESSAGE_MODEL_VERSION,
    eventSeq: true,
    replay: true,
    version: SYNTH_VERSION,
  };
  if (deps.getAttachments) {
    const attachments = deps.getAttachments();
    capabilities.attachments = {
      enabled: attachments.enabled,
      modalities: {
        image: attachments.modalities.image,
        pdf: attachments.modalities.pdf,
        audio: attachments.modalities.audio,
        video: attachments.modalities.video,
      },
      maxBytesPerFile: attachments.maxBytesPerFile,
      maxFilesPerMessage: attachments.maxFilesPerMessage,
      maxBytesPerSession: attachments.maxBytesPerSession,
    };
  }
  // PROP-125: пустой/незаданный набор признаков — поля `features` нет
  // (старый клиент читает ответ как прежде).
  if (deps.getFeatures) {
    const features = deps.getFeatures();
    if (features && Object.values(features).some((value) => value !== undefined)) {
      capabilities.features = features;
    }
  }
  return capabilities;
}

/**
 * Фабрика роутов возможностей инстанса (`GET /api/v2/meta`).
 * Монтируется в core как `app.route('/api/v2', createMetaRoutes(deps))`.
 */
export function createMetaRoutes(deps: MetaRoutesDeps = {}): Hono {
  const app = new Hono();

  app.get('/meta', (c) => c.json(instanceCapabilities(deps)));

  return app;
}
