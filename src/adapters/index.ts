import { PlatformAdapter } from './base';
import { ChatGPTAdapter } from './chatgpt';
import { ClaudeAdapter } from './claude';
import { GeminiAdapter } from './gemini';
import { GenericChatAdapter } from './generic';

const adapters: PlatformAdapter[] = [
  new ChatGPTAdapter(),
  new ClaudeAdapter(),
  new GeminiAdapter(),
  new GenericChatAdapter('deepseek', [/^chat\.deepseek\.com$/], {
    composerSelectors: ['#chat-input', 'textarea'],
    userSelectors: ['[class*="user-message"]', '[data-role="user"]']
  }),
  new GenericChatAdapter('grok', [/^grok\.com$/], {
    composerSelectors: ['div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
    userSelectors: ['div[data-index]']
  }),
  new GenericChatAdapter('perplexity', [/^(www\.)?perplexity\.ai$/], {
    composerSelectors: ['textarea', 'div[contenteditable="true"]'],
    userSelectors: ['[data-testid="query-text"]', '[class*="query" i]']
  }),
  new GenericChatAdapter('meta', [/^(www\.)?meta\.ai$/], {
    composerSelectors: ['div[contenteditable="true"]', 'textarea']
  }),
  new GenericChatAdapter('copilot', [/^(www\.)?copilot\.microsoft\.(com|cn)$/], {
    composerSelectors: ['#search-box', 'div[contenteditable="true"]', 'textarea']
  }),
  new GenericChatAdapter('mistral', [/^chat\.mistral\.ai$/], {
    composerSelectors: ['div[contenteditable="true"]', 'textarea']
  }),
  new GenericChatAdapter('kimi', [/^(www\.)?kimi\.com$/, /^kimi\.moonshot\.cn$/], {
    composerSelectors: ['div[contenteditable="true"]', 'textarea']
  }),
  new GenericChatAdapter('poe', [/^(www\.)?poe\.com$/], {
    composerSelectors: ['div[contenteditable="true"]', 'textarea'],
    userSelectors: ['[data-testid="chat-message-user"]']
  }),
  new GenericChatAdapter('duckduckgo', [/^(chat|duckduckgo)\.duckduckgo\.com$/], {
    composerSelectors: ['#chat-input', 'textarea']
  })
];

/** Resolve the adapter for the current page, or null on unsupported pages. */
export function getAdapter(): PlatformAdapter | null {
  return adapters.find((a) => a.detect()) ?? null;
}

export { PlatformAdapter } from './base';
export type { ExtractedConversation } from './base';
