// Centralised catalogue of Bandcamp DOM selectors. Keeping them here means a
// single diff when Bandcamp changes their markup, rather than hunting across
// multiple source files.

import { log } from './log';

// Native track/album page player
export const SEL_NATIVE_PLAYER      = '.inline_player';
export const SEL_NATIVE_PLAY_BUTTON = '.inline_player .playbutton';
export const SEL_NATIVE_TRACK_TABLE = '#track_table';
export const SEL_NATIVE_TRACK_ROW   = 'tr.track_row_view';
export const SEL_NATIVE_ROW_PLAY    = '.play_col, .play_status';
// The "buy track" link a row shows on hover, to the track page's buy dialog.
export const SEL_NATIVE_ROW_BUY_TRACK = '.dl_link a[href]';

export function isTrackOrAlbumPage(): boolean {
  return /^\/(track|album)\//.test(location.pathname);
}

// Cart sidebar
export const SEL_SIDECART_BODY = '#sidecartBody';
export const SEL_SIDECART_ITEM_LIST = '#item_list';
export const SEL_SIDECART_ITEM = '.item';
export const SEL_SIDECART_ITEM_LINK = 'a.itemName[href]';

// Discography grid (label pages)
export const SEL_MUSIC_GRID = '#music-grid';
export const SEL_LEFT_MIDDLE_COLUMNS = '.leftMiddleColumns';
export const SEL_MUSIC_GRID_ITEM = '.music-grid-item';
export const SEL_GRID_ITEM_TITLE = 'p.title';
export const SEL_FEATURED_GRID = 'ol.featured-grid';

// A grid of releases on a fan's pages, each item with artwork that plays its
// featured track in Bandcamp's own player.
export interface ReleaseGrid {
  // Holds the items; other grids on the page sit outside it.
  container: string;
  item: string;
  link: string;
  title: string;
  artist: string;
}

// The artwork, which plays the item's featured track in Bandcamp's player.
export const SEL_RELEASE_GRID_ITEM_PLAY = '.track_play_auxiliary';

// Fan collection and wishlist grids (bandcamp.com/<username> and
// bandcamp.com/<username>/wishlist). Both draw their items the same way. Search
// results sit in grids of their own, outside these.
export const COLLECTION_GRID: ReleaseGrid = {
  container: '#collection-items',
  item: 'li.collection-item-container',
  link: '.collection-title-details a.item-link[href]',
  title: '.collection-title-details .collection-item-title',
  artist: '.collection-title-details .collection-item-artist',
};
export const WISHLIST_GRID: ReleaseGrid = { ...COLLECTION_GRID, container: '#wishlist-items' };
export const SEL_COLLECTION_PLAYER = '#collection-player';

// Fan feed (bandcamp.com/<username>/feed), "Fan Activity": a story per new
// release or purchase. Stories of a fan buying several releases have no
// artwork to play, and no item container.
export const FEED_STORIES_GRID: ReleaseGrid = {
  container: '#story-list',
  item: '.story-innards.collection-item-container',
  link: '.tralbum-details a.item-link[href]',
  title: '.tralbum-details .collection-item-title',
  artist: '.tralbum-details .collection-item-artist',
};

// Fan feed sidebar, "New Releases from artists you follow".
export const FEED_NEW_RELEASES_GRID: ReleaseGrid = {
  container: '#new-releases-vm',
  item: 'li.collection-item-container',
  link: '.collection-item-gallery-container a.item-link[href]',
  title: '.collection-item-gallery-container .collection-item-title',
  artist: '.collection-item-gallery-container .collection-item-artist',
};

// Page context data attributes
export const SEL_DATA_SYNC_NUM = '[data-sync-num]';
export const SEL_DATA_BLOB = '[data-blob]';
export const SEL_DATA_FAN_ID = '[data-fan-id]';

// Regexes for script-tag scraping (matched against inline <script> text content)
const RE_SYNC_NUM = /"?sync_num"?\s*:\s*(\d+)/;
const RE_CLIENT_ID = /"?client_id"?\s*:\s*"([^"]*)"/;
const RE_CURRENCY = /"?currency"?\s*:\s*"([A-Z]{3})"/;
const RE_FAN_ID_DIRECT = /"?fan_id"?\s*:\s*(\d+)/;
const RE_FAN_ID_NESTED = /"fan"\s*:\s*\{[^}]*?"id"\s*:\s*(\d+)/;
const RE_COUNTRY_CODE = /"?ip_country_code"?\s*:\s*"([A-Z]{2})"/;

