import { ProviderFactory } from './base.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';

ProviderFactory.register('openai', OpenAIProvider);
ProviderFactory.register('generic', OpenAIProvider);
ProviderFactory.register('anthropic', AnthropicProvider);
ProviderFactory.register('ollama', OllamaProvider);

export { ProviderFactory, BaseProvider } from './base.js';
export type { LLMMessage, CancellationToken, ProviderConfig } from './base.js';
export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { OllamaProvider } from './ollama.js';
export { ProviderError, ContextLengthExceededError, RateLimitError } from './exceptions.js';
