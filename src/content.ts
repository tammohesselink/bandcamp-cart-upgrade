import type { CartItem, PlaylistTrack } from './types';
import { parseTralbum } from './bandcamp';
import { Player } from './player';
import { probeCart, probeDiscography, injectDiscographyButton } from './probe';
import { normalizeUrl } from './url';
import {
  readPageContext,
  SEL_SIDECART_BODY,
  SEL_SIDECART_ITEM_LIST,
  SEL_SIDECART_ITEM_LINK,
  SEL_MUSIC_GRID_ITEM,
  SEL_GRID_ITEM_TITLE,
} from './bandcamp-dom';
import { sendBcpMessage } from './messages';

console.log('[bcp] cart player loaded');

// Bandcamp's sync_num is an optimistic-concurrency counter — each cart mutation
// increments it server-side and returns the new value in cart_data.sync_num.
// We cache the latest known value so subsequent requests don't send a stale 0.
let latestSyncNum: number | null = null;

// Maps normalised cart item URL → purchase type ('track' | 'album').
// Bandcamp's sidecart can link an album purchase to a *track* URL, so URL-path
// detection alone is unreliable. We derive the type from the "digital album" /
// "digital track" suffix in the sidecart link text instead.
let cartItemTypes = new Map<string, 'track' | 'album'>();

// Maps normalised cart item URL → Bandcamp cart line-item id.
// req=del needs this id (assigned when the item entered the cart), not the tralbum id.
// Populated from cart_data.items in cart operation responses.
let cartLineItemIds = new Map<string, number>();

function updateCartLineItemIds(items: Record<string, unknown>[]): void {
  for (const item of items) {
    // cart_data.items shape: { id: <lineItemId>, item_id: <tralbumId>, item_type, url, ... }
    const lineItemId = item.id as number | undefined;
    const itemUrl = item.url as string | undefined;
    if (typeof lineItemId === 'number' && typeof itemUrl === 'string') {
      cartLineItemIds.set(normalizeUrl(itemUrl), lineItemId);
    }
  }
}

function buildCartItemTypes(items: CartItem[]): Map<string, 'track' | 'album'> {
  const map = new Map<string, 'track' | 'album'>();
  for (const item of items) {
    if (item.purchaseType) map.set(normalizeUrl(item.url), item.purchaseType);
  }
  return map;
}

main().catch(console.error);

