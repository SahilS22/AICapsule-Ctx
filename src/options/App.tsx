import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CapsuleListItem } from '../types/messages';
import type { CapsuleFile } from '../core/capsule/schema';
import { parseCapsuleText, serializeCapsule, capsuleFilename } from '../core/capsule/file';
import { formatRelative } from '../shared/helpers';
import { formatTokens } from '../core/tokenization/estimate';
import { sendToBackground } from '../shared/browser';
import { PROVIDER_PRESETS, loadAISettings, saveAISettings, type AISettings } from '../core/llm/aiSettings';

export default function App() {
  const [capsules, setCapsules] = useState<CapsuleListItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [ai, setAi] = useState<AISettings | null>(null);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadAISettings().then(setAi);
  }, []);

  const patchAi = (next: Partial<AISettings>) => {
    if (!ai) return;
    const merged = { ...ai, ...next };
    setAi(merged);
    void saveAISettings(merged);
  };

  const load = useCallback(async () => {
    try {
      setCapsules(await sendToBackground<CapsuleListItem[]>({ type: 'LIST_CAPSULES' }));
    } catch {
      setCapsules([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const listener = (message: { type?: string }) => {
      if (message?.type === 'CAPSULES_CHANGED') void load();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [load]);

  const flash = (msg: string) => {
    setNotice(msg);
    setError(null);
    setTimeout(() => setNotice(null), 4000);
  };
  const fail = (e: unknown) => {
    let msg = e instanceof Error ? e.message : String(e);
    if (/model_not_found|does not exist or you do not have access/i.test(msg)) {
      const model = ai?.model.trim() || PROVIDER_PRESETS.find((p) => p.id === ai?.provider)?.model || '?';
      msg = `Your key and endpoint work — only the model "${model}" isn't available on this account. Click "↻ Fetch models for my key" and pick one from the list.`;
    }
    setError(msg);
    setNotice(null);
  };

  const exportCapsule = async (id: string) => {
    try {
      const capsule = await sendToBackground<CapsuleFile>({ type: 'GET_CAPSULE', capsuleId: id });
      const blob = new Blob([serializeCapsule(capsule)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = capsuleFilename(capsule);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      flash('Capsule exported.');
    } catch (e) {
      fail(e);
    }
  };

  const importFile = async (file: File) => {
    try {
      const parsed = parseCapsuleText(await file.text());
      if (!parsed.ok) {
        setError(`This capsule appears invalid or incomplete. ${parsed.error}`);
        return;
      }
      await sendToBackground({ type: 'IMPORT_CAPSULE', file: parsed.file });
      flash('Capsule imported.');
      await load();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="page">
      <div className="brand">
        <span className="orb" aria-hidden />
        <span className="brand-name">Context Capsule</span>
      </div>
      <p className="tagline">Your AI conversations, portable. Everything is stored locally in your browser.</p>

      <h2>Capsules</h2>
      <div className="card">
        {capsules.length === 0 && (
          <div className="empty">No capsules yet. Open a ChatGPT conversation and create your first one.</div>
        )}
        {capsules.map((c) => (
          <div className="capsule-row" key={c.id}>
            <div>
              {renaming === c.id ? (
                <input
                  type="text"
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter') {
                      try {
                        await sendToBackground({ type: 'RENAME_CAPSULE', capsuleId: c.id, name: renameValue });
                        setRenaming(null);
                        await load();
                      } catch (err) {
                        fail(err);
                      }
                    }
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <div className="name">{c.projectName}</div>
              )}
              <div className="meta">
                v{c.currentVersion} · from {c.sourcePlatform} · updated {formatRelative(c.updatedAt)} · ~
                {formatTokens(c.coreTokens)} core tokens · {c.memoryCount} memories · versions:{' '}
                {c.versions.join(', ')}
              </div>
            </div>
            <div className="capsule-actions">
              <button
                className="btn"
                onClick={() => {
                  setRenaming(c.id);
                  setRenameValue(c.projectName);
                }}
              >
                Rename
              </button>
              <button className="btn" onClick={() => void exportCapsule(c.id)}>
                Export
              </button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (!confirm(`Delete capsule "${c.projectName}"? This cannot be undone.`)) return;
                  try {
                    await sendToBackground({ type: 'DELETE_CAPSULE', capsuleId: c.id });
                    flash('Capsule deleted.');
                    await load();
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
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
        </div>
        {notice && <div className="notice">{notice}</div>}
        {error && <div className="error">{error}</div>}
      </div>

      <h2>Privacy</h2>
      <div className="card">
        <div className="row">
          <div>
            <div className="label">Local-only processing</div>
            <div className="hint">
              Extraction, compression, search, and storage run entirely in your browser. No conversation content
              leaves your device.
            </div>
          </div>
          <span className="value">Always on</span>
        </div>
        <div className="row">
          <div>
            <div className="label">Permissions</div>
            <div className="hint">
              The extension only accesses supported AI chat pages (ChatGPT, Claude, Gemini, DeepSeek, Grok,
              Perplexity, Meta AI, Copilot, Mistral, Kimi, Poe, DuckDuckGo) and local extension storage. It never
              reads cookies, history, or other sites. In AI mode, your transcript excerpt is sent only to the
              provider whose key you configured.
            </div>
          </div>
        </div>
        <div className="row">
          <div>
            <div className="label">Clear all capsules</div>
            <div className="hint">Deletes every stored capsule, memory, and archive from this browser.</div>
          </div>
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (!confirm('Delete ALL capsules? This cannot be undone.')) return;
              try {
                await sendToBackground({ type: 'CLEAR_ALL' } as never);
                flash('All capsules cleared.');
                await load();
              } catch (e) {
                fail(e);
              }
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <h2>AI providers</h2>
      <div className={`card${ai?.enabled ? ' ai-card' : ''}`}>
        <div className="row">
          <div>
            <div className="label">
              {ai?.enabled
                ? `AI distillation — ${PROVIDER_PRESETS.find((p) => p.id === ai.provider)?.label ?? ai.provider}`
                : 'Local heuristics (offline)'}
            </div>
            <div className="hint">
              {ai?.enabled
                ? 'Capsules are distilled with your own provider account for richer summaries. If any call fails, the offline heuristic result is kept automatically.'
                : 'By default capsules are distilled fully offline by the built-in heuristic engine — no keys, no cloud. Turn on AI mode to distill with your own account; your key is stored only in this browser.'}
            </div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={ai?.enabled === true}
              onChange={(e) => patchAi({ enabled: e.target.checked })}
              aria-label="Enable AI distillation"
            />
            <i />
          </label>
        </div>
        {ai?.enabled && (
          <>
            <div className="ai-grid">
              <div className="field">
                <label htmlFor="ai-provider">Provider</label>
                <select
                  id="ai-provider"
                  value={ai.provider}
                  onChange={(e) => {
                    patchAi({ provider: e.target.value, model: '' });
                    setModels(null);
                  }}
                >
                  {PROVIDER_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ai-model">Model</label>
                <input
                  id="ai-model"
                  type="text"
                  spellCheck={false}
                  placeholder={`default: ${PROVIDER_PRESETS.find((p) => p.id === ai.provider)?.model ?? 'model name'}`}
                  value={ai.model}
                  onChange={(e) => patchAi({ model: e.target.value })}
                />
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button
                  className="btn"
                  disabled={fetchingModels || !ai.apiKey.trim() && PROVIDER_PRESETS.find((p) => p.id === ai.provider)?.keyRequired}
                  onClick={async () => {
                    setFetchingModels(true);
                    setError(null);
                    try {
                      const r = await sendToBackground<{ models: string[] }>({ type: 'LIST_AI_MODELS' } as never);
                      setModels(r.models);
                      if (!r.models.length) setError('The provider returned no models for this key.');
                      else if (!r.models.includes(ai.model)) flash(`Found ${r.models.length} models for this key — pick one below.`);
                    } catch (e) {
                      fail(e);
                    } finally {
                      setFetchingModels(false);
                    }
                  }}
                >
                  {fetchingModels ? 'Fetching…' : '↻ Fetch models for my key'}
                </button>
              </div>
              {models && models.length > 0 && (
                <div className="field full">
                  <label htmlFor="ai-model-pick">Available models ({models.length})</label>
                  <select
                    id="ai-model-pick"
                    value={models.includes(ai.model) ? ai.model : ''}
                    onChange={(e) => e.target.value && patchAi({ model: e.target.value })}
                  >
                    <option value="" disabled>
                      Pick a model…
                    </option>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field full">
                <label htmlFor="ai-key">API key</label>
                <input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    PROVIDER_PRESETS.find((p) => p.id === ai.provider)?.keyRequired
                      ? 'Paste your key — sent only to this provider'
                      : 'not needed for local servers'
                  }
                  value={ai.apiKey}
                  onChange={(e) => patchAi({ apiKey: e.target.value })}
                />
              </div>
            </div>
            <div className="ai-foot">
              <span className="ai-status">
                OpenAI · Claude · Gemini · Groq · OpenRouter · NVIDIA NIM · Mistral · DeepSeek · Grok · Cohere ·
                Ollama · LM Studio
              </span>
              <button
                className="btn btn-primary"
                disabled={testing}
                onClick={async () => {
                  setTesting(true);
                  setError(null);
                  try {
                    const r = await sendToBackground<{ reply: string }>({ type: 'TEST_AI_PROVIDER' } as never);
                    flash(`✓ Connected — provider replied "${r.reply}"`);
                  } catch (e) {
                    fail(e);
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
            </div>
            {error && <div className="error">{error}</div>}
            {notice && <div className="notice">{notice}</div>}
          </>
        )}
      </div>

      <h2>Compression preference</h2>
      <div className="card">
        <div className="row">
          <div>
            <div className="label">Default compression</div>
            <div className="hint">
              Maximum fidelity preserves more historical detail · Balanced keeps important project context · Maximum
              compression prioritizes minimal destination context. No mode guarantees perfect preservation.
            </div>
          </div>
          <select defaultValue="balanced" aria-label="Default compression">
            <option value="maximum_fidelity">Maximum fidelity</option>
            <option value="balanced">Balanced</option>
            <option value="maximum_compression">Maximum compression</option>
          </select>
        </div>
      </div>

      <h2>Supported platforms</h2>
      <div className="card">
        <div className="row">
          <div className="label">ChatGPT</div>
          <span className="value">chatgpt.com — create & import</span>
        </div>
        <div className="row">
          <div className="label">Claude</div>
          <span className="value">claude.ai — create & import</span>
        </div>
        <div className="row">
          <div className="label">Gemini</div>
          <span className="value">gemini.google.com — create & import</span>
        </div>
        <div className="row">
          <div className="label">DeepSeek · Grok · Perplexity · Meta AI · Copilot · Mistral · Kimi · Poe · DuckDuckGo</div>
          <span className="value">best-effort generic adapter — create & import</span>
        </div>
      </div>
    </div>
  );
}
