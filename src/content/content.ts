import { getAdapter } from '../adapters';
import { CapsulePanel } from '../ui/panel/Panel';
import cssText from '../ui/panel/panel.css';
import { normalizeMessages } from '../core/extraction/messages';
import { estimateMessagesTokens } from '../core/tokenization/estimate';
import { debounce } from '../shared/helpers';
import type { PageInfo } from '../types/messages';

const adapter = getAdapter();

function computePageInfo(): PageInfo {
  if (!adapter) return { supported: false, messageCount: 0, estimatedTokens: 0 };
  const messages = adapter.extractMessages();
  return {
    supported: true,
    platform: adapter.id,
    messageCount: messages.length,
    estimatedTokens: estimateMessagesTokens(messages.map((m) => m.text))
  };
}

let pageInfo = computePageInfo();
let panel: CapsulePanel | null = null;

// Message API for the popup and background.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = (fn: () => unknown) => {
    try {
      sendResponse({ ok: true, data: fn() });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  switch (message?.type) {
    case 'CAPSULES_CHANGED':
      void panel?.syncFromStore();
      sendResponse({ ok: true });
      break;
    case 'GET_PAGE_INFO':
      respond(() => {
        pageInfo = computePageInfo();
        return pageInfo;
      });
      break;
    case 'EXTRACT_CONVERSATION':
      respond(() => {
        if (!adapter) throw new Error('Unsupported platform');
        return adapter.extractConversation();
      });
      break;
    case 'APPLY_HANDOFF':
      (async () => {
        try {
          if (!adapter) throw new Error('Unsupported platform');
          const ok = await adapter.insertText(String(message.text ?? ''));
          if (!ok) throw new Error('The chat editor refused the text — press send again, the capsule is still armed');
          sendResponse({ ok: true, data: { inserted: true } });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      break;
    default:
      break;
  }
  return true;
});

// In-page control. Recompute stats (debounced) as the conversation grows so the
// panel always shows live numbers without re-reading the whole DOM on every node.
if (adapter) {
  panel = new CapsulePanel(
    {
      adapter,
      pageInfo: () => pageInfo,
      sendToBackground: async <T,>(msg: unknown) => {
        const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: T; error?: string };
        if (!res?.ok) throw new Error(res?.error || 'Request failed');
        return res.data as T;
      },
      onExtract: () => adapter.extractConversation()
    },
    cssText
  );

  const recompute = debounce(() => {
    pageInfo = computePageInfo();
    void pageInfo;
  }, 800);
  adapter.observeChanges(recompute);
}

export { normalizeMessages };
