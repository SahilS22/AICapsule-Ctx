import type { ArchiveMessage, MemoryItem } from '../capsule/schema';

/**
 * LLM provider abstraction (§33).
 *
 * The shipped product runs fully locally on the heuristic engine
 * (src/core/extraction/memories.ts). This interface is the seam for optional
 * higher-quality extraction/compression via OpenAI / Anthropic / Google /
 * Ollama etc. — always opt-in, always with the user's own key, never required.
 *
 * Nothing in core depends on a provider being present.
 */
export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  /** True when the provider is configured (e.g. API key present) and usable. */
  isAvailable(): Promise<boolean>;
  extract(messages: ArchiveMessage[]): Promise<MemoryItem[]>;
  compress(text: string, targetTokens: number): Promise<string>;
  classify(text: string): Promise<string>;
}

const providers = new Map<string, LLMProvider>();

export function registerProvider(p: LLMProvider): void {
  providers.set(p.id, p);
}

export function getProvider(id: string): LLMProvider | undefined {
  return providers.get(id);
}

export function listProviders(): LLMProvider[] {
  return [...providers.values()];
}
