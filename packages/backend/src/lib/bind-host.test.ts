/**
 * Аудит F5: bind-host backend — вне контейнера loopback, в контейнере 0.0.0.0,
 * `SYNTH_HOST` приоритетен всегда.
 */
import { describe, it, expect } from 'vitest';
import { detectContainer, resolveBindHost } from './bind-host.js';

describe('resolveBindHost', () => {
  it('без env вне контейнера → 127.0.0.1 (loopback)', () => {
    expect(resolveBindHost({}, false)).toBe('127.0.0.1');
  });

  it('без env в контейнере → 0.0.0.0', () => {
    expect(resolveBindHost({}, true)).toBe('0.0.0.0');
  });

  it('SYNTH_HOST переопределяет оба дефолта', () => {
    expect(resolveBindHost({ SYNTH_HOST: '0.0.0.0' }, false)).toBe('0.0.0.0');
    expect(resolveBindHost({ SYNTH_HOST: '10.1.2.3' }, true)).toBe('10.1.2.3');
  });

  it('пустой/пробельный SYNTH_HOST — как «не задан»', () => {
    expect(resolveBindHost({ SYNTH_HOST: '' }, false)).toBe('127.0.0.1');
    expect(resolveBindHost({ SYNTH_HOST: '   ' }, true)).toBe('0.0.0.0');
  });
});

describe('detectContainer', () => {
  it('маркер Docker (/.dockerenv)', () => {
    expect(detectContainer({}, (path) => path === '/.dockerenv')).toBe(true);
    expect(detectContainer({}, () => false)).toBe(false);
  });

  it('KUBERNETES_SERVICE_HOST → контейнер', () => {
    expect(detectContainer({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, () => false)).toBe(true);
  });

  it('SYNTH_IN_CONTAINER=true|1 → контейнер, иное — нет', () => {
    expect(detectContainer({ SYNTH_IN_CONTAINER: 'true' }, () => false)).toBe(true);
    expect(detectContainer({ SYNTH_IN_CONTAINER: '1' }, () => false)).toBe(true);
    expect(detectContainer({ SYNTH_IN_CONTAINER: 'false' }, () => false)).toBe(false);
  });
});
