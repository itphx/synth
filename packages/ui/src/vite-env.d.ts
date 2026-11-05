/// <reference types="vite/client" />

/**
 * Идентификатор сборки (`SYNTH_BUILD_ID`), подставляется Vite `define` в
 * `vite.config.ts`. В runtime без подстановки его нет — читать только через
 * `typeof` (см. `lib/build-info.ts`).
 */
declare const __SYNTH_BUILD_ID__: string | undefined
