import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SecretPattern, SecretPatternRepository } from '@itphx/synth-core';

function isValidPattern(p: unknown): p is SecretPattern {
  if (typeof p !== 'object' || p === null) return false;
  const { type, regex } = p as Record<string, unknown>;
  if (typeof type !== 'string' || type.trim() === '') return false;
  if (typeof regex !== 'string') return false;
  try {
    new RegExp(regex);
    return true;
  } catch {
    return false;
  }
}

/**
 * LLM Gateway (ADR-036) — управление regex-паттернами детекции секретов.
 * Схема «системный + override»: пользовательский список полностью заменяет дефолтный,
 * DELETE сбрасывает к встроенным паттернам. Только ADMIN.
 */
export function createGatewayPatternsRoutes(kit: AuthKit, store: SecretPatternRepository): Hono {
  const app = new Hono();

  // GET /api/v2/gateway/patterns — текущий список + признак override + дефолт
  app.get('/patterns', kit.requireAdmin, (c) => {
    const raw = store.getRawPatterns();
    return c.json({
      patterns: raw.patterns,
      is_overridden: raw.isOverridden,
      default_patterns: raw.defaultPatterns,
    });
  });

  // PUT /api/v2/gateway/patterns — сохранить override-список
  app.put('/patterns', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const patterns: unknown = (body as { patterns?: unknown })?.patterns;

    if (!Array.isArray(patterns) || !patterns.every(isValidPattern)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'patterns должен быть массивом элементов {type: string, regex: string}' },
      }, 400);
    }

    const ok = await store.savePatterns(patterns as SecretPattern[]);
    if (!ok) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Не удалось сохранить паттерны обфускации' },
      }, 400);
    }

    return c.json({ patterns: store.getPatterns(), is_overridden: true, saved: true });
  });

  // DELETE /api/v2/gateway/patterns — сброс к дефолтным паттернам
  app.delete('/patterns', kit.requireAdmin, async (c) => {
    await store.reset();
    return c.json({ status: 'restored' });
  });

  return app;
}
