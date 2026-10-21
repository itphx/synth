/**
 * Контрактный suite порта исполнения — прогон против inline-реализации
 * (PROP-077, шаг 1). Remote-реализация (шаг 7) прогоняет тот же набор.
 */

import { InlineExecutionPort } from '../inline-execution-port.js';
import { describeExecutionPort } from './index.js';

describeExecutionPort('InlineExecutionPort → ExecutionPort', async () => ({
  port: new InlineExecutionPort(),
}));
