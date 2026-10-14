import type { CartItem, PlaylistTrack, SavedCartItem, CartSnapshot } from './types';
import { parseTralbum } from './bandcamp';
import { Player } from './player';
import { probeCart, probeDiscography, injectDiscographyButton, injectRestoreCartButton, injectRemovePurchasedButton } from './probe';
import { addSnapshotIfChanged } from './cart-history';
import { openCartHistoryModal } from './cart-history-modal';
import { normalizeUrl } from './url';
import { formatTimestamp } from './format';
import { ensureModalStyles } from './styles';
import {
  readCache,
  readCacheBatch,
  writeCache,
  clearTrackCache,
  listCacheEntries,
  TRACK_DETAILS_MAX_AGE_MS,
  LIVE_DATA_MAX_AGE_MS,
  type CacheDump,
} from './cache';
import {
  readPageContext,
  isTrackOrAlbumPage,
  clickCheckout,
  SEL_SIDECART_BODY,
  SEL_SIDECART_ITEM_LIST,
  SEL_SIDECART_ITEM_LINK,
  SEL_MUSIC_GRID_ITEM,
  SEL_GRID_ITEM_TITLE,
  SEL_NATIVE_TRACK_TABLE,
  SEL_NATIVE_TRACK_ROW,
  SEL_NATIVE_ROW_PLAY,
} from './bandcamp-dom';
import { sendBcpMessage } from './messages';
import { mapWithConcurrency } from './inflight';

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

// Cart items that yielded no tracks on the last cart load, keyed by normalised URL.
let cartItemProblems = new Map<string, ItemProblem>();

// Normalised URLs of cart items the user has checked for partial checkout.
let cartSelection = new Set<string>();

// The injected "Checkout selected (N)" button, kept as a reference so it can
// be updated without re-injecting.
let checkoutSelectedBtn: HTMLButtonElement | null = null;

// Index maps for the active cart and discography playlists, used to resolve
// which page element to highlight when the playing track changes.
let activeCartIndexMap: Map<string, number> = new Map();
let activeDiscoIndexMap: Map<string, number> = new Map();

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

// --- Settings ----------------------------------------------------------------

const SETTINGS_KEY = 'bcp_settings_v1';

interface BcpSettings {
  showCartHistoryBtn: boolean;
}

async function loadSettings(): Promise<BcpSettings> {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = result[SETTINGS_KEY] as Partial<BcpSettings> | undefined;
    return { showCartHistoryBtn: true, ...stored };
  } catch {
    return { showCartHistoryBtn: true };
  }
}

// --- Cart history storage ----------------------------------------------------

const CART_HISTORY_KEY = 'bcp_cart_history_v1';

interface CartHistory {
  snapshots: CartSnapshot[];
  updatedAt: number;
}

async function loadSnapshots(): Promise<CartSnapshot[]> {
  try {
    const result = await chrome.storage.local.get(CART_HISTORY_KEY);
    const entry = result[CART_HISTORY_KEY] as CartHistory | undefined;
    return entry?.snapshots ?? [];
  } catch {
    return [];
  }
}

function saveSnapshots(snapshots: CartSnapshot[]): void {
  chrome.storage.local.set({ [CART_HISTORY_KEY]: { snapshots, updatedAt: Date.now() } }).catch(() => {});
}

// --- Pending-purchase storage -------------------------------------------------

const PENDING_PURCHASE_KEY = 'bcp_pending_purchase_v1';

async function loadPendingPurchase(): Promise<SavedCartItem[]> {
  try {
    const result = await chrome.storage.local.get(PENDING_PURCHASE_KEY);
    return (result[PENDING_PURCHASE_KEY] as SavedCartItem[] | undefined) ?? [];
  } catch {
    return [];
  }
}

function savePendingPurchase(items: SavedCartItem[]): void {
  chrome.storage.local.set({ [PENDING_PURCHASE_KEY]: items }).catch(() => {});
}

function clearPendingPurchase(): void {
  chrome.storage.local.remove(PENDING_PURCHASE_KEY).catch(() => {});
}

// --- Cache viewer modal -------------------------------------------------------

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function showCacheModal(entries: CacheDump[]): void {
  ensureModalStyles();

  const backdrop = document.createElement('div');
  backdrop.className = 'bcp-hb';

  const modal = document.createElement('div');
  modal.className = 'bcp-hm bcp-cache-hm';

  const title = document.createElement('h3');
  title.textContent = `Track cache (${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'})`;
  modal.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'bcp-hl';

  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'bcp-cache-empty';
    empty.textContent = 'Cache is empty';
    list.appendChild(empty);
  } else {
    for (const entry of entries) {
      const li = document.createElement('li');

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:baseline;flex-wrap:wrap;gap:4px;margin-bottom:2px';

      const urlLink = document.createElement('a');
      urlLink.className = 'bcp-cache-url';
      urlLink.href = entry.url;
      urlLink.target = '_blank';
      urlLink.rel = 'noopener noreferrer';
      urlLink.textContent = entry.url;

      const meta = document.createElement('span');
      meta.className = 'bcp-cache-meta';
      meta.textContent = `${entry.tracks.length} track${entry.tracks.length !== 1 ? 's' : ''} · cached ${formatTimestamp(entry.cachedAt)}`;

      header.append(urlLink, meta);
      li.appendChild(header);

      const trackList = document.createElement('ul');
      trackList.className = 'bcp-cache-tracks';

      for (const track of entry.tracks) {
        const row = document.createElement('li');

        const titleSpan = document.createElement('span');
        titleSpan.className = 'bcp-cache-track-title';
        titleSpan.textContent = track.trackTitle || '(untitled)';

        const detail = document.createElement('span');
        detail.className = 'bcp-cache-track-detail';
        const parts: string[] = [];
        if (track.artist) parts.push(track.artist);
        if (track.albumTitle) parts.push(track.albumTitle);
        if (track.durationSec) parts.push(formatDuration(track.durationSec));
        detail.textContent = parts.join(' · ');

        const priceStr: string[] = [];
        if (track.minPrice != null) priceStr.push(`release: ${track.minPrice} ${track.currency ?? ''}`);
        if (track.trackMinPrice != null) priceStr.push(`track: ${track.trackMinPrice} ${track.currency ?? ''}`);
        const flags: string[] = [];
        if (!track.purchasable) flags.push('not purchasable');
        if (track.unplayable) flags.push('unplayable');

        row.append(titleSpan, detail);

        if (priceStr.length > 0 || flags.length > 0) {
          const extra = document.createElement('span');
          extra.className = 'bcp-cache-flags';
          extra.textContent = [...priceStr, ...flags].join(' · ');
          row.appendChild(extra);
        }

        trackList.appendChild(row);
      }

      li.appendChild(trackList);
      list.appendChild(li);
    }
  }

  modal.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'bcp-ha';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'bcp-hcl';
  closeBtn.textContent = 'Close';
  actions.appendChild(closeBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  closeBtn.addEventListener('click', close);

  document.body.appendChild(backdrop);
}

// --- Cart mutation primitives -------------------------------------------------
// Used by the cart history modal and the incognito checkout stage A path.
// Keeping the hardened add/remove logic here ensures sync_num handling and
// line-item-id resolution are always consistent.

