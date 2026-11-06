/**
 * Единая семантика правил хоста (ADR-099 — TLS/egress; PROP-124 — SSH-политика).
 *
 * Проверяем: нормализацию хоста, матчинг шаблона (exact / `*.suffix` / `*`),
 * валидатор правил (hostname, поддомены, IP-литерал, CIDR) и fail-closed
 * отказ одиночному `*`.
 */
import { describe, it, expect } from 'vitest';
import {
  HOST_RULE_FORMAT_HINT,
  isIpLiteral,
  isValidHostRule,
  matchTlsHostPattern,
  normalizeTlsHost,
} from './host-pattern.js';

describe('normalizeTlsHost', () => {
  it('нижний регистр, без точки в конце и скобок IPv6', () => {
    expect(normalizeTlsHost('Git.Example.COM.')).toBe('git.example.com');
    expect(normalizeTlsHost('[::1]')).toBe('::1');
    expect(normalizeTlsHost('  host  ')).toBe('host');
  });

  it('пустое значение → undefined', () => {
    expect(normalizeTlsHost('')).toBeUndefined();
    expect(normalizeTlsHost('   ')).toBeUndefined();
    expect(normalizeTlsHost(undefined)).toBeUndefined();
  });
});

describe('matchTlsHostPattern', () => {
  it('точное совпадение (регистронезависимо)', () => {
    expect(matchTlsHostPattern('git.example.com', 'git.example.com')).toBe(true);
    expect(matchTlsHostPattern('git.example.com', 'GIT.EXAMPLE.COM')).toBe(true);
    expect(matchTlsHostPattern('git.example.com', 'other.example.com')).toBe(false);
  });

  it('`*.suffix` — только поддомены, сам suffix не матчится', () => {
    expect(matchTlsHostPattern('*.corp.example', 'git.corp.example')).toBe(true);
    expect(matchTlsHostPattern('*.corp.example', 'a.b.corp.example')).toBe(true);
    expect(matchTlsHostPattern('*.corp.example', 'corp.example')).toBe(false);
    expect(matchTlsHostPattern('*.corp.example', 'git.example.com')).toBe(false);
  });

  it('`*` в TLS-профилях допустим (все хосты)', () => {
    expect(matchTlsHostPattern('*', 'anything.example.com')).toBe(true);
  });

  it('пустой хост → false', () => {
    expect(matchTlsHostPattern('git.example.com', '')).toBe(false);
  });
});

describe('isIpLiteral', () => {
  it('IPv4', () => {
    expect(isIpLiteral('10.0.0.5')).toBe(true);
    expect(isIpLiteral('255.255.255.255')).toBe(true);
    expect(isIpLiteral('256.0.0.1')).toBe(false);
    expect(isIpLiteral('10.0.0')).toBe(false);
    expect(isIpLiteral('01.2.3.4')).toBe(false);
  });

  it('IPv6', () => {
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('fe80::1')).toBe(true);
    expect(isIpLiteral('2001:db8:0:0:0:0:2:1')).toBe(true);
    expect(isIpLiteral('::ffff:192.168.0.1')).toBe(true);
    expect(isIpLiteral('2001:db8::1::2')).toBe(false);
    expect(isIpLiteral('gggg::1')).toBe(false);
  });
});

describe('isValidHostRule', () => {
  it('точный hostname', () => {
    expect(isValidHostRule('git.example.com')).toBe(true);
    expect(isValidHostRule('localhost')).toBe(true);
    expect(isValidHostRule('host-1.internal')).toBe(true);
  });

  it('поддомены `*.suffix`', () => {
    expect(isValidHostRule('*.corp.example')).toBe(true);
    expect(isValidHostRule('*.example.com')).toBe(true);
  });

  it('IP-литерал и CIDR', () => {
    expect(isValidHostRule('10.0.0.5')).toBe(true);
    expect(isValidHostRule('10.0.0.0/8')).toBe(true);
    expect(isValidHostRule('2001:db8::/32')).toBe(true);
    expect(isValidHostRule('10.0.0.0/33')).toBe(false);
    expect(isValidHostRule('example.com/24')).toBe(false);
  });

  it('одиночный `*` отклоняется (fail-closed)', () => {
    expect(isValidHostRule('*')).toBe(false);
  });

  it('пустые и regex-подобные записи отклоняются', () => {
    expect(isValidHostRule('')).toBe(false);
    expect(isValidHostRule('   ')).toBe(false);
    expect(isValidHostRule('.*')).toBe(false);
    expect(isValidHostRule('git.*.example.com')).toBe(false);
    expect(isValidHostRule('git example.com')).toBe(false);
  });

  it('подсказка по формату непустая', () => {
    expect(HOST_RULE_FORMAT_HINT.length).toBeGreaterThan(0);
  });
});
