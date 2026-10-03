import type { CapsuleFile, MemoryItem, PlatformId } from '../../core/capsule/schema';
import type { CapsuleListItem, CapsuleStats, PageInfo, UpdateDiffEntry } from '../../types/messages';
import { capsuleStats } from '../../core/capsule/diff';
import { buildHandoff } from '../../core/retrieval/router';
import { searchCapsule } from '../../core/retrieval/search';
import { parseCapsuleText, serializeCapsule, capsuleFilename } from '../../core/capsule/file';
import { estimateMessagesTokens, formatTokens } from '../../core/tokenization/estimate';
import { formatRelative, shortCapsuleId, debounce } from '../../shared/helpers';
import type { ExtractedConversation, PlatformAdapter } from '../../adapters/base';
import { visibleRect } from '../../adapters/base';
import { platformIconSvg, PLATFORM_LABELS } from '../platformIcons';

type Msg = <T>(message: unknown) => Promise<T>;

interface PanelOpts {
  adapter: PlatformAdapter;
  pageInfo: () => PageInfo;
  sendToBackground: Msg;
  onExtract: () => ExtractedConversation;
}

type View = 'main' | 'creating' | 'created' | 'detail' | 'importing' | 'imported';

const STAGES = ['Extracting', 'Structuring', 'Compressing', 'Sealing'];
const STRUCTURE_ITEMS = ['Requirements', 'Decisions', 'Constraints', 'Current state', 'Important history', 'Artifacts'];

export class CapsulePanel {
  private root: ShadowRoot;
  private container: HTMLElement;
  private view: View = 'main';
  private capsules: CapsuleListItem[] = [];
  private error: string | null = null;
  private busy = false;
  private panelOpen = false;

