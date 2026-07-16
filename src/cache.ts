import type { PlaylistTrack } from './types';
import { normalizeUrl } from './url';

// Shared track-metadata cache — imported by both the content script and the
// background service worker, since the resumable loader (background) and the
// incognito/one-off resolvers (content) both need warm-cache reads.

export const CACHE_KEY_PREFIX = 'bcp_tracks_v7_';
export const CACHE_TTL_MS = 60 * 60 * 1000;

export interface CacheEntry {
  tracks: PlaylistTrack[];
  cachedAt: number;
}

export async function readCache(url: string): Promise<PlaylistTrack[] | null> {
  try {
    const key = CACHE_KEY_PREFIX + normalizeUrl(url);
    const result = await chrome.storage.local.get(key);
    const entry = result[key] as CacheEntry | undefined;
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      chrome.storage.local.remove(key);
      return null;
    }
    // Treat cached empty arrays as misses so transient parse failures don't
    // permanently block resolution on subsequent calls.
    if (entry.tracks.length === 0) {
      chrome.storage.local.remove(key);
      return null;
    }
    return entry.tracks;
  } catch {
    return null;
  }
}

export function writeCache(url: string, tracks: PlaylistTrack[]): void {
  if (tracks.length === 0) return; // Don't cache parse failures — allow retries.
  const entry: CacheEntry = { tracks, cachedAt: Date.now() };
  chrome.storage.local.set({ [CACHE_KEY_PREFIX + normalizeUrl(url)]: entry }).catch(() => {});
}

// Bulk cache lookup for playlist resolution — one chrome.storage.local.get() round trip
// for the whole cart/discography instead of one per item, since per-call IPC overhead
// otherwise dominates wall time even when every item is a hit.
export async function readCacheBatch(urls: string[]): Promise<Map<string, PlaylistTrack[]>> {
  const hits = new Map<string, PlaylistTrack[]>();
  const keyToUrl = new Map<string, string>();
  for (const url of urls) {
    keyToUrl.set(CACHE_KEY_PREFIX + normalizeUrl(url), url);
  }
  try {
    const all = await chrome.storage.local.get([...keyToUrl.keys()]);
    const staleKeys: string[] = [];
    for (const [key, url] of keyToUrl) {
      const entry = all[key] as CacheEntry | undefined;
      if (!entry) continue;
      if (Date.now() - entry.cachedAt > CACHE_TTL_MS || entry.tracks.length === 0) {
        staleKeys.push(key);
        continue;
      }
      hits.set(url, entry.tracks);
    }
    if (staleKeys.length > 0) chrome.storage.local.remove(staleKeys).catch(() => {});
  } catch {}
  return hits;
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
