// Pure DOM-probe and injection functions extracted from content.ts so they can
// be unit-tested without importing the full content script (which runs main()
// at module level and has side effects).

import type { CartItem, PlaylistTrack } from './types';
import { normalizeUrl } from './url';
import { log } from './log';
import {
  SEL_COLLECTION_ITEMS,
  SEL_COLLECTION_ITEM,
  SEL_COLLECTION_ITEM_LINK,
  SEL_COLLECTION_ITEM_TITLE,
  SEL_COLLECTION_ITEM_ARTIST,
} from './bandcamp-dom';

// --- Cart DOM probe -----------------------------------------------------------

export function probeCart(): CartItem[] {
  const sidecartBody = document.getElementById('sidecartBody');
  if (!sidecartBody) {
    log.warn('[bcp] #sidecartBody not found — cart may be empty or DOM changed');
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
    const purchaseTypeMatch = rawTitle.match(/,\s*digital\s+(track|album)$/i);
    const purchaseType: 'track' | 'album' | undefined =
      purchaseTypeMatch?.[1]?.toLowerCase() === 'album' ? 'album' :
      purchaseTypeMatch?.[1]?.toLowerCase() === 'track' ? 'track' :
      undefined;
    const title = rawTitle.replace(/,\s*digital\s+(track|album)$/i, '').trim();

    items.push({ url, type, title, artist: '', thumbnailUrl: '', purchaseType });
  }

  return items;
}

// --- [data-cart] JSON attribute reader ---------------------------------------
// Bandcamp embeds the full cart state as JSON in a [data-cart] attribute on
// checkout/cart pages. Returns raw parsed items; callers should treat the shape
// as opaque since it may vary across page types.

export interface DataCartItem {
  item_id: number;
  item_type: 'a' | 't';
  item_title: string;
  band_name: string;
  unit_price: number;
  currency: string;
  url: string;
}

export function readDataCart(): DataCartItem[] {
  const el = document.querySelector('[data-cart]');
  if (!el) return [];
  try {
    const raw = JSON.parse(el.getAttribute('data-cart')!);
    const items = raw?.items;
    if (!Array.isArray(items) || items.length === 0) return [];
    const result: DataCartItem[] = [];
    for (const item of items) {
      if (typeof item.item_id !== 'number') continue;
      if (item.item_type !== 'a' && item.item_type !== 't') continue;
      result.push({
        item_id: item.item_id,
        item_type: item.item_type as 'a' | 't',
        item_title: typeof item.item_title === 'string' ? item.item_title : '',
        band_name: typeof item.band_name === 'string' ? item.band_name : '',
        unit_price: typeof item.unit_price === 'number' ? item.unit_price : 0,
        currency: typeof item.currency === 'string' ? item.currency : '',
        url: typeof item.url === 'string' ? item.url : '',
      });
    }
    return result;
  } catch {
    return [];
  }
}

// --- Restore cart button injection -------------------------------------------

export function injectRestoreCartButton(snapshotCount: number): HTMLButtonElement | null {
  const anchor = document.getElementById('sidecart')
    ?? document.querySelector('#sidecartReveal')
    ?? document.getElementById('sidecartBody');
  if (!anchor) return null;

  const existing = document.querySelector<HTMLButtonElement>('.bcp-restore-btn');
  if (existing) return existing;

  const button = document.createElement('button');
  button.className = 'bcp-restore-btn';
  button.textContent = `Cart history (${snapshotCount} save${snapshotCount !== 1 ? 's' : ''})`;
  anchor.insertAdjacentElement('afterend', button);
  return button;
}

// Inserted directly below the "Checkout selected" partial-checkout button when
// present (both use insertAdjacentElement('afterend') on the same anchor chain,
// and this one runs after, so it lands below); falls back to the sidecart
// anchor chain so it still appears when the cart is empty. Hidden while named
// carts are off or there are none to check out, to keep the sidecart
// uncluttered.
export function injectCheckoutCartButton(namedCartCount: number, enabled: boolean): HTMLButtonElement | null {
  const anchor = document.querySelector<HTMLElement>('.bcp-checkout-selected-btn')
    ?? document.getElementById('sidecart')
    ?? document.querySelector('#sidecartReveal')
    ?? document.getElementById('sidecartBody');
  if (!anchor) return null;

  const existing = document.querySelector<HTMLButtonElement>('.bcp-checkout-cart-btn');
  if (existing) {
    existing.textContent = `Checkout a cart (${namedCartCount})`;
    existing.hidden = !enabled || namedCartCount === 0;
    return existing;
  }

  const button = document.createElement('button');
  button.className = 'bcp-checkout-cart-btn';
  button.textContent = `Checkout a cart (${namedCartCount})`;
  button.hidden = !enabled || namedCartCount === 0;
  anchor.insertAdjacentElement('afterend', button);
  return button;
}

// Always-available button that lets the fan check the cart against Bandcamp's
// own ownership state. Covers items bought through a private-window checkout,
// whether the extension opened it or the fan checked out the same cart in a
// separate anonymous/incognito window themselves.
export function injectRemoveAlreadyOwnedButton(): HTMLButtonElement | null {
  const anchor = document.getElementById('sidecart')
    ?? document.querySelector('#sidecartReveal')
    ?? document.getElementById('sidecartBody');
  if (!anchor) return null;

  const existing = document.querySelector<HTMLButtonElement>('.bcp-remove-owned-btn');
  if (existing) return existing;

  const button = document.createElement('button');
  button.className = 'bcp-remove-owned-btn';
  button.textContent = 'Remove purchased items from cart';
  anchor.insertAdjacentElement('afterend', button);
  return button;
}


