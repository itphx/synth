import { describe, expect, it } from 'vitest';
import {
  HTTP_ERROR_CODE,
  NETWORK_ERROR_CODE,
  SynthApiError,
  isSynthApiError,
  parseErrorBody,
} from './errors.js';

describe('SynthApiError', () => {
  it('является Error, несёт status/code/message/body', () => {
    const err = new SynthApiError({
      status: 409,
      code: 'CONFLICT',
      message: 'занято',
      body: { error: { code: 'CONFLICT' } },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SynthApiError);
    expect(err.name).toBe('SynthApiError');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('занято');
    expect(err.body).toEqual({ error: { code: 'CONFLICT' } });
  });
});

describe('isSynthApiError', () => {
  it('распознаёт только SynthApiError', () => {
    expect(isSynthApiError(new SynthApiError({ status: 0, code: 'X', message: 'm' }))).toBe(true);
    expect(isSynthApiError(new Error('m'))).toBe(false);
    expect(isSynthApiError(null)).toBe(false);
    expect(isSynthApiError({ status: 401, code: 'UNAUTHORIZED' })).toBe(false);
  });
});

describe('parseErrorBody', () => {
  it('разбирает единый формат { error: { code, message } }', () => {
    expect(
      parseErrorBody({ error: { code: 'VALIDATION_ERROR', message: 'плохое тело' } }),
    ).toEqual({ code: 'VALIDATION_ERROR', message: 'плохое тело' });
  });

  it('поддерживает FS-форму { error: { error, code } }', () => {
    expect(parseErrorBody({ error: { error: 'нет файла', code: 'NOT_FOUND' } })).toEqual({
      code: 'NOT_FOUND',
      message: 'нет файла',
    });
  });

  it('без code → HTTP_ERROR, пустое сообщение', () => {
    expect(parseErrorBody({ error: { message: 'только текст' } })).toEqual({
      code: HTTP_ERROR_CODE,
      message: 'только текст',
    });
  });

  it('неразобранное тело → HTTP_ERROR', () => {
    expect(parseErrorBody('boom')).toEqual({ code: HTTP_ERROR_CODE, message: '' });
    expect(parseErrorBody(null)).toEqual({ code: HTTP_ERROR_CODE, message: '' });
    expect(parseErrorBody({})).toEqual({ code: HTTP_ERROR_CODE, message: '' });
  });

  it('константы кодов стабильны', () => {
    expect(HTTP_ERROR_CODE).toBe('HTTP_ERROR');
    expect(NETWORK_ERROR_CODE).toBe('NETWORK_ERROR');
  });
});
