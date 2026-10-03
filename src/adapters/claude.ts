import { PlatformAdapter } from './base';
import type { RawMessage } from '../core/extraction/messages';

export class ClaudeAdapter extends PlatformAdapter {
  readonly id = 'claude' as const;
  readonly hostPatterns = [/(^|\.)claude\.ai$/];

  extractMessages(): RawMessage[] {
    const out: RawMessage[] = [];
    // Document order is preserved by querySelectorAll across mixed selectors.
    const nodes = document.querySelectorAll<HTMLElement>(
      '[data-testid="user-message"], .font-claude-message'
    );
    nodes.forEach((node) => {
      const role: RawMessage['role'] = node.matches('[data-testid="user-message"]') ? 'user' : 'assistant';
      const text = (node.innerText ?? '').trim();
      if (text) out.push({ role, text, timestamp: null });
    });
    return out;
  }

  getComposer(): HTMLElement | null {
    // Claude can mount extra editables (artifact editors, dialogs); the real
    // composer is the visible one nearest the bottom of the viewport.
    return this.pickComposer();
  }

  override get userMessageSelector(): string {
    return '[data-testid="user-message"]';
  }
}