async function addCartItem(item: SavedCartItem, cartLengthHint: number): Promise<boolean> {
  const tracks = await fetchTracksForUrl(item.url, LIVE_DATA_MAX_AGE_MS);
  if (tracks.length === 0) {
    console.error('[bcp] cart-add: could not fetch release page for', item.url);
    return false;
  }

  const track = tracks[0]!;
  const isTrackAdd = item.purchaseType === 'track';
  const tralbumId = isTrackAdd ? (track.trackId ?? track.releaseId) : track.releaseId;
  const tralbumType = isTrackAdd ? 't' : (track.releaseType === 'track' ? 't' : 'a');
  const minPrice = isTrackAdd ? (track.trackMinPrice ?? track.minPrice) : track.minPrice;

  if (tralbumId === null) {
    console.error('[bcp] cart-add: no tralbum id for', item.url, track);
    return false;
  }

  const ctx = readPageContext(latestSyncNum);
  console.log('[bcp] cart-add', { url: item.url, tralbumId, tralbumType, minPrice, syncNum: ctx.syncNum });

  const result = await sendBcpMessage({
    type: 'cart-add',
    tralbumId,
    tralbumType,
    minPrice: minPrice ?? 0,
    bandId: track.bandId,
    releaseUrl: item.url,
    syncNum: ctx.syncNum,
    clientId: ctx.clientId,
    fanId: ctx.fanId,
    countryCode: ctx.countryCode,
    cartLength: cartLengthHint,
  });

  if (result.ok) {
    updateSyncNum(result.body);
    return true;
  }

  console.error('[bcp] cart-add failed for', item.url, { error: result.error, body: result.body });
  return false;
}

async function removeCartItem(item: SavedCartItem): Promise<boolean> {
  let lineItemId: number | null = cartLineItemIds.get(normalizeUrl(item.url)) ?? null;
  let tralbumId: number | null = null;

  // Only fetch the release page when the cart line-item id is unknown. After the
  // first removal, Bandcamp's cart_data.items response populates the line-item id
  // for every remaining item, so bulk removal fetches at most one release page
  // total instead of one per item.
  if (lineItemId === null) {
    const tracks = await fetchTracksForUrl(item.url);
    if (tracks.length === 0) {
      console.error('[bcp] cart-remove: could not fetch release page for', item.url);
      return false;
    }

    const track = tracks[0]!;
    const isTrackItem = item.purchaseType === 'track';
    tralbumId = isTrackItem ? (track.trackId ?? track.releaseId) : track.releaseId;
    if (tralbumId === null) {
      console.error('[bcp] cart-remove: no tralbum id for', item.url, track);
      return false;
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const idToSend = lineItemId ?? tralbumId;
    const ctx = readPageContext(latestSyncNum);
    console.log('[bcp] cart-remove', { url: item.url, idToSend, syncNum: ctx.syncNum });

    const result = await sendBcpMessage({
      type: 'cart-remove',
      tralbumId: idToSend,
      releaseUrl: item.url,
      syncNum: ctx.syncNum,
      clientId: ctx.clientId,
      fanId: ctx.fanId,
    });

    if (!result.ok) {
      console.error('[bcp] cart-remove failed for', item.url, result.error, result.body);
      return false;
    }

    updateSyncNum(result.body);

    const responseItems = ((result.body as Record<string, unknown> | null)?.cart_data as Record<string, unknown> | null)?.items;
    if (Array.isArray(responseItems)) {
      updateCartLineItemIds(responseItems as Record<string, unknown>[]);
      if (lineItemId === null) lineItemId = cartLineItemIds.get(normalizeUrl(item.url)) ?? null;
    }

    const resync = (result.body as Record<string, unknown> | null)?.resync;
    if ((resync || lineItemId !== idToSend) && attempt === 0 && lineItemId !== null) continue;

    // Bandcamp assigns a new line-item id on re-add, so a stale entry here would
    // be sent on a future remove of the same URL and silently no-op.
    cartLineItemIds.delete(normalizeUrl(item.url));
    return true;
  }

  return false;
}

// --- Progress overlay --------------------------------------------------------

interface ProgressOverlay {
  setTitle(text: string): void;
  setProgress(text: string): void;
  showDone(onCheckout: () => void, onContinue: () => void, onLogin: () => void): void;
  remove(): void;
}

function createProgressOverlay(initialTitle: string, onCancel?: () => void): ProgressOverlay {
  const ff = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.65)',
    zIndex: '2147483647', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: ff,
  });
  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#1a1a1a', border: '1px solid #2e2e2e', borderTop: '3px solid #1da0c3',
    borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    padding: '28px 36px', textAlign: 'center', minWidth: '260px',
  });
  const titleEl = document.createElement('div');
  Object.assign(titleEl.style, { color: '#f0f0f0', fontSize: '15px', fontWeight: '600', marginBottom: '10px' });
  titleEl.textContent = initialTitle;
  const progressEl = document.createElement('div');
  Object.assign(progressEl.style, { color: '#1da0c3', fontSize: '13px' });
  const noteEl = document.createElement('div');
  Object.assign(noteEl.style, { color: '#666', fontSize: '11px', marginTop: '10px' });
  noteEl.textContent = 'Please don\'t close this tab';
  card.append(titleEl, progressEl, noteEl);
  let cancelBtn: HTMLButtonElement | undefined;
  if (onCancel) {
    cancelBtn = document.createElement('button');
    Object.assign(cancelBtn.style, {
      background: 'none', border: '1px solid #444', borderRadius: '4px',
      color: '#999', fontSize: '11px', padding: '4px 12px', marginTop: '14px',
      cursor: 'pointer', fontFamily: ff,
    });
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      cancelBtn!.disabled = true;
      cancelBtn!.textContent = 'Cancelling…';
      onCancel();
    });
    card.appendChild(cancelBtn);
  }
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  return {
    setTitle: (text) => { titleEl.textContent = text; },
    setProgress: (text) => { progressEl.textContent = text; },
    showDone: (onCheckout, onContinue, onLogin) => {
      titleEl.textContent = 'Your cart is ready!';
      progressEl.textContent = '';
      noteEl.style.display = 'none';
      cancelBtn?.remove();
      const btnRow = document.createElement('div');
      Object.assign(btnRow.style, { marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' });
      const goBtn = document.createElement('button');
      Object.assign(goBtn.style, {
        background: '#1da0c3', border: 'none', borderRadius: '4px',
        color: '#fff', fontSize: '13px', padding: '8px 16px',
        cursor: 'pointer', fontFamily: ff, fontWeight: '600',
      });
      goBtn.textContent = 'Go to checkout';
      goBtn.addEventListener('click', onCheckout);
      const contBtn = document.createElement('button');
      Object.assign(contBtn.style, {
        background: 'none', border: '1px solid #444', borderRadius: '4px',
        color: '#ccc', fontSize: '13px', padding: '8px 16px',
        cursor: 'pointer', fontFamily: ff,
      });
      contBtn.textContent = 'Continue browsing';
      contBtn.addEventListener('click', onContinue);
      const loginBtn = document.createElement('button');
      Object.assign(loginBtn.style, {
        background: 'none', border: '1px solid #444', borderRadius: '4px',
        color: '#ccc', fontSize: '13px', padding: '8px 16px',
        cursor: 'pointer', fontFamily: ff,
      });
      loginBtn.textContent = 'Login';
      loginBtn.addEventListener('click', onLogin);
      btnRow.append(goBtn, contBtn, loginBtn);
      card.appendChild(btnRow);
    },
    remove: () => { backdrop.remove(); },
  };
}

function showRemovePurchasedConfirm(items: SavedCartItem[]): Promise<boolean> {
  ensureModalStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'bcp-hb';

    const modal = document.createElement('div');
    modal.className = 'bcp-hm';

    const title = document.createElement('h3');
    title.textContent = `Remove ${items.length} item${items.length !== 1 ? 's' : ''} from cart?`;
    modal.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'bcp-hl';
    for (const item of items) {
      const li = document.createElement('li');
      const label = item.title || item.url;
      li.textContent = item.artist ? `${item.artist} — ${label}` : label;
      list.appendChild(li);
    }
    modal.appendChild(list);

    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexShrink: '0' });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'bcp-hcl';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => close(false));

    const confirmBtn = document.createElement('button');
    Object.assign(confirmBtn.style, {
      padding: '7px 16px', borderRadius: '4px', border: 'none',
      background: '#c0392b', color: '#fff', cursor: 'pointer',
      fontSize: '13px', fontFamily: 'inherit',
    });
    confirmBtn.textContent = `Remove (${items.length})`;
    confirmBtn.addEventListener('click', () => close(true));

    actions.append(cancelBtn, confirmBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);

    const close = (result: boolean) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    document.body.appendChild(backdrop);
  });
}

