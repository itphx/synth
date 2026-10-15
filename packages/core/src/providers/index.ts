import { ProviderFactory } from './base.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { RemoteProvider } from './remote.js';
import { DecisionProvider } from './decision.js';

ProviderFactory.register('openai', OpenAIProvider);
ProviderFactory.register('generic', OpenAIProvider);
ProviderFactory.register('anthropic', AnthropicProvider);
ProviderFactory.register('ollama', OllamaProvider);
ProviderFactory.register('remote', RemoteProvider);
ProviderFactory.register('synth-server', RemoteProvider);
// ADR-084: decision-модели (System One) — единый не-чат адаптер с двумя
// протоколами: `decision` (RouterAI, /decisions) и `systemone` (Ollama, /v1/systemone).
ProviderFactory.register('decision', DecisionProvider);
ProviderFactory.register('systemone', DecisionProvider);

export { ProviderFactory, BaseProvider } from './base.js';
export type { LLMMessage, CancellationToken, ProviderConfig } from './base.js';
export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { OllamaProvider } from './ollama.js';
export { RemoteProvider, setRemoteTokenProvider, clearRemoteTokenProviders } from './remote.js';
export { DecisionProvider } from './decision.js';
export { ProviderError, ContextLengthExceededError, RateLimitError } from './exceptions.js';
