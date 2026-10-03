import type { PlatformId } from '../core/capsule/schema';
import type { RawMessage } from '../core/extraction/messages';

export interface ExtractedConversation {
  platform: PlatformId;
  url: string;
  title: string;
  messages: RawMessage[];
}

/** Rect of an element that is actually painted on screen, or null. */
export function visibleRect(el: HTMLElement): DOMRect | null {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 120 || r.height < 16) return null;
  // Anything resting above the fold or below the viewport is not the live composer.
  if (r.bottom < 24 || r.top > window.innerHeight - 12) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.15) return null;
  if (el.closest('[aria-hidden="true"], [hidden]')) return null;
  return r;
}

const EDITABLE_SELECTORS = ['div[contenteditable="true"]', 'div[contenteditable="plaintext-only"]', 'textarea', 'input[type="text"]'];

/**
 * Platform adapter contract (§10–11). All platform-specific DOM knowledge lives
 * in adapters — the rest of the extension never touches a chat platform's DOM.
 */
export abstract class PlatformAdapter {
  abstract readonly id: PlatformId;
  abstract readonly hostPatterns: RegExp[];

  detect(): boolean {
    return this.hostPatterns.some((re) => re.test(location.hostname));
  }

  /** Extract the visible conversation in document order. */
  abstract extractMessages(): RawMessage[];

  /** The chat composer element, if present on this page. */
  abstract getComposer(): HTMLElement | null;

  /**
   * Resolve the composer the user can actually see. Chat UIs keep decoy inputs
   * mounted (Canvas, artifact editors, collapsed prompt boxes behind a modal),
   * so a selector hit is not enough — the winner must be on screen, and the
   * lowest one wins because composers sit at the bottom.
   */
  protected pickComposer(priority: string[] = []): HTMLElement | null {
    for (const sel of priority) {
      let nodes: HTMLElement[];
      try {
        nodes = [...document.querySelectorAll<HTMLElement>(sel)];
      } catch {
        continue;
      }
      for (const el of nodes) if (visibleRect(el)) return el;
    }
    const seen = new Set<HTMLElement>();
    let best: HTMLElement | null = null;
    let bestTop = -Infinity;
    for (const sel of EDITABLE_SELECTORS) {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const r = visibleRect(el);
        if (r && r.top >= bestTop) {
          bestTop = r.top;
          best = el;
        }
      });
    }
    return best;
  }

  /** Is this element the live, on-screen composer right now? */
  isComposerVisible(el: HTMLElement): boolean {
    return visibleRect(el) !== null;
  }

  /** Selector matching user message nodes, used to decorate sent capsules. */
  get userMessageSelector(): string | null {
    return null;
  }

  /** User message nodes on the page — used to decorate sent capsules. */
  getUserMessageNodes(): HTMLElement[] {
    const sel = this.userMessageSelector;
    return sel ? [...document.querySelectorAll<HTMLElement>(sel)] : [];
  }

  getConversationTitle(): string {
    return (
      document.title
        .replace(/\s*[|–—-]\s*(ChatGPT|Claude|Gemini|DeepSeek|Grok|Perplexity|Meta AI|Copilot|Mistral|Kimi|Poe|DuckDuckGo|AI)\s*$/i, '')
        .trim() || document.title
    );
  }

  extractConversation(): ExtractedConversation {
    return {
      platform: this.id,
      url: location.href,
      title: this.getConversationTitle(),
      messages: this.extractMessages()
    };
  }

  /** Current plain text inside the composer ('' when absent). */
  getComposerText(target?: HTMLElement | null): string {
    const composer = target ?? this.getComposer();
    if (!composer) return '';
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) return composer.value;
    return composer.innerText ?? '';
  }

  /**
   * Insert text into the composer and VERIFY the platform's editor model
   * actually holds it. Modern editors (Gemini's ProseMirror, ChatGPT's
   * Lexical) accept direct DOM writes visually but silently REVERT them a
   * frame later when their internal model syncs — so every method is checked
   * again after a settle delay, not just immediately. Returns false when the
   * text never truly stuck; callers must not submit in that case.
   */
  async insertText(text: string, target?: HTMLElement | null): Promise<boolean> {
    const composer = target ?? this.getComposer();
    if (!composer) return false;
    const probe = text.slice(0, 32);
    const holds = () => this.getComposerText(composer).includes(probe);
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 90));
      if (!holds()) return false;
      await new Promise((r) => setTimeout(r, 120));
      return holds();
    };

    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return settle();
    }

    // contenteditable — three methods, each re-verified after the framework settles.
    const selectAll = () => {
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(composer);
      sel.addRange(range);
    };

    selectAll();
    try {
      document.execCommand('insertText', false, text);
    } catch {
      /* try the next method */
    }
    if (await settle()) return true;

    selectAll();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      composer.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    } catch {
      /* try the next method */
    }
    if (await settle()) return true;

    composer.innerText = text;
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return settle();
  }

  /** Best-effort: empty the composer through the editor's own input path so
   * the framework model clears too (not just the DOM). */
  async clearComposer(target?: HTMLElement | null): Promise<void> {
    const composer = target ?? this.getComposer();
    if (!composer) return;
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, '');
      else composer.value = '';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: '' }));
      return;
    }
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(composer);
      sel.addRange(range);
    }
    try {
      document.execCommand('delete');
    } catch {
      /* fall through to direct clear */
    }
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: '' }));
    await new Promise((r) => setTimeout(r, 120));
    if ((composer.innerText ?? '').trim()) {
      composer.innerText = '';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: '' }));
    }
  }

  /** Submit the composer. Prefers the platform's send button, then Enter. */
  async submit(target?: HTMLElement | null): Promise<boolean> {
    const composer = target ?? this.getComposer();
    if (!composer) return false;
    const root = composer.closest('form') ?? composer.parentElement?.parentElement ?? document;
    const btn =
      root.querySelector<HTMLButtonElement>('button[data-testid*="send" i]') ??
      document.querySelector<HTMLButtonElement>(
        'button[aria-label*="Send" i], button[aria-label*="submit" i], button[data-testid*="send" i], button.send-button'
      );
    if (btn && !btn.disabled) {
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      btn.click();
      return true;
    }
    const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent('keydown', enter));
    composer.dispatchEvent(new KeyboardEvent('keypress', enter));
    composer.dispatchEvent(new KeyboardEvent('keyup', enter));
    return true;
  }

  observeChanges(callback: () => void): MutationObserver {
    const observer = new MutationObserver(callback);
    observer.observe(document.body, { childList: true, subtree: true, characterData: false });
    return observer;
  }
}