function setupRemovePurchasedButton(items: SavedCartItem[]): void {
  const btn = injectRemovePurchasedButton(items.length);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!await showRemovePurchasedConfirm(items)) return;
    btn.disabled = true;
    for (let i = 0; i < items.length; i++) {
      const label = items[i]!.title || items[i]!.url;
      btn.textContent = `Removing "${label}" (${i + 1} / ${items.length})…`;
      await removeCartItem(items[i]!);
    }
    clearPendingPurchase();
    location.reload();
  });
}

main().catch(console.error);

// Loads (or reloads) the cart playlist: resolves track metadata, updates the
// player's cart playlist, and re-injects sidecart UI elements.
async function loadCartPlaylist(cartItems: CartItem[], player: Player): Promise<void> {
  // Another playlist (e.g. the current page) may already be active, so progress
  // goes to the cart tab instead of overwriting that playlist's status line.
  const reportProgress = (done: number) => {
    const progress = `${done} / ${cartItems.length}`;
    player.setPlaylistUnavailable(
      'cart',
      `Cart (loading ${progress})`,
      `Loading track info for your cart: ${done} of ${cartItems.length} releases done. ` +
        'Releases loaded before come from the cache; new ones are fetched from Bandcamp a few at a time.',
      'loading'
    );
    if (player.currentPlaylistId === null) {
      player.setStatus(`Loading ${progress}…`, 'loading');
    } else {
      player.setPlaylistStatus('cart', `Loading ${progress}…`, 'loading');
    }
  };
  reportProgress(0);

  const { tracks: cartTracks, indexMap: cartIndexMap, problems } = await resolvePlaylist(cartItems, reportProgress);
  cartItemProblems = new Map(Array.from(problems, ([url, problem]) => [normalizeUrl(url), problem]));

  if (cartTracks.length === 0) {
    const { label, reason } = describeNothingToPlay(cartItems.length, problems, 'in your cart');
    player.setPlaylistUnavailable('cart', `Cart (${label})`, reason, 'error');
    player.setPlaylistStatus('cart', `Cart: ${label}`, 'error');
    if (player.currentPlaylistId === null) player.setStatus(`Cart: ${label}`, 'error');
    return;
  }

  activeCartIndexMap = cartIndexMap;
  player.setPlaylist('cart', 'Cart', cartTracks);
  document.body.style.paddingBottom = `${player.wrapper.offsetHeight}px`;
  injectCartPlayButtons(cartIndexMap, player);
  cartItems.forEach((item) => injectCheckboxForSidecartItem(item.url));
  injectCheckoutSelectedBtn(player);

  refreshCartStatus(player);
}

