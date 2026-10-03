import { PlatformAdapter } from './base';
import type { RawMessage } from '../core/extraction/messages';
import type { PlatformId } from '../core/capsule/schema';

interface GenericOpts {
  /** Preferred composer selectors for this platform. */
  composerSelectors?: string[];
  /** Preferred selectors for user-message nodes. */
  userSelectors?: string[];
}

const USER_HINT = /(user|human|prompt|query|question)/i;
const BOT_HINT = /(assistant|response|model|bot|answer|system)/i;

function roleAttr(node: HTMLElement): string | null {
  return (
    node.getAttribute('data-message-author-role') ??
    node.getAttribute('data-message-role') ??
    node.getAttribute('data-role') ??
    null
  );
}

/**
 * Heuristic adapter for AI chat platforms without a dedicated one. It finds
 * message-like nodes via common attributes and class-name hints, which keeps
 * capsule creation working across many interfaces even as they change.
 */
export class GenericChatAdapter extends PlatformAdapter {
  readonly hostPatterns: RegExp[];

  constructor(readonly id: PlatformId, hosts: RegExp[], private readonly opts: GenericOpts = {}) {
    super();
    this.hostPatterns = hosts;
  }

  private collect(): { node: HTMLElement; role: 'user' | 'assistant' }[] {
    const candidates: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    const sel = [
      ...(this.opts.userSelectors ?? []),
      '[data-message-author-role]',
      '[data-message-role]',
      '[data-role]',
      'article',
      '[class*="message" i]',
      '[class*="turn" i]'
    ].join(', ');
    document.querySelectorAll<HTMLElement>(sel).forEach((n) => {
      if (seen.has(n)) return;
      seen.add(n);
      candidates.push(n);
    });

    // Drop nodes that merely contain another candidate (nav wrappers etc.).
    const kept = candidates.filter(
      (a) => !candidates.some((b) => b !== a && b.contains(a) === false && a.contains(b))
    );

    let flip = 0;
    const out: { node: HTMLElement; role: 'user' | 'assistant' }[] = [];
    for (const node of kept) {
      const text = (node.innerText ?? '').trim();
      if (!text || text.length > 100_000) continue;
      const attr = roleAttr(node);
      const cls = `${node.className ?? ''} ${node.parentElement?.className ?? ''}`;
      let role: 'user' | 'assistant';
      if (attr) role = USER_HINT.test(attr) && !/assistant/i.test(attr) ? 'user' : 'assistant';
      else if (USER_HINT.test(cls) && !BOT_HINT.test(cls)) role = 'user';
      else if (BOT_HINT.test(cls)) role = 'assistant';
      else role = flip++ % 2 === 0 ? 'user' : 'assistant';
      out.push({ node, role });
    }
    return out;
  }

  extractMessages(): RawMessage[] {
    return this.collect().map(({ node, role }) => ({
      role,
      text: (node.innerText ?? '').trim(),
      timestamp: node.querySelector('time')?.getAttribute('datetime') ?? null
    }));
  }

  get userMessageSelector(): string | null {
    return (this.opts.userSelectors ?? [])[0] ?? null;
  }

  /** Heuristic user-message discovery — used to decorate sent capsules. */
  getUserMessageNodes(): HTMLElement[] {
    if (this.opts.userSelectors?.length) {
      const direct = [...new Set(this.opts.userSelectors.flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)]))];
      if (direct.length) return direct;
    }
    return this.collect()
      .filter((m) => m.role === 'user')
      .map((m) => m.node);
  }

  getComposer(): HTMLElement | null {
    // Platform hints first, then the lowest visible editable on the page.
    return this.pickComposer(this.opts.composerSelectors ?? []);
  }
}
