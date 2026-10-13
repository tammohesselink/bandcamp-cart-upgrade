import type { PlaylistTrack } from './types';
import { normalizeUrl } from './url';

export const CACHE_KEY_PREFIX = 'bcp_tracks_v7_';

// Titles, IDs, artwork and durations rarely change.
export const TRACK_DETAILS_MAX_AGE_MS = 182 * 24 * 60 * 60 * 1000;

// Stream links expire and prices can change, so playback and cart adds only
// trust data fetched within this window.
export const LIVE_DATA_MAX_AGE_MS = 60 * 60 * 1000;

export interface CacheEntry {
  tracks: PlaylistTrack[];
  cachedAt: number;
}

export function isCacheEntryUsable(entry: CacheEntry, maxAgeMs: number, now = Date.now()): boolean {
  if (entry.tracks.length === 0) return false;
  // Unplayable tracks can become playable after logging in, so recheck them as
  // often as stream links.
  const limit = entry.tracks.some((t) => t.unplayable) ? Math.min(maxAgeMs, LIVE_DATA_MAX_AGE_MS) : maxAgeMs;
  return now - entry.cachedAt <= limit;
}

export function isStreamFresh(track: PlaylistTrack, now = Date.now()): boolean {
  return track.streamFetchedAt !== undefined && now - track.streamFetchedAt <= LIVE_DATA_MAX_AGE_MS;
}

function cacheKey(url: string): string {
  return CACHE_KEY_PREFIX + normalizeUrl(url);
}

export async function readCache(url: string, maxAgeMs = TRACK_DETAILS_MAX_AGE_MS): Promise<PlaylistTrack[] | null> {
  try {
    const key = cacheKey(url);
    const result = await chrome.storage.local.get(key);
    const entry = result[key] as CacheEntry | undefined;
    if (!entry) return null;
    if (isCacheEntryUsable(entry, maxAgeMs)) return entry.tracks;
    if (!isCacheEntryUsable(entry, TRACK_DETAILS_MAX_AGE_MS)) chrome.storage.local.remove(key).catch(() => {});
    return null;
  } catch {
    return null;
  }
}

// Reads a whole playlist's entries in one storage call: per-item reads cost a
// round trip each, which dominates load time for a large, fully cached cart.
export async function readCacheBatch(urls: string[]): Promise<Map<string, PlaylistTrack[]>> {
  const hits = new Map<string, PlaylistTrack[]>();
  const keyToUrl = new Map(urls.map((url) => [cacheKey(url), url]));
  try {
    const all = await chrome.storage.local.get([...keyToUrl.keys()]);
    const expiredKeys: string[] = [];
    for (const [key, url] of keyToUrl) {
      const entry = all[key] as CacheEntry | undefined;
      if (!entry) continue;
      if (isCacheEntryUsable(entry, TRACK_DETAILS_MAX_AGE_MS)) {
        hits.set(url, entry.tracks);
      } else {
        expiredKeys.push(key);
      }
    }
    if (expiredKeys.length > 0) chrome.storage.local.remove(expiredKeys).catch(() => {});
  } catch {}
  return hits;
}

export function writeCache(url: string, tracks: PlaylistTrack[]): void {
  if (tracks.length === 0) return; // Don't cache parse failures — allow retries.
  const entry: CacheEntry = { tracks, cachedAt: Date.now() };
  chrome.storage.local.set({ [cacheKey(url)]: entry }).catch(() => {});
}

export async function clearTrackCache(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_KEY_PREFIX));
    if (keys.length > 0) await chrome.storage.local.remove(keys);
  } catch {}
}

export interface CacheDump {
  url: string;
  cachedAt: number;
  tracks: PlaylistTrack[];
}

export async function listCacheEntries(): Promise<CacheDump[]> {
  try {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(CACHE_KEY_PREFIX))
      .map((k) => {
        const entry = all[k] as CacheEntry;
        return { url: k.slice(CACHE_KEY_PREFIX.length), cachedAt: entry.cachedAt, tracks: entry.tracks };
      })
      .sort((a, b) => b.cachedAt - a.cachedAt);
  } catch {
    return [];
  }
}