async function main() {
  // --- Incognito checkout: Stage A — add selected items to a fresh cart ------
  // The normal window opens this URL: bandcamp.com/cart#bcp_cart=<items>.
  // We parse the payload, add items via the incognito session's cookie jar,
  // then reload to Stage B.
  if (chrome.extension.inIncognitoContext) {
    const hash = window.location.hash;

    if (hash.startsWith('#bcp_cart=')) {
      history.replaceState(null, '', window.location.pathname);

      type IncognitoItem = { u: string; id: number; t: 't' | 'a'; pr: number; b: number | null };
      const items: IncognitoItem[] = [];
      try {
        const raw = JSON.parse(decodeURIComponent(hash.slice('#bcp_cart='.length))) as unknown[];
        for (const x of raw) {
          const xi = x as { u?: unknown; id?: unknown; t?: unknown; pr?: unknown; b?: unknown };
          if (typeof xi.u === 'string' && typeof xi.id === 'number' &&
              (xi.t === 't' || xi.t === 'a') && typeof xi.pr === 'number') {
            items.push({ u: xi.u, id: xi.id, t: xi.t, pr: xi.pr, b: typeof xi.b === 'number' ? xi.b : null });
          }
        }
      } catch {
        console.error('[bcp] incognito stage A: could not parse payload');
      }

      if (items.length > 0) {
        latestSyncNum = null;
        cartLineItemIds.clear();

        let cancelled = false;
        const overlay = createProgressOverlay('Building your cart…', () => { cancelled = true; });
        overlay.setProgress(`0 / ${items.length} items`);

        // Track data is pre-resolved — just read page context and POST directly,
        // no release-page fetches needed.
        let added = 0;
        for (let i = 0; i < items.length; i++) {
          const it = items[i]!;
          const ctx = readPageContext(latestSyncNum);
          const result = await sendBcpMessage({
            type: 'cart-add',
            tralbumId: it.id,
            tralbumType: it.t,
            minPrice: it.pr,
            bandId: it.b,
            releaseUrl: it.u,
            syncNum: ctx.syncNum,
            clientId: ctx.clientId,
            fanId: ctx.fanId,
            countryCode: ctx.countryCode,
            cartLength: added,
          });
          if (result.ok) {
            updateSyncNum(result.body);
            added++;
          }
          overlay.setProgress(`${added} / ${items.length} items`);
          if (cancelled) break;
        }

        if (!cancelled && added === 0) {
          overlay.setTitle('Could not add items to cart');
          overlay.setProgress('Try logging into Bandcamp in this window and refreshing.');
          // Leave overlay visible so the message is readable; user closes the tab.
        } else if (cancelled) {
          overlay.remove();
        } else {
          // Reload so the page reflects the cart we just built, then show options.
          location.assign('https://bandcamp.com/cart#bcp_cart_ready=1');
        }
      }

      return;
    }

    // --- Stage B (ready) — cart built, show options on freshly loaded page ---
    // Arrives here after Stage A navigates to this hash, giving the page a
    // chance to reflect the newly populated cart before the user acts.
    if (hash.startsWith('#bcp_cart_ready=')) {
      history.replaceState(null, '', window.location.pathname);

      const overlay = createProgressOverlay('Your cart is ready!');
      overlay.showDone(
        () => { location.assign('https://bandcamp.com/cart#bcp_go_checkout=1'); },
        () => { overlay.remove(); },
        () => { location.assign('https://bandcamp.com/login'); },
      );
      return;
    }

    // --- Stage C — cart is populated, click checkout -------------------------
    // We arrive here after the user clicks "Go to checkout" in Stage B.
    if (hash.startsWith('#bcp_go_checkout=')) {
      history.replaceState(null, '', window.location.pathname);

      // Poll for the checkout button — the cart page may still be rendering.
      let clicked = false;
      for (let attempt = 0; attempt < 5 && !clicked; attempt++) {
        if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 500));
        // Try the sidecart-aware helper first, then a document-wide text fallback
        // for the full cart page layout (no sidecart container).
        clicked = clickCheckout();
        if (!clicked) {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>('a, button'))) {
            if (/check\s?out/i.test(el.textContent ?? '')) {
              el.click();
              clicked = true;
              break;
            }
          }
        }
      }
      if (!clicked) location.assign('https://bandcamp.com/cart');
      return;
    }
  }
  // ---------------------------------------------------------------------------

  const cartItems = probeCart();
  const settings = await loadSettings();

  if (!chrome.extension.inIncognitoContext) {
    const liveItems: SavedCartItem[] = cartItems.map((i) => ({ url: i.url, title: i.title, purchaseType: i.purchaseType }));
    const snapshots = addSnapshotIfChanged(await loadSnapshots(), liveItems);
    saveSnapshots(snapshots);

    if (settings.showCartHistoryBtn && snapshots.length > 0) {
      const btn = injectRestoreCartButton(snapshots.length);
      if (btn) {
        btn.addEventListener('click', async () => {
          const modalInitialItems: SavedCartItem[] = probeCart().map((i) => ({ url: i.url, title: i.title, purchaseType: i.purchaseType }));
          const changedCount = await openCartHistoryModal({
            snapshots,
            initialItems: modalInitialItems,
            addItem: async (item, cartLengthHint) => {
              const ok = await addCartItem(item, cartLengthHint);
              if (ok) addSidecartItem(item.url, item.title, null, item.purchaseType === 'track' ? 'track' : 'release');
              return ok;
            },
            removeItem: async (item) => {
              const ok = await removeCartItem(item);
              if (ok) removeSidecartItem(item.url);
              return ok;
            },
          });
          if (changedCount > 0) location.reload();
        });
      }
    }

    // Re-show the cleanup button if a pending-purchase list was saved from a previous session.
    const pending = await loadPendingPurchase();
    if (pending.length > 0) {
      const cartUrls = new Set(cartItems.map((i) => normalizeUrl(i.url)));
      const stillInCart = pending.filter((i) => cartUrls.has(normalizeUrl(i.url)));
      if (stillInCart.length > 0) {
        // Trim the stored list if some items were already manually removed from the cart.
        if (stillInCart.length < pending.length) savePendingPurchase(stillInCart);
        setupRemovePurchasedButton(stillInCart);
      } else {
        // All previously purchased items are already gone — nothing to clean up.
        clearPendingPurchase();
      }
    }
  } else if (settings.showCartHistoryBtn) {
    const anchor = document.getElementById('sidecart')
      ?? document.querySelector('#sidecartReveal')
      ?? document.getElementById('sidecartBody');
    if (anchor) {
      const note = document.createElement('div');
      Object.assign(note.style, {
        color: '#666', fontSize: '11px', marginTop: '6px', textAlign: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      });
      note.textContent = 'No history tracked in incognito mode';
      anchor.insertAdjacentElement('afterend', note);
    }
  }

  console.log('[bcp] Cart items found:');
  console.table(cartItems.map((it) => ({ type: it.type, title: it.title, artist: it.artist, url: it.url })));

  // Probe discography early so we can show the player on label pages even when
  // the cart is empty. Release pages always get the player for their own tracks.
  const discoItems = probeDiscography();

  if (cartItems.length === 0 && discoItems.length === 0 && !isTrackOrAlbumPage()) {
    console.warn(
      '[bcp] No cart items detected. The cart may be empty, or the selectors need updating. ' +
        'Open DevTools, inspect the cart item DOM nodes, and update probeCart() in src/content.ts.'
    );
    return;
  }

  const player = new Player([]);
  document.body.appendChild(player.wrapper);

  if (cartItems.length === 0) {
    const reason = document.querySelector(SEL_SIDECART_BODY)
      ? 'No items found in your shopping cart. If it is not empty, Bandcamp may have changed its page layout.'
      : 'Your cart is empty: Bandcamp shows no shopping cart on this page. Use + Track, + Release or + Cart to add something.';
    player.setPlaylistUnavailable('cart', 'Cart (empty)', reason);
  }

  // Build the initial cart URL set and purchase-type map.
  cartItemTypes = buildCartItemTypes(cartItems);
  player.setCartUrls(buildCartUrlSet(cartItems));

  player.onTrackChange = (id, index) => {
    if (id === 'cart') {
      highlightCartItem(index);
      clearDiscoHighlight();
    } else if (id === 'discography') {
      clearCartHighlight();
      highlightDiscoItem(index);
    } else {
      clearCartHighlight();
      clearDiscoHighlight();
    }
  };

  // Wire up cart mutation callbacks.
  player.onCartAdd = async (track, addType) => {
    const tralbumId = addType === 'track' ? track.trackId : track.releaseId;
    const tralbumType = addType === 'track' ? 't' : (track.releaseType === 'track' ? 't' : 'a');

    // Playlist tracks can come from a months-old cache entry; prices must be current.
    const releaseTracks = await fetchTracksForUrl(track.releaseUrl, LIVE_DATA_MAX_AGE_MS);
    if (releaseTracks.length === 0) {
      // `false` would tell the player only the full release is for sale.
      player.showToast('Could not check the current price, please try again', 'error');
      return;
    }
    // A null track price makes the code below read it from the track's own page.
    let minPrice = addType === 'track'
      ? (releaseTracks.find((t) => t.trackId === track.trackId)?.trackMinPrice ?? null)
      : releaseTracks[0]!.minPrice;

    // Album pages often omit per-track pricing. Fetch the track's own page to get it.
    // We also check purchasability here: album pages always produce purchasable=true since
    // the signal only exists on a track's own page. If the track page shows it's album-only,
    // abort — sending the request to Bandcamp can cause unexpected cart state changes.
    if (addType === 'track' && minPrice === null) {
      try {
        const response = await sendBcpMessage({ type: 'fetch', url: track.pageUrl });
        if (!response.error) {
          const parsed = parseTralbum(response.html ?? '', track.pageUrl);
          if (parsed.length > 0) {
            if (!parsed[0]!.purchasable) {
              player.showToast('Cannot purchase single track, only full release available', 'error');
              return false;
            }
            if (parsed[0]!.minPrice !== null) {
              minPrice = parsed[0]!.minPrice;
            }
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
      const tracksToAdd = addType === 'track' ? [track] : releaseTracks;
      const startIndex = player.addTracksToPlaylist('cart', tracksToAdd);
      if (startIndex !== null) {
        activeCartIndexMap.set(normalizeUrl(cartItemUrl), startIndex);
        injectPlayButtonForSidecartItem(cartItemUrl, startIndex, player);
        injectCheckboxForSidecartItem(cartItemUrl);
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
      cartSelection.delete(normalizeUrl(cartItemUrl));
      updateCheckoutSelectedBtn();
      refreshCartStatus(player);
      return;
    }

    player.setStatus('Remove failed: could not sync cart state', 'error');
  };

  // Partial-checkout: open a private window with a fresh cart containing only
  // the selected items. The main cart is never touched.
  player.onCheckoutSelected = async (selectedRawUrls) => {
    const current = probeCart();
    const sel = new Set(selectedRawUrls.map(normalizeUrl));
    const leftover = current.filter((i) => !sel.has(normalizeUrl(i.url)));
    const selectedItems = current.filter((i) => sel.has(normalizeUrl(i.url)));

    // Selecting everything is a normal full-cart checkout — no private window needed.
    if (leftover.length === 0) {
      if (!clickCheckout()) {
        player.showToast('Could not find checkout button — opening cart page', 'warn');
        location.assign('/cart');
      }
      return;
    }

    // Resolve track data here in the normal window where the cache is warm.
    // The incognito window's storage is a separate empty instance, so it
    // can't use the cache.
    const items: Array<{ u: string; id: number; t: 't' | 'a'; pr: number; b: number | null }> = [];
    for (const item of selectedItems) {
      const tracks = await fetchTracksForUrl(item.url, LIVE_DATA_MAX_AGE_MS);
      if (tracks.length === 0) continue;
      const track = tracks[0]!;
      const isTrackAdd = item.purchaseType === 'track';
      const tralbumId = isTrackAdd ? (track.trackId ?? track.releaseId) : track.releaseId;
      if (tralbumId === null) continue;
      const tralbumType: 't' | 'a' = isTrackAdd ? 't' : (track.releaseType === 'track' ? 't' : 'a');
      const minPrice = isTrackAdd ? (track.trackMinPrice ?? track.minPrice) : track.minPrice;
      items.push({ u: item.url, id: tralbumId, t: tralbumType, pr: minPrice ?? 0, b: track.bandId });
    }
    if (items.length === 0) {
      player.showToast('Could not resolve any selected items — check the console', 'error');
      return;
    }

    const result = await sendBcpMessage({ type: 'open-incognito-checkout', items });
    if (!result.ok) {
      player.showToast(
        'Could not open a private window. Enable "Allow in incognito" for this extension in chrome://extensions, then try again.',
        'error',
      );
      return;
    }

    // Persist selected items so the cleanup button survives a page reload.
    const toRemove: SavedCartItem[] = selectedItems.map((i) => ({
      url: i.url, title: i.title, artist: i.artist, purchaseType: i.purchaseType,
    }));
    savePendingPurchase(toRemove);
    setupRemovePurchasedButton(toRemove);
  };

  // Keep cart state in sync when Bandcamp's own JS updates the sidecart.
  const sidecartObserver = watchSidecart(player);

  // Tear down on navigation away: disconnect the observer, stop audio, and
  // remove the injected UI so subsequent pages start clean.
  window.addEventListener('pagehide', () => {
    sidecartObserver?.disconnect();
    player.destroy();
  }, { once: true });

  const discoBtn = discoItems.length > 0 ? injectDiscographyButton() : null;

  // Refreshes every loaded copy of the release's tracks, so the rest of an
  // album plays without another fetch.
  player.onRefreshStream = async (track, force) => {
    const fresh = await fetchTracksForUrl(track.releaseUrl, force ? 0 : LIVE_DATA_MAX_AGE_MS);
    const freshByPage = new Map(fresh.map((t) => [normalizeUrl(t.pageUrl), t]));
    const playlistTracks = (['currentpage', 'cart', 'discography'] as const).flatMap((id) => player.getPlaylistTracks(id));
    // `track` may no longer be in any playlist, e.g. after its release was removed mid-play.
    for (const loaded of [track, ...playlistTracks]) {
      const match = freshByPage.get(normalizeUrl(loaded.pageUrl));
      if (!match) continue;
      loaded.streamUrl = match.streamUrl;
      loaded.unplayable = match.unplayable;
      loaded.streamFetchedAt = match.streamFetchedAt;
    }
  };

  player.onShowCache = async () => {
    const entries = await listCacheEntries();
    showCacheModal(entries);
  };

  // The current page's tracks are already in the DOM, so they load before the
  // cart and discography, which each need a fetch per release. Being the first
  // playlist set, it also becomes the active one.
  const pageTracks = isTrackOrAlbumPage()
    ? parseTralbum(document.documentElement.outerHTML, location.href)
    : [];
  const pageLoadedAt = Date.now();
  for (const track of pageTracks) track.streamFetchedAt = pageLoadedAt;
  const setCurrentPageStatus = () => {
    const n = pageTracks.length;
    player.setPlaylistStatus('currentpage', `${n} track${n !== 1 ? 's' : ''}`, 'info');
  };
  if (pageTracks.length > 0) {
    player.setPlaylist('currentpage', 'Current page', pageTracks);
    setCurrentPageStatus();
    const teardown = setupNativePlayerSync(player);
    window.addEventListener('pagehide', teardown, { once: true });
  } else if (discoItems.length === 0) {
    player.setPlaylistUnavailable(
      'currentpage',
      'Current page (nothing to play)',
      isTrackOrAlbumPage()
        ? 'No playable tracks could be read from this page.'
        : 'This page has no tracks of its own. Open a release or label page to play it from here.'
    );
  }

  // A label can have hundreds of releases, each needing a fetch on first load,
  // so the discography only loads once the user asks to play it.
  let discoLoad: Promise<boolean> | null = null;
  const resolveDiscography = async (): Promise<boolean> => {
    const reportProgress = (done: number) => {
      const progress = `${done} / ${discoItems.length}`;
      player.setPlaylistUnavailable(
        'discography',
        `Label discography (loading ${progress})`,
        `Loading track info for this label: ${done} of ${discoItems.length} releases done.`,
        'loading'
      );
      if (discoBtn) {
        discoBtn.textContent = `Loading label discography… ${progress}`;
        discoBtn.disabled = true;
      }
    };
    reportProgress(0);
    const { tracks: discoTracks, indexMap: discoIndexMap, problems } = await resolvePlaylist(discoItems, reportProgress);
    if (discoTracks.length === 0) {
      const { label, reason } = describeNothingToPlay(discoItems.length, problems, 'on this page');
      player.setPlaylistUnavailable('discography', `Label discography (${label})`, reason, 'error');
      if (discoBtn) discoBtn.textContent = 'No playable discography tracks found';
      return false;
    }
    activeDiscoIndexMap = discoIndexMap;
    player.setPlaylist('discography', 'Label discography', discoTracks);
    player.setPlaylistStatus('discography', `${discoTracks.length} tracks (${discoItems.length} releases)`, 'info');
    if (discoBtn) {
      discoBtn.textContent = `Play label discography (${discoTracks.length} tracks, ${discoItems.length} releases)`;
      discoBtn.disabled = false;
    }
    return true;
  };
  const loadDiscography = (): Promise<boolean> => {
    discoLoad ??= resolveDiscography();
    return discoLoad;
  };

  if (discoItems.length > 0) {
    // On a label page the discography is the page's own music, so its tab shows
    // before anything is fetched.
    player.setPlaylistOnDemand(
      'discography',
      `Label discography (${discoItems.length} releases)`,
      'Click to load and play every release on this page.',
      () => {
        void loadDiscography().then((loaded) => {
          if (loaded) player.jumpTo('discography', 0);
        });
      }
    );

    console.log('[bcp] Discography releases found:');
    console.table(discoItems.map((it) => ({ type: it.type, url: it.url })));

    injectDiscographyPlayButtons(discoItems, async (item) => {
      if (!(await loadDiscography())) return;
      const index = activeDiscoIndexMap.get(item.url);
      if (index === undefined) {
        player.showToast('No playable tracks for this release', 'warn');
        return;
      }
      player.jumpTo('discography', index);
    });
  }

  if (discoBtn) {
    discoBtn.textContent = `Play label discography (${discoItems.length} releases)`;
    discoBtn.style.display = player.discographyButtonEnabled ? '' : 'none';
    player.onDiscographyButtonVisibilityChange = (show) => {
      discoBtn.style.display = show ? '' : 'none';
    };
    discoBtn.addEventListener('click', async () => {
      if (await loadDiscography()) player.jumpTo('discography', 0);
    });
  }

  player.onReloadPlaylist = async () => {
    player.setStatus('Reloading playlist info…', 'loading');
    await clearTrackCache();
    if (pageTracks.length > 0) setCurrentPageStatus();
    if (cartItems.length > 0) {
      await loadCartPlaylist(cartItems, player);
    }
    if (discoLoad) {
      // Let a load that is still running finish, so two never run at once.
      await discoLoad;
      discoLoad = null;
      await loadDiscography();
    }
  };

  if (cartItems.length > 0) {
    await loadCartPlaylist(cartItems, player);
  } else if (player.currentPlaylistId === null) {
    // Cart is empty — show player on label page with a placeholder status.
    // Tracks can still be added from the discography below.
    player.setStatus('Cart is empty', 'info');
  }
}

function buildCartUrlSet(items: CartItem[]): Set<string> {
  return new Set(items.map((i) => normalizeUrl(i.url)));
}

function refreshCartState(player: Player): void {
  const fresh = probeCart();
  cartItemTypes = buildCartItemTypes(fresh);
  player.setCartUrls(buildCartUrlSet(fresh));
  // Prune selected items no longer in the cart (e.g. removed via native sidecart).
  const freshUrls = new Set(fresh.map((i) => normalizeUrl(i.url)));
  for (const key of Array.from(cartSelection)) {
    if (!freshUrls.has(key)) cartSelection.delete(key);
  }
  updateCheckoutSelectedBtn();
}

function refreshCartStatus(player: Player): void {
  const tracks = player.getPlaylistTracks('cart');
  const cartItems = probeCart();
  if (tracks.length === 0 && cartItems.length > 0) {
    // The items left in the cart are ones that yielded no tracks.
    const problems = new Map(cartItems.map((i) => [i.url, cartItemProblems.get(normalizeUrl(i.url)) ?? 'no-tracks' as const]));
    const { label, reason } = describeNothingToPlay(cartItems.length, problems, 'in your cart');
    player.setPlaylistUnavailable('cart', `Cart (${label})`, reason, 'error');
    player.setPlaylistStatus('cart', `Cart: ${label}`, 'error');
    return;
  }
  if (tracks.length === 0) {
    player.setPlaylistUnavailable(
      'cart',
      'Cart (empty)',
      'Everything was removed from your cart. Use + Track, + Release or + Cart to add something.'
    );
    player.setPlaylistStatus('cart', 'Cart is empty', 'info');
    return;
  }

  const inCart = new Set(cartItems.map((i) => normalizeUrl(i.url)));
  const problemsInCart = Array.from(cartItemProblems).filter(([url]) => inCart.has(url)).map(([, problem]) => problem);
  const fetchFailed = problemsInCart.filter((p) => p === 'fetch-failed').length;
  const noTracks = problemsInCart.length - fetchFailed;
  const unplayable = tracks.filter((t) => t.unplayable).length;

  const notes: string[] = [];
  if (unplayable > 0) {
    notes.push(unplayable / tracks.length >= 0.5
      ? 'Log in for full streams'
      : `${unplayable} track${unplayable > 1 ? 's' : ''} unavailable`);
  }
  if (fetchFailed > 0) notes.push(`${fetchFailed} item${fetchFailed > 1 ? 's' : ''} could not be loaded`);
  if (noTracks > 0) notes.push(`${noTracks} item${noTracks > 1 ? 's have' : ' has'} nothing to play`);

  if (notes.length > 0) {
    player.setPlaylistStatus('cart', notes.join(' · '), 'warn');
  } else {
    const releaseCount = new Set(tracks.map((t) => t.releaseUrl)).size;
    player.setPlaylistStatus('cart', `${tracks.length} tracks (${releaseCount} releases)`, 'info');
  }
}

function updateCheckoutSelectedBtn(): void {
  if (!checkoutSelectedBtn) return;
  const n = cartSelection.size;
  checkoutSelectedBtn.disabled = n === 0;
  checkoutSelectedBtn.textContent = `Checkout selected (${n})`;
}

function injectCheckboxForSidecartItem(url: string): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;
  const normalized = normalizeUrl(url);
  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
    if (normalizeUrl(link.href) !== normalized) continue;
    if (link.parentElement?.querySelector('.bcp-cart-checkbox')) return; // already injected
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bcp-cart-checkbox';
    checkbox.checked = cartSelection.has(normalized);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        cartSelection.add(normalized);
      } else {
        cartSelection.delete(normalized);
      }
      updateCheckoutSelectedBtn();
    });
    // Insert before the play button if present, otherwise before the link.
    const playBtn = link.previousElementSibling;
    const insertBefore = playBtn?.classList.contains('bcp-cart-play-btn') ? playBtn : link;
    withSuppressedObserver(() => link.parentElement?.insertBefore(checkbox, insertBefore));
    break;
  }
}

