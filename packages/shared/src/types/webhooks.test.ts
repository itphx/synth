import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEBHOOK_EVENT_PATTERNS,
  isWebhookEventPattern,
  matchWebhookEvent,
} from './webhooks.js';

describe('webhooks: матчер событий (ADR-052, этап II)', () => {
  it('пустой список — дефолтный набор', () => {
    expect(matchWebhookEvent(undefined, 'session.created')).toBe(true);
    expect(matchWebhookEvent([], 'stream.done')).toBe(true);
    // Высокочастотный стриминг в дефолт не входит.
    expect(matchWebhookEvent([], 'stream.chunk')).toBe(false);
    expect(DEFAULT_WEBHOOK_EVENT_PATTERNS).toContain('session.*');
  });

  it('точный паттерн и prefix.*', () => {
    expect(matchWebhookEvent(['session.created'], 'session.created')).toBe(true);
    expect(matchWebhookEvent(['session.created'], 'session.updated')).toBe(false);
    expect(matchWebhookEvent(['session.*'], 'session.moved')).toBe(true);
    expect(matchWebhookEvent(['session.*'], 'message.added')).toBe(false);
    // `prefix.*` не матчит соседний префикс и сам префикс без точки.
    expect(matchWebhookEvent(['event.*'], 'event.routed')).toBe(true);
    expect(matchWebhookEvent(['event.*'], 'events')).toBe(false);
  });

  it('валидация формата паттерна', () => {
    expect(isWebhookEventPattern('session.created')).toBe(true);
    expect(isWebhookEventPattern('session.*')).toBe(true);
    expect(isWebhookEventPattern('bad pattern')).toBe(false);
    expect(isWebhookEventPattern('')).toBe(false);
    expect(isWebhookEventPattern('nodot')).toBe(false);
    expect(isWebhookEventPattern('session..created')).toBe(false);
  });
});
