import type { ExtMessage, CapsuleListItem } from '../types/messages';
import type { ExtractedConversation } from '../adapters/base';
import type { ArchiveMessage } from '../core/capsule/schema';
import { normalizeMessages } from '../core/extraction/messages';
import { createCapsule } from '../core/capsule/create';
import { updateCapsule } from '../core/capsule/update';
import { summarizeUpdate } from '../core/capsule/diff';
import { buildHandoff } from '../core/retrieval/router';
import { sanitizeCapsule } from '../security/sanitize';
import { migrateCapsule } from '../core/versioning/migrate';
import { loadAISettings } from '../core/llm/aiSettings';
import { chatCompletion, listModels } from '../core/llm/ai';
import { distillCapsule } from '../core/llm/distill';
import { nowIso } from '../shared/helpers';
import { clearCapsules, deleteCapsule, getCapsule, listCapsules, saveCapsule } from '../storage/db';

function toListItem(c: Awaited<ReturnType<typeof getCapsule>> & object): CapsuleListItem {
  return {
    id: c.id,
    projectName: c.project.name,
    updatedAt: c.updated_at,
    sourcePlatform: c.source_platform,
    currentVersion: c.current_version,
    coreTokens: c.metadata.coreTokensEstimated,
    memoryCount: c.memories.length,
    versions: [...c.history.map((h) => h.version), c.current_version].sort((a, b) => b - a)
  };
}

async function maybeDistill(capsule: ReturnType<typeof sanitizeCapsule>['capsule'], messages: ArchiveMessage[]): Promise<void> {
  try {
    const settings = await loadAISettings();
    if (!settings.enabled) return;
    await distillCapsule(settings, messages, capsule);
  } catch {
    // AI is an optional upgrade — any failure keeps the heuristic capsule.
  }
}

