import { PlatformAdapter } from './base';
import type { RawMessage } from '../core/extraction/messages';

export class GeminiAdapter extends PlatformAdapter {
  readonly id = 'gemini' as const;
  readonly hostPatterns = [/^gemini\.google\.com$/];

  extractMessages(): RawMessage[] {
    const out: RawMessage[] = [];
    const nodes = document.querySelectorAll<HTMLElement>('user-query, .model-response-text, .markdown-main-panel');
    nodes.forEach((node) => {
      const role: RawMessage['role'] = node.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant';
      const text = (node.innerText ?? '').trim();
      if (text) out.push({ role, text, timestamp: null });
    });
    return out;
  }

  getComposer(): HTMLElement | null {
    // Gemini mounts extra editables; the real composer is the visible one
    // nearest the bottom of the viewport.
    return this.pickComposer(['rich-textarea div[contenteditable="true"]']);
  }

  override get userMessageSelector(): string {
    return 'user-query';
  }
}
