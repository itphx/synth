/**
 * Публикация события `pipeline.updated` — **сущность пайплайна проекта
 * изменилась** (ADR-101 авторство × ADR-118 §4, инвариант 27).
 *
 * ## Зачем единый шов
 *
 * Пайплайн проекта мутируют два контура: HTTP-роуты
 * (`server/routes/pipeline-project-routes.ts`: `POST /projects/:id/pipelines`,
 * `PUT|DELETE /projects/:id/pipelines/:pid`, `POST .../publish`,
 * `POST /pipeline-templates/:tid/instantiate`) и встроенные тулы агента
 * (`engine/tools/pipeline-authoring.ts` — `pipeline_save|publish|delete`,
 * `engine/tools/pipeline-templates.ts` — `pipeline_instantiate`). Если событие
 * публикует только один путь, второй «молчит», и список пайплайнов в левой
 * панели (вкладка «Пайплайны») показывает устаревший состав до перезагрузки
 * страницы. Поэтому публикация — здесь, один помощник на все пути.
 *
 * ## Контракт
 *
 * - канал — **каналы сессий проекта** (`EventBus.publish`, ADR-024/ADR-118:
 *   новых транспортных каналов не заводим). Пайплайн — ресурс проекта
 *   (ADR-014), поэтому подписчики соседних сессий того же проекта тоже должны
 *   увидеть изменение — ровно как у `worktree.updated` (ADR-114 §6) и
 *   `project.updated` (инвариант 27). Инстансный канал здесь **не** подходит:
 *   он не про проект и в managed не доходит до обычного `USER`;
 * - прогоны сюда не относятся: `pipeline.run.*` — отдельные события
 *   инстансного канала (`engine/pipelines/engine.ts`, ADR-101 §2.12.3);
 * - payload минимальный — `{ pipelineId, projectId, action }`
 *   (`PipelineUpdatedEventData`): клиент перечитывает список/деталь своим
 *   обычным запросом. Черновик спецификации, `vars` и граф узлов в событие
 *   не попадают — это свойство типа payload'а, а не соглашение вызывающих;
 * - публикация — **только после успешной записи**: ошибки валидации, 404 и 409
 *   событие не порождают (один запрос — максимум одно событие);
 * - хук **необязателен**: без шины или без источника сессий (тесты, сторонние
 *   потребители) помощник молча ничего не делает — поведение прежнее.
 *
 * Направление зависимостей — как у соседнего `engine/worktree/events.ts`:
 * модуль знает только **шину** и **источник сессий** (структурные интерфейсы),
 * а не `SessionManager`/`EventBus` целиком. Так его можно вызвать из HTTP-роутов,
 * из тулов и из тестов.
 */
import type {
  PipelineChangeAction,
  PipelineUpdatedEventData,
  Session,
} from '@itphx/synth-shared';

/**
 * Предел числа сессий, которым публикуется событие.
 *
 * Событие — сигнал «перечитай список», а не поток данных: 200 каналов
 * достаточно для любого реального проекта, а перебор не даёт заблокировать
 * публикацию на проекте с тысячами сессий (тот же предел, что у
 * `worktree.updated`).
 */
export const PIPELINE_EVENT_MAX_SESSIONS = 200;

/**
 * Минимальный контракт шины: достаточно публикации в канал сессии.
 * `EventBus` (`events/bus.ts`) подходит структурно.
 */
export interface PipelineEventPublisherLike {
  publish(channel: string, type: 'pipeline.updated', data?: Record<string, unknown>): void;
}

/**
 * Источник сессий проекта — структурно совместим с `SessionManager`
 * (`listSessions({ projectId })`).
 */
export interface PipelineEventSessionSource {
  listSessions(filter?: { projectId?: string; userId?: string }): Promise<Session[]>;
}

/** Зависимости публикации события пайплайна (не заданы — событие не публикуется). */
export interface PipelineEventDeps {
  /** Шина событий сессий (ADR-009). */
  eventBus?: PipelineEventPublisherLike;
  /** Источник сессий проекта (обычно `SessionManager`). */
  sessionStore?: PipelineEventSessionSource;
}

/** Что публикуем: проект-владелец, пайплайн и характер изменения. */
export interface PipelineUpdatedInput {
  /** Проект-владелец пайплайна. */
  projectId: string;
  /** Пайплайн, которого коснулась мутация. */
  pipelineId: string;
  /** Что произошло: `save`/`publish`/`delete`/`instantiate`. */
  action: PipelineChangeAction;
}

/**
 * Опубликовать `pipeline.updated` в каналы сессий проекта.
 *
 * Проект без сессий — молча ничего (нечего инвалидировать: подписчиков нет).
 * Ошибка чтения сессий не должна ломать операцию авторства: событие — побочный
 * сигнал, а мутация уже выполнена и подтверждена ответом, поэтому ошибка
 * глушится (с предупреждением в лог — как у `project.updated`).
 */
export async function publishPipelineUpdated(
  deps: PipelineEventDeps,
  input: PipelineUpdatedInput,
): Promise<void> {
  const { eventBus, sessionStore } = deps;
  if (!eventBus || !sessionStore || !input.projectId || !input.pipelineId) return;

  let sessions: Session[];
  try {
    sessions = await sessionStore.listSessions({ projectId: input.projectId });
  } catch (err) {
    console.warn('[pipelines] не удалось прочитать сессии проекта для pipeline.updated:', err);
    return;
  }

  const payload: PipelineUpdatedEventData = {
    pipelineId: input.pipelineId,
    projectId: input.projectId,
    action: input.action,
  };
  for (const session of sessions.slice(0, PIPELINE_EVENT_MAX_SESSIONS)) {
    eventBus.publish(session.id, 'pipeline.updated', payload);
  }
}
