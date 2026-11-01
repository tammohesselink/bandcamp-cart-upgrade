// Pure DOM-probe and injection functions extracted from content.ts so they can
// be unit-tested without importing the full content script (which runs main()
// at module level and has side effects).

import type { CartItem } from './types';

// --- Cart DOM probe -----------------------------------------------------------

export function probeCart(): CartItem[] {
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
  button.className = 'buttonLink bcp-restore-btn';
  button.textContent = `Cart history (${snapshotCount} save${snapshotCount !== 1 ? 's' : ''})`;
  anchor.insertAdjacentElement('afterend', button);
  return button;
}

// Inserted directly below the "Checkout selected" partial-checkout button when
// present (both use insertAdjacentElement('afterend') on the same anchor chain,
// and this one runs after, so it lands below); falls back to the sidecart
// anchor chain so it still appears when the cart is empty.
export function injectCheckoutCartButton(namedCartCount: number): HTMLButtonElement | null {
  const anchor = document.querySelector<HTMLElement>('.bcp-checkout-selected-btn')
    ?? document.getElementById('sidecart')
    ?? document.querySelector('#sidecartReveal')
    ?? document.getElementById('sidecartBody');
  if (!anchor) return null;

  const existing = document.querySelector<HTMLButtonElement>('.bcp-checkout-cart-btn');
  if (existing) {
    existing.textContent = `Checkout a cart (${namedCartCount})`;
    existing.disabled = namedCartCount === 0;
    return existing;
  }

  const button = document.createElement('button');
  button.className = 'bcp-checkout-cart-btn';
  button.textContent = `Checkout a cart (${namedCartCount})`;
  button.disabled = namedCartCount === 0;
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
  button.className = 'buttonLink bcp-remove-owned-btn';
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
    console.warn('[bcp] Could not parse #music-grid data-client-items');
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
