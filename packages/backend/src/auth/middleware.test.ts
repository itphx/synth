import { describe, it, expect } from 'vitest';
import { isSessionCookieSecure } from './middleware.js';

// Cookie сессии: `Secure` по умолчанию; отключается только явным opt-out
// `SYNTH_COOKIE_INSECURE=true` (локальная http-разработка).
describe('isSessionCookieSecure', () => {
  it('по умолчанию (пустое окружение) → true', () => {
    expect(isSessionCookieSecure({})).toBe(true);
  });

  it('NODE_ENV=production → true', () => {
    expect(isSessionCookieSecure({ NODE_ENV: 'production' })).toBe(true);
  });

  it('NODE_ENV=development без opt-out → true (Secure по умолчанию)', () => {
    expect(isSessionCookieSecure({ NODE_ENV: 'development' })).toBe(true);
  });

  it('SYNTH_COOKIE_INSECURE=true → false (явный opt-out)', () => {
    expect(isSessionCookieSecure({ SYNTH_COOKIE_INSECURE: 'true' })).toBe(false);
  });

  it('SYNTH_COOKIE_INSECURE=false/иное значение → true', () => {
    expect(isSessionCookieSecure({ SYNTH_COOKIE_INSECURE: 'false' })).toBe(true);
    expect(isSessionCookieSecure({ SYNTH_COOKIE_INSECURE: '1' })).toBe(true);
  });
});
