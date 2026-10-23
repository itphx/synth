/**
 * ADR-090: реестр провайдеров блоков системного промпта.
 *
 * Реестр живёт рядом с `SystemPromptComposer` (`engine/context/composer.ts`):
 * композер обходит его при каждой сборке промпта и добавляет блоки провайдеров
 * в **тот же** массив блоков, что и встроенные (один манифест, одна склейка,
 * одна сортировка по тирам).
 *
 * **Правила регистрации (fail-closed).**
 * - тир `stable` — **отказ** (не тихое понижение до `context`): stable-блок
 *   ломал бы границу prompt-cache (ADR-070 §2.1);
 * - ключ уникален в инстансе (для плагина — `plugin.<pluginName>.<slot>`);
 * - порядок обхода — порядок регистрации (детерминированный), итоговый
 *   порядок блоков определяет `sortPromptBlocks` (тир → `order`).
 *
 * Реестр не знает про плагины: он работает с провайдерами как с абстракцией.
 * Плагинный provenance (`plugin:<name>`) задаёт вызывающая сторона (фасад
 * плагина, `engine/plugins/activation.ts`).
 */
import type { PromptBlockProvider } from '@itphx/synth-shared';
import { PROMPT_BLOCK_PROVIDER_TIERS } from '@itphx/synth-shared';

/** Ошибка регистрации провайдера блока промпта (понятная причина — не тихий отказ). */
export class PromptBlockRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptBlockRegistrationError';
  }
}

/** Параметры регистрации провайдера. */
export interface PromptBlockRegistrationOptions {
  /** Provenance блока (для плагина — `plugin:<name>`). */
  provenance?: string;
  /** Подпись блока в манифесте промпта (перекрывает `provider.title`). */
  title?: string;
}

/** Зарегистрированный провайдер вместе с метаданными регистрации. */
export interface RegisteredPromptBlock {
  provider: PromptBlockProvider;
  provenance?: string;
  title?: string;
}

/**
 * Реестр провайдеров блоков системного промпта.
 *
 * Порядок обхода — порядок регистрации; `unregister`/disposer удаляет
 * провайдера (блок исчезает из следующей сборки промпта).
 */
export class PromptBlockRegistry {
  private readonly _providers = new Map<string, RegisteredPromptBlock>();

  /**
   * Зарегистрировать провайдера.
   *
   * @returns disposer — снимает провайдера (идемпотентен).
   * @throws {PromptBlockRegistrationError} — невалидный тир (`stable`), пустой
   *   ключ, нечисловой порядок или занятый ключ.
   */
  register(
    provider: PromptBlockProvider,
    opts: PromptBlockRegistrationOptions = {},
  ): () => void {
    const key = provider.key?.trim() ?? '';
    if (!key) {
      throw new PromptBlockRegistrationError(
        'Провайдер блока промпта не задан (пустой key) — блок не зарегистрирован.',
      );
    }
    if (!(PROMPT_BLOCK_PROVIDER_TIERS as readonly string[]).includes(provider.tier)) {
      throw new PromptBlockRegistrationError(
        `Провайдер блока промпта «${key}» заявил тир «${String(provider.tier)}»: ` +
        `тир stable запрещён для расширений (граница prompt-cache, ADR-070). ` +
        `Допустимы: ${PROMPT_BLOCK_PROVIDER_TIERS.join('|')}.`,
      );
    }
    if (typeof provider.order !== 'number' || !Number.isFinite(provider.order)) {
      throw new PromptBlockRegistrationError(
        `Провайдер блока промпта «${key}» заявил нечисловой порядок ` +
        `«${String(provider.order)}» — блок не зарегистрирован.`,
      );
    }
    if (this._providers.has(key)) {
      throw new PromptBlockRegistrationError(
        `Провайдер блока промпта «${key}» уже зарегистрирован: ` +
        'ключ блока должен быть уникален в инстансе.',
      );
    }

    this._providers.set(key, {
      provider,
      ...(opts.provenance ? { provenance: opts.provenance } : {}),
      ...(opts.title ? { title: opts.title } : {}),
    });

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this._providers.delete(key);
    };
  }

  /** Снять провайдера по ключу (`false` — провайдера не было). */
  unregister(key: string): boolean {
    return this._providers.delete(key);
  }

  /** Запись по ключу (`undefined` — не зарегистрирован). */
  get(key: string): RegisteredPromptBlock | undefined {
    return this._providers.get(key);
  }

  /** Все провайдеры в порядке регистрации. */
  list(): RegisteredPromptBlock[] {
    return [...this._providers.values()];
  }

  /** Число зарегистрированных провайдеров. */
  get size(): number {
    return this._providers.size;
  }

  /** Снять всех провайдеров (служебно — тесты/сброс). */
  clear(): void {
    this._providers.clear();
  }
}
