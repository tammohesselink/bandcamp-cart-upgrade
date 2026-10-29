import type { PlaylistTrack } from './types';
import { normalizeUrl } from './url';

export const CACHE_KEY_PREFIX = 'bcp_tracks_v7_';

// Titles, IDs, artwork and durations rarely change.
export const TRACK_DETAILS_MAX_AGE_MS = 182 * 24 * 60 * 60 * 1000;

// Stream links expire and prices can change, so playback and cart adds only
// trust data fetched within this window.
export const LIVE_DATA_MAX_AGE_MS = 60 * 60 * 1000;

// A release page without tracks (merch, or nothing uploaded yet) is cached as
// an empty entry so it isn't refetched on every load, but rechecked weekly in
// case tracks are added.
export const NO_TRACKS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CacheEntry {
  tracks: PlaylistTrack[];
  cachedAt: number;
}

export function isCacheEntryUsable(entry: CacheEntry, maxAgeMs: number, now = Date.now()): boolean {
  const maxAge = entry.tracks.length === 0 ? Math.min(maxAgeMs, NO_TRACKS_MAX_AGE_MS) : maxAgeMs;
  return now - entry.cachedAt <= maxAge;
}

// Unplayable tracks can become playable (a pre-order is released, or the user
// logs in), so a release with any is rechecked once it is older than an hour.
export function needsPlayabilityRecheck(entry: CacheEntry, now = Date.now()): boolean {
  return entry.tracks.some((t) => t.unplayable) && now - entry.cachedAt > LIVE_DATA_MAX_AGE_MS;
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
export async function readCacheBatch(urls: string[]): Promise<Map<string, CacheEntry>> {
  const hits = new Map<string, CacheEntry>();
  const keyToUrl = new Map(urls.map((url) => [cacheKey(url), url]));
  try {
    const all = await chrome.storage.local.get([...keyToUrl.keys()]);
    const expiredKeys: string[] = [];
    for (const [key, url] of keyToUrl) {
      const entry = all[key] as CacheEntry | undefined;
      if (!entry) continue;
      if (isCacheEntryUsable(entry, TRACK_DETAILS_MAX_AGE_MS)) {
        hits.set(url, entry);
      } else {
        expiredKeys.push(key);
      }
    }
    if (expiredKeys.length > 0) chrome.storage.local.remove(expiredKeys).catch(() => {});
  } catch {}
  return hits;
}

// An empty `tracks` records a release page that has no tracks. Callers must
// not write one for a page that failed to parse, or it would not be retried.
export function writeCache(url: string, tracks: PlaylistTrack[]): void {
  const entry: CacheEntry = { tracks, cachedAt: Date.now() };
  chrome.storage.local.set({ [cacheKey(url)]: entry }).catch(() => {});
}

// Removes expired entries and entries from older cache versions. Entries are
// otherwise only dropped when read, and a label page visited once never is.
export async function pruneTrackCache(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => {
      if (!key.startsWith('bcp_tracks_')) return false;
      if (!key.startsWith(CACHE_KEY_PREFIX)) return true;
      return !isCacheEntryUsable(all[key] as CacheEntry, TRACK_DETAILS_MAX_AGE_MS);
    });
    if (keys.length > 0) await chrome.storage.local.remove(keys);
  } catch {}
}
