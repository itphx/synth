/**
 * Метрики provisioner'а (ADR-094, PROP-135 §4b-2a).
 *
 * - собственный реестр (counter/gauge) и exposition 0.0.4;
 * - нули на старте (серии «нет данных» и «ноль» различимы);
 * - счётчики provision/release/idle/errors;
 * - gauge `synth_provisioner_pools{profile,state}` по источнику состояния;
 * - экранирование help/лейблов и ограничение кардинальности.
 */
import { describe, expect, it } from 'vitest';
import {
  ProvisionerRegistry,
  createProvisionerMetrics,
  escapeHelp,
  escapeLabelValue,
} from './metrics.js';

describe('provisioner: метрики', () => {
  it('нули на старте и все объявленные метрики', () => {
    const metrics = createProvisionerMetrics({ profiles: ['default'] });
    const { text, series } = metrics.render();
    expect(text).toContain('# TYPE synth_provisioner_pools gauge');
    expect(text).toContain('# HELP synth_provisioner_pools ');
    expect(text).toContain('synth_provisioner_pools{profile="default",state="ready"} 0');
    expect(text).toContain('synth_provisioner_pools{profile="default",state="draining"} 0');
    expect(text).toContain('# TYPE synth_provisioner_provision_total counter');
    for (const outcome of ['ok', 'error', 'capacity']) {
      expect(text).toContain(`synth_provisioner_provision_total{outcome="${outcome}"} 0`);
    }
    for (const outcome of ['ok', 'idle', 'lifetime', 'error']) {
      expect(text).toContain(`synth_provisioner_release_total{outcome="${outcome}"} 0`);
    }
    expect(text).toContain('synth_provisioner_idle_terminations_total 0');
    for (const reason of ['invalid_request', 'unauthorized', 'not_found', 'pool_not_found', 'capacity', 'internal_error']) {
      expect(text).toContain(`synth_provisioner_errors_total{reason="${reason}"} 0`);
    }
    expect(series).toBeGreaterThan(0);
  });

  it('счётчики инкрементируются по исходам', () => {
    const metrics = createProvisionerMetrics({ profiles: ['default'] });
    metrics.provisioned('ok');
    metrics.provisioned('ok');
    metrics.provisioned('capacity');
    metrics.released('ok');
    metrics.released('idle');
    metrics.released('lifetime');
    metrics.released('error');
    metrics.idleTerminated();
    metrics.error('pool_not_found');
    metrics.error('unauthorized');
    const text = metrics.render().text;
    expect(text).toContain('synth_provisioner_provision_total{outcome="ok"} 2');
    expect(text).toContain('synth_provisioner_provision_total{outcome="capacity"} 1');
    expect(text).toContain('synth_provisioner_release_total{outcome="ok"} 1');
    expect(text).toContain('synth_provisioner_release_total{outcome="idle"} 1');
    expect(text).toContain('synth_provisioner_idle_terminations_total 1');
    expect(text).toContain('synth_provisioner_errors_total{reason="pool_not_found"} 1');
    expect(text).toContain('synth_provisioner_errors_total{reason="unauthorized"} 1');
  });

  it('gauge пулов считается по источнику (профиль + состояние)', () => {
    const metrics = createProvisionerMetrics({ profiles: ['default'] });
    metrics.setPoolSource(() => [
      { profile: 'default', state: 'ready' },
      { profile: 'default', state: 'ready' },
      { profile: 'default', state: 'draining' },
      { profile: 'browser', state: 'ready' },
    ]);
    const text = metrics.render().text;
    expect(text).toContain('synth_provisioner_pools{profile="default",state="ready"} 2');
    expect(text).toContain('synth_provisioner_pools{profile="default",state="draining"} 1');
    expect(text).toContain('synth_provisioner_pools{profile="browser",state="ready"} 1');
    expect(text).toContain('synth_provisioner_pools{profile="browser",state="draining"} 0');
  });

  it('исчезнувшие из источника серии не залипают в gauge', () => {
    const metrics = createProvisionerMetrics({ profiles: [] });
    let records = [{ profile: 'default', state: 'ready' as const }];
    metrics.setPoolSource(() => records);
    expect(metrics.render().text).toContain('synth_provisioner_pools{profile="default",state="ready"} 1');
    records = [];
    expect(metrics.render().text).toContain('synth_provisioner_pools{profile="default",state="ready"} 0');
  });

  it('сбой источника пулов не ломает рендер', () => {
    const metrics = createProvisionerMetrics({ profiles: ['default'] });
    metrics.setPoolSource(() => {
      throw new Error('source failed');
    });
    expect(metrics.render().text).toContain('synth_provisioner_pools{profile="default",state="ready"} 0');
  });

  it('экранирование help и значений лейблов', () => {
    expect(escapeHelp('a "b" \\ c\n')).toBe('a \\"b\\" \\\\ c\\n');
    expect(escapeLabelValue('a "b" \\ c\n')).toBe('a \\"b\\" \\\\ c\\n');

    const registry = new ProvisionerRegistry();
    const counter = registry.counter('synth_test_total', 'Help "quoted"', ['reason']);
    counter.inc({ reason: 'a"b\nc' });
    const text = registry.render().text;
    expect(text).toContain('# HELP synth_test_total Help \\"quoted\\"');
    expect(text).toContain('synth_test_total{reason="a\\"b\\nc"} 1');
  });

  it('лейблы вне объявленного набора игнорируются (кардинальность)', () => {
    const registry = new ProvisionerRegistry();
    const counter = registry.counter('synth_test_total', 'help', ['reason']);
    counter.inc({ reason: 'ok', extra: 'should-be-ignored' });
    expect(registry.render().text).toContain('synth_test_total{reason="ok"} 1');
    expect(registry.render().text).not.toContain('should-be-ignored');
  });

  it('порядок вывода детерминирован: метрики и серии отсортированы', () => {
    const registry = new ProvisionerRegistry();
    const counter = registry.counter('synth_z_total', 'z', ['reason']);
    counter.inc({ reason: 'b' });
    counter.inc({ reason: 'a' });
    registry.gauge('synth_a', 'a');
    const lines = registry.render().text.trimEnd().split('\n');
    const metricNames = lines.filter((line) => line.startsWith('# TYPE')).map((line) => line.split(' ')[2]);
    expect(metricNames).toEqual(['synth_a', 'synth_z_total']);
    const seriesLines = lines.filter((line) => line.startsWith('synth_z_total'));
    expect(seriesLines[0]).toContain('reason="a"');
    expect(seriesLines[1]).toContain('reason="b"');
  });
});
