/**
 * Контрактный suite порта исполнения (PROP-077, шаг 1).
 *
 * По образцу `storage/contract/` — набор проверок, обязательный для ЛЮБОЙ
 * реализации порта (`InlineExecutionPort` сейчас, `RemoteExecutionPort` — на
 * шаге 7 плана PROP-077).
 */

export { describeExecutionPort } from './execution.js';