function injectCheckoutSelectedBtn(player: Player): void {
  if (checkoutSelectedBtn) return;
  const anchor = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!anchor) return;

  const btn = document.createElement('button');
  btn.className = 'bcp-checkout-selected-btn';
  btn.disabled = true;
  btn.textContent = 'Checkout selected (0)';
  btn.addEventListener('click', async () => {
    const current = probeCart();
    const selectedRawUrls = current
      .filter((i) => cartSelection.has(normalizeUrl(i.url)))
      .map((i) => i.url);
    if (selectedRawUrls.length === 0) return;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      await player.onCheckoutSelected?.(selectedRawUrls);
    } finally {
      updateCheckoutSelectedBtn();
    }
  });

  anchor.insertAdjacentElement('afterend', btn);
  checkoutSelectedBtn = btn;
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

// Why an item yielded no tracks: the page could not be fetched, or it was
// fetched but has nothing to play (e.g. merch).
type ItemProblem = 'fetch-failed' | 'no-tracks';

// Fetches and parses a release page, bypassing the cache, and caches the result.
async function fetchRelease(url: string): Promise<{ tracks: PlaylistTrack[]; problem?: ItemProblem }> {
  try {
    const response = await sendBcpMessage({ type: 'fetch', url });
    if (response.error) {
      console.warn('[bcp] Fetch error for', url, response.error);
      return { tracks: [], problem: 'fetch-failed' };
    }
    const parsed = parseTralbum(response.html ?? '', url);
    if (parsed.length === 0) {
      console.warn('[bcp] No tracks parsed from', url);
      return { tracks: [], problem: 'no-tracks' };
    }
    const fetchedAt = Date.now();
    for (const track of parsed) track.streamFetchedAt = fetchedAt;
    writeCache(url, parsed);
    return { tracks: parsed };
  } catch (err) {
    console.warn('[bcp] Failed to fetch', url, err);
    return { tracks: [], problem: 'fetch-failed' };
  }
}