export interface BandcampPageContext {
  syncNum: number;
  clientId: string;
  currency: string;
  fanId: string;
  countryCode: string;
}

/**
 * Reads auth/state values from Bandcamp's inline scripts and data attributes in
 * a single DOM pass. Returns zeros/empty strings for any value not found, and
 * logs a single warning (in development) listing which fields are missing,
 * unless `warn` is false.
 */
export function readPageContext(latestSyncNum: number | null, { warn = true } = {}): BandcampPageContext {
  let syncNum: number | null = latestSyncNum;
  let clientId = '';
  let currency = '';
  let fanId = '';
  let countryCode = '';

  const scripts = Array.from(document.querySelectorAll('script'));
  for (const script of scripts) {
    const text = script.textContent ?? '';

    if (syncNum === null) {
      const m = text.match(RE_SYNC_NUM);
      if (m) syncNum = parseInt(m[1]!, 10);
    }
    if (!clientId) {
      const m = text.match(RE_CLIENT_ID);
      if (m?.[1]) clientId = m[1];
    }
    if (!currency) {
      const m = text.match(RE_CURRENCY);
      if (m?.[1]) currency = m[1];
    }
    if (!fanId) {
      const m = text.match(RE_FAN_ID_DIRECT);
      if (m?.[1]) fanId = m[1];
      if (!fanId) {
        const m2 = text.match(RE_FAN_ID_NESTED);
        if (m2?.[1]) fanId = m2[1];
      }
    }
    if (!countryCode) {
      const m = text.match(RE_COUNTRY_CODE);
      if (m?.[1]) countryCode = m[1];
    }

    if (syncNum !== null && clientId && currency && fanId && countryCode) break;
  }

  // data-sync-num attribute fallback
  if (syncNum === null) {
    const el = document.querySelector(SEL_DATA_SYNC_NUM);
    if (el) {
      const n = parseInt(el.getAttribute('data-sync-num') ?? '', 10);
      if (!isNaN(n)) syncNum = n;
    }
  }

  // data-blob fallback for fan_id
  if (!fanId) {
    for (const el of Array.from(document.querySelectorAll(SEL_DATA_BLOB))) {
      try {
        const blob = JSON.parse(el.getAttribute('data-blob')!) as Record<string, unknown>;
        if (typeof blob.fan_id === 'number') { fanId = String(blob.fan_id); break; }
        const fan = (blob.fan ?? (blob.identities as Record<string, unknown> | undefined)?.fan) as
          Record<string, unknown> | undefined;
        if (typeof fan?.id === 'number') { fanId = String(fan.id); break; }
      } catch { /* continue */ }
    }
  }

  // data-fan-id attribute fallback
  if (!fanId) {
    const el = document.querySelector(SEL_DATA_FAN_ID);
    if (el) fanId = el.getAttribute('data-fan-id') ?? '';
  }

  const missing: string[] = [];
  if (syncNum === null) missing.push('sync_num');
  if (!clientId) missing.push('client_id');
  if (!fanId) missing.push('fan_id');
  if (warn && missing.length > 0) {
    log.warn(
      `[bcp] Could not find ${missing.join(', ')} in page. ` +
        'Cart mutations may fail. Bandcamp may have changed their page format.'
    );
  }

  return { syncNum: syncNum ?? 0, clientId, currency, fanId, countryCode };
}

/**
 * The whole sidecart entry (title and price rows) holding `link`: its `.item`
 * ancestor inside #sidecartBody, the class Bandcamp's entries carry and
 * addSidecartItem copies. Matching the entry itself, rather than walking up to
 * a container's child, keeps a wrapper around the entries (Bandcamp's
 * #item_list, or any other) from being taken for one entry and removed with all
 * of them. Null when there is no such entry, so nothing is removed.
 */
export function sidecartItemFor(link: HTMLAnchorElement): Element | null {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody?.contains(link)) return null;
  const item = link.closest(SEL_SIDECART_ITEM);
  return item && item !== sidecartBody && sidecartBody.contains(item) ? item : null;
}

// --- Checkout navigation ------------------------------------------------------

/**
 * Finds Bandcamp's native checkout control within the sidecart. Searches for
 * known selectors first; falls back to text-content matching so Bandcamp
 * markup changes only need to be fixed here.
 *
 * NOTE: The exact class/id must be verified against the live Bandcamp DOM —
 * update the known-selectors list below as it becomes available.
 */
