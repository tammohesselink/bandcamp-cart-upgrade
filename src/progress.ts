import type { LoadLabel, JobStatus } from './messages';

// Progress for a background load job, persisted to chrome.storage.local under
// a fixed per-label key so the content script can read it without knowing the
// job's key, and subscribe to chrome.storage.onChanged for live updates.
// Shared by src/background.ts (writer) and src/content.ts (reader).

export interface JobFailure {
  url: string;
  title: string;
  artist: string;
  reason: 'error' | 'empty';
}

export interface JobProgress {
  jobKey: string;
  label: LoadLabel;
  total: number;
  // Count of items visited so far this job run (success or failure) — drives
  // the "N / total" progress display and always reaches `total` at job end.
  processed: number;
  // URLs successfully resolved, in item order — content rebuilds the
  // playlist from the per-release cache using this list.
  doneUrls: string[];
  failures: JobFailure[];
  currentUrl: string | null;
  status: JobStatus;
  updatedAt: number;
}

export const PAUSE_FLAG_KEY = 'bcp_loading_paused';

export function progressKey(label: LoadLabel): string {
  return label === 'cart' ? 'bcp_progress_cart' : 'bcp_progress_discography';
}

export async function readProgress(label: LoadLabel): Promise<JobProgress | null> {
  try {
    const key = progressKey(label);
    const result = await chrome.storage.local.get(key);
    return (result[key] as JobProgress | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function writeProgress(progress: JobProgress): Promise<void> {
  try {
    await chrome.storage.local.set({ [progressKey(progress.label)]: progress });
  } catch {}
}