async function main() {
  const cartItems = probeCart();

  console.log('[bcp] Cart items found:');
  console.table(cartItems.map((it) => ({ type: it.type, title: it.title, artist: it.artist, url: it.url })));

  // Probe discography early so we can show the player on label pages even when
  // the cart is empty.
  const discoItems = probeDiscography();

  if (cartItems.length === 0 && discoItems.length === 0) {
    console.warn(
      '[bcp] No cart items detected. The cart may be empty, or the selectors need updating. ' +
        'Open DevTools, inspect the cart item DOM nodes, and update probeCart() in src/content.ts.'
    );
    return;
  }

  const player = new Player([]);
  document.body.appendChild(player.wrapper);
  document.body.style.paddingBottom = '90px';

  // Build the initial cart URL set and purchase-type map.
  cartItemTypes = buildCartItemTypes(cartItems);
  player.setCartUrls(buildCartUrlSet(cartItems));

  // Wire up cart mutation callbacks.
  player.onCartAdd = async (track, addType) => {
    const tralbumId = addType === 'track' ? track.trackId : track.releaseId;
    const tralbumType = addType === 'track' ? 't' : (track.releaseType === 'track' ? 't' : 'a');

    let minPrice = addType === 'track' ? track.trackMinPrice : track.minPrice;

    // Album pages often omit per-track pricing. Fetch the track's own page to get it.
    if (addType === 'track' && minPrice === null) {
      try {
        const response = await sendBcpMessage({ type: 'fetch', url: track.pageUrl });
        if (!response.error) {
          const parsed = parseTralbum(response.html ?? '', track.pageUrl);
          if (parsed.length > 0 && parsed[0]!.minPrice !== null) {
            minPrice = parsed[0]!.minPrice;
          }
        }
      } catch {
        // proceed with null → background sends unit_price=0
      }
    }

    const ctx = readPageContext(latestSyncNum);
    const result = await sendBcpMessage({
      type: 'cart-add',
      tralbumId,
      tralbumType,
      minPrice,
      bandId: track.bandId,
      releaseUrl: track.releaseUrl,
      syncNum: ctx.syncNum,
      clientId: ctx.clientId,
      fanId: ctx.fanId,
      countryCode: ctx.countryCode,
      cartLength: probeCart().length,
    });
    if (result.ok) {
      updateSyncNum(result.body);
      // Individual track adds use the track page URL in the sidecart;
      // release adds use the album/release URL.
      const cartItemUrl = addType === 'track' ? track.pageUrl : track.releaseUrl;
      player.addCartUrl(cartItemUrl);
      const label = addType === 'track' ? track.trackTitle : (track.albumTitle || track.trackTitle);
      addSidecartItem(cartItemUrl, label, minPrice, addType);
      const tracksToAdd = addType === 'track'
        ? [track]
        : await fetchTracksForUrl(track.releaseUrl).then((r) => r.length > 0 ? r : [track]);
      const startIndex = player.addTracksToPlaylist('cart', tracksToAdd);
      if (startIndex !== null) {
        injectPlayButtonForSidecartItem(cartItemUrl, startIndex, player);
      }
      refreshCartStatus(player);
    } else {
      player.setStatus(`Add failed: ${result.error ?? 'unknown error'}`, 'error');
    }
  };

  player.onCartRemove = async (track, cartItemUrl) => {
    // cartItemUrl tells us what the cart holds: track.pageUrl for individual track
    // purchases, track.releaseUrl for album/release purchases. The tralbumId and
    // type must match what was passed to the original add call.
    // Use the stored purchase type to decide which ID to send.
    // Bandcamp's sidecart can link album purchases to a track URL, so URL matching
    // alone would misclassify them — we trust the "digital album"/"digital track"
    // text that probeCart() (and addSidecartItem) sets in cartItemTypes.
    const storedType = cartItemTypes.get(normalizeUrl(cartItemUrl));
    const isTrackItem = storedType === 'track' ||
      // Fallback for items without stored type: track URL that differs from release URL.
      (storedType === undefined && cartItemUrl === track.pageUrl && track.pageUrl !== track.releaseUrl);
    const tralbumId = isTrackItem ? (track.trackId ?? track.releaseId) : track.releaseId;

    // req=del needs the cart LINE-ITEM id (assigned by Bandcamp when the item entered
    // the cart), not the tralbum/track id. We look it up from cartLineItemIds (populated
    // from cart_data.items in previous responses). If not yet known we fall back to
    // tralbumId for attempt 1 — the resync response then gives us cart_data.items so
    // we can extract the real id for attempt 2.
    let lineItemId: number | null = cartLineItemIds.get(normalizeUrl(cartItemUrl)) ?? null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const idToSend = lineItemId ?? tralbumId;
      const ctx = readPageContext(latestSyncNum);
      const result = await sendBcpMessage({
        type: 'cart-remove',
        tralbumId: idToSend,
        releaseUrl: cartItemUrl,
        syncNum: ctx.syncNum,
        clientId: ctx.clientId,
        fanId: ctx.fanId,
      });
      if (!result.ok) {
        player.setStatus(`Remove failed: ${result.error ?? 'unknown error'}`, 'error');
        return;
      }

      updateSyncNum(result.body);

      // Parse cart_data.items to extract/update line-item IDs for future operations.
      const cartItems = ((result.body as Record<string, unknown> | null)?.cart_data as Record<string, unknown> | null)?.items;
      if (Array.isArray(cartItems)) {
        updateCartLineItemIds(cartItems as Record<string, unknown>[]);
        // Resolve the line-item id for THIS item if we didn't have it yet.
        if (lineItemId === null) {
          lineItemId = cartLineItemIds.get(normalizeUrl(cartItemUrl)) ?? null;
        }
      }

      const resync = (result.body as Record<string, unknown> | null)?.resync;
      if ((resync || lineItemId !== idToSend) && attempt === 0 && lineItemId !== null) {
        // Either stale sync_num or we just learned the real line-item id — retry.
        continue;
      }

      player.removeCartUrl(cartItemUrl);
      if (isTrackItem) {
        player.removeTrackByPageUrl('cart', track.pageUrl);
      } else {
        player.removeTracksByReleaseUrl('cart', track.releaseUrl);
      }
      removeSidecartItem(cartItemUrl);
      refreshCartStatus(player);
      return;
    }

    player.setStatus('Remove failed: could not sync cart state', 'error');
  };

  // Keep cart state in sync when Bandcamp's own JS updates the sidecart.
  const sidecartObserver = watchSidecart(player);

  // Tear down on navigation away: disconnect the observer, stop audio, and
  // remove the injected UI so subsequent pages start clean.
  window.addEventListener('pagehide', () => {
    sidecartObserver?.disconnect();
    player.destroy();
  }, { once: true });

  if (cartItems.length > 0) {
    player.setStatus(`Loading 0 / ${cartItems.length}…`, 'loading');

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
  } else {
    // Cart is empty — show player on label page with a placeholder status.
    // Tracks can still be added from the discography below.
    player.setStatus('Cart is empty', 'info');
  }

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