  private createdCapsule: CapsuleFile | null = null;
  private detailCapsule: CapsuleFile | null = null;
  private detailStats: CapsuleStats | null = null;
  private updateDiff: UpdateDiffEntry | null = null;
  private searchQuery = '';
  private importedItem: { name: string; coreTokens: number; memoryCount: number } | null = null;
  private chipEl: HTMLElement | null = null;
  private chipMeta: HTMLElement | null = null;
  private chipAnchor: HTMLElement | null = null;
  private chipAnchorAt = 0;
  private chipRaf = 0;
  private pendingHandoff: string | null = null;
  private interceptor: { key: (e: KeyboardEvent) => void; click: (e: MouseEvent) => void } | null = null;
  private activeCapsuleId: string | null = null;

  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private opts: PanelOpts, cssText: string) {
    const host = document.createElement('div');
    host.id = 'context-capsule-host';
    this.root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = cssText;
    this.root.appendChild(style);
    this.container = document.createElement('div');
    this.container.className = 'cc-root';
    this.root.appendChild(this.container);
    document.documentElement.appendChild(host);
    void this.refreshCapsules();
    this.render();
    this.decorateSentCapsules();
    const decorate = debounce(() => this.decorateSentCapsules(), 500);
    this.sentDecorator = this.opts.adapter.observeChanges(decorate);
  }

  private sentDecorator: MutationObserver | null = null;

  private async refreshCapsules() {
    try {
      this.capsules = await this.opts.sendToBackground<CapsuleListItem[]>({ type: 'LIST_CAPSULES' });
    } catch {
      this.capsules = [];
    }
  }

  /** Capsules changed in another tab/options page — refresh live instead of waiting for F5. */
  async syncFromStore(): Promise<void> {
    await this.refreshCapsules();
    const gone = (id: string | null) => !!id && !this.capsules.some((c) => c.id === id);
    if (gone(this.activeCapsuleId)) {
      this.disarmHandoff();
      this.hideChip();
      this.activeCapsuleId = null;
    }
    if (gone(this.detailCapsule?.id ?? null)) {
      this.detailCapsule = null;
      this.detailStats = null;
      this.view = 'main';
    }
    this.render();
  }

  private extract(): ExtractedConversation {
    return this.opts.onExtract();
  }

  private setView(v: View) {
    this.view = v;
    this.error = null;
    this.render();
  }

  // ---------------------------------------------------------------- actions

  private async createCapsuleFlow() {
    const info = this.opts.pageInfo();
    if (!info.messageCount) {
      this.error = 'No conversation was detected on this page.';
      this.render();
      return;
    }
    this.busy = true;
    this.setView('creating');
    await this.runCreationAnimation(info);
    try {
      const extraction = this.extract();
      const capsule = await this.opts.sendToBackground<CapsuleFile>({ type: 'CREATE_CAPSULE', extraction });
      this.createdCapsule = capsule;
      await this.refreshCapsules();
      this.setView('created');
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.setView('main');
    } finally {
      this.busy = false;
    }
  }

  private async runCreationAnimation(info: PageInfo): Promise<void> {
    const step = async (ms: number) => {
      if (this.reducedMotion) return;
      await new Promise((r) => setTimeout(r, ms));
    };
    for (let i = 0; i < STAGES.length; i++) {
      (this as unknown as { animStage: number }).animStage = i;
      this.render();
      await step(i === 1 ? 1100 : 700);
    }
    void info;
  }

  private animStage = 0;

  private async openDetail(item: CapsuleListItem) {
    try {
      this.detailCapsule = await this.opts.sendToBackground<CapsuleFile>({ type: 'GET_CAPSULE', capsuleId: item.id });
      this.detailStats = capsuleStats(this.detailCapsule);
      this.updateDiff = null;
      this.searchQuery = '';
      this.setView('detail');
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  private async updateCapsuleFlow() {
    if (!this.detailCapsule || this.busy) return;
    this.busy = true;
    this.render();
    try {
      const extraction = this.extract();
      const res = await this.opts.sendToBackground<{ capsule: CapsuleFile; diff: UpdateDiffEntry }>({
        type: 'UPDATE_CAPSULE',
        capsuleId: this.detailCapsule.id,
        extraction
      });
      this.detailCapsule = res.capsule;
      this.detailStats = capsuleStats(res.capsule);
      this.updateDiff = res.diff;
      await this.refreshCapsules();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private exportCapsule(capsule: CapsuleFile) {
    const blob = new Blob([serializeCapsule(capsule)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = capsuleFilename(capsule);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  private async deleteCapsule(id: string) {
    await this.opts.sendToBackground({ type: 'DELETE_CAPSULE', capsuleId: id });
    await this.refreshCapsules();
    this.setView('main');
  }

  private async restoreVersion(version: number) {
    if (!this.detailCapsule) return;
    try {
      this.detailCapsule = await this.opts.sendToBackground<CapsuleFile>({
        type: 'RESTORE_VERSION',
        capsuleId: this.detailCapsule.id,
        version
      });
      this.detailStats = capsuleStats(this.detailCapsule);
      await this.refreshCapsules();
      this.render();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  private async togglePin(memoryId: string) {
    if (!this.detailCapsule) return;
    this.detailCapsule = await this.opts.sendToBackground<CapsuleFile>({
      type: 'TOGGLE_PIN_MEMORY',
      capsuleId: this.detailCapsule.id,
      memoryId
    });
    this.render();
  }

  private async removeMemory(memoryId: string) {
    if (!this.detailCapsule) return;
    this.detailCapsule = await this.opts.sendToBackground<CapsuleFile>({
      type: 'REMOVE_MEMORY',
      capsuleId: this.detailCapsule.id,
      memoryId
    });
    this.detailStats = capsuleStats(this.detailCapsule);
    this.render();
  }

  private async importFile(file: File) {
    this.busy = true;
    this.render();
    try {
      const text = await file.text();
      const parsed = parseCapsuleText(text);
      if (!parsed.ok) {
        this.error = `This capsule appears invalid or incomplete. ${parsed.error}`;
        this.setView('importing');
        return;
      }
      const res = await this.opts.sendToBackground<{ capsule: CapsuleListItem }>({
        type: 'IMPORT_CAPSULE',
        file: parsed.file
      });
      this.importedItem = {
        name: res.capsule.projectName,
        coreTokens: res.capsule.coreTokens,
        memoryCount: res.capsule.memoryCount
      };
      this.detailCapsule = await this.opts.sendToBackground<CapsuleFile>({
        type: 'GET_CAPSULE',
        capsuleId: res.capsule.id
      });
      await this.refreshCapsules();
      this.setView('imported');
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.setView('importing');
    } finally {
      this.busy = false;
    }
  }

  private startConversation(submit: boolean) {
    if (!this.detailCapsule) return;
    void this.injectCapsule(this.detailCapsule, submit);
  }

  /** Fetch a stored capsule and unseal it straight into the composer. */
  private async unsealFromList(item: CapsuleListItem) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const capsule = await this.opts.sendToBackground<CapsuleFile>({ type: 'GET_CAPSULE', capsuleId: item.id });
      this.busy = false;
      await this.injectCapsule(capsule, false);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.busy = false;
      this.render();
    }
  }

  /** Destination-conversation snippet used for verbatim archive deep recall. */
  private recallQueryForThisPage(): string {
    try {
      const recent = this.opts.adapter.extractMessages().slice(-4).map((m) => m.text);
      const typed = this.opts.adapter.getComposerText(this.composer());
      return [...recent, typed].join('\n').replace(/\s+/g, ' ').trim().slice(0, 1200);
    } catch {
      return '';
    }
  }

  /**
   * Unseal a capsule. By default the handoff text is NOT shown in the composer:
   * it is armed inside the chip and silently rides along with the user's next
   * sent message. `submit=true` (Start & Send) sends the handoff as one visible
   * first message instead.
   */
  private async injectCapsule(capsule: CapsuleFile, submit: boolean): Promise<boolean> {
    if (this.busy) return false;
    const composer = this.opts.adapter.getComposer();
    if (!composer) {
      this.setView('main');
      this.panelOpen = true;
      this.error = 'Could not find the chat composer on this page. The AI platform may have changed its interface.';
      this.render();
      return false;
    }
    this.busy = true;
    const handoff = buildHandoff(capsule, { recallQuery: this.recallQueryForThisPage() });
    this.activeCapsuleId = capsule.id;
    if (submit) {
      this.submitWithShield(handoff.text);
    } else {
      this.armHandoff(handoff.text);
    }
    this.panelOpen = false;
    this.view = 'main';
    this.render();
    // Chip + armed handoff land immediately; the 2s unseal FX plays on top,
    // so the composer is ready the moment it ends.
    this.showChip(capsule, handoff.budget.totalTokens);
    await this.playUnseal(
      composer.getBoundingClientRect(),
      capsule.source_platform,
      `~${formatTokens(handoff.budget.totalTokens)} ctx`
    );
    this.busy = false;
    this.render();
    this.decorateSentCapsules();
    return true;
  }

  // ------------------------------------------------- sent-message capsule card

  /** Show sent handoff bubbles as an attachment-style capsule card (icon + name only). */
  private decorateSentCapsules() {
    const MARK = '# Context Capsule:';
    const nodes = this.opts.adapter.getUserMessageNodes();
    nodes.forEach((node) => {
      if (node.querySelector(':scope > [data-cc-head]')) return; // decorated & still intact
      const raw = (node.innerText ?? '').trim();
      if (!raw) return;
      // Some platforms prefix invisible chars or labels before the text.
      const text = raw.replace(/[\u200b-\u200d\ufeff]/g, '');
      const at = text.indexOf(MARK);
      if (at === -1 || at > 60) return;
      const firstLine = text.slice(at + MARK.length).split('\n')[0].trim();
      // The router appends "[from <platform>]" so the card can show the source chat's logo.
      const from = firstLine.match(/\s*\[from\s+([a-z0-9_-]+)\]\s*$/i);
      const platform = (from?.[1] ?? '') as PlatformId;
      const name = (from ? firstLine.slice(0, from.index) : firstLine).trim() || 'Capsule';
      const tok = Math.max(1, Math.round(text.length / 4));

      node.style.position = 'relative';
      const head = document.createElement('div');
      head.dataset.ccHead = '1';
      head.style.cssText =
        'display:flex;align-items:center;gap:9px;width:236px;padding:8px 10px;cursor:pointer;' +
        'border:1px solid rgba(47,107,255,.42);border-radius:14px;' +
        'background:linear-gradient(135deg,rgba(47,107,255,.13),rgba(47,107,255,.03));';

      const logo = document.createElement('span');
      logo.style.cssText =
        'flex:none;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;' +
        'background:#ffffff;border:1px solid rgba(47,107,255,.22);box-shadow:0 1px 2px rgba(10,42,107,.18);';
      const svg = platformIconSvg(platform, 18);
      if (svg) logo.innerHTML = svg;
      else logo.textContent = '◉'; // older capsule without provenance, or a platform we have no mark for
      if (!svg) {
        logo.style.font = '700 15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
        logo.style.color = '#2f6bff';
      }

      const meta = document.createElement('span');
      meta.style.cssText = 'flex:1;min-width:0;display:block;overflow:hidden;';
      const nm = document.createElement('span');
      nm.style.cssText =
        'display:block;font:600 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
        'color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      nm.textContent = name;
      const sub = document.createElement('span');
      sub.style.cssText =
        'display:block;font:500 10.5px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
        'opacity:.62;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      sub.textContent = `~${tok} tok attached`;
      meta.append(nm, sub);

      const chevron = document.createElement('span');
      chevron.style.cssText = 'flex:none;font:600 10px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;opacity:.5;';
      chevron.textContent = '▾';
      head.append(logo, meta, chevron);

      const body = document.createElement('div');
      body.style.cssText = 'max-height:0;overflow:hidden;transition:max-height .35s ease;';
      while (node.firstChild) body.appendChild(node.firstChild);
      node.append(head, body);

      head.onclick = () => {
        const open = body.style.maxHeight !== '0px';
        body.style.maxHeight = open ? '0px' : '3000px';
        chevron.textContent = open ? '▾' : '▴';
      };
    });
  }

  // ------------------------------------------------------- capsule radar

  /** Does the current conversation look like one of the stored capsules? */
  private radarMatch(): CapsuleListItem | null {
    if (!this.capsules.length) return null;
    const title = (this.opts.adapter.getConversationTitle() ?? '').toLowerCase().trim();
    if (title.length < 4) return null;
    const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'using', 'project', 'build', 'building', 'make', 'create', 'how', 'what', 'why']);
    let best: { item: CapsuleListItem; score: number } | null = null;
    for (const c of this.capsules) {
      const words = c.projectName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !stop.has(w));
      let score = 0;
      for (const w of words) if (title.includes(w)) score++;
      if (!best || score > best.score) best = { item: c, score };
    }
    if (!best) return null;
    const needed = best.item.projectName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !stop.has(w)).length <= 1 ? 1 : 2;
    return best.score >= needed ? best.item : null;
  }

  // -------------------------------------------------- context-saved gauge

  private gaugeEl(pct: number): HTMLElement {
    const g = document.createElement('div');
    g.className = 'cc-gauge';
    g.style.setProperty('--cc-p-final', String(pct));
    const inner = document.createElement('div');
    inner.className = 'cc-gauge-in';
    const b = document.createElement('b');
    b.textContent = `${pct}%`;
    const s = document.createElement('span');
    s.textContent = 'context saved';
    inner.append(b, s);
    g.appendChild(inner);
    return g;
  }

  // ------------------------------------------------- silent handoff carrier

  /** The element the user is actually typing in (beats guessed selectors). */
  private preferredComposer: HTMLElement | null = null;

  private composer(): HTMLElement | null {
    const p = this.preferredComposer;
    // A composer the platform later hides (expanded prompt panel, Canvas view)
    // must not keep steering the chip or the handoff.
    if (p && this.opts.adapter.isComposerVisible(p)) return p;
    this.preferredComposer = null;
    return this.opts.adapter.getComposer();
  }

  /** Keep the handoff inside the chip and prepend it to the next sent message. */
  private armHandoff(text: string) {
    this.disarmHandoff();
    this.pendingHandoff = text;

    const key = (e: KeyboardEvent) => {
      if (!this.pendingHandoff || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      const editable =
        !!t && (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t.isContentEditable);
      // Trust the focused editable over selector guesses (pages have decoys).
      if (editable) this.preferredComposer = t;
      const composer = this.composer();
      if (!composer || (!editable && e.target !== composer && !composer.contains(e.target as Node))) return;
      const userText = this.opts.adapter.getComposerText(composer).trim();
      e.preventDefault();
      e.stopPropagation();
      this.deliverHandoff(userText);
    };
    const click = (e: MouseEvent) => {
      if (!this.pendingHandoff) return;
      const btn = (e.target as Element | null)?.closest?.(
        'button[data-testid*="send" i], button[aria-label*="Send" i], button[aria-label*="send message" i]'
      );
      if (!btn) return;
      const composer = this.composer();
      if (!composer) return;
      const userText = this.opts.adapter.getComposerText(composer).trim();
      if (!userText) return;
      e.preventDefault();
      e.stopPropagation();
      this.deliverHandoff(userText);
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('click', click, true);
    this.interceptor = { key, click };
  }

  private deliverHandoff(userText: string) {
    const handoff = this.pendingHandoff;
    if (!handoff) return;
    this.disarmHandoff();
    const combined = userText ? `${handoff}\n\n---\nUser message: ${userText}` : handoff;
    this.submitWithShield(combined, (ok) => {
      if (ok) {
        if (this.chipMeta) this.chipMeta.textContent = '✓ delivered';
        return;
      }
      // The editor refused the capsule — never claim delivery we can't prove.
      // Stay armed so the next send retries the attach.
      this.armHandoff(handoff);
      const composer = this.composer();
      if (userText && !this.opts.adapter.getComposerText(composer).trim()) {
        void this.opts.adapter.insertText(userText, composer);
      }
      if (this.chipMeta) this.chipMeta.textContent = '⚠ not attached — press send again';
    });
  }

  /** How many capsule handoffs are visible in the thread right now. */
  private countSentCapsules(): number {
    return this.opts.adapter
      .getUserMessageNodes()
      .filter((n) => {
        // Decorated cards keep only a short header visible, so match loosely.
        if (n.querySelector('[data-cc-head]')) return true;
        const t = n.innerText ?? '';
        return t.includes('Context Capsule') || t.includes('Context from my capsule');
      })
      .length;
  }

  /** Insert + submit while a shield hides the composer; only reports success when the capsule provably landed. */
  private submitWithShield(text: string, done?: (ok: boolean) => void) {
    const composer = this.composer();
    const shield = this.showDeliveryShield(composer);
    const before = this.countSentCapsules();
    void (async () => {
      if (!(await this.opts.adapter.insertText(text, composer))) {
        shield?.remove();
        done?.(false);
        return;
      }
      const probe = text.slice(0, 48);
      let attempts = 0;
      const clearIfSticky = () => {
        const c = this.composer();
        if (this.opts.adapter.getComposerText(c).includes(probe)) {
          void this.opts.adapter.clearComposer(c);
        }
      };
      const finish = (ok: boolean) => {
        if (ok) clearIfSticky(); // never leave capsule text visibly sitting in the input box
        shield?.remove();
        done?.(ok);
        if (ok) setTimeout(clearIfSticky, 600); // editors sometimes re-render the old text
        this.decorateSentCapsules();
        setTimeout(() => this.decorateSentCapsules(), 1200);
        setTimeout(() => this.decorateSentCapsules(), 3000);
      };
      const landed = () => this.countSentCapsules() > before;
      const attempt = () => {
        attempts++;
        void this.opts.adapter.submit(this.composer());
        let waits = 0;
        const poll = () => {
          if (landed()) {
            // The thread itself proves the capsule was sent — even if the
            // editor failed to clear its input afterwards.
            clearIfSticky();
            finish(true);
            return;
          }
          const value = this.opts.adapter.getComposerText(this.composer()).trim();
          if (!value.includes(probe)) {
            // Composer cleared — confirm the capsule actually reached the
            // thread before calling it delivered (guards against the editor
            // reverting our text and sending only the user's words).
            setTimeout(() => {
              if (landed()) finish(true);
              else setTimeout(() => finish(landed()), 1000);
            }, 700);
            return;
          }
          if (++waits < 14) {
            setTimeout(poll, 220);
          } else if (attempts < 3) {
            attempt();
          } else {
            finish(landed());
          }
        };
        setTimeout(poll, 250);
      };
      // Give the editor's model a beat to absorb the insert before sending.
      setTimeout(attempt, 200);
    })();
  }

  /** Opaque panel that hides the composer during silent delivery. */
  private showDeliveryShield(composer?: HTMLElement | null): HTMLElement | null {
    const rect = (composer ?? this.composer())?.getBoundingClientRect();
    const s = document.createElement('div');
    s.className = 'cc-shield';
    if (rect && rect.width > 0 && rect.height > 0) {
      s.style.left = `${Math.max(0, rect.left - 4)}px`;
      s.style.top = `${Math.max(0, rect.top - 4)}px`;
      s.style.width = `${Math.min(window.innerWidth - 8, rect.width + 8)}px`;
      s.style.height = `${rect.height + 8}px`;
    } else {
      s.style.left = '50%';
      s.style.top = '80%';
      s.style.width = 'min(640px, 90vw)';
      s.style.transform = 'translateX(-50%)';
    }
    s.appendChild(this.capsuleEl('cc-shield-capsule'));
    const t = document.createElement('span');
    t.textContent = '🔒 Attaching capsule…';
    s.appendChild(t);
    this.root.appendChild(s);
    return s;
  }

  private disarmHandoff() {
    if (this.interceptor) {
      document.removeEventListener('keydown', this.interceptor.key, true);
      document.removeEventListener('click', this.interceptor.click, true);
      this.interceptor = null;
    }
    this.pendingHandoff = null;
  }

  // ------------------------------------------------------------ capsule FX

  /** Two-half capsule graphic (halves can split/close via CSS classes). */
  private capsuleEl(extraClass: string, face?: { platform?: PlatformId; dose?: string }): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `cc-capsule ${extraClass}`;
    const shell = document.createElement('span');
    shell.className = 'cc-shell';
    const a = document.createElement('span');
    a.className = 'cc-half cc-half-a';
    const b = document.createElement('span');
    b.className = 'cc-half cc-half-b';
    if (face) {
      // The coloured half carries the source chat's mark; the clear half carries the dose.
      const brand = document.createElement('span');
      brand.className = 'cc-face cc-face-brand';
      const svg = face.platform ? platformIconSvg(face.platform, 26) : '';
      if (svg) brand.innerHTML = svg;
      else brand.textContent = '◉';
      a.appendChild(brand);

      const dose = document.createElement('span');
      dose.className = 'cc-face cc-face-dose';
      dose.textContent = face.dose ?? '';
      b.appendChild(dose);
    }
    shell.append(a, b);
    wrap.appendChild(shell);
    return wrap;
  }

  /** Capsule that crossfades into the originating chat's brand mark (0.8s). */
  private pickIcon(source: PlatformId, idx: number): HTMLElement {
    const stack = document.createElement('span');
    stack.className = 'cc-pick-icon';
    const capsule = this.capsuleEl('cc-pick-capsule');
    const mark = document.createElement('span');
    mark.className = 'cc-pick-mark';
    const svg = platformIconSvg(source, 16);
    if (svg) mark.innerHTML = svg;
    else {
      mark.textContent = '◉';
      mark.classList.add('cc-pick-mark-plain');
    }
    // Stagger so a list of capsules doesn't flip in lockstep.
    const delay = `${idx * 0.25}s`;
    capsule.style.animationDelay = delay;
    mark.style.animationDelay = delay;
    stack.append(capsule, mark);
    return stack;
  }

  /** Capsule breaks into two halves; context shards stream toward the composer (~2s). */
  private playUnseal(composerRect: DOMRect | null, source?: PlatformId, dose?: string): Promise<void> {
    if (this.reducedMotion) return Promise.resolve();
    return new Promise((resolve) => {
      this.root.querySelector('.cc-unseal')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'cc-unseal';
      const cx = Math.round(window.innerWidth / 2);
      const cy = Math.round(window.innerHeight * 0.42);

      const capsule = this.capsuleEl('cc-capsule-xl cc-unseal-capsule', { platform: source, dose });
      capsule.style.left = `${cx}px`;
      capsule.style.top = `${cy}px`;
      overlay.appendChild(capsule);

      const tx = composerRect ? composerRect.left + composerRect.width / 2 - cx : 0;
      const ty = composerRect ? composerRect.top + composerRect.height / 2 - cy : 140;
      const count = 22;
      for (let i = 0; i < count; i++) {
        const s = document.createElement('span');
        s.className = 'cc-shard';
        s.style.left = `${cx}px`;
        s.style.top = `${cy}px`;
        const ang = (i / count) * Math.PI * 2;
        const spread = 56 + Math.random() * 60;
        s.style.setProperty('--sx', `${Math.cos(ang) * spread}px`);
        s.style.setProperty('--sy', `${Math.sin(ang) * spread}px`);
        s.style.setProperty('--tx', `${tx * (0.65 + Math.random() * 0.45) + Math.cos(ang) * 26}px`);
        s.style.setProperty('--ty', `${ty * (0.65 + Math.random() * 0.45) + Math.sin(ang) * 18}px`);
        // two waves of shards so the effect lingers
        s.style.animationDelay = `${420 + (i % 11) * 40 + Math.floor(i / 11) * 150}ms`;
        s.style.animationDuration = '0.9s';
        overlay.appendChild(s);
      }

      this.root.appendChild(overlay);
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 2000);
    });
  }

  // ---------------------------------------------------------- composer chip

  private showChip(capsule: CapsuleFile, injectedTokens: number) {
    this.hideChip();
    const chip = document.createElement('button');
    chip.className = 'cc-chip';
    chip.setAttribute('aria-label', `Active capsule: ${capsule.project.name}`);
    const logo = document.createElement('span');
    logo.className = 'cc-chip-logo';
    const svg = platformIconSvg(capsule.source_platform, 17);
    if (svg) logo.innerHTML = svg;
    else logo.appendChild(this.capsuleEl('cc-chip-capsule'));
    const txt = document.createElement('span');
    txt.className = 'cc-chip-txt';
    const name = document.createElement('span');
    name.className = 'cc-chip-name';
    name.textContent = capsule.project.name;
    const tok = document.createElement('span');
    tok.className = 'cc-chip-meta';
    tok.textContent = `~${formatTokens(injectedTokens)} tok · rides next msg`;
    txt.append(name, tok);
    const x = document.createElement('span');
    x.className = 'cc-chip-x';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss capsule chip');
    x.onclick = (e) => {
      e.stopPropagation();
      this.disarmHandoff();
      this.hideChip();
      this.activeCapsuleId = null;
    };
    chip.append(logo, txt, x);
    chip.onclick = () => {
      this.detailCapsule = capsule;
      this.detailStats = capsuleStats(capsule);
      this.updateDiff = null;
      this.searchQuery = '';
      this.panelOpen = true;
      this.setView('detail');
    };
    this.root.appendChild(chip);
    this.chipEl = chip;
    this.chipMeta = tok;

    // Glue the chip to the composer every frame — survives scroll, resize and
    // layout shifts of the chat UI without lag spikes.
    this.placeChip();
    const loop = () => {
      if (!this.chipEl) {
        this.chipRaf = 0;
        return;
      }
      this.placeChip();
      this.chipRaf = requestAnimationFrame(loop);
    };
    this.chipRaf = requestAnimationFrame(loop);
  }

  private placeChip() {
    const chip = this.chipEl;
    if (!chip) return;
    const now = performance.now();
    // Resolving the composer scans every editable on the page — do it a few
    // times a second, not every frame; re-reading a cached rect is cheap.
    if (!this.chipAnchor || now - this.chipAnchorAt > 250) {
      this.chipAnchor = this.composer();
      this.chipAnchorAt = now;
    }
    let r: DOMRect | null = null;
    if (this.chipAnchor?.isConnected) {
      const form = this.chipAnchor.closest('form') as HTMLElement | null;
      const el = form && visibleRect(form) ? form : this.chipAnchor;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight + 400) r = rect;
    }
    if (r) {
      // .cc-chip rides translateY(-100%), so `top` is its bottom edge.
      const W = 236;
      const H = 46;
      chip.style.left = `${Math.max(8, Math.min(r.left + 10, window.innerWidth - W - 12))}px`;
      chip.style.top = `${Math.min(Math.max(r.top - 10, H + 8), window.innerHeight - 10)}px`;
      chip.style.right = 'auto';
      chip.style.bottom = 'auto';
    } else {
      chip.style.left = 'auto';
      chip.style.top = 'auto';
      chip.style.right = '20px';
      chip.style.bottom = '76px';
    }
  }

  private hideChip() {
    this.chipEl?.remove();
    this.chipEl = null;
    this.chipMeta = null;
    this.chipAnchor = null;
    if (this.chipRaf) {
      cancelAnimationFrame(this.chipRaf);
      this.chipRaf = 0;
    }
  }

  // ---------------------------------------------------------------- render

  private render() {
    const c = this.container;
    c.textContent = '';

    const fab = document.createElement('button');
    fab.className = 'cc-fab' + (this.panelOpen ? ' cc-open' : '') + (this.radarMatch() ? ' cc-radar' : '');
    fab.setAttribute('aria-label', 'Open Context Capsule');
    fab.appendChild(this.capsuleEl('cc-capsule-fab'));
    fab.onclick = () => {
      this.panelOpen = !this.panelOpen;
      this.render();
    };
    c.appendChild(fab);

    if (!this.panelOpen) return;

    const panel = document.createElement('section');
    panel.className = 'cc-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Context Capsule');

    const head = document.createElement('div');
    head.className = 'cc-head';
    const headCapsule = this.capsuleEl('cc-capsule-head');
    const titleWrap = document.createElement('div');
    titleWrap.style.flex = '1';
    const title = document.createElement('div');
    title.className = 'cc-head-title';
    title.textContent = 'Context Capsule';
    const sub = document.createElement('div');
    sub.className = 'cc-head-sub';
    sub.textContent = 'Your AI context, portable.';
    titleWrap.append(title, sub);
    const gear = document.createElement('button');
    gear.className = 'cc-icon-btn';
    gear.setAttribute('aria-label', 'Open settings');
    gear.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    gear.onclick = () => {
      // Most reliable from a content script: open the options page URL directly.
      try {
        void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
      } catch {
        void this.opts.sendToBackground({ type: 'OPEN_OPTIONS' } as never).catch(() => undefined);
      }
    };
    const close = document.createElement('button');
    close.className = 'cc-icon-btn';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close panel');
    close.onclick = () => {
      this.panelOpen = false;
      this.render();
    };
    head.append(headCapsule, titleWrap, gear, close);

    const body = document.createElement('div');
    body.className = 'cc-body';

    switch (this.view) {
      case 'main': this.renderMain(body); break;
      case 'creating': this.renderCreating(body); break;
      case 'created': this.renderCreated(body); break;
      case 'detail': this.renderDetail(body); break;
      case 'importing': this.renderImport(body); break;
      case 'imported': this.renderImported(body); break;
    }

    if (this.error) {
      const err = document.createElement('div');
      err.className = 'cc-error';
      err.setAttribute('role', 'alert');
      err.textContent = this.error;
      body.appendChild(err);
    }

    panel.append(head, body);
    c.appendChild(panel);
  }

  private renderMain(body: HTMLElement) {
    const radar = this.radarMatch();
    if (radar) {
      const card = document.createElement('div');
      card.className = 'cc-card cc-radar-card';
      card.appendChild(this.capsuleEl('cc-radar-capsule'));
      const txt = document.createElement('div');
      txt.className = 'cc-pick-txt';
      const t = document.createElement('div');
      t.className = 'cc-card-title';
      t.textContent = '📡 Radar — this chat matches';
      const s = document.createElement('div');
      s.className = 'cc-card-sub';
      s.textContent = `“${radar.projectName}” — continue where you left off`;
      txt.append(t, s);
      const go = document.createElement('button');
      go.className = 'cc-mini-btn cc-pick-go';
      go.textContent = 'Unseal ↩';
      go.disabled = this.busy;
      go.onclick = (e) => {
        e.stopPropagation();
        void this.unsealFromList(radar);
      };
      card.append(txt, go);
      body.appendChild(card);
    }

    const info = this.opts.pageInfo();
    if (info.supported && info.messageCount > 0) {
      const label = document.createElement('div');
      label.className = 'cc-section-label';
      label.textContent = 'This page';
      const card = document.createElement('div');
      card.className = 'cc-card cc-detect';
      const icon = document.createElement('div');
      icon.className = 'cc-detect-icon cc-detect-brand';
      const svg = platformIconSvg(this.opts.adapter.id);
      if (svg) icon.innerHTML = svg;
      else icon.textContent = '◉';
      const txt = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'cc-detect-name';
      name.textContent = 'Conversation detected';
      const meta = document.createElement('div');
      meta.className = 'cc-detect-meta';
      meta.textContent = `${PLATFORM_LABELS[this.opts.adapter.id] ?? 'This chat'} · ${info.messageCount} messages · ~${formatTokens(info.estimatedTokens)} estimated tokens`;
      txt.append(name, meta);
      card.append(icon, txt);
      body.append(label, card);
    } else if (!info.supported) {
      const card = document.createElement('div');
      card.className = 'cc-card';
      const t = document.createElement('div');
      t.className = 'cc-card-title';
      t.textContent = "This AI platform isn't supported yet";
      const s = document.createElement('div');
      s.className = 'cc-card-sub';
      s.textContent = 'You can still export a capsule elsewhere and import it manually.';
      card.append(t, s);
      body.appendChild(card);
    }

    const createBtn = document.createElement('button');
    createBtn.className = 'cc-btn cc-btn-primary';
    createBtn.textContent = info.messageCount > 0 ? 'Create Capsule' : 'No conversation to capture';
    createBtn.disabled = this.busy || info.messageCount === 0;
    createBtn.style.marginTop = '12px';
    createBtn.onclick = () => void this.createCapsuleFlow();
    body.appendChild(createBtn);

    const importBtn = document.createElement('button');
    importBtn.className = 'cc-btn';
    importBtn.textContent = 'Import a .contextcapsule file';
    importBtn.onclick = () => this.setView('importing');
    body.appendChild(importBtn);

    const recent = document.createElement('div');
    recent.className = 'cc-section-label';
    recent.textContent = 'Unseal into this chat';
    body.appendChild(recent);

    if (!this.capsules.length) {
      const empty = document.createElement('div');
      empty.className = 'cc-empty';
      empty.textContent = 'No capsules yet. Create one from this conversation.';
      body.appendChild(empty);
    }

    for (const [idx, item] of this.capsules.slice(0, 6).entries()) {
      const card = document.createElement('div');
      card.className = 'cc-card cc-pick';
      if (this.busy) card.setAttribute('aria-disabled', 'true');
      card.appendChild(this.pickIcon(item.sourcePlatform, idx));
      const txt = document.createElement('div');
      txt.className = 'cc-pick-txt';
      const t = document.createElement('div');
      t.className = 'cc-card-title';
      t.textContent = item.projectName + (this.activeCapsuleId === item.id ? ' · unsealed here' : '');
      const s = document.createElement('div');
      s.className = 'cc-card-sub';
      s.textContent = `v${item.currentVersion} · updated ${formatRelative(item.updatedAt)} · ~${formatTokens(item.coreTokens)} core tokens`;
      txt.append(t, s);
      const unseal = document.createElement('button');
      unseal.className = 'cc-mini-btn cc-pick-go';
      unseal.textContent = 'Unseal ↩';
      unseal.title = 'Keep this capsule in the chip — it rides along with your next sent message';
      unseal.disabled = this.busy;
      unseal.onclick = (e) => {
        e.stopPropagation();
        void this.unsealFromList(item);
      };
      const info = document.createElement('button');
      info.className = 'cc-mini-btn cc-pick-info';
      info.textContent = 'ⓘ';
      info.title = 'Open capsule details';
      info.onclick = (e) => {
        e.stopPropagation();
        void this.openDetail(item);
      };
      card.append(txt, unseal, info);
      card.onclick = () => {
        if (!this.busy) void this.unsealFromList(item);
      };
      body.appendChild(card);
    }
  }

  private renderCreating(body: HTMLElement) {
    const info = this.opts.pageInfo();
    const wrap = document.createElement('div');
    wrap.className = 'cc-anim';

    const stage = document.createElement('div');
    stage.className = 'cc-stage';
    const stageName = STAGES[Math.min(this.animStage, STAGES.length - 1)];
    stage.textContent = `${stageName.toUpperCase()} — ${info.messageCount} messages, ~${formatTokens(info.estimatedTokens)} estimated tokens`;

    const bar = document.createElement('div');
    bar.className = 'cc-bar';
    const fill = document.createElement('div');
    fill.className = 'cc-bar-fill';
    fill.style.width = `${((this.animStage + 1) / STAGES.length) * 100}%`;
    bar.appendChild(fill);

    wrap.append(stage, bar);

    if (this.animStage === 1) {
      const list = document.createElement('div');
      list.className = 'cc-checklist';
      STRUCTURE_ITEMS.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'done';
        const name = document.createElement('span');
        name.textContent = item;
        const check = document.createElement('span');
        check.className = 'cc-check';
        check.textContent = '✓';
        if (!this.reducedMotion) {
          check.style.opacity = '0';
          setTimeout(() => {
            check.style.transition = 'opacity .2s';
            check.style.opacity = '1';
          }, 120 * i);
        }
        row.append(name, check);
        list.appendChild(row);
      });
      wrap.appendChild(list);
    }

    if (this.animStage >= 2 && !this.reducedMotion) {
      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'cc-canvas-wrap';
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 110;
      canvasWrap.appendChild(canvas);
      wrap.appendChild(canvasWrap);
      requestAnimationFrame(() => this.animateParticles(canvas, this.animStage >= 3));
    } else if (this.animStage >= 2) {
      const orb = document.createElement('div');
      orb.className = 'cc-orb-big';
      wrap.appendChild(orb);
    }

    body.appendChild(wrap);
  }

  /** GPU-friendly canvas particle compression — particles converge into the capsule. */
  private animateParticles(canvas: HTMLCanvasElement, converging: boolean) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const particles = Array.from({ length: 140 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 0.8 + Math.random() * 1.6,
      speed: 0.012 + Math.random() * 0.02,
      wobble: Math.random() * Math.PI * 2
    }));
    const accent = getComputedStyle(this.container).getPropertyValue('--cc-accent').trim() || '#0f62fe';
    let frame = 0;
    const tick = () => {
      if (this.view !== 'creating') return;
      frame++;
      ctx.clearRect(0, 0, W, H);
      const converge = converging ? 0.09 : 0.02;
      for (const p of particles) {
        p.x += (cx - p.x) * p.speed * (converge * 50);
        p.y += (cy - p.y) * p.speed * (converge * 50) + Math.sin(frame / 14 + p.wobble) * 0.3;
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < 12) {
          p.x = Math.random() * W;
          p.y = Math.random() * H;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.globalAlpha = Math.max(0.15, Math.min(0.8, d / 140));
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // capsule core
      ctx.beginPath();
      ctx.arc(cx, cy, converging ? 14 : 10, 0, Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, converging ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      requestAnimationFrame(tick);
    };
    tick();
  }

  private renderCreated(body: HTMLElement) {
    const capsule = this.createdCapsule;
    if (!capsule) return;
    const stats = capsuleStats(capsule);
    const wrap = document.createElement('div');
    wrap.className = 'cc-sealed';

    const seal = this.capsuleEl('cc-capsule-xl cc-capsule-seal', {
      platform: capsule.source_platform,
      dose: `~${formatTokens(stats.coreTokens)} ctx`
    });

    const h = document.createElement('h3');
    h.textContent = 'Capsule sealed';
    const sub = document.createElement('div');
    sub.className = 'cc-card-sub';
    sub.textContent = `${capsule.project.name} · ${shortCapsuleId(capsule.id)}`;

    const grid = document.createElement('div');
    grid.className = 'cc-stat-grid';
    const stat = (value: string, labelText: string) => {
      const d = document.createElement('div');
      d.className = 'cc-stat';
      const b = document.createElement('b');
      b.textContent = value;
      const s = document.createElement('span');
      s.textContent = labelText;
      d.append(b, s);
      return d;
    };
    grid.append(
      stat(`~${formatTokens(stats.originalTokens)}`, 'original context (est.)'),
      stat(`~${formatTokens(stats.coreTokens)}`, 'core context (est.)'),
      stat(`${stats.reductionPct}%`, 'estimated reduction'),
      stat(String(stats.memoryCount), 'memories extracted')
    );

    wrap.append(seal, h, sub, this.gaugeEl(stats.reductionPct), grid);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'cc-btn cc-btn-primary';
    exportBtn.textContent = 'Export Capsule';
    exportBtn.onclick = () => this.exportCapsule(capsule);
    const openBtn = document.createElement('button');
    openBtn.className = 'cc-btn';
    openBtn.textContent = 'Open Capsule';
    openBtn.onclick = () => {
      this.detailCapsule = capsule;
      this.detailStats = stats;
      this.setView('detail');
    };
    const doneBtn = document.createElement('button');
    doneBtn.className = 'cc-btn';
    doneBtn.textContent = 'Done';
    doneBtn.onclick = () => this.setView('main');
    wrap.append(exportBtn, openBtn, doneBtn);

    body.appendChild(wrap);
  }

  private renderImport(body: HTMLElement) {
    const back = this.backButton();
    body.appendChild(back);

    const zone = document.createElement('div');
    zone.className = 'cc-import-zone';
    const zoneCapsule = this.capsuleEl('cc-capsule-zone');
    const t1 = document.createElement('div');
    t1.textContent = 'Select a .contextcapsule file';
    zone.append(zoneCapsule, t1);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.contextcapsule,application/json';
    input.style.display = 'none';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void this.importFile(f);
    };
    zone.style.cursor = 'pointer';
    zone.onclick = () => input.click();
    body.append(zone, input);

    const note = document.createElement('div');
    note.className = 'cc-note';
    note.textContent =
      'Capsules are validated before import. Importing replaces nothing — the capsule is stored locally alongside your existing ones.';
    body.appendChild(note);
  }

  private renderImported(body: HTMLElement) {
    const item = this.importedItem;
    if (!item || !this.detailCapsule) return;
    const wrap = document.createElement('div');
    wrap.className = 'cc-sealed';
    const capsule = this.capsuleEl('cc-capsule-xl cc-capsule-idle', {
      platform: this.detailCapsule.source_platform,
      dose: `~${formatTokens(item.coreTokens)} ctx`
    });
    const h = document.createElement('h3');
    h.textContent = '✨ Context Capsule ready';
    const sub = document.createElement('div');
    sub.className = 'cc-card-sub';
    sub.textContent = item.name;
    const grid = document.createElement('div');
    grid.className = 'cc-stat-grid';
    const mk = (v: string, l: string) => {
      const d = document.createElement('div');
      d.className = 'cc-stat';
      const b = document.createElement('b');
      b.textContent = v;
      const s = document.createElement('span');
      s.textContent = l;
      d.append(b, s);
      return d;
    };
    grid.append(
      mk(`~${formatTokens(item.coreTokens)}`, 'core tokens (est.)'),
      mk(String(item.memoryCount), 'relevant memories available')
    );
    const stats = capsuleStats(this.detailCapsule);
    wrap.append(capsule, h, sub, this.gaugeEl(stats.reductionPct), grid);

    const start = document.createElement('button');
    start.className = 'cc-btn cc-btn-primary';
    start.textContent = 'Unseal — rides with next message';
    start.onclick = () => this.startConversation(false);
    const startSend = document.createElement('button');
    startSend.className = 'cc-btn';
    startSend.textContent = 'Send as first message';
    startSend.onclick = () => this.startConversation(true);
    const openBtn = document.createElement('button');
    openBtn.className = 'cc-btn';
    openBtn.textContent = 'Open Capsule';
    openBtn.onclick = () => {
      this.detailStats = capsuleStats(this.detailCapsule!);
      this.setView('detail');
    };
    wrap.append(start, startSend, openBtn);
    body.appendChild(wrap);
  }

  private backButton(): HTMLButtonElement {
    const back = document.createElement('button');
    back.className = 'cc-btn cc-back';
    back.textContent = '← Back';
    back.onclick = () => this.setView('main');
    return back;
  }

  private renderDetail(body: HTMLElement) {
    const capsule = this.detailCapsule;
    const stats = this.detailStats;
    if (!capsule || !stats) return;

    body.appendChild(this.backButton());

    const name = document.createElement('div');
    name.className = 'cc-detail-name';
    name.textContent = capsule.project.name;
    const meta = document.createElement('div');
    meta.className = 'cc-detail-meta';
    meta.textContent = `${shortCapsuleId(capsule.id)} · v${capsule.current_version} · from ${capsule.source_platform} · updated ${formatRelative(capsule.updated_at)}`;
    body.append(name, meta);

    if (this.updateDiff) {
      const diff = document.createElement('div');
      diff.className = 'cc-diff card';
      const add = document.createElement('div');
      add.className = 'cc-diff-add';
      add.textContent = `+ ${this.updateDiff.newMemories.length} new memories`;
      const sup = document.createElement('div');
      sup.className = 'cc-diff-sup';
      sup.textContent = this.updateDiff.superseded.length
        ? `~ ${this.updateDiff.superseded.length} decision(s) superseded`
        : 'no decisions changed';
      diff.append(add, sup);
      body.appendChild(diff);
    }

    // Stats
    const statsLabel = this.label('Context (estimated)');
    const card = document.createElement('div');
    card.className = 'cc-card';
    const kv = (k: string, v: string) => {
      const row = document.createElement('div');
      row.className = 'cc-kv';
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('b');
      b.textContent = v;
      row.append(a, b);
      return row;
    };
    card.append(
      kv('Original conversation', `~${formatTokens(stats.originalTokens)} tokens`),
      kv('Core capsule', `~${formatTokens(stats.coreTokens)} tokens`),
      kv('Estimated reduction', `${stats.reductionPct}%`),
      kv('Memories', String(stats.memoryCount)),
      kv('Archived messages', String(capsule.archive.messages.length))
    );
    body.append(statsLabel, card);

    // Actions
    const exportBtn = this.actionButton('Export Capsule', () => this.exportCapsule(capsule), true);
    const updateBtn = this.actionButton(this.busy ? 'Updating…' : 'Update from this page', () => void this.updateCapsuleFlow(), false);
    updateBtn.disabled = this.busy;
    const startBtn = this.actionButton('Unseal into this chat', () => this.startConversation(false), false);
    body.append(exportBtn, updateBtn, startBtn);

    // Core context
    const core = capsule.core_context;
    const addList = (titleText: string, items: string[], struck = false) => {
      if (!items.length) return;
      body.appendChild(this.label(titleText));
      const ul = document.createElement('ul');
      ul.className = 'cc-list';
      for (const item of items) {
        const li = document.createElement('li');
        if (struck) li.className = 'cc-struck';
        li.textContent = item;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    };
    addList('Objective', core.goals);
    addList('Requirements', core.requirements);
    addList('Constraints', core.constraints);
    addList('Decisions', core.decisions);
    addList('Rejected approaches', core.rejectedApproaches);
    addList('Known issues', core.knownIssues);
    addList('Current task', core.currentTask ? [core.currentTask] : []);

    // Memories with controls
    if (capsule.memories.length) {
      body.appendChild(this.label(`Memories (${capsule.memories.length})`));
      const sorted = [...capsule.memories].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      for (const m of sorted.slice(0, 60)) {
        body.appendChild(this.memoryCard(m));
      }
      if (capsule.memories.length > 60) {
        const more = document.createElement('div');
        more.className = 'cc-note';
        more.textContent = `Showing 60 of ${capsule.memories.length} memories — use search to find others.`;
        body.appendChild(more);
      }
    }

    // Archive search
    body.appendChild(this.label('Search archive'));
    const search = document.createElement('input');
    search.className = 'cc-search';
    search.placeholder = 'Search capsule…';
    search.value = this.searchQuery;
    search.setAttribute('aria-label', 'Search capsule archive');
    search.oninput = () => {
      this.searchQuery = search.value;
      renderHits();
    };
    body.appendChild(search);
    const hitsWrap = document.createElement('div');
    body.appendChild(hitsWrap);

    const attachBtn = this.actionButton('🎯 Attach matching memories to my next message', () => {
      const q = this.searchQuery.trim();
      if (!q) {
        this.error = 'Type a search first — this attaches only the memories that match it.';
        this.render();
        return;
      }
      const h = buildHandoff(capsule, { query: q, budgetTokens: 1200 });
      if (!h.retrievedMemories.length) {
        this.error = 'No capsule memories match that search.';
        this.render();
        return;
      }
      const block = [
        `## Context from my capsule "${capsule.project.name}" (relevant to: "${q}")`,
        ...h.retrievedMemories.map((m) => `- [${m.type}] ${m.content}`),
        'Use this directly in your next reply \u2014 do not summarize or acknowledge it separately.'
      ].join('\n');
      this.armHandoff(this.pendingHandoff ? `${this.pendingHandoff}\n\n${block}` : block);
      this.activeCapsuleId = capsule.id;
      if (this.chipEl && this.chipMeta) {
        this.chipMeta.textContent = `${h.retrievedMemories.length} matched memories · rides next msg`;
      } else {
        this.showChip(capsule, h.budget.retrievedTokens);
      }
      attachBtn.textContent = `✓ Armed — ${h.retrievedMemories.length} memories will ride your next message`;
    }, false);
    body.appendChild(attachBtn);

    const renderHits = () => {
      hitsWrap.textContent = '';
      if (!this.searchQuery.trim()) return;
      const hits = searchCapsule(capsule, this.searchQuery, 8);
      if (!hits.length) {
        const none = document.createElement('div');
        none.className = 'cc-empty';
        none.textContent = 'No matches.';
        hitsWrap.appendChild(none);
        return;
      }
      for (const hit of hits) {
        const d = document.createElement('div');
        d.className = 'cc-hit';
        const t = document.createElement('div');
        t.className = 'cc-hit-title';
        t.textContent = hit.kind === 'memory' ? `${hit.title}` : `archive — ${hit.title}`;
        const s = document.createElement('div');
        s.textContent = hit.snippet;
        d.append(t, s);
        hitsWrap.appendChild(d);
      }
    };
    renderHits();

    // Version history
    if (capsule.history.length) {
      body.appendChild(this.label('Version history'));
      for (const h of [...capsule.history].reverse()) {
        const row = document.createElement('div');
        row.className = 'cc-kv';
        const v = document.createElement('span');
        v.textContent = `v${h.version} — ${h.note ?? ''} (${formatRelative(h.createdAt)})`;
        const restore = document.createElement('button');
        restore.className = 'cc-mini-btn';
        restore.textContent = 'Restore';
        restore.onclick = () => void this.restoreVersion(h.version);
        row.append(v, restore);
        body.appendChild(row);
      }
    }

    // Danger zone
    const del = this.actionButton('Delete capsule', () => void this.deleteCapsule(capsule.id), false);
    del.classList.add('cc-btn-danger');
    body.appendChild(del);
  }

  private memoryCard(m: MemoryItem): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cc-memory';
    const metaRow = document.createElement('div');
    metaRow.className = 'cc-memory-meta';
    const tag = document.createElement('span');
    tag.className = 'cc-tag' + (m.supersededBy ? ' superseded' : '');
    tag.textContent = m.supersededBy ? `${m.type} · superseded` : m.type;
    metaRow.appendChild(tag);
    if (m.pinned) {
      const pin = document.createElement('span');
      pin.className = 'cc-tag';
      pin.textContent = 'pinned';
      metaRow.appendChild(pin);
    }
    const pinBtn = document.createElement('button');
    pinBtn.className = 'cc-mini-btn';
    pinBtn.title = m.pinned ? 'Unpin' : 'Pin (keep in core)';
    pinBtn.textContent = m.pinned ? '★' : '☆';
    pinBtn.onclick = () => void this.togglePin(m.id);
    const delBtn = document.createElement('button');
    delBtn.className = 'cc-mini-btn';
    delBtn.title = 'Remove from capsule';
    delBtn.textContent = '🗑';
    delBtn.onclick = () => void this.removeMemory(m.id);
    metaRow.append(pinBtn, delBtn);
    const content = document.createElement('div');
    content.textContent = m.content;
    card.append(metaRow, content);
    return card;
  }

  private label(text: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'cc-section-label';
    d.textContent = text;
    return d;
  }

  private actionButton(text: string, onClick: () => void, primary: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'cc-btn' + (primary ? ' cc-btn-primary' : '');
    b.style.marginTop = '8px';
    b.textContent = text;
    b.onclick = onClick;
    return b;
  }
}
