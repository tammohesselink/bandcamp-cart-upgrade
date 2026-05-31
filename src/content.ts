import type { CartItem, PlaylistTrack } from './types';
import { parseTralbum } from './bandcamp';
import { Player } from './player';

console.log('[bcp] cart player loaded');

main().catch(console.error);

async function main() {
  const cartItems = probeCart();

  console.log('[bcp] Cart items found:');
  console.table(cartItems.map((it) => ({ type: it.type, title: it.title, artist: it.artist, url: it.url })));

  if (cartItems.length === 0) {
    console.warn(
      '[bcp] No cart items detected. The cart may be empty, or the selectors need updating. ' +
        'Open DevTools, inspect the cart item DOM nodes, and update probeCart() in src/content.ts.'
    );
    return;
  }

  const player = new Player([]);
  document.body.appendChild(player.wrapper);
  player.setStatus(`Loading 0 / ${cartItems.length}…`, 'loading');
  document.body.style.paddingBottom = '90px';

  const { tracks: cartTracks, indexMap: cartIndexMap } = await resolvePlaylist(cartItems, (done) => {
    player.setStatus(`Loading ${done} / ${cartItems.length}…`, 'loading');
  });

  if (cartTracks.length === 0) {
    player.setStatus('No playable tracks found', 'error');
    return;
  }

  player.setPlaylist('cart', 'Cart', cartTracks);
  document.body.style.paddingBottom = `${player.wrapper.offsetHeight}px`;
  injectCartPlayButtons(cartIndexMap, player);

  const unplayable = cartTracks.filter((t) => t.unplayable).length;
  if (unplayable > 0) {
    const pct = unplayable / cartTracks.length;
    if (pct >= 0.5) {
      player.setStatus('Log in for full streams', 'warn');
    } else {
      player.setStatus(`${unplayable} track${unplayable > 1 ? 's' : ''} unavailable`, 'warn');
    }
  } else {
    player.setStatus(`${cartTracks.length} tracks (${cartItems.length} releases)`, 'info');
  }

  // After the cart is fully loaded, check for a discography and load it eagerly.
  const discoItems = probeDiscography();
  if (discoItems.length > 0) {
    const discoBtn = injectDiscographyButton();
    console.log('[bcp] Discography releases found:');
    console.table(discoItems.map((it) => ({ type: it.type, url: it.url })));

    const { tracks: discoTracks, indexMap: discoIndexMap } = await resolvePlaylist(discoItems, (done) => {
      discoBtn.textContent = `Loading label discography… ${done} / ${discoItems.length}`;
    });

    if (discoTracks.length > 0) {
      player.setPlaylist('discography', 'Label discography', discoTracks);
      player.setPlaylistStatus('discography', `${discoTracks.length} tracks (${discoItems.length} releases)`, 'info');
      discoBtn.textContent = `Play label discography (${discoTracks.length} tracks, ${discoItems.length} releases)`;
      discoBtn.disabled = false;
      discoBtn.addEventListener('click', () => {
        player.jumpTo('discography', 0);
      });
      injectDiscographyPlayButtons(discoIndexMap, discoItems, player);
    } else {
      discoBtn.textContent = 'No playable discography tracks found';
    }
  }
}

// --- Cart DOM probe -----------------------------------------------------------

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

    const rawTitle = link.textContent?.trim() ?? '';
    const title = rawTitle.replace(/,\s*digital\s+(track|album)$/i, '').trim();

    items.push({ url, type, title, artist: '', thumbnailUrl: '' });
  }

  return items;
}

// --- Discography DOM probe ---------------------------------------------------

