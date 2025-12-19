export type DebugProvider = 'google' | 'openrouter';

export type DebugLogEntry = {
  ts: string;
  action: string;
  provider?: DebugProvider;
  model?: string;
  details?: Record<string, unknown>;
};

export const DEBUG_LOG_STORAGE_KEY = 'coverLocalizer.debugLog.v1';
export const MAX_LOG_ENTRIES = 200;

export function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function summarizeText(text: string, max = 220) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(details)) {
    if (value == null) {
      out[key] = value;
      continue;
    }

    if (typeof value === 'string') {
      if (value.startsWith('data:') || value.startsWith('data:image/')) {
        out[key] = { redacted: true, kind: 'dataUrl', length: value.length };
        continue;
      }
      out[key] = summarizeText(value, 600);
      continue;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }

    // Prevent giant nested objects from clogging console / clipboard.
    try {
      const json = JSON.stringify(value);
      out[key] = json && json.length > 1200 ? `${json.slice(0, 1200)}…` : value;
    } catch {
      out[key] = String(value);
    }
  }

  return out;
}

export function loadDebugLog(): DebugLogEntry[] {
  const restored = safeJsonParse<DebugLogEntry[]>(localStorage.getItem(DEBUG_LOG_STORAGE_KEY));
  if (!Array.isArray(restored)) return [];
  return restored.slice(-MAX_LOG_ENTRIES);
}

export function saveDebugLog(entries: DebugLogEntry[]) {
  try {
    localStorage.setItem(DEBUG_LOG_STORAGE_KEY, JSON.stringify(entries.slice(-MAX_LOG_ENTRIES)));
  } catch {
    // ignore
  }
}

export function appendLog(prev: DebugLogEntry[], entry: DebugLogEntry): DebugLogEntry[] {
  return [...prev, entry].slice(-MAX_LOG_ENTRIES);
}

export function formatLogForClipboard(entries: DebugLogEntry[]) {
  return entries
    .map((e) => {
      const base = `${e.ts} ${e.action}`;
      const meta = {
        provider: e.provider,
        model: e.model,
        ...(e.details ? { details: e.details } : {}),
      };
      return `${base}\n${JSON.stringify(meta)}\n`;
    })
    .join('\n');
}
