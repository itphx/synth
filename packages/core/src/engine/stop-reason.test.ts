/**
 * PROP-143: конверт причины остановки хода и durable-запись в истории
 * (`engine/stop-reason.ts`).
 *
 * Конверт — единственное, что видит модель; запись — служебное user-сообщение
 * с маркером `metadata.type = 'execution_stopped'`.
 */
import { describe, it, expect } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import {
  STOP_MESSAGE_TYPE,
  buildStopRecord,
  renderStopEnvelope,
} from './stop-reason.js';
import { t as sm } from './system-messages.js';

describe('renderStopEnvelope — конверт причины остановки (PROP-143)', () => {
  it('полный набор атрибутов', () => {
    const envelope = renderStopEnvelope({
      reason: 'provider_error',
      errorType: 'rate_limit',
      retryable: true,
      attempts: 3,
    });

    expect(envelope).toBe(
      '<execution_stopped reason="provider_error" error_type="rate_limit" retryable="true" attempts="3">\n'
      + `${sm('stop.internal')}\n`
      + '</execution_stopped>',
    );
  });

  it('атрибуты без значения опускаются (пустых атрибутов нет)', () => {
    const envelope = renderStopEnvelope({ reason: 'stopped_by_user' });

    expect(envelope).toBe(
      '<execution_stopped reason="stopped_by_user">\n'
      + `${sm('stop.stopped_by_user')}\n`
      + '</execution_stopped>',
    );
    expect(envelope).not.toContain('error_type');
    expect(envelope).not.toContain('retryable');
    expect(envelope).not.toContain('attempts');
  });

  it('retryable=false — явное значение, а не пропуск атрибута', () => {
    const envelope = renderStopEnvelope({ reason: 'provider_error', retryable: false });

    expect(envelope).toContain('retryable="false"');
  });

  it('значения атрибутов экранируются как XML', () => {
    const envelope = renderStopEnvelope({
      reason: 'internal',
      errorType: 'a&b<c>d"e',
    });

    expect(envelope).toContain('error_type="a&amp;b&lt;c&gt;d&quot;e"');
    // сырых спецсимволов в атрибуте не осталось
    expect(envelope).not.toContain('error_type="a&b');
  });

  it('тело из сырого текста провайдера — без локализации', () => {
    const envelope = renderStopEnvelope({
      reason: 'provider_error',
      errorType: 'quota_exceeded',
      error: 'insufficient_quota: billing limit reached',
    });

    expect(envelope).toBe(
      '<execution_stopped reason="provider_error" error_type="quota_exceeded">\n'
      + 'insufficient_quota: billing limit reached\n'
      + '</execution_stopped>',
    );
  });

  it('тело лимита шага — локализованный текст с лимитом', () => {
    const envelope = renderStopEnvelope({ reason: 'steps_limit', limit: 10 });

    expect(envelope).toBe(
      '<execution_stopped reason="steps_limit">\n'
      + `${sm('stop.steps_limit', { limit: '10' })}\n`
      + '</execution_stopped>',
    );
  });

  it('тело бюджета контекста — локализованный текст с токенами и шагами', () => {
    const envelope = renderStopEnvelope({ reason: 'context_budget', tokens: 12000, steps: 4 });

    expect(envelope).toBe(
      '<execution_stopped reason="context_budget">\n'
      + `${sm('stop.context_budget', { tokens: '12000', steps: '4' })}\n`
      + '</execution_stopped>',
    );
  });

  it('тела причин нейтральны к типу сессии (не про сабагента/отчёт модели)', () => {
    // Запись причины остановки может лежать в основной сессии — тексты
    // `task.*`/`session.*` («subagent», «текстовый отчёт») там были бы неверны.
    const bodies = [
      renderStopEnvelope({ reason: 'steps_limit', limit: 3 }),
      renderStopEnvelope({ reason: 'context_budget', tokens: 100, steps: 2 }),
      renderStopEnvelope({ reason: 'stopped_by_user' }),
      renderStopEnvelope({ reason: 'denied' }),
    ].join('\n');

    expect(bodies).not.toContain('subagent');
    expect(bodies).not.toContain('Subagent');
    expect(bodies).not.toContain('textual report');
  });

  it('причины без текста провайдера локализованы по своей причине', () => {
    expect(renderStopEnvelope({ reason: 'stopped_by_user' })).toContain(sm('stop.stopped_by_user'));
    expect(renderStopEnvelope({ reason: 'denied' })).toContain(sm('stop.denied'));
    expect(renderStopEnvelope({ reason: 'restart' })).toContain(sm('stop.restarted'));
    expect(renderStopEnvelope({ reason: 'orphaned' })).toContain(sm('stop.orphaned'));
    expect(renderStopEnvelope({ reason: 'internal' })).toContain(sm('stop.internal'));
    // provider_error без текста провайдера — тот же внутренний текст
    expect(renderStopEnvelope({ reason: 'provider_error' })).toContain(sm('stop.internal'));
  });
});