async function fetchTracksForUrl(url: string, maxAgeMs = TRACK_DETAILS_MAX_AGE_MS): Promise<PlaylistTrack[]> {
  return (await readCache(url, maxAgeMs)) ?? (await fetchRelease(url)).tracks;
}

// Enough parallel release-page fetches to fill a large cart quickly without
// tripping Bandcamp's rate limiting.
const RELEASE_FETCH_CONCURRENCY = 4;

async function resolvePlaylist(
  items: CartItem[],
  onProgress: (done: number) => void
): Promise<{ tracks: PlaylistTrack[]; indexMap: Map<string, number>; problems: Map<string, ItemProblem> }> {
  const tracks: PlaylistTrack[] = [];
  const indexMap = new Map<string, number>();
  const problems = new Map<string, ItemProblem>();
  const cached = await readCacheBatch(items.map((item) => item.url));
  let done = cached.size;
  onProgress(done);

  const misses = items.filter((item) => !cached.has(item.url));
  const fetched = await mapWithConcurrency(misses, RELEASE_FETCH_CONCURRENCY, (item) => fetchRelease(item.url), () => {
    done++;
    onProgress(done);
  });
  const fetchedByUrl = new Map(misses.map((item, i) => [item.url, fetched[i]!]));

  for (const item of items) {
    const result = cached.has(item.url) ? { tracks: cached.get(item.url)! } : fetchedByUrl.get(item.url)!;
    if (result.tracks.length > 0) {
      indexMap.set(item.url, tracks.length);
      tracks.push(...result.tracks);
    } else {
      problems.set(item.url, result.problem ?? 'no-tracks');
    }
  }

  return { tracks, indexMap, problems };
}

