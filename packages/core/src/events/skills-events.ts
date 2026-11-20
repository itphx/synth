/**
 * Событие шины `skills.updated` — **реестр скиллов инстанса изменился**.
 *
 * ## Зачем единый шов
 *
 * Реестр скиллов мутируют три фабрики роутов: `createSkillRoutes`
 * (`POST /`, `PATCH|DELETE /:name`, `PUT|DELETE /:name/files/<path>`,
 * `POST /reload`), `createSkillBundleRoutes` (`POST`/`PATCH`/`DELETE`) и
 * `createSkillScopeRoutes`-семейство (`PUT /sessions/:id/skills`,
 * `PUT /projects/:id/skills`, `PUT|DELETE /settings/skills`). Плюс правка
 * файлов скиллов руками на диске (её подхватывает скан реестра). Если событие
 * публикует только один путь, остальные «молчат»: панели скиллов (админская,
 * пользовательская, «Команды» с бандлами) и `$`-пикер в композере показывают
 * устаревший состав до перезагрузки страницы. Поэтому публикация — здесь, один
 * помощник на все пути.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): реестр скиллов — ресурс инстанса, а не сессии; новых транспортных
 *   каналов не заводим (инвариант 6 `AGENTS.md`). Уровневые операции
 *   (`scope: 'project'`/`'session'`) несут id области в payload'е того же
 *   инстансного события — отдельного канала для них не нужно;
 * - payload минимальный — `{ name?, action, scope?, projectId?, sessionId? }`
 *   (`SkillsUpdatedEventData`): клиент перечитывает реестр своим обычным
 *   запросом (`GET /skills`, `GET /skill-bundles`, `GET /settings/skills`);
 * - **содержимое скилла в событие не попадает никогда**: тело `SKILL.md`,
 *   `metadata` и supporting-файлы в payload не кладутся (инвариант 13
 *   `AGENTS.md` — в скиллах встречаются рецепты с секретами). Это свойство типа
 *   payload'а, а не соглашение вызывающих;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрики работают как раньше — событие не публикуется, падений нет.
 */
import type {
  SkillChangeAction,
  SkillChangeScope,
  SkillsUpdatedEventData,
} from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседних швов: `agents.updated` даёт минимум
// для инстансного канала, `mcp.updated` — для канала сессии (`session.updated`
// на уровневую операцию), дублировать типы незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';
import type { SessionEventPublisherLike } from './mcp-events.js';

export type { InstanceEventPublisherLike, SessionEventPublisherLike };

/** Что изменилось в реестре скиллов (payload события `skills.updated`). */
export interface SkillsChangedInfo {
  /** Имя скилла/бандла, которого коснулась мутация (не задано — изменение целиком). */
  name?: string;
  /** Вид мутации. */
  action: SkillChangeAction;
  /** Область уровневой операции (реестр инстанса — не задана). */
  scope?: SkillChangeScope;
  /** Проект, чей скоуп скиллов изменён (`scope: 'project'`). */
  projectId?: string;
  /** Сессия, чей скоуп скиллов изменён (`scope: 'session'`). */
  sessionId?: string;
}

/**
 * Хук «состав реестра скиллов изменился» — вызывается **после** успешной
 * записи; `createSkillRoutes`/`createSkillBundleRoutes`/
 * `createSkillScopeRoutes`-семейство передают его в `publishSkillsUpdated`.
 */
export type SkillsChangedHook = (info: SkillsChangedInfo) => void;

/**
 * Опубликовать `skills.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload
 * уходят только имя/вид мутации/область: тело скилла, metadata и
 * supporting-файлы в событие не попадают.
 */
export function publishSkillsUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: SkillsChangedInfo,
): void {
  if (!bus) return;
  const data: SkillsUpdatedEventData = { action: info.action };
  if (info.name) data.name = info.name;
  if (info.scope) data.scope = info.scope;
  if (info.projectId) data.projectId = info.projectId;
  if (info.sessionId) data.sessionId = info.sessionId;
  bus.publishInstance('skills.updated', data);
}

/** Готовый хук для фабрики роутов: `onSkillsChanged` поверх шины. */
export function skillsChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): SkillsChangedHook {
  return (info) => publishSkillsUpdated(bus, info);
}
