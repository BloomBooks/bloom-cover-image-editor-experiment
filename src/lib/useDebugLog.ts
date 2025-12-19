import { useEffect, useMemo, useState } from 'react';
import {
  appendLog,
  DebugLogEntry,
  DebugProvider,
  formatLogForClipboard,
  loadDebugLog,
  sanitizeDetails,
  saveDebugLog,
} from './debugLog';

export type LogEventFn = (
  action: string,
  meta?: {
    provider?: DebugProvider;
    model?: string;
    details?: Record<string, unknown>;
  },
) => void;

export function useDebugLog() {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [copySuccess, setCopySuccess] = useState(false);

  useEffect(() => {
    const restored = loadDebugLog();
    setEntries(restored);
  }, []);

  const logEvent: LogEventFn = (action, meta) => {
    const entry: DebugLogEntry = {
      ts: new Date().toISOString(),
      action,
      provider: meta?.provider,
      model: meta?.model,
      details: sanitizeDetails(meta?.details),
    };

    setEntries((prev) => {
      const next = appendLog(prev, entry);
      saveDebugLog(next);
      return next;
    });

    // Always emit to console for debugging.
    console.log('[CoverLocalizer]', entry);
  };

  const copyLogToClipboard = async () => {
    const text = formatLogForClipboard(entries);
    await navigator.clipboard.writeText(text);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 1500);
    logEvent('debug.copy_log.success', { details: { chars: text.length, entries: entries.length } });
  };

  // Keep the returned object stable-ish.
  return useMemo(
    () => ({
      entries,
      logEvent,
      copyLogToClipboard,
      copySuccess,
    }),
    [entries, copySuccess],
  );
}
