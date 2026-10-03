import type { AISettings } from './aiSettings';
import { PROVIDER_PRESETS } from './aiSettings';

/**
 * Minimal multi-provider chat client. Everything runs from the background
 * worker using the user's own API key; nothing is ever called unless AI mode
 * is explicitly enabled in Options.
 */

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.text();
      detail = body.slice(0, 240);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json();
}

export async function chatCompletion(
  settings: AISettings,
  system: string,
  user: string,
  maxTokens = 2000
): Promise<string> {
  const preset = PROVIDER_PRESETS.find((p) => p.id === settings.provider);
  if (!preset) throw new Error(`Unknown AI provider: ${settings.provider}`);
  if (preset.keyRequired && !settings.apiKey.trim()) throw new Error(`${preset.label} needs an API key.`);
  const model = settings.model.trim() || preset.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    if (preset.kind === 'anthropic') {
      const data = await fetchJson(
        `${preset.base}/messages`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': settings.apiKey.trim(),
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature: 0.2,
            system,
            messages: [{ role: 'user', content: user }]
          })
        }
      );
      const text = (data.content ?? [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');
      if (!text) throw new Error(`No text returned by ${preset.label}${data.stop_reason ? ` (stop reason: ${data.stop_reason})` : ''} — try another model.`);
      return text;
    }

    if (preset.kind === 'gemini') {
      const data = await fetchJson(
        `${preset.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey.trim())}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens }
          })
        }
      );
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      if (!text) {
        const block = data.promptFeedback?.blockReason;
        throw new Error(
          `No text returned by ${preset.label}${block ? ` (prompt blocked: ${block})` : ' — the model returned an empty answer'} — try another model.`
        );
      }
      return text;
    }

    // OpenAI-compatible (OpenAI, Groq, OpenRouter, NVIDIA, Mistral, DeepSeek,
    // xAI, Cohere v2, Ollama, LM Studio).
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (settings.apiKey.trim()) headers.authorization = `Bearer ${settings.apiKey.trim()}`;
    const data = await fetchJson(`${preset.base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    const choice = (data.choices ?? [])[0];
    const text = choice?.message?.content ?? choice?.message?.reasoning_content ?? '';
    if (!text) {
      const reason = choice ? `finish reason: ${choice.finish_reason ?? 'none'}` : 'no choices returned';
      throw new Error(
        `No text returned by ${preset.label} for model "${model}" (${reason}). ` +
          'Reasoning models can spend all output tokens thinking — pick a regular chat model or increase the output size.'
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Model ids the configured key can actually use, from the provider's /models endpoint. */
export async function listModels(settings: AISettings): Promise<string[]> {
  const preset = PROVIDER_PRESETS.find((p) => p.id === settings.provider);
  if (!preset) throw new Error(`Unknown AI provider: ${settings.provider}`);
  if (preset.keyRequired && !settings.apiKey.trim()) throw new Error(`${preset.label} needs an API key.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    if (preset.kind === 'anthropic') {
      const data = await fetchJson(`${preset.base}/models`, {
        signal: controller.signal,
        headers: { 'x-api-key': settings.apiKey.trim(), 'anthropic-version': '2023-06-01' }
      });
      return (data.data ?? []).map((m: any) => String(m.id)).filter(Boolean);
    }
    if (preset.kind === 'gemini') {
      const data = await fetchJson(
        `${preset.base}/models?key=${encodeURIComponent(settings.apiKey.trim())}`,
        { signal: controller.signal }
      );
      return (data.models ?? [])
        .map((m: any) => String(m.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
    }
    const headers: Record<string, string> = {};
    if (settings.apiKey.trim()) headers.authorization = `Bearer ${settings.apiKey.trim()}`;
    const data = await fetchJson(`${preset.base}/models`, { signal: controller.signal, headers });
    return (data.data ?? []).map((m: any) => String(m.id)).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}
