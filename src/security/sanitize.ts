import type { CapsuleFile } from '../core/capsule/schema';

/**
 * Redaction pass applied to every capsule at creation and again at export.
 * Conversations routinely contain pasted credentials; the capsule must never
 * become a credential-exfiltration vector.
 */

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: 'api key' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, label: 'api key' },
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, label: 'api key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws access key' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, label: 'github token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'github token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'slack token' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'jwt' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'private key' },
  { re: /\b(pass(word)?|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi, label: 'credential' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g, label: 'bearer token' },
  { re: /\b(session|sess|sid)[=:]\s*[A-Za-z0-9._-]{16,}\b/gi, label: 'session id' },
  { re: /\b(?:\d[ -]*?){13,19}\b/g, label: 'card-like number' }
];

export const REDACTED = '[redacted]';

export function redactText(text: string): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redactions += 1;
      return REDACTED;
    });
  }
  return { text: out, redactions };
}

/** Redact secrets throughout the capsule (archive, memories, artifacts, core). */
export function sanitizeCapsule(capsule: CapsuleFile): { capsule: CapsuleFile; redactions: number } {
  let redactions = 0;
  const clean = (s: string): string => {
    const r = redactText(s);
    redactions += r.redactions;
    return r.text;
  };

  return {
    redactions,
    capsule: {
      ...capsule,
      project: {
        name: capsule.project.name,
        objective: clean(capsule.project.objective),
        description: clean(capsule.project.description)
      },
      core_context: {
        goals: capsule.core_context.goals.map(clean),
        requirements: capsule.core_context.requirements.map(clean),
        constraints: capsule.core_context.constraints.map(clean),
        decisions: capsule.core_context.decisions.map(clean),
        rejectedApproaches: capsule.core_context.rejectedApproaches.map(clean),
        currentState: {
          summary: clean(capsule.core_context.currentState.summary),
          messageCount: capsule.core_context.currentState.messageCount
        },
        currentTask: clean(capsule.core_context.currentTask),
        knownIssues: capsule.core_context.knownIssues.map(clean),
        importantPreferences: capsule.core_context.importantPreferences.map(clean)
      },
      conversation: {
        meta: capsule.conversation.meta,
        summary: clean(capsule.conversation.summary),
        keyEvents: capsule.conversation.keyEvents.map(clean)
      },
      memories: capsule.memories.map((m) => ({ ...m, content: clean(m.content) })),
      artifacts: capsule.artifacts.map((a) => ({
        ...a,
        name: clean(a.name),
        content: a.content !== undefined ? clean(a.content) : undefined
      })),
      archive: { messages: capsule.archive.messages.map((m) => ({ ...m, text: clean(m.text) })) },
      history: capsule.history.map((h) => ({
        ...h,
        coreContext: {
          ...h.coreContext,
          goals: h.coreContext.goals.map(clean),
          requirements: h.coreContext.requirements.map(clean),
          constraints: h.coreContext.constraints.map(clean),
          decisions: h.coreContext.decisions.map(clean),
          rejectedApproaches: h.coreContext.rejectedApproaches.map(clean),
          knownIssues: h.coreContext.knownIssues.map(clean),
          importantPreferences: h.coreContext.importantPreferences.map(clean),
          currentTask: clean(h.coreContext.currentTask)
        },
        memories: h.memories.map((m) => ({ ...m, content: clean(m.content) }))
      }))
    }
  };
}
