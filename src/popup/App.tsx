import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CapsuleListItem, PageInfo } from '../types/messages';
import type { CapsuleFile } from '../core/capsule/schema';
import { parseCapsuleText } from '../core/capsule/file';
import { formatRelative } from '../shared/helpers';
import { formatTokens } from '../core/tokenization/estimate';
import { sendToActiveTab, sendToBackground } from '../shared/browser';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; page: PageInfo; capsules: CapsuleListItem[] }
  | { kind: 'creating' }
  | { kind: 'created'; capsule: CapsuleFile }
  | { kind: 'error'; message: string; page?: PageInfo; capsules?: CapsuleListItem[] };

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    let page: PageInfo = { supported: false, messageCount: 0, estimatedTokens: 0 };
    try {
      page = await sendToActiveTab<PageInfo>({ type: 'GET_PAGE_INFO' });
    } catch {
      // not a supported tab / no content script — leave defaults
    }
    let capsules: CapsuleListItem[] = [];
    try {
      capsules = await sendToBackground<CapsuleListItem[]>({ type: 'LIST_CAPSULES' });
    } catch {
      /* empty state */
    }
    setState({ kind: 'ready', page, capsules });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setState({ kind: 'creating' });
    try {
      const extraction = await sendToActiveTab({ type: 'EXTRACT_CONVERSATION' });
      const capsule = await sendToBackground<CapsuleFile>({ type: 'CREATE_CAPSULE', extraction });
      setState({ kind: 'created', capsule });
    } catch (e) {
      setState({ kind: 'error', message: errMsg(e) });
    }
  };

  const importFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseCapsuleText(text);
      if (!parsed.ok) {
        setNotice(`This capsule appears invalid or incomplete. ${parsed.error}`);
        return;
      }
      await sendToBackground({ type: 'IMPORT_CAPSULE', file: parsed.file });
      setNotice('Capsule imported. Open a supported AI chat to use it.');
      await load();
    } catch (e) {
      setNotice(errMsg(e));
    }
  };

  return (
    <div className="popup">
      <button
        className="gear"
        aria-label="Open settings"
        title="Settings"
        onClick={() => chrome.runtime.openOptionsPage()}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <div className="brand">
        <span className="orb" aria-hidden />
        <span className="brand-name">Context Capsule</span>
      </div>
      <p className="tagline">Your AI context, portable.</p>

      {state.kind === 'loading' && <div className="empty">Loading…</div>}

      {state.kind === 'creating' && (
        <div className="empty">Creating capsule… keep this tab active and use the in-page panel for the full view.</div>
      )}

      {state.kind === 'created' && (
        <>
          <div className="detect-card">
            <b>Capsule sealed — {state.capsule.project.name}</b>
            <div className="meta">
              ~{formatTokens(state.capsule.metadata.coreTokensEstimated)} core tokens (est.) ·{' '}
              {state.capsule.memories.length} memories
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              // export
              import('../core/capsule/file').then(({ serializeCapsule, capsuleFilename }) => {
                const blob = new Blob([serializeCapsule(state.capsule)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = capsuleFilename(state.capsule);
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
              });
            }}
          >
            Export Capsule
          </button>
          <button className="btn" onClick={() => void load()}>
            Done
          </button>
        </>
      )}

      {(state.kind === 'ready' || state.kind === 'error') && (
        <>
          {state.kind === 'error' && <div className="error" role="alert">{state.message}</div>}
          {state.kind === 'ready' && (
            <>
              <div className="section-label">This page</div>
              {state.page.supported && state.page.messageCount > 0 ? (
                <div className="detect-card">
                  <b>Conversation detected</b>
                  <div className="meta">
                    {state.page.messageCount} messages · ~{formatTokens(state.page.estimatedTokens)} estimated tokens
                  </div>
                </div>
              ) : state.page.supported ? (
                <div className="detect-card">
                  <b>No conversation visible</b>
                  <div className="meta">Open a conversation on this platform to create a capsule.</div>
                </div>
              ) : (
                <div className="detect-card">
                  <b>This AI platform isn't supported yet</b>
                  <div className="meta">Supported: ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Meta AI, Copilot, Mistral, Kimi, Poe, DuckDuckGo.</div>
                </div>
              )}

              <button
                className="btn btn-primary"
                disabled={!state.page.supported || state.page.messageCount === 0}
                onClick={() => void create()}
              >
                Create Capsule
              </button>
              <button className="btn" onClick={() => fileRef.current?.click()}>
                Import Capsule
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".contextcapsule,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = '';
                }}
              />

              <div className="section-label">Recent</div>
              {state.capsules.length === 0 && <div className="empty">No capsules yet.</div>}
              {state.capsules.slice(0, 4).map((c) => (
                <button key={c.id} className="capsule-card" onClick={() => chrome.runtime.openOptionsPage()}>
                  <div className="name">{c.projectName}</div>
                  <div className="meta">
                    v{c.currentVersion} · updated {formatRelative(c.updatedAt)} · ~{formatTokens(c.coreTokens)} core
                    tokens
                  </div>
                </button>
              ))}
            </>
          )}
        </>
      )}

      {notice && <div className="note">{notice}</div>}
    </div>
  );
}

function errMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Receiving end|Could not establish connection/i.test(msg)) {
    return "We couldn't read this page. Open a supported AI chat (ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Copilot, …) and try again.";
  }
  return msg;
}