async function handle(message: ExtMessage): Promise<unknown> {
  switch (message.type) {
    case 'LIST_CAPSULES': {
      const all = await listCapsules();
      return all.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(toListItem);
    }

    case 'GET_CAPSULE': {
      const capsule = await getCapsule(message.capsuleId);
      if (!capsule) throw new Error('Capsule not found');
      return capsule;
    }

    case 'CREATE_CAPSULE': {
      const extraction = message as unknown as { extraction: ExtractedConversation };
      const raw = extraction.extraction;
      if (!raw?.messages?.length) throw new Error('No conversation messages were extracted from this page');
      const normalized = normalizeMessages(raw.messages);
      const created = createCapsule(
        { platform: raw.platform, url: raw.url, title: raw.title, messages: normalized },
        {}
      );
      await maybeDistill(created, normalized);
      const { capsule } = sanitizeCapsule(created);
      await saveCapsule(capsule);
      return capsule;
    }

    case 'UPDATE_CAPSULE': {
      const { capsuleId } = message;
      const extraction = (message as unknown as { extraction: ExtractedConversation }).extraction;
      const existing = await getCapsule(capsuleId);
      if (!existing) throw new Error('Capsule not found');
      const updMessages = normalizeMessages(extraction.messages);
      const result = updateCapsule(existing, {
        platform: extraction.platform,
        url: extraction.url,
        title: extraction.title,
        messages: updMessages
      });
      await maybeDistill(result.capsule, updMessages);
      const { capsule } = sanitizeCapsule(result.capsule);
      await saveCapsule(capsule);
      return { capsule, diff: summarizeUpdate(result) };
    }

    case 'IMPORT_CAPSULE': {
      const { file, migrated } = migrateCapsule(message.file);
      const { capsule } = sanitizeCapsule({ ...file, updated_at: nowIso() });
      await saveCapsule(capsule);
      return { capsule: toListItem(capsule), migrated };
    }

    case 'DELETE_CAPSULE':
      await deleteCapsule(message.capsuleId);
      return { deleted: true };

    case 'RENAME_CAPSULE': {
      const capsule = await getCapsule(message.capsuleId);
      if (!capsule) throw new Error('Capsule not found');
      capsule.project.name = message.name.trim() || capsule.project.name;
      capsule.updated_at = nowIso();
      await saveCapsule(capsule);
      return toListItem(capsule);
    }

    case 'RESTORE_VERSION': {
      const capsule = await getCapsule(message.capsuleId);
      if (!capsule) throw new Error('Capsule not found');
      const snap = capsule.history.find((h) => h.version === message.version);
      if (!snap) throw new Error(`Version ${message.version} not found in capsule history`);
      capsule.history.push({
        version: capsule.current_version,
        createdAt: capsule.updated_at,
        note: `Snapshot before restoring v${message.version}`,
        coreContext: capsule.core_context,
        memories: capsule.memories
      });
      capsule.core_context = snap.coreContext;
      capsule.memories = snap.memories;
      capsule.current_version += 1;
      capsule.updated_at = nowIso();
      await saveCapsule(capsule);
      return capsule;
    }

    case 'REMOVE_MEMORY': {
      const capsule = await getCapsule(message.capsuleId);
      if (!capsule) throw new Error('Capsule not found');
      capsule.memories = capsule.memories.filter((m) => m.id !== message.memoryId);
      capsule.updated_at = nowIso();
      await saveCapsule(capsule);
      return capsule;
    }

    case 'TOGGLE_PIN_MEMORY': {
      const capsule = await getCapsule(message.capsuleId);
      if (!capsule) throw new Error('Capsule not found');
      const mem = capsule.memories.find((m) => m.id === message.memoryId);
      if (mem) mem.pinned = !mem.pinned;
      capsule.updated_at = nowIso();
      await saveCapsule(capsule);
      return capsule;
    }

    case 'GET_HANDOFF': {
      const capsule = await getCapsule(message.capsuleId);
      if (!capsule) throw new Error('Capsule not found');
      return buildHandoff(capsule, { query: message.query, recallQuery: message.query });
    }

    case 'OPEN_OPTIONS': {
      // openOptionsPage can fail silently in some Chromium forks — fall back to the explicit URL.
      let opened = false;
      try {
        chrome.runtime.openOptionsPage(() => {
          if (chrome.runtime.lastError) {
            void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }).catch(() => undefined);
          }
          opened = true;
        });
      } catch {
        /* fallback below */
      }
      setTimeout(() => {
        if (!opened) {
          void chrome.tabs
            .create({ url: chrome.runtime.getURL('options.html') })
            .catch(() => undefined);
        }
      }, 250);
      return { opened: true };
    }

    case 'CLEAR_ALL': {
      await clearCapsules();
      return { cleared: true };
    }

    case 'TEST_AI_PROVIDER': {
      const settings = await loadAISettings();
      const reply = await chatCompletion(settings, 'You are a connection tester.', 'Reply with exactly: OK', 64);
      return { reply: reply.trim().slice(0, 40) };
    }

    case 'LIST_AI_MODELS': {
      const settings = await loadAISettings();
      const models = await listModels(settings);
      return { models: models.sort() };
    }

    default:
      throw new Error('Unknown message type');
  }
}

const MUTATING: ExtMessage['type'][] = [
  'CREATE_CAPSULE', 'UPDATE_CAPSULE', 'IMPORT_CAPSULE', 'DELETE_CAPSULE', 'RENAME_CAPSULE',
  'RESTORE_VERSION', 'REMOVE_MEMORY', 'TOGGLE_PIN_MEMORY', 'CLEAR_ALL'
];

/** Tell every open tab (chat pages, options) that the capsule store changed. */
function notifyCapsulesChanged() {
  void chrome.tabs
    .query({})
    .then((tabs) =>
      tabs.forEach((t) => {
        if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'CAPSULES_CHANGED' }).catch(() => undefined);
      })
    )
    .catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  handle(message)
    .then((data) => {
      if (MUTATING.includes(message.type)) notifyCapsulesChanged();
      sendResponse({ ok: true, data });
    })
    .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // async response
});

export {};
