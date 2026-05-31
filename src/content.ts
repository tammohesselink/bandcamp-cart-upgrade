import type { CartItem, PlaylistTrack } from './types';
import { parseTralbum } from './bandcamp';
import { Player } from './player';

console.log('[bcp] cart player loaded');

main().catch(console.error);

async function main() {
  const cartItems = probeCart();

  // Step 2: Always log the probe output so selectors can be validated.
  // If the table is empty, the cart DOM selectors likely need adjustment.
  console.log('[bcp] Cart items found:');
  console.table(cartItems.map((it) => ({ type: it.type, title: it.title, artist: it.artist, url: it.url })));

  if (cartItems.length === 0) {
    console.warn(
      '[bcp] No cart items detected. The cart may be empty, or the selectors need updating. ' +
        'Open DevTools, inspect the cart item DOM nodes, and update probeCart() in src/content.ts.'
    );
    return;
  }

  // Inject player in loading state immediately so the user gets visual feedback
  const player = new Player([]);
  document.body.appendChild(player.wrapper);
  player.setStatus(`Loading 0 / ${cartItems.length}…`, 'loading');

  // Pad the page bottom so the player doesn't overlap content (placeholder until loaded)
  document.body.style.paddingBottom = '90px';

  const { tracks: playlist, cartIndexMap } = await resolvePlaylist(cartItems, (done) => {
    player.setStatus(`Loading ${done} / ${cartItems.length}…`, 'loading');
  });

  if (playlist.length === 0) {
    player.setStatus('No playable tracks found', 'error');
    return;
  }

  const unplayable = playlist.filter((t) => t.unplayable).length;

  // Replace the empty player with a fully loaded one
  player.wrapper.remove();
  const loaded = new Player(playlist);
  document.body.appendChild(loaded.wrapper);
  document.body.style.paddingBottom = `${loaded.wrapper.offsetHeight}px`;
  injectCartPlayButtons(cartIndexMap, loaded);

  if (unplayable > 0) {
    const pct = unplayable / playlist.length;
    if (pct >= 0.5) {
      loaded.setStatus('Log in for full streams', 'warn');
    } else {
      loaded.setStatus(`${unplayable} track${unplayable > 1 ? 's' : ''} unavailable`, 'warn');
    }
  } else {
    loaded.setStatus(`${playlist.length} tracks`, 'info');
  }
}

// --- Step 2: Cart DOM probe -----------------------------------------------
//
// Reads cart items exclusively from #sidecartBody, which Bandcamp renders on
// track/album pages. Each item has an `a.itemName` link pointing to the track
// or album URL — everything else on the page (discography, recommendations,
// etc.) is ignored.

function probeCart(): CartItem[] {
  const sidecartBody = document.getElementById('sidecartBody');
  if (!sidecartBody) {
    console.warn('[bcp] #sidecartBody not found — cart may be empty or DOM changed');
    return [];
  }

  const seen = new Set<string>();
  const items: CartItem[] = [];

  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>('a.itemName[href]'))) {
    const url = link.href;
    if (seen.has(url)) continue;
    seen.add(url);

    const typeMatch = url.match(/\/(track|album)\//);
    const type =
      typeMatch?.[1] === 'album' ? 'album' :
      typeMatch?.[1] === 'track' ? 'track' :
      'unknown';

    // Link text is "Track Title, digital track" — strip the suffix for display
    const rawTitle = link.textContent?.trim() ?? '';
    const title = rawTitle.replace(/,\s*digital\s+(track|album)$/i, '').trim();

    items.push({ url, type, title, artist: '', thumbnailUrl: '' });
  }

  return items;
}

// --- Step 4: Fetch + parse --------------------------------------------------

const CACHE_KEY_PREFIX = 'bcp_tracks_';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — Bandcamp stream URLs expire

interface CacheEntry {
  tracks: PlaylistTrack[];
  cachedAt: number;
}

async function readCache(url: string): Promise<PlaylistTrack[] | null> {
  try {
    const key = CACHE_KEY_PREFIX + url;
    const result = await chrome.storage.local.get(key);
    const entry = result[key] as CacheEntry | undefined;
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      chrome.storage.local.remove(key);
      return null;
    }
    return entry.tracks;
  } catch {
    return null;
  }
}

function writeCache(url: string, tracks: PlaylistTrack[]): void {
  const entry: CacheEntry = { tracks, cachedAt: Date.now() };
  chrome.storage.local.set({ [CACHE_KEY_PREFIX + url]: entry }).catch(() => {
    // silently skip if storage is unavailable
  });
}

async function resolvePlaylist(
  items: CartItem[],
  onProgress: (done: number) => void
): Promise<{ tracks: PlaylistTrack[]; cartIndexMap: Map<string, number> }> {
  const tracks: PlaylistTrack[] = [];
  const cartIndexMap = new Map<string, number>();
  let done = 0;

  for (const item of items) {
    const firstIndex = tracks.length;

    const cached = await readCache(item.url);
    if (cached) {
      console.log('[bcp] Cache hit:', item.url);
      cartIndexMap.set(item.url, firstIndex);
      tracks.push(...cached);
      done++;
      onProgress(done);
      continue;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'fetch', url: item.url });
      if (response.error) {
        console.warn(`[bcp] Fetch error for ${item.url}:`, response.error);
      } else {
        const parsed = parseTralbum(response.html as string, item.url);
        if (parsed.length === 0) {
          console.warn('[bcp] No tracks parsed from', item.url);
        }
        writeCache(item.url, parsed);
        cartIndexMap.set(item.url, firstIndex);
        tracks.push(...parsed);
      }
    } catch (err) {
      console.warn('[bcp] Failed to fetch', item.url, err);
    }
    done++;
    onProgress(done);
  }

  return { tracks, cartIndexMap };
}

function injectCartPlayButtons(cartIndexMap: Map<string, number>, player: Player): void {
  const sidecartBody = document.getElementById('sidecartBody');
  if (!sidecartBody) return;

  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>('a.itemName[href]'))) {
    const index = cartIndexMap.get(link.href);
    if (index === undefined) continue;

    const playBtn = document.createElement('button');
    playBtn.className = 'bcp-cart-play-btn';
    playBtn.textContent = '▶';
    playBtn.title = 'Play in cart player';
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      player.jumpTo(index);
    });

    link.parentElement?.insertBefore(playBtn, link);
  }
}