function buildCartUrlSet(items: CartItem[]): Set<string> {
  return new Set(items.map((i) => normalizeUrl(i.url)));
}

function refreshCartState(player: Player): void {
  const fresh = probeCart();
  cartItemTypes = buildCartItemTypes(fresh);
  player.setCartUrls(buildCartUrlSet(fresh));
}

function refreshCartStatus(player: Player): void {
  const tracks = player.getPlaylistTracks('cart');
  if (tracks.length === 0) return;
  const unplayable = tracks.filter((t) => t.unplayable).length;
  const releaseCount = new Set(tracks.map((t) => t.releaseUrl)).size;
  if (unplayable > 0) {
    const pct = unplayable / tracks.length;
    player.setPlaylistStatus(
      'cart',
      pct >= 0.5 ? 'Log in for full streams' : `${unplayable} track${unplayable > 1 ? 's' : ''} unavailable`,
      'warn'
    );
  } else {
    player.setPlaylistStatus('cart', `${tracks.length} tracks (${releaseCount} releases)`, 'info');
  }
}

function injectPlayButtonForSidecartItem(url: string, index: number, player: Player): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;
  const normalized = normalizeUrl(url);
  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
    if (normalizeUrl(link.href) === normalized) {
      if (link.previousElementSibling?.classList.contains('bcp-cart-play-btn')) return;
      const playBtn = document.createElement('button');
      playBtn.className = 'bcp-cart-play-btn';
      playBtn.textContent = '▶';
      playBtn.title = 'Play in cart player';
      playBtn.addEventListener('click', (e) => {
        e.preventDefault();
        player.jumpTo('cart', index);
      });
      link.parentElement?.insertBefore(playBtn, link);
      break;
    }
  }
}

function addSidecartItem(releaseUrl: string, title: string, price: number | null, addType: 'track' | 'release'): void {
  const target = document.querySelector<HTMLElement>(SEL_SIDECART_ITEM_LIST) ?? document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!target) return;

  const { currency } = readPageContext(latestSyncNum);
  const priceText = price !== null
    ? (currency ? `${price.toFixed(2)} ${currency}` : price.toFixed(2))
    : '';

  const item = document.createElement('div');
  item.className = 'item first';

  const reveal = document.createElement('div');
  reveal.className = 'cartItemReveal reveal';

  const contents = document.createElement('div');
  contents.className = 'cartItemContents';

  const p = document.createElement('p');

  const nameLink = document.createElement('a');
  nameLink.className = 'itemName notSkinnable';
  nameLink.href = releaseUrl;
  nameLink.textContent = `${title}, digital ${addType === 'track' ? 'track' : 'album'}`;
  cartItemTypes.set(normalizeUrl(releaseUrl), addType === 'track' ? 'track' : 'album');

  const priceSpan = document.createElement('span');
  priceSpan.className = 'price';
  priceSpan.textContent = priceText;

  p.append(nameLink, document.createElement('br'), priceSpan);
  contents.appendChild(p);
  reveal.appendChild(contents);
  item.appendChild(reveal);
  withSuppressedObserver(() => target.appendChild(item));
}

