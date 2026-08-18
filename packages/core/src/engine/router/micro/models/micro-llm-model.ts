/**
 * MicroLlmModel — микро-модель на локальной LLM (AD-035).
 * Уровень 3 каскада: структурированный prompt + локальная LLM через ProviderPool.
 *
 * Использует первую доступную локальную модель для классификации/решения.
 */
import type { MicroInput, MicroResult, MicroTaskClass } from '../types.js';
import type { MicroModel } from './base.js';
import type { ProviderPool } from '../../provider-pool.js';
import type { SessionSettings } from '@itphx/synth-shared';
import { warning } from '../../../../logger.js';

export interface MicroLlmConfig {
  provider?: string;
  model?: string;
}

export class MicroLlmModel implements MicroModel {
  readonly kind = 'micro_llm' as const;
  readonly name = 'micro-llm-classifier';
  private readonly _pool: ProviderPool;
  private readonly _config: MicroLlmConfig;

  constructor(pool: ProviderPool, config: MicroLlmConfig = {}) {
    this._pool = pool;
    this._config = config;
  }

  canHandle(taskClass: MicroTaskClass): boolean {
    return taskClass === 'classify' || taskClass === 'enum_decision';
  }

  async handle(input: MicroInput, taskClass: MicroTaskClass): Promise<MicroResult> {
    const startTime = performance.now();

    // Определяем провайдера и модель
    const providerName = this._config.provider || this._findFirstLocalProvider(input.sessionSettings);
    const modelName = this._config.model || this._getModelForProvider(providerName, input.sessionSettings);

    if (!providerName || !modelName) {
      return this._unsure(taskClass, startTime, ['no_local_provider']);
    }

    const provider = this._pool.getProvider(providerName, modelName, 0.1);
    if (!provider) {
      return this._unsure(taskClass, startTime, [`provider_not_found:${providerName}/${modelName}`]);
    }

    try {
      const prompt = this._buildPrompt(taskClass, input.userMessage);
      const messages = [{
        id: '',
        role: 'user' as const,
        content: prompt,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      }];

      const response = await provider.chat(messages, undefined, undefined, false);
      const content = response.content.trim().toLowerCase();

      // Парсим ответ: ожидаем одно слово/метку
      const label = this._parseLabel(content, taskClass);
      const confidence = label ? 0.85 : 0.4;

      return {
        status: confidence >= (input.sessionSettings.microConfidenceThreshold || 0.8) ? 'OK' : 'UNSURE',
        taskClass,
        label: label || undefined,
        confidence,
        usage: response.usage ? {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        } : undefined,
        latencyMs: Math.round(performance.now() - startTime),
        signals: label ? [`micro_llm:${label}`] : ['micro_llm:unparsable'],
      };
    } catch (err) {
      warning('MICRO', `Micro-LLM error: ${err}`);
      return this._unsure(taskClass, startTime, [`error:${String(err).slice(0, 100)}`]);
    }
  }

  // ── private ──

  private _findFirstLocalProvider(settings: SessionSettings): string {
    // Если в настройках сессии указан провайдер — используем его
    if (settings.provider) return settings.provider;
    return '';
  }

  private _getModelForProvider(_providerName: string, _settings: SessionSettings): string {
    // Если в настройках сессии указана модель — используем её
    // Иначе возвращаем пустую строку, pool сам найдёт default
    return '';
  }

  private _buildPrompt(taskClass: MicroTaskClass, userMessage: string): string {
    switch (taskClass) {
      case 'classify':
        return [
          'Классифицируй запрос пользователя. Ответь одним словом из списка.',
          'Метки: question, command, review, explain, debug, fix, test, other.',
          'Отвечай только одним словом.',
          '',
          `Запрос: ${userMessage}`,
        ].join('\n');

      case 'enum_decision':
        return [
          'Ответь на запрос одним словом из списка.',
          'Метки: yes, no, approve, reject, mode_plan, mode_act, other.',
          'Отвечай только одним словом.',
          '',
          `Запрос: ${userMessage}`,
        ].join('\n');

      default:
        return userMessage;
    }
  }

  private _parseLabel(content: string, taskClass: MicroTaskClass): string | null {
    const word = content.split(/\s+/)[0]?.replace(/[^a-z_]/g, '') || '';

    const validLabels: Record<MicroTaskClass, string[]> = {
      small_talk: [],
      classify: ['question', 'command', 'review', 'explain', 'debug', 'fix', 'test', 'other'],
      enum_decision: ['yes', 'no', 'approve', 'reject', 'mode_plan', 'mode_act', 'other'],
      llm_task: [],
    };

    const labels = validLabels[taskClass] ?? [];
    return labels.includes(word) ? word : null;
  }

  private _unsure(taskClass: MicroTaskClass, startTime: number, signals: string[]): MicroResult {
    return {
      status: 'UNSURE',
      taskClass,
      confidence: 0.3,
      latencyMs: Math.round(performance.now() - startTime),
      signals,
    };
  }
}
