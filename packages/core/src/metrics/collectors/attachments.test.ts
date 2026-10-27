/**
 * ADR-094/ADR-115: метрики вложений сообщений.
 *
 * Проверяем контракт имён/лейблов (только `synth_attachment_*`, лейблы
 * `kind`/`outcome`), конечные наборы значений и рендер exposition 0.0.4.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import {
  createAttachmentMetrics,
  normalizeAttachmentDownloadOutcome,
  normalizeAttachmentKind,
  normalizeAttachmentUploadOutcome,
} from './attachments.js';

describe('метрики вложений (ADR-094/ADR-115)', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it('нормализует значения лейблов к конечным наборам', () => {
    expect(normalizeAttachmentKind('image')).toBe('image');
    expect(normalizeAttachmentKind('video')).toBe('video');
    expect(normalizeAttachmentKind('application/octet-stream')).toBe('other');
    expect(normalizeAttachmentKind(undefined)).toBe('other');

    expect(normalizeAttachmentUploadOutcome('too_large')).toBe('too_large');
    expect(normalizeAttachmentUploadOutcome('weird')).toBe('other');
    expect(normalizeAttachmentDownloadOutcome('not_found')).toBe('not_found');
    expect(normalizeAttachmentDownloadOutcome('weird')).toBe('other');
  });

  it('считает загрузки по исходу/виду и наблюдает размер принятого файла', () => {
    const metrics = createAttachmentMetrics(registry);
    metrics.onUpload({ outcome: 'ok', kind: 'image', bytes: 2048 });
    metrics.onUpload({ outcome: 'ok', kind: 'image', bytes: 1024 * 1024 });
    metrics.onUpload({ outcome: 'too_large', kind: 'video' });
    metrics.onUpload({ outcome: 'unsupported', kind: 'file' });

    const snapshot = registry.snapshot();
    const uploads = snapshot.find((m) => m.name === 'synth_attachment_uploads_total');
    expect(uploads?.type).toBe('counter');
    expect(uploads?.labelNames).toEqual(['outcome', 'kind']);
    expect(uploads?.series.map((s) => [s.labels.outcome, s.labels.kind, s.value])).toEqual([
      ['ok', 'image', 2],
      ['too_large', 'video', 1],
      ['unsupported', 'file', 1],
    ]);

    const bytes = snapshot.find((m) => m.name === 'synth_attachment_upload_bytes');
    expect(bytes?.type).toBe('histogram');
    expect(bytes?.labelNames).toEqual(['kind']);
    const imageSeries = bytes?.series.find((s) => s.labels.kind === 'image');
    expect(imageSeries?.count).toBe(2);
    expect(imageSeries?.sum).toBe(2048 + 1024 * 1024);

    // Гистограмма наблюдает только принятые файлы (`outcome: 'ok'`).
    metrics.onUpload({ outcome: 'too_large', kind: 'video', bytes: 999999 });
    expect(
      registry.snapshot().find((m) => m.name === 'synth_attachment_upload_bytes')?.series
        .find((s) => s.labels.kind === 'video'),
    ).toBeUndefined();
  });

  it('считает раздачи и удаления GC', () => {
    const metrics = createAttachmentMetrics(registry);
    metrics.onDownload({ outcome: 'ok' });
    metrics.onDownload({ outcome: 'ok' });
    metrics.onDownload({ outcome: 'not_found' });
    metrics.onGcRemoved(3);
    metrics.onGcRemoved(0);

    const text = registry.render().text;
    expect(text).toContain('synth_attachment_downloads_total{outcome="ok"} 2');
    expect(text).toContain('synth_attachment_downloads_total{outcome="not_found"} 1');
    expect(text).toContain('synth_attachment_gc_removed_total 3');
    // Имена только `synth_*`; id сессий/путей в лейблах нет.
    expect(registry.snapshot().map((m) => m.name).every((name) => name.startsWith('synth_'))).toBe(true);
  });

  it('не падает и не влияет на поток при ошибке записи метрик', () => {
    const metrics = createAttachmentMetrics(registry);
    metrics.onUpload({ outcome: 'unknown-outcome', kind: 'unknown-kind' });
    expect(registry.render().text).toContain('synth_attachment_uploads_total{outcome="other",kind="other"} 1');
  });
});