function probeDiscography(): CartItem[] {
  if (window.location.pathname !== '/music') return [];

  // Try the standard music grid first; fall back to scanning the whole column.
  const grid = document.getElementById('music-grid');
  const container = grid ?? document.querySelector('.leftMiddleColumns');
  if (!container) return [];

  const seen = new Set<string>();
  const items: CartItem[] = [];

  const selector = 'a[href*="/album/"], a[href*="/track/"]';
  for (const link of Array.from(container.querySelectorAll<HTMLAnchorElement>(selector))) {
    // Resolve relative URLs (Bandcamp grid hrefs are relative: "/album/lateral")
    const url = new URL(link.href, window.location.href).href;

    // Skip in-page section links or hash-only hrefs
    if (!url.match(/\/(album|track)\//)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const typeMatch = url.match(/\/(track|album)\//);
    const type = typeMatch?.[1] === 'album' ? 'album' : 'track';

    const title = link.querySelector('p.title')?.textContent?.trim() ?? link.textContent?.trim() ?? '';

    items.push({ url, type, title, artist: '', thumbnailUrl: '' });
  }

  return items;
}

// --- Discography button injection --------------------------------------------

function injectDiscographyButton(): HTMLButtonElement {
  const grid = document.getElementById('music-grid');
  const container = grid ?? document.querySelector('.leftMiddleColumns');

  const button = document.createElement('button');
  button.className = 'bcp-discography-btn';
  button.textContent = 'Loading label discography…';
  button.disabled = true;

  const target = grid ?? container;
  if (target) {
    target.parentElement?.insertBefore(button, target);
  }

  return button;
}

// --- Fetch + parse -----------------------------------------------------------

const CACHE_KEY_PREFIX = 'bcp_tracks_';
const CACHE_TTL_MS = 60 * 60 * 1000;

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
  chrome.storage.local.set({ [CACHE_KEY_PREFIX + url]: entry }).catch(() => {});
}

async function resolvePlaylist(
  items: CartItem[],
  onProgress: (done: number) => void
): Promise<{ tracks: PlaylistTrack[]; indexMap: Map<string, number> }> {
  const tracks: PlaylistTrack[] = [];
  const indexMap = new Map<string, number>();
  let done = 0;

  for (const item of items) {
    const firstIndex = tracks.length;

    const cached = await readCache(item.url);
    if (cached) {
      console.log('[bcp] Cache hit:', item.url);
      indexMap.set(item.url, firstIndex);
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
        indexMap.set(item.url, firstIndex);
        tracks.push(...parsed);
      }
    } catch (err) {
      console.warn('[bcp] Failed to fetch', item.url, err);
    }
    done++;
    onProgress(done);
  }

  return { tracks, indexMap };
}

function injectCartPlayButtons(indexMap: Map<string, number>, player: Player): void {
  const sidecartBody = document.getElementById('sidecartBody');
  if (!sidecartBody) return;

  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>('a.itemName[href]'))) {
    const index = indexMap.get(link.href);
    if (index === undefined) continue;

    const playBtn = document.createElement('button');
    playBtn.className = 'bcp-cart-play-btn';
    playBtn.textContent = '▶';
    playBtn.title = 'Play in cart player';
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      player.jumpTo('cart', index);
    });

    link.parentElement?.insertBefore(playBtn, link);
  }
}

function injectDiscographyPlayButtons(
  indexMap: Map<string, number>,
  discoItems: CartItem[],
  player: Player
): void {
  for (const item of discoItems) {
    const index = indexMap.get(item.url);
    if (index === undefined) continue;

    // Find the grid <li> whose <a> links to this release URL.
    // Bandcamp uses relative hrefs so we match by pathname.
    const itemPath = new URL(item.url).pathname;
    const li = document.querySelector<HTMLElement>(
      `.music-grid-item a[href="${itemPath}"]`
    )?.closest<HTMLElement>('.music-grid-item');
    if (!li) continue;

    const playBtn = document.createElement('button');
    playBtn.className = 'bcp-grid-play-btn';
    playBtn.textContent = '▶';
    playBtn.title = 'Play in discography player';
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      player.jumpTo('discography', index);
    });

    const titleEl = li.querySelector<HTMLElement>('p.title');
    if (titleEl) {
      titleEl.insertBefore(playBtn, titleEl.firstChild);
    } else {
      li.appendChild(playBtn);
    }
  }
}
