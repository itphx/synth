import type { ProviderConfig, ModelConfig } from '@itphx/synth-shared';
import type { JsonStoreLike } from '../storage/json-store.js';

/**
 * Синхронизация провайдеров/моделей из переменных окружения `SYNTH_PROVIDER_*`
 * (AD-038). Формат: `SYNTH_PROVIDER_<NAME>_(API_KEY|URL|MODEL|TYPE)`; имя
 * приводится к lowercase с `_` → `-`. Провайдеры сохраняются в `providerStore`
 * (дефолтный `type: 'openai'`), указанная `MODEL` дополнительно создаёт модель
 * `<name>/<model>` с `isDefault: true`, если её ещё нет.
 *
 * Общая точка для core и backend: вызывается после создания stores и до
 * заполнения in-memory кэшей провайдеров/моделей.
 */
export async function syncProvidersFromEnv(
  providerStore: JsonStoreLike<ProviderConfig>,
  modelStore: JsonStoreLike<ModelConfig>,
): Promise<void> {
  const providerPattern = /^SYNTH_PROVIDER_([A-Z][A-Z0-9_]*?)_(API_KEY|URL|MODEL|TYPE)$/;
  const providers: Map<string, Partial<ProviderConfig> & { model?: string }> = new Map();

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(providerPattern);
    if (!match || !value) continue;

    const [, rawName, field] = match;
    if (!rawName) continue;
    const name = rawName.toLowerCase().replace(/_/g, '-');

    if (!providers.has(name)) {
      providers.set(name, { name, type: 'openai' });
    }

    const p = providers.get(name)!;
    switch (field) {
      case 'API_KEY': p.apiKey = value; break;
      case 'URL': p.baseUrl = value; break;
      case 'MODEL': p.model = value; break;
      case 'TYPE': p.type = value; break;
    }
  }

  for (const [name, envConfig] of providers) {
    const existing = await providerStore.load(name);
    const provider: ProviderConfig = {
      name,
      type: envConfig.type || existing?.type || 'openai',
      baseUrl: envConfig.baseUrl || existing?.baseUrl,
      apiKey: envConfig.apiKey || existing?.apiKey,
      defaultModel: envConfig.model || existing?.defaultModel,
      timeout: existing?.timeout ?? 120,
      enabled: true,
      icon: existing?.icon ?? '',
    };
    await providerStore.save(name, provider);

    // Если указана модель — создаём её
    if (envConfig.model) {
      const modelId = `${name}/${envConfig.model}`;
      const existingModel = await modelStore.load(modelId);
      if (!existingModel) {
        await modelStore.save(modelId, {
          id: modelId,
          name: envConfig.model,
          provider: name,
          description: '',
          enabled: true,
          isDefault: true,
        });
      }
    }

    console.log(`  [env] провайдер: ${name} (${provider.type})${provider.baseUrl ? ` → ${provider.baseUrl}` : ''}`);
  }
}
