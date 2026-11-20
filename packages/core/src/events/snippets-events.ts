/**
 * Событие шины `snippets.updated` — **реестр сниппетов изменился**.
 *
 * ## Зачем единый шов
 *
 * Реестр `#`-сниппетов (ADR-126 §4) мутирует одна фабрика —
 * `createSnippetRoutes`, write-путей три: `POST /` (создание),
 * `PATCH /:name` (правка, в том числе переименование и перенос на другой
 * уровень) и `DELETE /:name` (удаление). `POST /expand` — предпросмотр раскрытия
 * без записи, событие не публикует.
 *
 * Если событие не публикуется, UI показывает устаревший реестр: панель
 * «Сниппеты» (`components/settings/SnippetsSettings.tsx` →
 * `components/snippets/SnippetScopeEditor.tsx`) и `#`-пикер композера
 * (`components/chat/SnippetAutocomplete.tsx`) грузят список один раз при
 * монтировании и перечитывают его только после **своих** действий. Сниппет,
 * созданный/изменённый/удалённый в другом клиенте или соседней вкладке (или
 * агентом/скриптом через HTTP API), виден только после перезагрузки страницы.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): у сниппетов нет сессии-владельца (уровни `instance`/`user`/
 *   `project`), новых транспортных каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ action, snippetId? }` (`SnippetsUpdatedEventData`):
 *   клиент перечитывает свой список обычным запросом (`GET /api/v2/snippets`),
 *   видимость уровней проверяет роут, а не событие. `snippetId` — каноническое
 *   **имя** сниппета: отдельного id у записи нет (имя и есть ключ реестра);
 * - **текста сниппета (`body`), описания и алиасов в событие не попадает
 *   никогда**: сниппет — пользовательский и проектный (то есть недоверенный)
 *   ввод, а сигналу достаточно «перечитай»; свойство типа payload'а, а не
 *   соглашение вызывающих;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрика работает как раньше — событие не публикуется, падений нет;
 * - публикация — **после** успешной записи: 400 (невалидное имя/тело), 403 (нет
 *   права на слот), 404 (сниппета нет) событие не публикуют. Переименование и
 *   перенос на другой уровень (`PATCH`) — одна мутация и **одно** событие
 *   (`action: 'update'`): промежуточные create/delete внутри запроса клиенту
 *   видны как правка записи.
 */
import type { SnippetChangeAction, SnippetsUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в реестре сниппетов (payload `snippets.updated`). */
export interface SnippetsChangedInfo {
  /** Каноническое имя сниппета (не задано — изменение реестра целиком). */
  snippetId?: string;
  /** Вид мутации. */
  action: SnippetChangeAction;
}

/**
 * Хук «реестр сниппетов изменился» — вызывается **после** успешной записи;
 * `createSnippetRoutes` передаёт его в `publishSnippetsUpdated`.
 */
export type SnippetsChangedHook = (info: SnippetsChangedInfo) => void;

/**
 * Опубликовать `snippets.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только имя сниппета и вид мутации: тела сниппета, описания и алиасов в событии
 * нет.
 */
export function publishSnippetsUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: SnippetsChangedInfo,
): void {
  if (!bus) return;
  const data: SnippetsUpdatedEventData = { action: info.action };
  if (info.snippetId) data.snippetId = info.snippetId;
  bus.publishInstance('snippets.updated', data);
}

/** Готовый хук для фабрики роутов: `onSnippetsChanged` поверх шины. */
export function snippetsChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): SnippetsChangedHook {
  return (info) => publishSnippetsUpdated(bus, info);
}