// --- Discography DOM probe ---------------------------------------------------

export function probeDiscography(): CartItem[] {
  if (window.location.pathname !== '/music' && window.location.pathname !== '/') return [];

  // When a featured grid is present alongside #music-grid, scan the whole
  // column so both grids are included. Otherwise prefer #music-grid for
  // precision, falling back to the full column.
  const featuredGrid = document.querySelector('ol.featured-grid');
  const grid = document.getElementById('music-grid');
  const container = featuredGrid
    ? document.querySelector('.leftMiddleColumns')
    : (grid ?? document.querySelector('.leftMiddleColumns'));
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

  // Bandcamp only draws the first releases of a big label; the rest sit in
  // #music-grid's data-client-items and are drawn as the page scrolls.
  // Compared without the query string, which drawn links can carry (?label=…).
  const releaseKey = (url: string) => {
    const { origin, pathname } = new URL(url);
    return origin + pathname;
  };
  const drawn = new Set(items.map((item) => releaseKey(item.url)));
  for (const item of readGridClientItems()) {
    if (drawn.has(releaseKey(item.url))) continue;
    drawn.add(releaseKey(item.url));
    items.push(item);
  }

  return items;
}

function readGridClientItems(): CartItem[] {
  const raw = document.getElementById('music-grid')?.getAttribute('data-client-items');
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('[bcp] Could not parse #music-grid data-client-items');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: CartItem[] = [];
  for (const entry of parsed as Record<string, unknown>[]) {
    if (typeof entry?.page_url !== 'string') continue;
    // Resolved like the drawn links are, against the document.
    const url = new URL(entry.page_url, document.baseURI).href;
    const typeMatch = url.match(/\/(track|album)\//);
    if (!typeMatch) continue;
    items.push({
      url,
      type: typeMatch[1] === 'album' ? 'album' : 'track',
      title: typeof entry.title === 'string' ? entry.title : '',
      artist: typeof entry.artist === 'string' ? entry.artist : '',
      thumbnailUrl: '',
    });
  }
  return items;
}

// --- Collection DOM probe ----------------------------------------------------

// The items drawn in a fan's collection grid, in page order. Only what is on
// the page: the rest of a big collection is drawn as the fan asks for more.
export function probeCollection(): CartItem[] {
  const container = document.querySelector(SEL_COLLECTION_ITEMS);
  if (!container) return [];

  const seen = new Set<string>();
  const items: CartItem[] = [];
  for (const li of Array.from(container.querySelectorAll<HTMLElement>(SEL_COLLECTION_ITEM))) {
    const item = readCollectionItem(li);
    if (!item || seen.has(collectionItemKey(item))) continue;
    seen.add(collectionItemKey(item));
    items.push(item);
  }
  return items;
}

// One collection grid item, or null when it links to no release. `type` is what
// the fan bought: a track bought on its own links to its album, so it is told
// apart by its tralbumId, the track's id.
export function readCollectionItem(li: Element): CartItem | null {
  const link = li.querySelector<HTMLAnchorElement>(SEL_COLLECTION_ITEM_LINK);
  if (!link) return null;
  const url = new URL(link.href, window.location.href).href;
  if (!/\/(track|album)\//.test(url)) return null;

  const tralbumType = li.getAttribute('data-tralbumtype') === 't' ? 't' : 'a';
  const tralbumId = parseInt(li.getAttribute('data-tralbumid') ?? '', 10);
  // The title also holds a hidden "(gift given)" label, so only its own text is read.
  const titleEl = li.querySelector(SEL_COLLECTION_ITEM_TITLE);
  const title = Array.from(titleEl?.childNodes ?? [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join('')
    .trim();
  const artist = (li.querySelector(SEL_COLLECTION_ITEM_ARTIST)?.textContent ?? '').trim().replace(/^by\s+/, '');
  return {
    url,
    type: tralbumType === 't' ? 'track' : 'album',
    title,
    artist,
    thumbnailUrl: '',
    tralbumId: isNaN(tralbumId) ? undefined : tralbumId,
    tralbumType,
  };
}

// Tells collection items apart: several tracks bought on their own from one
// album all link to that album.
export function collectionItemKey(item: CartItem): string {
  const url = normalizeUrl(item.url);
  return item.type === 'track' && item.tralbumId !== undefined ? `${url}#track=${item.tralbumId}` : url;
}

// What a collection item plays, out of the tracks of the release it links to:
// a track bought on its own plays just that track. When the track can't be
// found there, the whole release plays rather than nothing.
export function collectionItemTracks(item: CartItem, releaseTracks: PlaylistTrack[]): PlaylistTrack[] {
  if (item.type !== 'track') return releaseTracks;
  const bought = releaseTracks.filter((track) => track.trackId === item.tralbumId);
  return bought.length > 0 ? bought : releaseTracks;
}

// --- Discography button injection --------------------------------------------

export function injectDiscographyButton(): HTMLButtonElement {
  const grid = document.getElementById('music-grid');
  const container = grid ?? document.querySelector('.leftMiddleColumns');

  const button = document.createElement('button');
  button.className = 'bcp-discography-btn';
  button.textContent = 'Play label discography';

  const featuredGrid = document.querySelector('ol.featured-grid');
  const target = featuredGrid ?? grid ?? container;
  if (target) {
    target.parentElement?.insertBefore(button, target);
  }

  return button;
}