describe('buildStopRecord — служебная запись истории (PROP-143)', () => {
  it('роль user, автор System, маркер и причины в metadata', () => {
    const message = buildStopRecord({
      reason: 'provider_error',
      errorType: 'quota_exceeded',
      retryable: false,
      attempts: 3,
      maxRetries: 3,
      provider: 'openai',
      model: 'gpt-4o',
      agentRole: 'fixer',
      turnId: 'turn-1',
      streamId: 'stream_1',
    });

    expect(message.role).toBe(MessageRole.USER);
    expect(message.author).toBe('System');
    expect(message.origin).toBe('local');
    expect(message.seq).toBe(0);
    expect(message.hidden).toBe(false);
    expect(message.disabled).toBe(false);
    expect(message.pinned).toBe(false);
    expect(message.ephemeral).toBe(false);

    // Id хода — на самом сообщении (сериализатор отдаёт из него `turn_id`,
    // по нему лента группирует блок хода) и в metadata (для аналитики).
    expect(message.turnId).toBe('turn-1');
    expect(message.metadata?.turn_id).toBe('turn-1');

    expect(message.metadata?.type).toBe(STOP_MESSAGE_TYPE);
    expect(message.metadata?.type).toBe('execution_stopped');
    expect(message.metadata?.reason).toBe('provider_error');
    expect(message.metadata?.error_type).toBe('quota_exceeded');
    expect(message.metadata?.retryable).toBe(false);
    expect(message.metadata?.attempts).toBe(3);
    expect(message.metadata?.max_retries).toBe(3);
    expect(message.metadata?.provider).toBe('openai');
    expect(message.metadata?.model).toBe('gpt-4o');
    expect(message.metadata?.agent_role).toBe('fixer');
    expect(message.metadata?.stream_id).toBe('stream_1');
    expect(typeof message.metadata?.stopped_at).toBe('string');
    // i18n-метаданных нет: UI локализует подпись по `reason`
    expect(message.metadata?.i18n).toBeUndefined();
  });

  it('контент и часть — тот же конверт', () => {
    const input = {
      reason: 'steps_limit' as const,
      limit: 5,
    };
    const message = buildStopRecord(input);

    expect(message.content).toBe(renderStopEnvelope(input));
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]?.type).toBe('text');
    expect(message.parts[0]?.data).toBe(message.content);
  });

  it('незаданные детали в metadata не появляются', () => {
    const message = buildStopRecord({ reason: 'stopped_by_user' });

    expect(message.metadata?.error_type).toBeUndefined();
    expect(message.metadata?.retryable).toBeUndefined();
    expect(message.metadata?.attempts).toBeUndefined();
    expect(message.metadata?.max_retries).toBeUndefined();
    expect(message.metadata?.turn_id).toBeUndefined();
    // `report_delivered` — только у причин, где он осмыслен (`steps_limit`):
    // для остальных причина не задаёт поле и в metadata его нет.
    expect(message.metadata?.report_delivered).toBeUndefined();
    // Без хода — и на сообщении поля `turnId` нет (не «пустая строка»)
    expect(message.turnId).toBeUndefined();
  });

  it('report_delivered: в metadata записи, но не в конверте модели', () => {
    // `false` — тоже значение: глоток `if (… !== undefined)` отличает «не задано»
    // от «отчёта нет» (пустой отчёт по лимиту шагов).
    const missing = buildStopRecord({ reason: 'steps_limit', limit: 3, reportDelivered: false });
    expect(missing.metadata?.report_delivered).toBe(false);
    // Конверт (то, что видит модель) поля не содержит — это метаинформация UI.
    expect(missing.content).not.toContain('report_delivered');
    expect(renderStopEnvelope({ reason: 'steps_limit', limit: 3, reportDelivered: true }))
      .toBe(renderStopEnvelope({ reason: 'steps_limit', limit: 3 }));

    const delivered = buildStopRecord({ reason: 'steps_limit', limit: 3, reportDelivered: true });
    expect(delivered.metadata?.report_delivered).toBe(true);
    expect(delivered.content).not.toContain('report_delivered');
  });
});
