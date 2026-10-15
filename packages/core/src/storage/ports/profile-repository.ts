import type { ProfileStore } from '@itphx/synth-shared';

/**
 * Порт хранилища профилей (реализация — `FileProfileStore`).
 *
 * Профильное хранилище уже описано доменным контрактом `ProfileStore` в
 * `@itphx/synth-shared` (им используется и backend, и UI через API). Чтобы не
 * дублировать сигнатуры и не допустить расхождения, порт — алиас на этот
 * контракт, а не копия методов.
 */
export type ProfileRepository = ProfileStore;
