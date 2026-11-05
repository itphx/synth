/**
 * Идентификатор сборки UI (`SYNTH_BUILD_ID`, подставляется Vite `define`).
 *
 * Пустая строка означает «неизвестен»: в тестах/локальной сборке без
 * переменной подстановки нет — тогда PWA-обновление фоллбечится на сравнение
 * semver (`health.version` vs `SYNTH_VERSION`).
 */
export const BUILD_ID: string = typeof __SYNTH_BUILD_ID__ === 'string' ? __SYNTH_BUILD_ID__ : ''
