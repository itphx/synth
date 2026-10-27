/**
 * ADR-094: метрики вложений сообщений (ADR-115).
 *
 * Каталог:
 * - `synth_attachment_uploads_total{outcome,kind}` — попытки загрузки по исходу
 *   (`ok`/`too_large`/`unsupported`) и виду вложения;
 * - `synth_attachment_upload_bytes{kind}` — гистограмма размера **принятого**
 *   файла (после вычищения метаданных);
 * - `synth_attachment_downloads_total{outcome}` — раздача байтов по исходу
 *   (`ok`/`not_found`);
 * - `synth_attachment_gc_removed_total` — объекты, удалённые GC (без ссылок и
 *   старше `attachments.gcDays`).
 *
 * ## Контракт ADR-094
 *
 * - имена — только `synth_*`;
 * - лейблы — только из фиксированного списка: здесь `kind` и `outcome`
 *   (канонический набор ADR-094);
 * - **никаких id** (сессии/сообщения/части), имён файлов и сырых путей в
 *   лейблах: путь вложения — content-addressed хеш, это высокая кардинальность
 *   и утечка содержимого в `/metrics`;
 * - значения лейблов приводятся к **конечным наборам** (`normalize*` ниже):
 *   неизвестное значение → `other`;
 * - ошибка метрик не влияет на загрузку/раздачу/GC (записи обёрнуты в try/catch).
 *
 * ## Почему sink в модуле
 *
 * `AttachmentService` собирается внутри фабрики роутов сессий
 * (`server/routes/sessions.ts`) из `deps.attachments`, куда метрики не
 * прокидываются — контейнер зависимостей (`server/app/deps.ts`,
 * `backend/app/deps.ts`) в этой точке не участвует. Поэтому, по образцу
 * «процесс-глобального реестра», фабрика метрик при включённых метриках
 * ставится в модульный sink (`setAttachmentMetricsHook`) на старте и снимается
 * на graceful shutdown. Явный `metrics` в опциях сервиса/GC приоритетнее sink'а
 * (так тесты обходятся без глобального состояния).
 */
import type { MetricsRegistry } from '../registry.js';

/** Вид вложения в метрике (конечный набор) — по MIME. */
export type AttachmentMetricKind = 'image' | 'audio' | 'video' | 'file' | 'other';

/** Исход загрузки вложения (конечный набор). */
export type AttachmentUploadOutcome = 'ok' | 'too_large' | 'unsupported' | 'other';

/** Исход раздачи вложения (конечный набор). */
export type AttachmentDownloadOutcome = 'ok' | 'not_found' | 'other';

/** Корзины размера вложения (байты): от 1 КиБ до 64 МиБ. */
export const ATTACHMENT_UPLOAD_BYTES_BUCKETS: readonly number[] = [
  1024,
  16 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
  64 * 1024 * 1024,
];

const KINDS: readonly string[] = ['image', 'audio', 'video', 'file'];
const UPLOAD_OUTCOMES: readonly string[] = ['ok', 'too_large', 'unsupported'];
const DOWNLOAD_OUTCOMES: readonly string[] = ['ok', 'not_found'];

/** Приведение значения к конечному набору: неизвестное → `other`. */
function normalize(value: string | undefined, allowed: readonly string[]): string {
  if (!value) return 'other';
  return allowed.includes(value) ? value : 'other';
}

/** Нормализация вида вложения. */
export function normalizeAttachmentKind(value: string | undefined): AttachmentMetricKind {
  return normalize(value, KINDS) as AttachmentMetricKind;
}

/** Нормализация исхода загрузки. */
export function normalizeAttachmentUploadOutcome(value: string | undefined): AttachmentUploadOutcome {
  return normalize(value, UPLOAD_OUTCOMES) as AttachmentUploadOutcome;
}

/** Нормализация исхода раздачи. */
export function normalizeAttachmentDownloadOutcome(
  value: string | undefined,
): AttachmentDownloadOutcome {
  return normalize(value, DOWNLOAD_OUTCOMES) as AttachmentDownloadOutcome;
}

/**
 * Колбэки метрик вложений — их вызывают сервис вложений (`AttachmentService`),
 * HTTP-роут раздачи и GC (`startAttachmentPruner`).
 */
export interface AttachmentMetricsHooks {
  /**
   * Попытка загрузки. `bytes` — размер принятого файла (только при `outcome: 'ok'`):
   * попадает в гистограмму `synth_attachment_upload_bytes`.
   */
  onUpload: (info: { outcome: string; kind: string; bytes?: number }) => void;
  /** Раздача байтов вложения (`ok` — объект отдан, `not_found` — части/объекта нет). */
  onDownload: (info: { outcome: string }) => void;
  /** GC удалил `count` осиротевших объектов (вместе с sidecar). */
  onGcRemoved: (count: number) => void;
}

/**
 * Создать колбэки метрик вложений (ADR-094/ADR-115).
 *
 * Реестр метрик — общий (`MetricsRegistry`); новых зависимостей нет.
 */
export function createAttachmentMetrics(registry: MetricsRegistry): AttachmentMetricsHooks {
  const uploads = registry.counter(
    'synth_attachment_uploads_total',
    'Total number of attachment upload attempts by outcome and kind.',
    ['outcome', 'kind'],
  );
  const uploadBytes = registry.histogram(
    'synth_attachment_upload_bytes',
    'Size of accepted attachment uploads in bytes.',
    ['kind'],
    ATTACHMENT_UPLOAD_BYTES_BUCKETS,
  );
  const downloads = registry.counter(
    'synth_attachment_downloads_total',
    'Total number of attachment download attempts by outcome.',
    ['outcome'],
  );
  const gcRemoved = registry.counter(
    'synth_attachment_gc_removed_total',
    'Total number of orphaned attachment objects removed by GC.',
  );

  return {
    onUpload(info) {
      try {
        const kind = normalizeAttachmentKind(info.kind);
        uploads.inc({ outcome: normalizeAttachmentUploadOutcome(info.outcome), kind });
        if (info.outcome === 'ok' && typeof info.bytes === 'number') {
          if (Number.isFinite(info.bytes) && info.bytes >= 0) uploadBytes.observe({ kind }, info.bytes);
        }
      } catch {
        // Ошибка метрик не влияет на загрузку.
      }
    },
    onDownload(info) {
      try {
        downloads.inc({ outcome: normalizeAttachmentDownloadOutcome(info.outcome) });
      } catch {
        // Ошибка метрик не влияет на раздачу.
      }
    },
    onGcRemoved(count) {
      try {
        if (!Number.isFinite(count) || count <= 0) return;
        gcRemoved.inc(count);
      } catch {
        // Ошибка метрик не влияет на GC.
      }
    },
  };
}

/** Текущий sink метрик вложений (задаётся контейнером зависимостей на старте). */
let currentHook: AttachmentMetricsHooks | null = null;

/**
 * Поставить sink метрик вложений. Возвращает функцию снятия (восстанавливает
 * предыдущее значение) — её кладут в `stopMetricsCollectors`.
 *
 * `null` — метрики выключены (`metrics.enabled=false`): вызовы в сервисе/роуте/GC
 * становятся no-op.
 */
export function setAttachmentMetricsHook(hooks: AttachmentMetricsHooks | null): () => void {
  const previous = currentHook;
  currentHook = hooks;
  return () => {
    currentHook = previous;
  };
}

/** Текущий sink метрик вложений (`null` — метрики выключены). */
export function getAttachmentMetricsHook(): AttachmentMetricsHooks | null {
  return currentHook;
}
