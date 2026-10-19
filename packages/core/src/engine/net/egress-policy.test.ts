import { describe, it, expect } from 'vitest';
import { isValidEgressRule, validateEgressPolicy } from './egress-policy.js';

/**
 * Грамматика правил политики (ADR-071 §2.3.1, ADR-099):
 * hostname | `*.suffix` | CIDR | одиночный IP-литерал.
 *
 * Инварианты, которые тесты фиксируют:
 * - одиночный IP-литерал **валиден** и равнозначен CIDR с полной маской
 *   (`10.0.0.5` → /32, `::1` → /128) — иначе deny-список не блокировал бы
 *   адрес, а исключение молча игнорировалось бы (fail-open);
 * - паттерн «`*`» **недопустим**: исключение не может разрешить любой хост
 *   (fail-closed) — иначе одно правило снимало бы всю SSRF-защиту.
 */
describe('egress-policy: грамматика правил (isValidEgressRule)', () => {
  it('hostname и *.suffix — валидны', () => {
    expect(isValidEgressRule('example.com')).toBe(true);
    expect(isValidEgressRule('gw.synth.svc.cluster.local')).toBe(true);
    expect(isValidEgressRule('*.svc.cluster.local')).toBe(true);
    expect(isValidEgressRule('*.local')).toBe(true);
  });

  it('CIDR — валиден, мусорный CIDR — нет', () => {
    expect(isValidEgressRule('10.0.0.0/8')).toBe(true);
    expect(isValidEgressRule('::/128')).toBe(true);
    expect(isValidEgressRule('::ffff:0:0/96')).toBe(true);
    expect(isValidEgressRule('10.0.0.0/33')).toBe(false);
    expect(isValidEgressRule('nonsense/8')).toBe(false);
    expect(isValidEgressRule('/8')).toBe(false);
  });

  it('одиночный IP-литерал — валиден (/32 или /128)', () => {
    expect(isValidEgressRule('169.254.169.254')).toBe(true);
    expect(isValidEgressRule('10.0.0.5')).toBe(true);
    expect(isValidEgressRule('::1')).toBe(true);
    expect(isValidEgressRule('::ffff:169.254.169.254')).toBe(true);
  });

  it('«*» недопустим — исключение не может разрешить любой хост (fail-closed)', () => {
    expect(isValidEgressRule('*')).toBe(false);
    expect(isValidEgressRule(' * ')).toBe(false);
    expect(isValidEgressRule('*.*')).toBe(false);
  });

  it('мусор, пустые строки и regex-подобные записи недопустимы', () => {
    expect(isValidEgressRule('')).toBe(false);
    expect(isValidEgressRule('   ')).toBe(false);
    expect(isValidEgressRule('bad host')).toBe(false);
    expect(isValidEgressRule('a.*.com')).toBe(false);
    expect(isValidEgressRule('*example.com')).toBe(false);
    expect(isValidEgressRule('http://example.com')).toBe(false);
    expect(isValidEgressRule('example.com/path')).toBe(false);
  });
});

describe('egress-policy: validateEgressPolicy (точные сообщения об ошибках)', () => {
  it('валидная политика принимается, записи нормализуются (trim)', () => {
    const res = validateEgressPolicy({
      mode: 'deny',
      list: [' 10.0.0.0/8 ', 'example.com'],
      exceptions: [' *.svc.cluster.local '],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех валидации');
    expect(res.policy.list).toEqual(['10.0.0.0/8', 'example.com']);
    expect(res.policy.exceptions).toEqual(['*.svc.cluster.local']);
  });

  it('не-объект — точное сообщение', () => {
    expect(validateEgressPolicy(null)).toEqual({
      ok: false,
      message: 'policy: ожидается { mode, list: string[], exceptions: string[] }',
    });
  });

  it('неверный mode — точное сообщение', () => {
    expect(validateEgressPolicy({ mode: 'block', list: [] })).toEqual({
      ok: false,
      message: 'policy.mode: ожидается "deny" | "allow"',
    });
  });

  it('list не массив — точное сообщение', () => {
    expect(validateEgressPolicy({ mode: 'deny', list: '10.0.0.0/8' })).toEqual({
      ok: false,
      message: 'policy.list: ожидается string[]',
    });
  });

  it('exceptions не массив — точное сообщение', () => {
    expect(validateEgressPolicy({ mode: 'deny', list: [], exceptions: 'example.com' })).toEqual({
      ok: false,
      message: 'policy.exceptions: ожидается string[]',
    });
  });

  it('мусорное правило в list — точное сообщение с самой записью', () => {
    expect(validateEgressPolicy({ mode: 'deny', list: ['bad host'], exceptions: [] })).toEqual({
      ok: false,
      message: 'policy: невалидная запись "bad host" (ожидается hostname, *.suffix, CIDR или IP)',
    });
  });

  it('мусорное исключение — точное сообщение (тот же текст, что и для list)', () => {
    expect(validateEgressPolicy({ mode: 'deny', list: [], exceptions: ['bad host'] })).toEqual({
      ok: false,
      message: 'policy: невалидная запись "bad host" (ожидается hostname, *.suffix, CIDR или IP)',
    });
  });

  it('«*» в исключениях отвергается — точный текст (fail-closed)', () => {
    expect(validateEgressPolicy({ mode: 'deny', list: [], exceptions: ['*'] })).toEqual({
      ok: false,
      message: 'policy: невалидная запись "*" (ожидается hostname, *.suffix, CIDR или IP)',
    });
  });

  it('пустая запись отвергается с указанием самой записи', () => {
    expect(validateEgressPolicy({ mode: 'deny', list: ['  '], exceptions: [] })).toEqual({
      ok: false,
      message: 'policy: невалидная запись "" (ожидается hostname, *.suffix, CIDR или IP)',
    });
  });

  it('голый IP валиден и в list, и в exceptions', () => {
    const res = validateEgressPolicy({
      mode: 'deny',
      list: ['169.254.169.254'],
      exceptions: ['10.0.0.5', '::1'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('ожидался успех валидации');
    expect(res.policy.list).toEqual(['169.254.169.254']);
    expect(res.policy.exceptions).toEqual(['10.0.0.5', '::1']);
  });

  it('mode=off допустим только при allowOff (webhooks)', () => {
    expect(validateEgressPolicy({ mode: 'off', list: [], exceptions: [] })).toEqual({
      ok: false,
      message: 'policy.mode: ожидается "deny" | "allow"',
    });
    const webhooks = validateEgressPolicy({ mode: 'off', list: [], exceptions: [] }, { allowOff: true });
    expect(webhooks.ok).toBe(true);
  });
});