function removeSidecartItem(releaseUrl: string): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;
  const normalized = normalizeUrl(releaseUrl);
  cartItemTypes.delete(normalized);
  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
    if (normalizeUrl(link.href) === normalized) {
      // Walk up to the direct child of sidecartBody so we remove the entire item
      // block (title + price rows) even when they are separate siblings inside one
      // wrapper rather than nested under a single <li>.
      let el: Element | null = link;
      while (el && el.parentElement !== sidecartBody) {
        el = el.parentElement;
      }
      withSuppressedObserver(() => el?.remove());
      break;
    }
  }
  // Remove any injected play buttons whose itemName sibling was removed above.
  // Our buttons are always inserted as the immediate previous sibling of a.itemName.
  for (const btn of Array.from(sidecartBody.querySelectorAll<HTMLElement>('.bcp-cart-play-btn'))) {
    if (!btn.nextElementSibling?.classList.contains('itemName')) {
      btn.remove();
    }
  }
}

// Set to true when the extension itself is mutating #sidecartBody (add/remove
// item) so the MutationObserver callback skips the re-probe and avoids a
// feedback loop. Cleared after a tick (macrotask) to ensure the queued
// MutationObserver microtask fires while the flag is still set.
let suppressSidecartObserver = false;

function withSuppressedObserver(fn: () => void): void {
  suppressSidecartObserver = true;
  fn();
  setTimeout(() => { suppressSidecartObserver = false; }, 0);
}

function watchSidecart(player: Player): MutationObserver | null {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return null;
  const observer = new MutationObserver(() => {
    if (suppressSidecartObserver) return;
    refreshCartState(player);
  });
  observer.observe(sidecartBody, { childList: true, subtree: true });
  return observer;
}

function updateSyncNum(responseBody: unknown): void {
  const syncNum = (responseBody as Record<string, unknown> | null)?.cart_data;
  if (syncNum && typeof syncNum === 'object') {
    const n = (syncNum as Record<string, unknown>).sync_num;
    if (typeof n === 'number') latestSyncNum = n;
  }
}


// --- Fetch + parse -----------------------------------------------------------

const CACHE_KEY_PREFIX = 'bcp_tracks_v6_';
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

async function fetchTracksForUrl(url: string): Promise<PlaylistTrack[]> {
  const cached = await readCache(url);
  if (cached) return cached;
  try {
    const response = await sendBcpMessage({ type: 'fetch', url });
    if (!response.error) {
      const parsed = parseTralbum(response.html ?? '', url);
      writeCache(url, parsed);
      return parsed;
    }
  } catch {}
  return [];
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
      const response = await sendBcpMessage({ type: 'fetch', url: item.url });
      if (response.error) {
        console.warn(`[bcp] Fetch error for ${item.url}:`, response.error);
      } else {
        const parsed = parseTralbum(response.html ?? '', item.url);
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
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;

  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
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
      `${SEL_MUSIC_GRID_ITEM} a[href="${CSS.escape(itemPath)}"]`
    )?.closest<HTMLElement>(SEL_MUSIC_GRID_ITEM);
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

    const titleEl = li.querySelector<HTMLElement>(SEL_GRID_ITEM_TITLE);
    if (titleEl) {
      titleEl.insertBefore(playBtn, titleEl.firstChild);
    } else {
      li.appendChild(playBtn);
    }
  }
}
