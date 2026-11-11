import type { PlaylistTrack } from './types';
import { normalizeUrl } from './url';

// Detected and hand-set BPMs, one entry per track. A track's tempo never
// changes, so entries don't expire.
export const TEMPO_KEY_PREFIX = 'bcp_bpm_v1_';

export interface StoredTempo {
  bpm: number;
  confidence: number;
  // 'manual' is a BPM the user typed, tapped or halved/doubled. Detecting again
  // replaces it, but automatic detection leaves it alone.
  source: 'detected' | 'manual';
  savedAt: number;
}

// Bandcamp's track IDs are unique across the site. A track without one (a
// page that didn't say) falls back to its page and title, since tracks without
// their own page all share the release's.
export function trackTempoKey(track: Pick<PlaylistTrack, 'trackId' | 'pageUrl' | 'trackTitle'>): string {
  if (track.trackId != null) return `${TEMPO_KEY_PREFIX}id${track.trackId}`;
  return `${TEMPO_KEY_PREFIX}${normalizeUrl(track.pageUrl)}|${track.trackTitle}`;
}

export function isStoredTempo(value: unknown): value is StoredTempo {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['bpm'] === 'number' && v['bpm'] > 0 && typeof v['confidence'] === 'number' &&
    (v['source'] === 'detected' || v['source'] === 'manual');
}

// Reads the stored tempos under many keys (see trackTempoKey) in one storage call.
export async function readTempos(keys: string[]): Promise<Map<string, StoredTempo>> {
  const found = new Map<string, StoredTempo>();
  if (keys.length === 0) return found;
  try {
    const all = await chrome.storage.local.get(keys);
    for (const key of keys) {
      const value = all[key];
      if (isStoredTempo(value)) found.set(key, value);
    }
  } catch {}
  return found;
}

export function writeTempo(key: string, tempo: StoredTempo): void {
  chrome.storage.local.set({ [key]: tempo }).catch(() => {});
}
