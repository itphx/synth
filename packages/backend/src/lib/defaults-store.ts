// ADR-096 (W2.3): реализация перенесена в core (`storage/defaults-store.ts`) —
// это просто `{dataDir}/defaults.json` + атомарная запись, без backend-специфики.
// Здесь оставлен реэкспорт, чтобы существующие импорты (`../lib/defaults-store.js`)
// не менялись. См. `@itphx/synth-core`.
export { DefaultsStore, UI_SCALE_MIN, UI_SCALE_MAX } from '@itphx/synth-core';
export type { AppearanceDefaults } from '@itphx/synth-core';