export function findCheckoutControl(): HTMLElement | null {
  const containers = [
    document.getElementById('sidecart'),
    document.querySelector<HTMLElement>('#sidecartReveal'),
    document.getElementById('sidecartBody'),
  ].filter((e): e is HTMLElement => e !== null);

  for (const container of containers) {
    // Known selectors (extend as Bandcamp's markup becomes confirmed)
    const known = container.querySelector<HTMLElement>(
      '.checkout-link, a.checkout, button.checkout, #checkout-button, [data-checkout]'
    );
    if (known) return known;

    // Text-content fallback
    for (const candidate of Array.from(container.querySelectorAll<HTMLElement>('a, button'))) {
      if (/check\s?out/i.test(candidate.textContent ?? '')) return candidate;
    }
  }
  return null;
}

/**
 * Clicks Bandcamp's native checkout control to navigate to checkout in the
 * same tab. Returns true if the control was found and clicked.
 */
export function clickCheckout(): boolean {
  const control = findCheckoutControl();
  if (!control) return false;
  control.click();
  return true;
}

/**
 * Returns true when the current page is Bandcamp's checkout or payment flow,
 * so the pending-restore auto-re-add does not fire mid-checkout.
 *
 * NOTE: Verify the exact checkout URL/host against the live site; the patterns
 * below cover the most common forms observed in the wild.
 */
export function isCheckoutPage(): boolean {
  return (
    location.hostname === 'checkout.bandcamp.com' ||
    /^\/(checkout|payment|cart\/checkout)(\/?$|\/)/i.test(location.pathname)
  );
}

// Bandcamp lists the signed-in fan under identities.fan in the page's data
// blob; it is null when logged out. Unknown counts as logged out.
export function isLoggedIn(): boolean {
  for (const el of Array.from(document.querySelectorAll(SEL_DATA_BLOB))) {
    try {
      const blob = JSON.parse(el.getAttribute('data-blob')!) as { identities?: { fan?: unknown } };
      if (blob.identities) return !!blob.identities.fan;
    } catch { /* continue */ }
  }
  return false;
}

// The logged-in fan's id on their own fan page (bandcamp.com/<username>), or
// null on someone else's page or when logged out. Read from the page's
// data-blob, whose fan_data describes the page's fan.
export function readOwnFanPageFanId(): string | null {
  for (const el of Array.from(document.querySelectorAll(SEL_DATA_BLOB))) {
    try {
      const blob = JSON.parse(el.getAttribute('data-blob')!) as Record<string, unknown>;
      const fanData = blob.fan_data as Record<string, unknown> | undefined;
      if (!fanData) continue;
      const fanId = fanData.fan_id;
      const viewer = (blob.identities as Record<string, unknown> | undefined)?.fan as Record<string, unknown> | undefined;
      const isOwnPage = fanData.is_own_page === true || (typeof viewer?.id === 'number' && viewer.id === fanId);
      return isOwnPage && typeof fanId === 'number' ? String(fanId) : null;
    } catch { /* continue */ }
  }
  return null;
}

// The crumb Bandcamp gives the page for one of its endpoints, such as
// uncollect_item_cb, or null when the page has none.
export function readPageCrumb(endpoint: string): string | null {
  const el = document.querySelector('#js-crumbs-data');
  try {
    const crumbs = JSON.parse(el?.getAttribute('data-crumbs') ?? '{}') as Record<string, unknown>;
    const crumb = crumbs[endpoint];
    return typeof crumb === 'string' ? crumb : null;
  } catch {
    return null;
  }
}

// The purchases page, bandcamp.com/<username>/purchases, with its order list.
export function isPurchasesPage(): boolean {
  return location.hostname === 'bandcamp.com'
    && /^\/[^/]+\/purchases\/?$/.test(location.pathname)
    && document.querySelector('.purchases') !== null;
}

// The logged-in fan's username and the number of orders Bandcamp says they
// have, from the purchases page's data-blob. Null when logged out.
export function readOrderHistoryContext(): { username: string; totalItems: number | null } | null {
  for (const el of Array.from(document.querySelectorAll(SEL_DATA_BLOB))) {
    try {
      const blob = JSON.parse(el.getAttribute('data-blob')!) as Record<string, unknown>;
      const fan = (blob.identities as Record<string, unknown> | undefined)?.fan as Record<string, unknown> | undefined;
      if (!fan || typeof fan.username !== 'string' || !fan.username) continue;
      const total = (blob.orderhistory as Record<string, unknown> | undefined)?.total_items;
      return { username: fan.username, totalItems: typeof total === 'number' ? total : null };
    } catch { /* continue */ }
  }
  return null;
}