// Explains why nothing in a playlist could be played, for its greyed-out tab.
function describeNothingToPlay(itemCount: number, problems: Map<string, ItemProblem>, what: string): { label: string; reason: string } {
  const fetchFailed = Array.from(problems.values()).filter((p) => p === 'fetch-failed').length;
  if (fetchFailed === itemCount) {
    return {
      label: 'could not load',
      reason:
        `None of the ${itemCount} items ${what} could be fetched from Bandcamp. ` +
        'Check that you are online, then press ⟳ to retry. The DevTools console shows the error for each item.',
    };
  }
  return {
    label: 'nothing to play',
    reason:
      `None of the ${itemCount} items ${what} have tracks the player can read; merch and other non-music items have none.` +
      (fetchFailed > 0 ? ` ${fetchFailed} could not be fetched at all; press ⟳ to retry those.` : '') +
      ' The DevTools console lists each item.',
  };
}

function findReleaseUrlForIndex(indexMap: Map<string, number>, activeIndex: number): string | null {
  let bestUrl: string | null = null;
  let bestStart = -1;
  for (const [url, start] of indexMap) {
    if (start <= activeIndex && start > bestStart) {
      bestStart = start;
      bestUrl = url;
    }
  }
  return bestUrl;
}

function highlightCartItem(index: number): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;
  for (const el of Array.from(sidecartBody.querySelectorAll<HTMLElement>('.bcp-playing'))) {
    el.classList.remove('bcp-playing');
  }
  const activeUrl = findReleaseUrlForIndex(activeCartIndexMap, index);
  if (!activeUrl) return;
  const normalized = normalizeUrl(activeUrl);
  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
    if (normalizeUrl(link.href) === normalized) {
      link.classList.add('bcp-playing');
      break;
    }
  }
}

function clearCartHighlight(): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;
  for (const el of Array.from(sidecartBody.querySelectorAll<HTMLElement>('.bcp-playing'))) {
    el.classList.remove('bcp-playing');
  }
}

function highlightDiscoItem(index: number): void {
  for (const li of Array.from(document.querySelectorAll<HTMLElement>(`${SEL_MUSIC_GRID_ITEM}.bcp-playing`))) {
    li.classList.remove('bcp-playing');
  }
  const activeUrl = findReleaseUrlForIndex(activeDiscoIndexMap, index);
  if (!activeUrl) return;
  try {
    const itemPath = new URL(activeUrl).pathname;
    document.querySelector<HTMLElement>(
      `${SEL_MUSIC_GRID_ITEM} a[href="${CSS.escape(itemPath)}"]`
    )?.closest<HTMLElement>(SEL_MUSIC_GRID_ITEM)?.classList.add('bcp-playing');
  } catch {
    // invalid URL — skip
  }
}

function clearDiscoHighlight(): void {
  for (const li of Array.from(document.querySelectorAll<HTMLElement>(`${SEL_MUSIC_GRID_ITEM}.bcp-playing`))) {
    li.classList.remove('bcp-playing');
  }
}

function injectCartPlayButtons(indexMap: Map<string, number>, player: Player): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;

  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
    const index = indexMap.get(link.href);
    if (index === undefined) continue;
    if (link.previousElementSibling?.classList.contains('bcp-cart-play-btn')) continue; // already injected

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
  discoItems: CartItem[],
  onPlay: (item: CartItem) => void
): void {
  // Pre-index all visible grid <li> elements by their link's pathname.
  // We use the JS .pathname property rather than the href attribute so that
  // cross-domain absolute hrefs (e.g. https://artist.bandcamp.com/album/foo?label=...)
  // and same-domain relative hrefs both resolve correctly.
  // Featured items appear as li.featured-item in ol.featured-grid AND as hidden
  // li.music-grid-item (style="display:none") in #music-grid — we skip the hidden ones.
  const lisByPath = new Map<string, HTMLElement[]>();
  const register = (li: HTMLElement) => {
    const a = li.querySelector<HTMLAnchorElement>('a[href]');
    if (!a?.href) return;
    const path = new URL(a.href).pathname;
    const arr = lisByPath.get(path) ?? [];
    arr.push(li);
    lisByPath.set(path, arr);
  };

  for (const li of Array.from(document.querySelectorAll<HTMLElement>('ol.featured-grid li.featured-item'))) {
    register(li);
  }
  for (const li of Array.from(document.querySelectorAll<HTMLElement>(SEL_MUSIC_GRID_ITEM))) {
    if (li.style.display === 'none') continue;
    register(li);
  }

  for (const item of discoItems) {
    const itemPath = new URL(item.url).pathname;
    const lis = lisByPath.get(itemPath);
    if (!lis) continue;

    for (const li of lis) {
      if (li.querySelector('.bcp-grid-play-btn')) continue; // already injected
      const playBtn = document.createElement('button');
      playBtn.className = 'bcp-grid-play-btn';
      playBtn.textContent = '▶';
      playBtn.title = 'Play in discography player';
      playBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPlay(item);
      });

      const titleEl = li.querySelector<HTMLElement>(SEL_GRID_ITEM_TITLE);
      if (titleEl) {
        titleEl.insertBefore(playBtn, titleEl.firstChild);
      } else {
        li.appendChild(playBtn);
      }
    }
  }
}

// --- Native player sync (Current page tab) -----------------------------------

