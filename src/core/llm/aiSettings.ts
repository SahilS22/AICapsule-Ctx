/**
 * AI provider settings — opt-in. The product's default extraction engine is
 * the offline heuristic pipeline; these settings only switch distillation to
 * the user's own LLM account when explicitly enabled.
 */

export interface AISettings {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  kind: 'openai' | 'anthropic' | 'gemini';
  base: string;
  model: string;
  keyRequired: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI (ChatGPT)', kind: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyRequired: true },
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest', keyRequired: true },
  { id: 'gemini', label: 'Google Gemini', kind: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-1.5-flash', keyRequired: true },
  { id: 'groq', label: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyRequired: true },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', keyRequired: true },
  { id: 'nvidia', label: 'NVIDIA NIM', kind: 'openai', base: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.1-70b-instruct', keyRequired: true },
  { id: 'mistral', label: 'Mistral AI', kind: 'openai', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', keyRequired: true },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai', base: 'https://api.deepseek.com', model: 'deepseek-chat', keyRequired: true },
  { id: 'xai', label: 'xAI (Grok)', kind: 'openai', base: 'https://api.x.ai/v1', model: 'grok-3-mini', keyRequired: true },
  { id: 'cohere', label: 'Cohere', kind: 'openai', base: 'https://api.cohere.com/v2', model: 'command-r-08-2024', keyRequired: true },
  { id: 'ollama', label: 'Ollama (local)', kind: 'openai', base: 'http://localhost:11434/v1', model: 'llama3.1', keyRequired: false },
  { id: 'lmstudio', label: 'LM Studio (local)', kind: 'openai', base: 'http://localhost:1234/v1', model: 'local-model', keyRequired: false }
];

const STORAGE_KEY = 'cc_ai_settings';

export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: false,
  provider: 'openai',
  model: '',
  apiKey: ''
};

export async function loadAISettings(): Promise<AISettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const s = stored?.[STORAGE_KEY];
  if (!s || typeof s !== 'object') return { ...DEFAULT_AI_SETTINGS };
  return {
    enabled: s.enabled === true,
    provider: typeof s.provider === 'string' ? s.provider : DEFAULT_AI_SETTINGS.provider,
    model: typeof s.model === 'string' ? s.model : '',
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : ''
  };
}

export async function saveAISettings(settings: AISettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}
