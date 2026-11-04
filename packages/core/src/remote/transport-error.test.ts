import { describe, it, expect } from 'vitest';
import { describeTransportError, extractTransportErrorCode } from './transport-error.js';

/** Транспортная ошибка undici: `TypeError: fetch failed` + `cause`. */
function transportFailure(code: string): TypeError {
  const cause = Object.assign(new Error(`boom ${code}`), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('extractTransportErrorCode', () => {
  it('достаёт code из cause', () => {
    expect(extractTransportErrorCode(transportFailure('ENOTFOUND'))).toBe('ENOTFOUND');
  });

  it('достаёт code из AggregateError (undici)', () => {
    const error = new AggregateError([transportFailure('ECONNREFUSED')], 'fetch failed');
    expect(extractTransportErrorCode(error)).toBe('ECONNREFUSED');
  });

  it('нет code → undefined', () => {
    expect(extractTransportErrorCode(new TypeError('Failed to fetch'))).toBeUndefined();
    expect(extractTransportErrorCode(undefined)).toBeUndefined();
  });
});

describe('describeTransportError', () => {
  it('TLS-код → подсказка про CA и имя хоста', () => {
    const text = describeTransportError(transportFailure('SELF_SIGNED_CERT_IN_CHAIN'));
    expect(text).toContain('SELF_SIGNED_CERT_IN_CHAIN');
    expect(text).toContain('CA');
  });

  it('префикс ERR_SSL тоже считается TLS', () => {
    const text = describeTransportError(transportFailure('ERR_SSL_WRONG_VERSION_NUMBER'));
    expect(text).toContain('TLS');
  });

  it('DNS-код → подсказка про DNS', () => {
    expect(describeTransportError(transportFailure('EAI_AGAIN'))).toContain('DNS');
  });

  it('отказ соединения и таймаут — свои подсказки', () => {
    expect(describeTransportError(transportFailure('ECONNREFUSED'))).toContain('отклонено');
    expect(describeTransportError(transportFailure('UND_ERR_CONNECT_TIMEOUT'))).toContain('таймаут');
  });

  it('неизвестный код — только код, без домыслов', () => {
    expect(describeTransportError(transportFailure('ESOMETHING'))).toBe(': ESOMETHING');
  });

  it('нет кода → пустая строка (текст ошибки не меняется)', () => {
    expect(describeTransportError(new TypeError('Failed to fetch'))).toBe('');
  });
});
