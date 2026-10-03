/** Thin wrappers around extension APIs, with a no-op fallback so modules stay testable outside the browser. */

export function isExtensionEnv(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

export async function sendToBackground<T>(message: unknown): Promise<T> {
  const res = (await chrome.runtime.sendMessage(message)) as { ok: boolean; data?: T; error?: string };
  if (!res || res.ok !== true) throw new Error(res?.error || 'Background request failed');
  return res.data as T;
}

export async function sendToActiveTab<T>(message: unknown): Promise<T> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  const res = (await chrome.tabs.sendMessage(tab.id, message)) as { ok: boolean; data?: T; error?: string };
  if (!res || res.ok !== true) throw new Error(res?.error || 'Content script request failed');
  return res.data as T;
}