// Returns a teardown callback to be registered with the pagehide event.
function setupNativePlayerSync(player: Player): () => void {
  // Suppress flags prevent feedback loops when we programmatically change
  // one player's state and don't want it to echo back, mirroring the
  // suppressSidecartObserver pattern used for cart mutations.
  let suppressNative = false;
  let suppressSeekSync = false;

  // Bandcamp's audio element lives in the DOM; our bottom player's Audio()
  // is never inserted, so this always finds the native one (or null).
  const getNativeAudio = (): HTMLAudioElement | null =>
    document.querySelector<HTMLAudioElement>('audio');

  // --- native → bottom: native started playing ---
  const onNativePlay = () => {
    if (suppressNative) return;
    // Suppress seek sync briefly: the browser fires 'seeked' on the native
    // audio element when a track starts (seeking to position 0), which would
    // otherwise call player.seekToFraction(0) and jump the bottom player back
    // to the beginning on every play event / buffer stall recovery.
    suppressSeekSync = true;
    setTimeout(() => { suppressSeekSync = false; }, 500);

    const currentRow = document.querySelector<HTMLElement>(`${SEL_NATIVE_TRACK_ROW}.current_track`);
    const a = currentRow?.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
    const pageUrl = a ? new URL(a.href, location.href).href : null;
    const tracks = player.getPlaylistTracks('currentpage');
    const idx = pageUrl
      ? tracks.findIndex((t) => normalizeUrl(t.pageUrl) === normalizeUrl(pageUrl))
      : -1;
    // Hold suppressNative across the bottom player's resulting 'play' macrotask
    // so onPlayStateChange doesn't echo back and double-drive the native audio.
    suppressNative = true;
    // silent=true: native is already on the right track — don't drive it again.
    player.jumpTo('currentpage', idx === -1 ? 0 : idx, true);
    setTimeout(() => { suppressNative = false; }, 0);
  };

  // --- native → bottom: native paused ---
  const onNativePause = () => {
    if (suppressNative) return;
    // While the tab is backgrounded, Chrome suspends the muted native <audio>
    // and fires 'pause'. That is not a user action, so don't stop the bottom
    // player — but the native play button reacts to this same event on its
    // own (outside our control) and flips to its paused glyph. If the bottom
    // player is still actively playing this track, immediately resume the
    // muted native audio (muted autoplay is allowed regardless of tab
    // visibility) so the native button reflects "playing" again.
    if (document.hidden) {
      if (player.currentPlaylistId === 'currentpage' && player.isPlaying) {
        getNativeAudio()?.play().catch(() => {});
      }
      return;
    }
    // Hold suppressNative across the bottom player's resulting 'pause' macrotask
    // so onPlayStateChange doesn't echo back and re-pause the native redundantly.
    suppressNative = true;
    player.pause();
    setTimeout(() => { suppressNative = false; }, 0);
  };

  // --- tab regains visibility: re-sync the native button as a fallback -----
  // Covers cases where the background resume above didn't stick (e.g. the
  // browser re-suspended the native audio again while still hidden).
  const onVisibilityChange = () => {
    if (document.hidden) return;
    if (player.currentPlaylistId !== 'currentpage' || !player.isPlaying) return;
    const nativeAudio = getNativeAudio();
    if (!nativeAudio || !nativeAudio.paused) return;
    suppressNative = true;
    nativeAudio.play().catch(() => {});
    setTimeout(() => { suppressNative = false; }, 0);
  };

  // --- native → bottom: seek sync ---
  const onNativeSeeked = () => {
    if (suppressSeekSync) return;
    const nativeAudio = getNativeAudio();
    if (!nativeAudio || !isFinite(nativeAudio.duration)) return;
    player.seekToFraction(nativeAudio.currentTime / nativeAudio.duration);
  };

  // --- bottom → native: seek sync ---
  player.onSeek = (fraction) => {
    const nativeAudio = getNativeAudio();
    if (!nativeAudio || !isFinite(nativeAudio.duration)) return;
    suppressSeekSync = true;
    nativeAudio.currentTime = fraction * nativeAudio.duration;
    queueMicrotask(() => { suppressSeekSync = false; });
  };

  // --- bottom → native: play/pause sync ---
  // When the bottom player plays or pauses, mirror that state on the native
  // audio element so the native play button glyph stays accurate. We only
  // resume the native audio when the active playlist is 'currentpage'; for
  // cart/discography playback the native button should remain in the paused
  // state. suppressNative is held until the next task so the resulting native
  // play/pause event doesn't echo back through onNativePlay/onNativePause.
  player.onPlayStateChange = (playing) => {
    if (suppressNative) return;
    const nativeAudio = getNativeAudio();
    if (!nativeAudio) return;
    suppressNative = true;
    if (playing && player.currentPlaylistId === 'currentpage') {
      nativeAudio.play().catch(() => {});
      setTimeout(() => { suppressNative = false; }, 0);
    } else {
      nativeAudio.pause();
      if (player.isPlaylistSwitching) {
        // Reset the native player's position to 0:00. Setting currentTime can
        // trigger Bandcamp's seek handler asynchronously (which may call play()),
        // so hold suppressNative for 500ms to cover that window. Also suppress
        // the resulting seeked echo back to the bottom player.
        suppressSeekSync = true;
        nativeAudio.currentTime = 0;
        setTimeout(() => { suppressNative = false; suppressSeekSync = false; }, 500);
      } else {
        setTimeout(() => { suppressNative = false; }, 0);
      }
    }
  };

  // --- bottom → native: track selection ---
  player.onCurrentPageTrackChange = (pageUrl) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(SEL_NATIVE_TRACK_ROW));
    const row = rows.find((r) => {
      const a = r.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
      if (!a) return false;
      return normalizeUrl(new URL(a.href, location.href).href) === normalizeUrl(pageUrl);
    });
    if (!row) return;
    suppressNative = true;
    const rowPlay = row.querySelector<HTMLElement>(SEL_NATIVE_ROW_PLAY);
    (rowPlay ?? row).click();
    const nativeAudio = getNativeAudio();
    if (nativeAudio) nativeAudio.pause();
    // Use setTimeout(0) rather than queueMicrotask: the row click causes the
    // native audio to fire a 'play' event as a macrotask, and we must keep
    // suppressNative set until after it fires so onNativePlay doesn't echo
    // back and restart the bottom player.
    setTimeout(() => { suppressNative = false; }, 0);
  };

  // Attach play/pause/seeked listeners to the native audio element and mute it
  // so only the bottom player produces sound. Bandcamp may create the element
  // lazily (on first play), so we also watch for it appearing in the DOM.
  let attachedAudio: HTMLAudioElement | null = null;
  const attach = (audio: HTMLAudioElement) => {
    audio.muted = true;
    audio.addEventListener('play', onNativePlay);
    audio.addEventListener('pause', onNativePause);
    audio.addEventListener('seeked', onNativeSeeked);
    attachedAudio = audio;
  };

  document.addEventListener('visibilitychange', onVisibilityChange);

  const initialAudio = getNativeAudio();
  if (initialAudio) {
    attach(initialAudio);
  } else {
    const audioWatcher = new MutationObserver(() => {
      const found = getNativeAudio();
      if (found) {
        audioWatcher.disconnect();
        attach(found);
      }
    });
    audioWatcher.observe(document.body, { childList: true, subtree: true });
  }

  // --- native → bottom: track changes (native current_track class change) ---
  const trackTableObserver = new MutationObserver(() => {
    if (suppressNative) return;
    const currentRow = document.querySelector<HTMLElement>(`${SEL_NATIVE_TRACK_ROW}.current_track`);
    if (!currentRow) return;
    const a = currentRow.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
    if (!a) return;
    player.cueTrackByPageUrl('currentpage', new URL(a.href, location.href).href);
  });

  const trackTable = document.querySelector<HTMLElement>(SEL_NATIVE_TRACK_TABLE);
  if (trackTable) {
    trackTableObserver.observe(trackTable, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  return () => {
    trackTableObserver.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (attachedAudio) {
      attachedAudio.muted = false;
      attachedAudio.removeEventListener('play', onNativePlay);
      attachedAudio.removeEventListener('pause', onNativePause);
      attachedAudio.removeEventListener('seeked', onNativeSeeked);
    }
  };
}
