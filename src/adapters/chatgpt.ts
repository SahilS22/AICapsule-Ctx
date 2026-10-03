import { PlatformAdapter } from './base';
import type { RawMessage } from '../core/extraction/messages';

export class ChatGPTAdapter extends PlatformAdapter {
  readonly id = 'chatgpt' as const;
  readonly hostPatterns = [/^(www\.)?chatgpt\.com$/];

  extractMessages(): RawMessage[] {
    const out: RawMessage[] = [];
    const turns = document.querySelectorAll<HTMLElement>(
      'article[data-testid^="conversation-turn"], [data-message-author-role]'
    );
    const seen = new Set<HTMLElement>();

    turns.forEach((node, i) => {
      // Prefer the turn article; fall back to the role node itself.
      const container = (node.closest('article[data-testid^="conversation-turn"]') as HTMLElement) ?? node;
      if (seen.has(container)) return;
      seen.add(container);

      const roleNode = container.matches('[data-message-author-role]')
        ? container
        : container.querySelector('[data-message-author-role]');
      const roleAttr = roleNode?.getAttribute('data-message-author-role');
      const role: RawMessage['role'] =
        roleAttr === 'user' ? 'user' : roleAttr === 'system' ? 'system' : roleAttr === 'assistant' ? 'assistant' : i % 2 === 0 ? 'user' : 'assistant';

      const textRoot = (container.querySelector('.markdown') as HTMLElement) ?? container;
      const text = (textRoot.innerText ?? '').trim();
      if (!text) return;

      const time = container.querySelector('time');
      out.push({ role, text, timestamp: time?.getAttribute('datetime') ?? null });
    });

    return out;
  }

  getComposer(): HTMLElement | null {
    // Decoys exist (Canvas, the collapsed box behind an expanded prompt panel),
    // so #prompt-textarea only wins while it is actually on screen.
    return this.pickComposer(['#prompt-textarea']);
  }

  override get userMessageSelector(): string {
    return '[data-message-author-role="user"]';
  }
}
