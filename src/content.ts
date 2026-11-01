import type { CartItem, PlaylistTrack, SavedCartItem, NamedCart } from './types';
import { hasTralbumData, parseTralbum, isReleaseOwned } from './bandcamp';
import { Player } from './player';
import { setupNativePlayerSync } from './native-sync';
import { probeCart, probeDiscography, injectDiscographyButton, injectRestoreCartButton, injectRemoveAlreadyOwnedButton, injectCheckoutCartButton } from './probe';
import { addSnapshotIfChanged, loadSnapshots, saveSnapshots } from './cart-history';
import { openCartHistoryModal } from './cart-history-modal';
import { createNamedCart, deleteNamedCart, toggleItemInNamedCart, partitionByCart } from './named-carts';
import { normalizeUrl } from './url';
import { ensureModalStyles } from './styles';
import {
  readCache,
  readCacheBatch,
  needsPlayabilityRecheck,
  writeCache,
  TRACK_DETAILS_MAX_AGE_MS,
  LIVE_DATA_MAX_AGE_MS,
} from './cache';
import {
  readPageContext,
  isTrackOrAlbumPage,
  isLoggedIn,
  clickCheckout,
  SEL_SIDECART_BODY,
  SEL_SIDECART_ITEM_LIST,
  SEL_SIDECART_ITEM_LINK,
  SEL_MUSIC_GRID,
  SEL_MUSIC_GRID_ITEM,
  SEL_GRID_ITEM_TITLE,
} from './bandcamp-dom';
import { sendBcpMessage } from './messages';
import { mapWithConcurrency } from './inflight';
import { log, initDebugLogging } from './log';
import { loadSettings } from './settings';

// Appended to error messages: the [bcp] logs are silent until the user switches them on.
const DEBUG_LOGGING_HINT = "Turn on debug logging in the extension's advanced options and check the browser console for details.";

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

// Per playlist, normalised release URL → its tracks, for the ▶ buttons on the
// page. The tracks are the playlist's own objects, so a button finds them
// wherever they are in the playlist, and stream refetches that change their
// playability show up here too.
const tracksByReleaseUrl: Record<'cart' | 'discography', Map<string, PlaylistTrack[]>> = {
  cart: new Map(),
  discography: new Map(),
};

// The live named-cart list and the Player instance for the current page, if any
// (main() can return before creating a Player when there's nothing to play).
// Kept at module scope so the "Checkout a cart" button — injected independently
// of the Player — can read the current values from its click handler.
let namedCarts: NamedCart[] = [];
let activePlayer: Player | null = null;

// Maps normalised cart item URL → Bandcamp cart line-item id.
// req=del needs this id (assigned when the item entered the cart), not the tralbum id.
// Populated from cart_data.items in cart operation responses.
let cartLineItemIds = new Map<string, number>();

// True while a bulk cart-cleanup flow (already-owned check or history restore)
// is running. Both mutate the same cart and each reloads the page when done, so
// running them at once would race.
let cartCleanupInFlight = false;

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

// --- Named-cart storage --------------------------------------------------------

const NAMED_CARTS_KEY = 'bcp_named_carts_v1';

interface NamedCartsStorage {
  carts: NamedCart[];
  updatedAt: number;
}

async function loadNamedCarts(): Promise<NamedCart[]> {
  try {
    const result = await chrome.storage.local.get(NAMED_CARTS_KEY);
    const entry = result[NAMED_CARTS_KEY] as NamedCartsStorage | undefined;
    return entry?.carts ?? [];
  } catch {
    return [];
  }
}

function saveNamedCarts(carts: NamedCart[]): void {
  // Keep the sidecart's "Checkout a cart (N)" count in step with the carts.
  if (document.querySelector('.bcp-checkout-cart-btn')) injectCheckoutCartButton(carts.length);
  chrome.storage.local.set({ [NAMED_CARTS_KEY]: { carts, updatedAt: Date.now() } }).catch(() => {});
}

// --- Named carts --------------------------------------------------------------
// Named carts are pure metadata: tagging a track never touches the real
// Bandcamp cart or makes a network request. Checkout resolves each entry's
// release page on demand (like the partial-checkout flow below) and opens a
// private window, exactly as "Checkout selected" does.

// Builds the SavedCartItem stored on tag. Prefers the live sidecart entry
// (its title already has the ", digital track/album" suffix stripped by
// probeCart()); falls back to the track's own metadata for an item that has
// since left the real cart.
function toSavedCartItem(track: PlaylistTrack, cartItemUrl: string): SavedCartItem {
  const cartMatch = probeCart().find((i) => normalizeUrl(i.url) === normalizeUrl(cartItemUrl));
  if (cartMatch) {
    return { url: cartMatch.url, title: cartMatch.title, artist: cartMatch.artist, purchaseType: cartMatch.purchaseType };
  }
  const title = (cartItemUrl === track.releaseUrl ? track.albumTitle : track.trackTitle) || track.trackTitle;
  return {
    url: cartItemUrl,
    title,
    artist: track.artist,
    purchaseType: cartItemTypes.get(normalizeUrl(cartItemUrl)),
  };
}

function showDeleteNamedCartConfirm(cart: NamedCart): Promise<boolean> {
  ensureModalStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'bcp-hb';

    const modal = document.createElement('div');
    modal.className = 'bcp-hm';

    const title = document.createElement('h3');
    title.textContent = `Delete "${cart.name}"?`;
    modal.appendChild(title);

    const body = document.createElement('div');
    body.style.cssText = 'font-size:13px;color:#444;margin-bottom:12px';
    body.textContent = `This removes the named cart and its ${cart.items.length} item${cart.items.length !== 1 ? 's' : ''}. Your Bandcamp cart is not affected.`;
    modal.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'bcp-ha';
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
    confirmBtn.textContent = 'Delete';
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

// Opened from the player's tag button. Lets the user toggle the current track
// into any named cart, or create a new one, without closing the modal.
function showNamedCartPicker(player: Player, track: PlaylistTrack, cartItemUrl: string): void {
  ensureModalStyles();

  const backdrop = document.createElement('div');
  backdrop.className = 'bcp-hb';

  const modal = document.createElement('div');
  modal.className = 'bcp-hm';

  const title = document.createElement('h3');
  title.textContent = 'Add to named cart';
  modal.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'bcp-hl';
  modal.appendChild(list);

  const renderList = () => {
    list.innerHTML = '';
    if (namedCarts.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'bcp-nc-empty';
      empty.textContent = 'No named carts yet — create one below';
      list.appendChild(empty);
      return;
    }
    for (const cart of namedCarts) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'bcp-nc-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = cart.items.some((i) => normalizeUrl(i.url) === normalizeUrl(cartItemUrl));
      checkbox.addEventListener('change', () => {
        namedCarts = toggleItemInNamedCart(namedCarts, cart.id, toSavedCartItem(track, cartItemUrl));
        saveNamedCarts(namedCarts);
        player.setNamedCarts(namedCarts);
        renderList();
      });

      const name = document.createElement('span');
      name.className = 'bcp-nc-name';
      name.textContent = cart.name;

      const meta = document.createElement('span');
      meta.className = 'bcp-nc-meta';
      meta.textContent = `${cart.items.length} item${cart.items.length !== 1 ? 's' : ''}`;

      row.append(checkbox, name, meta);
      li.appendChild(row);
      list.appendChild(li);
    }
  };
  renderList();

  const newRow = document.createElement('div');
  newRow.className = 'bcp-nc-new';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'New cart name';
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Create + add';
  const createAndAdd = () => {
    if (!nameInput.value.trim()) return;
    namedCarts = createNamedCart(namedCarts, nameInput.value);
    const created = namedCarts[0]!;
    namedCarts = toggleItemInNamedCart(namedCarts, created.id, toSavedCartItem(track, cartItemUrl));
    saveNamedCarts(namedCarts);
    player.setNamedCarts(namedCarts);
    nameInput.value = '';
    renderList();
  };
  addBtn.addEventListener('click', createAndAdd);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createAndAdd(); });
  newRow.append(nameInput, addBtn);
  modal.appendChild(newRow);

  const actions = document.createElement('div');
  actions.className = 'bcp-ha';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'bcp-hcl';
  closeBtn.textContent = 'Done';
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

// Opened from the sidecart's "Checkout a cart" button. Lists every named cart
// with a per-cart checkout button, reusing the same private-window flow as
// "Checkout selected".
function showNamedCartCheckoutModal(player: Player | null): void {
  ensureModalStyles();

  const backdrop = document.createElement('div');
  backdrop.className = 'bcp-hb';

  const modal = document.createElement('div');
  modal.className = 'bcp-hm';

  const title = document.createElement('h3');
  title.textContent = 'Checkout a cart';
  modal.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'bcp-hl';

  if (namedCarts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'bcp-nc-empty';
    empty.textContent = 'No named carts yet — tag tracks from the Cart tab in the player';
    list.appendChild(empty);
  } else {
    const current = probeCart();
    for (const cart of namedCarts) {
      const li = document.createElement('li');
      const { stale } = partitionByCart(cart, current);

      const header = document.createElement('div');
      header.className = 'bcp-nc-row';

      const name = document.createElement('span');
      name.className = 'bcp-nc-name';
      name.textContent = cart.name;

      const meta = document.createElement('span');
      meta.className = 'bcp-nc-meta' + (stale.length > 0 ? ' bcp-nc-stale' : '');
      meta.textContent = `${cart.items.length} item${cart.items.length !== 1 ? 's' : ''}` +
        (stale.length > 0 ? ` (${stale.length} no longer in cart)` : '');

      const checkoutBtn = document.createElement('button');
      checkoutBtn.className = 'bcp-nc-checkout-btn';
      checkoutBtn.textContent = `Checkout (${cart.items.length})`;
      checkoutBtn.disabled = cart.items.length === 0;
      checkoutBtn.addEventListener('click', async () => {
        checkoutBtn.disabled = true;
        checkoutBtn.textContent = 'Opening…';
        const ok = await checkoutInPrivateWindow(player, cart.items);
        if (ok) {
          close();
        } else {
          checkoutBtn.disabled = false;
          checkoutBtn.textContent = `Checkout (${cart.items.length})`;
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'bcp-nc-delete-btn';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!await showDeleteNamedCartConfirm(cart)) return;
        namedCarts = deleteNamedCart(namedCarts, cart.id);
        saveNamedCarts(namedCarts);
        player?.setNamedCarts(namedCarts);
        li.remove();
      });

      header.append(name, meta, checkoutBtn, deleteBtn);
      li.appendChild(header);

      if (cart.items.length > 0) {
        const itemList = document.createElement('ul');
        itemList.className = 'bcp-nc-items';
        for (const it of cart.items) {
          const row = document.createElement('li');
          row.textContent = it.title || it.url;
          itemList.appendChild(row);
        }
        li.appendChild(itemList);
      }

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

interface CartAddTarget {
  tralbumId: number;
  tralbumType: 't' | 'a';
  minPrice: number;
  bandId: number | null;
}

// What Bandcamp's cart/cb needs to add `item`, read from its release page's
// tracks. Null when that can't be worked out.
async function resolveCartAddTarget(item: SavedCartItem, tracks: PlaylistTrack[]): Promise<CartAddTarget | null> {
  let track = tracks[0];
  if (!track) return null;
  const isTrackAdd = item.purchaseType === 'track';
  // Album purchases can link to one of the album's track pages, whose own ids
  // are the track's: adding those would buy just that track, or be refused for
  // an album-only track, so add the album's copy instead.
  if (item.purchaseType === 'album' && track.releaseType === 'track' && track.albumUrl) {
    const albumTrack = await albumTrackFor(track);
    if (albumTrack === null) return null;
    track = albumTrack;
  }
  const tralbumId = isTrackAdd ? (track.trackId ?? track.releaseId) : track.releaseId;
  if (tralbumId === null) return null;
  return {
    tralbumId,
    tralbumType: isTrackAdd ? 't' : (track.releaseType === 'track' ? 't' : 'a'),
    minPrice: (isTrackAdd ? (track.trackMinPrice ?? track.minPrice) : track.minPrice) ?? 0,
    bandId: track.bandId,
  };
}

// `preparedTracks` are release details fetched moments ago; without them the
// release page is fetched (or read from a cache entry under an hour old).
async function addCartItem(item: SavedCartItem, cartLengthHint: number, preparedTracks?: PlaylistTrack[]): Promise<boolean> {
  const tracks = preparedTracks ?? (await fetchTracksForUrl(item.url, LIVE_DATA_MAX_AGE_MS));
  if (tracks.length === 0) {
    log.error('[bcp] cart-add: could not fetch release page for', item.url);
    return false;
  }

  const target = await resolveCartAddTarget(item, tracks);
  if (target === null) {
    log.error('[bcp] cart-add: no tralbum id for', item.url, tracks[0]);
    return false;
  }

  const ctx = readPageContext(latestSyncNum);
  log.info('[bcp] cart-add', { url: item.url, ...target, syncNum: ctx.syncNum });

  const result = await sendBcpMessage({
    type: 'cart-add',
    ...target,
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

  log.error('[bcp] cart-add failed for', item.url, { error: result.error, body: result.body });
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
      log.error('[bcp] cart-remove: could not fetch release page for', item.url);
      return false;
    }

    const track = tracks[0]!;
    const isTrackItem = item.purchaseType === 'track';
    if (isTrackItem) {
      tralbumId = track.trackId ?? track.releaseId;
    } else {
      // Album purchases can link to one of the album's own track pages, so the
      // fetched "release page" can really be a track page whose own releaseId
      // is the track's, not the album's — resolve the album's copy instead.
      const albumTrack = track.releaseType === 'track' ? await albumTrackFor(track) : null;
      tralbumId = albumTrack?.releaseId ?? track.releaseId;
    }
    if (tralbumId === null) {
      log.error('[bcp] cart-remove: no tralbum id for', item.url, track);
      return false;
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const idToSend = lineItemId ?? tralbumId;
    const ctx = readPageContext(latestSyncNum);
    log.info('[bcp] cart-remove', { url: item.url, idToSend, syncNum: ctx.syncNum });

    const result = await sendBcpMessage({
      type: 'cart-remove',
      tralbumId: idToSend,
      releaseUrl: item.url,
      syncNum: ctx.syncNum,
      clientId: ctx.clientId,
      fanId: ctx.fanId,
    });

    if (!result.ok) {
      log.error('[bcp] cart-remove failed for', item.url, result.error, result.body);
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
  showDone(onCheckout: () => void, onContinue: () => void, onLogin: () => void, warning?: string): void;
  remove(): void;
}

// One release per line, without the scheme, for the private-window overlay.
function describeReleaseUrls(urls: string[]): string {
  return urls.map((u) => u.replace(/^https?:\/\//, '')).join('\n');
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
  Object.assign(progressEl.style, { color: '#1da0c3', fontSize: '13px', whiteSpace: 'pre-line' });
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
    showDone: (onCheckout, onContinue, onLogin, warning) => {
      titleEl.textContent = 'Your cart is ready!';
      progressEl.textContent = warning ?? '';
      if (warning) progressEl.style.color = '#e0a040';
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

// Resolves each item's release page and opens a private-window checkout
// containing exactly `items`. The real cart is left as is.
async function checkoutInPrivateWindow(player: Player | null, items: SavedCartItem[]): Promise<boolean> {
  // Without incognito access the private window still opens, but nothing runs
  // in it to build the cart. A pop-up rather than a toast: it needs action.
  const { allowed } = await sendBcpMessage({ type: 'incognito-access' });
  if (!allowed) {
    alert(
      'Bandcamp Cart Upgrade is not allowed in private windows, so it cannot build the cart there.\n\n' +
        'Turn on "Allow in incognito" for it in chrome://extensions, reload this page, and try again.'
    );
    return false;
  }

  // Resolve track data here in the normal window where the cache is warm
  // (resolvePlaylist already fetched these). The incognito window's storage
  // is a separate empty instance, so it can't use the cache.
  const resolved: Array<{ u: string; id: number; t: 't' | 'a'; pr: number; b: number | null }> = [];
  const unresolved: SavedCartItem[] = [];
  for (const item of items) {
    const target = await resolveCartAddTarget(item, await fetchTracksForUrl(item.url, LIVE_DATA_MAX_AGE_MS));
    if (target === null) {
      unresolved.push(item);
      continue;
    }
    resolved.push({ u: item.url, id: target.tralbumId, t: target.tralbumType, pr: target.minPrice, b: target.bandId });
  }
  if (resolved.length === 0) {
    const msg = `Could not resolve any selected items. ${DEBUG_LOGGING_HINT}`;
    if (player) player.showToast(msg, 'error'); else alert(msg);
    return false;
  }

  const result = await sendBcpMessage({ type: 'open-incognito-checkout', items: resolved });
  if (!result.ok) {
    const msg = `Could not open a private window: ${result.error ?? 'unknown error'}`;
    if (player) player.showToast(msg, 'error'); else alert(msg);
    return false;
  }

  if (unresolved.length > 0) {
    const msg = `Left out of the private cart, as they could not be looked up: ${unresolved.map((i) => i.title || i.url).join(', ')}`;
    if (player) player.showToast(msg, 'warn'); else alert(msg);
  }
  return true;
}

// Album purchases can link to one of the album's track pages; owning just
// that track doesn't mean owning the album, so those are checked on the album
// page. Returns null when the release page couldn't be fetched.
async function isCartItemOwned(item: CartItem): Promise<boolean | null> {
  const html = await fetchRawHtml(item.url);
  if (html === null) return null;
  if (item.purchaseType === 'album') {
    const albumUrl = parseTralbum(html, item.url)[0]?.albumUrl;
    if (albumUrl) {
      const albumHtml = await fetchRawHtml(albumUrl);
      return albumHtml === null ? null : isReleaseOwned(albumHtml);
    }
  }
  return isReleaseOwned(html);
}

// Checks every cart item against Bandcamp's own ownership state and removes
// whichever ones the fan already owns — e.g. items bought through a
// private-window checkout, whether or not the extension opened it.
function setupRemoveAlreadyOwnedButton(): void {
  const btn = injectRemoveAlreadyOwnedButton();
  if (!btn) return;
  const idleLabel = btn.textContent ?? 'Remove already purchased items from cart';
  const reset = () => {
    btn.disabled = false;
    btn.textContent = idleLabel;
  };
  btn.addEventListener('click', async () => {
    if (cartCleanupInFlight) {
      alert('Another cart cleanup is already in progress — please wait for it to finish.');
      return;
    }
    cartCleanupInFlight = true;
    btn.disabled = true;

    try {
      let owned: CartItem[];
      let uncheckedNote: string;
      try {
        // Re-probed on click: items can be added to the sidecart without a reload.
        const cartItems = probeCart();
        const ownedItems: CartItem[] = [];
        const unchecked: CartItem[] = [];
        for (let i = 0; i < cartItems.length; i++) {
          const item = cartItems[i]!;
          btn.textContent = `Checking "${item.title || item.url}" (${i + 1} / ${cartItems.length})…`;
          const isOwned = await isCartItemOwned(item);
          if (isOwned === null) unchecked.push(item);
          else if (isOwned) ownedItems.push(item);
        }
        owned = ownedItems;
        uncheckedNote = unchecked.length > 0
          ? `\n\nCould not check ${unchecked.length} item${unchecked.length !== 1 ? 's' : ''}: ${unchecked.map((i) => i.title || i.url).join(', ')}`
          : '';
      } catch (err) {
        log.error('[bcp] remove already owned: checking cart failed', err);
        reset();
        alert(`Checking the cart for already-purchased items failed. ${DEBUG_LOGGING_HINT}`);
        return;
      }

      if (owned.length === 0) {
        reset();
        alert(`No already-purchased items found in your cart.${uncheckedNote}`);
        return;
      }

      const toRemove: SavedCartItem[] = owned.map((i) => ({ url: i.url, title: i.title, artist: i.artist, purchaseType: i.purchaseType }));
      if (!await showRemovePurchasedConfirm(toRemove)) {
        reset();
        return;
      }

      try {
        const failed: SavedCartItem[] = [];
        for (let i = 0; i < toRemove.length; i++) {
          const item = toRemove[i]!;
          btn.textContent = `Removing "${item.title || item.url}" (${i + 1} / ${toRemove.length})…`;
          if (!await removeCartItem(item)) failed.push(item);
        }
        if (failed.length > 0 || uncheckedNote) {
          const failedNote = failed.length > 0
            ? `\n\nCould not remove: ${failed.map((i) => i.title || i.url).join(', ')}`
            : '';
          alert(`Removed ${toRemove.length - failed.length} of ${toRemove.length} already-purchased items.${failedNote}${uncheckedNote}`);
        }
        location.reload();
      } catch (err) {
        // Some items may already be gone from the live cart even though this threw —
        // reload so the sidecart reflects the real cart state instead of a stale one.
        log.error('[bcp] remove already owned: removing items failed', err);
        alert(`Removing already-purchased items from the cart failed partway through. Reloading to show the current cart state. ${DEBUG_LOGGING_HINT}`);
        location.reload();
      }
    } finally {
      cartCleanupInFlight = false;
    }
  });
}

main().catch(log.error);

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

  const { tracks: cartTracks, tracksByRelease, problems, recheckUrls } = await resolvePlaylist(cartItems, reportProgress);
  cartItemProblems = new Map(Array.from(problems, ([url, problem]) => [normalizeUrl(url), problem]));

  if (cartTracks.length === 0) {
    const { label, reason } = describeNothingToPlay(cartItems.length, problems, 'in your cart');
    player.setPlaylistUnavailable('cart', `Cart (${label})`, reason, 'error');
    player.setPlaylistStatus('cart', `Cart: ${label}`, 'error');
    if (player.currentPlaylistId === null) player.setStatus(`Cart: ${label}`, 'error');
    return;
  }

  tracksByReleaseUrl.cart = tracksByRelease;
  player.setPlaylist('cart', 'Cart', cartTracks);
  document.body.style.paddingBottom = `${player.wrapper.offsetHeight}px`;
  injectCartPlayButtons(player);
  cartItems.forEach((item) => injectCheckboxForSidecartItem(item.url));
  injectCheckoutSelectedBtn(player);

  refreshCartStatus(player);
  void recheckPlayability(recheckUrls, player).then(() => refreshCartStatus(player));
}

async function main() {
  // Before anything else, so nothing logs while the stored option is still unknown.
  await initDebugLogging();
  log.info('[bcp] cart player loaded');

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
        log.error('[bcp] incognito stage A: could not parse payload');
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
        // Release URLs Bandcamp didn't add, listed on the ready screen.
        const failed: string[] = [];
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
          } else {
            log.error('[bcp] incognito stage A: could not add', it.u, result.error);
            failed.push(it.u);
          }
          overlay.setProgress(`${added} / ${items.length} items`);
          if (cancelled) break;
        }

        if (!cancelled && added === 0) {
          overlay.setTitle('Could not add items to cart');
          overlay.setProgress(
            `Bandcamp did not add:\n${describeReleaseUrls(failed)}\n\n` +
              'Try logging into Bandcamp in this window and refreshing.'
          );
          // Leave overlay visible so the message is readable; user closes the tab.
        } else if (cancelled) {
          overlay.remove();
        } else {
          // Reload so the page reflects the cart we just built, then show options.
          location.assign(`https://bandcamp.com/cart#bcp_cart_ready=${encodeURIComponent(JSON.stringify(failed))}`);
        }
      }

      return;
    }

    // --- Stage B (ready) — cart built, show options on freshly loaded page ---
    // Arrives here after Stage A navigates to this hash, giving the page a
    // chance to reflect the newly populated cart before the user acts.
    if (hash.startsWith('#bcp_cart_ready=')) {
      history.replaceState(null, '', window.location.pathname);

      let failed: string[] = [];
      try {
        const raw = JSON.parse(decodeURIComponent(hash.slice('#bcp_cart_ready='.length))) as unknown;
        if (Array.isArray(raw)) failed = raw.filter((u): u is string => typeof u === 'string');
      } catch {
        log.error('[bcp] incognito stage B: could not parse the items that were not added');
      }

      const overlay = createProgressOverlay('Your cart is ready!');
      overlay.showDone(
        () => { location.assign('https://bandcamp.com/cart#bcp_go_checkout=1'); },
        () => { overlay.remove(); },
        () => { location.assign('https://bandcamp.com/login'); },
        failed.length > 0
          ? `Bandcamp did not add ${failed.length} item${failed.length !== 1 ? 's' : ''}:\n${describeReleaseUrls(failed)}`
          : undefined,
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
    setupRemoveAlreadyOwnedButton();

    const liveItems: SavedCartItem[] = cartItems.map((i) => ({ url: i.url, title: i.title, purchaseType: i.purchaseType }));
    const snapshots = addSnapshotIfChanged(await loadSnapshots(), liveItems);
    saveSnapshots(snapshots).catch(() => {});

    if (settings.showCartHistoryBtn && snapshots.length > 0) {
      const btn = injectRestoreCartButton(snapshots.length);
      if (btn) {
        btn.addEventListener('click', async () => {
          if (cartCleanupInFlight) {
            alert('Another cart cleanup is already in progress — please wait for it to finish.');
            return;
          }
          cartCleanupInFlight = true;
          try {
            const modalInitialItems: SavedCartItem[] = probeCart().map((i) => ({ url: i.url, title: i.title, purchaseType: i.purchaseType }));
            // Filled by prepareAdds and used once by the matching add; a later
            // single "Add back" fetches a fresh copy.
            const preparedTracks = new Map<string, PlaylistTrack[]>();
            const changedCount = await openCartHistoryModal({
              snapshots,
              initialItems: modalInitialItems,
              addItem: async (item, cartLengthHint) => {
                const prepared = preparedTracks.get(item.url);
                preparedTracks.delete(item.url);
                const ok = await addCartItem(item, cartLengthHint, prepared);
                if (ok) addSidecartItem(item.url, item.title, null, item.purchaseType === 'track' ? 'track' : 'release');
                return ok;
              },
              removeItem: async (item) => {
                const ok = await removeCartItem(item);
                if (ok) removeSidecartItem(item.url);
                return ok;
              },
              prepareAdds: async (items, onProgress) => {
                let done = 0;
                await mapWithConcurrency(
                  items,
                  RELEASE_FETCH_CONCURRENCY,
                  (item) => fetchTracksForUrl(item.url, LIVE_DATA_MAX_AGE_MS, { bulk: true }),
                  (tracks, item) => {
                    preparedTracks.set(item.url, tracks);
                    done++;
                    onProgress(done);
                  }
                );
              },
            });
            if (changedCount > 0) location.reload();
          } finally {
            cartCleanupInFlight = false;
          }
        });
      }
    }

    // "Checkout a cart" doesn't need the Player instance (it opens a private
    // window directly), so it's injected here rather than gated behind the
    // player-creation check below — it still appears when the real cart is
    // empty. The click handler reads `activePlayer`, which may still be null
    // at this point; it's read lazily so it reflects whichever value is set
    // (or not) by the time the user actually clicks.
    namedCarts = await loadNamedCarts();
    ensureModalStyles();
    const checkoutCartBtn = injectCheckoutCartButton(namedCarts.length);
    checkoutCartBtn?.addEventListener('click', () => showNamedCartCheckoutModal(activePlayer));
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

  log.info('[bcp] Cart items found:');
  log.table(cartItems.map((it) => ({ type: it.type, title: it.title, artist: it.artist, url: it.url })));

  // Probe discography early so we can show the player on label pages even when
  // the cart is empty. Release pages always get the player for their own tracks.
  const discoItems = probeDiscography();

  if (cartItems.length === 0 && discoItems.length === 0 && !isTrackOrAlbumPage()) {
    log.warn(
      '[bcp] No cart items detected. The cart may be empty, or the selectors need updating. ' +
        'Open DevTools, inspect the cart item DOM nodes, and update probeCart() in src/content.ts.'
    );
    return;
  }

  const player = new Player([]);
  document.body.appendChild(player.wrapper);
  activePlayer = player;

  if (cartItems.length === 0) {
    const reason = document.querySelector(SEL_SIDECART_BODY)
      ? 'No items found in your shopping cart. If it is not empty, Bandcamp may have changed its page layout.'
      : 'Your cart is empty: Bandcamp shows no shopping cart on this page. Use + Track, + Release or + Cart to add something.';
    player.setPlaylistUnavailable('cart', 'Cart (empty)', reason);
  }

  // Build the initial cart URL set and purchase-type map.
  cartItemTypes = buildCartItemTypes(cartItems);
  player.setCartUrls(buildCartUrlSet(cartItems));
  // Named carts are skipped entirely in incognito: its storage is a separate,
  // throwaway instance (same reason cart history is skipped, see below).
  if (!chrome.extension.inIncognitoContext) {
    // Set before setNamedCarts() renders, which only draws tag buttons once a handler exists.
    player.onTagTrack = (track, cartItemUrl) => showNamedCartPicker(player, track, cartItemUrl);
    player.setNamedCarts(namedCarts);
  }

  player.onTrackChange = (id, index) => {
    const track = player.getPlaylistTracks(id)[index];
    if (id === 'cart') {
      highlightCartItem(track ? releaseUrlForTrack('cart', track) : null);
      clearDiscoHighlight();
    } else if (id === 'discography') {
      clearCartHighlight();
      highlightDiscoItem(track ? releaseUrlForTrack('discography', track) : null);
    } else {
      clearCartHighlight();
      clearDiscoHighlight();
    }
  };

  // Wire up cart mutation callbacks.
  player.onCartAdd = async (pageTrack, requestedAddType) => {
    // "+ Release" on a single-track page adds the album the track belongs to,
    // as a release add of the album's copy of the track.
    const track = requestedAddType === 'album' ? await albumTrackFor(pageTrack) : pageTrack;
    const addType = requestedAddType === 'album' ? 'release' : requestedAddType;
    if (track === null) {
      player.showToast('Could not load the album, please try again', 'error');
      return;
    }

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
      // Tracks another cart item already holds (e.g. a track of an album in
      // the cart) are not added twice, but the new item still gets its buttons.
      player.addTracksToPlaylist('cart', tracksToAdd);
      tracksByReleaseUrl.cart.set(normalizeUrl(cartItemUrl), tracksToAdd);
      injectPlayButtonForSidecartItem(cartItemUrl, player);
      injectCheckboxForSidecartItem(cartItemUrl);
      refreshCartStatus(player);
    } else {
      player.setStatus(`Add failed: ${result.error ?? 'unknown error'}`, 'error');
    }
  };

  player.onCartRemove = async (pageTrack, cartItemUrl) => {
    // A single-track page's album sits in the cart under the album's url and id.
    const isAlbumOfTrackPage = !!pageTrack.albumUrl &&
      normalizeUrl(cartItemUrl) === normalizeUrl(pageTrack.albumUrl);
    const track = isAlbumOfTrackPage ? await albumTrackFor(pageTrack) : pageTrack;
    if (track === null) {
      player.setStatus('Remove failed: could not load the album', 'error');
      return;
    }

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
      // Keep tracks another cart item still holds, e.g. the album of a removed track.
      const removedTracks = tracksByReleaseUrl.cart.get(normalizeUrl(cartItemUrl)) ?? (isTrackItem ? [track] : null);
      tracksByReleaseUrl.cart.delete(normalizeUrl(cartItemUrl));
      const stillHeld = new Set(Array.from(tracksByReleaseUrl.cart.values()).flat().map((t) => normalizeUrl(t.pageUrl)));
      const removedPages = new Set(removedTracks?.map((t) => normalizeUrl(t.pageUrl)));
      const releaseUrl = normalizeUrl(track.releaseUrl);
      const wasRemoved = (t: PlaylistTrack) =>
        removedTracks ? removedPages.has(normalizeUrl(t.pageUrl)) : normalizeUrl(t.releaseUrl) === releaseUrl;
      player.removeTracks('cart', (t) => wasRemoved(t) && !stillHeld.has(normalizeUrl(t.pageUrl)));
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

    const items: SavedCartItem[] = selectedItems.map((i) => ({
      url: i.url, title: i.title, artist: i.artist, purchaseType: i.purchaseType,
    }));
    await checkoutInPrivateWindow(player, items);
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
  player.onRefreshStream = async (track, force, bulk = false) => {
    const fresh = await fetchTracksForUrl(track.releaseUrl, force ? 0 : LIVE_DATA_MAX_AGE_MS, { bulk });
    // `track` may no longer be in any playlist, e.g. after its release was removed mid-play.
    applyFreshStreams(fresh, [track, ...allPlaylistTracks(player)]);
    refreshPlayButtons();
  };

  // The current page's tracks are already in the DOM, so they load before the
  // cart and discography, which each need a fetch per release. Being the first
  // playlist set, it also becomes the active one.
  const pageTracks = isTrackOrAlbumPage()
    ? parseTralbum(document.documentElement.outerHTML, location.href)
    : [];
  const pageLoadedAt = Date.now();
  for (const track of pageTracks) track.streamFetchedAt = pageLoadedAt;
  if (pageTracks.length > 0) {
    const n = pageTracks.length;
    player.setPlaylist('currentpage', 'Current page', pageTracks);
    player.setPlaylistStatus('currentpage', `${n} track${n !== 1 ? 's' : ''}`, 'info');
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
  // Set once every release is in the discography playlist, rather than just
  // those played from the grid while it loaded.
  let discoLoaded = false;
  const resolveDiscography = async (): Promise<boolean> => {
    const reportProgress = (done: number) => {
      const progress = `${done} / ${discoItems.length}`;
      // A release played before the rest loaded keeps its tab usable meanwhile.
      if (player.getPlaylistTracks('discography').length > 0) {
        player.setPlaylistStatus('discography', `Loading the rest of the label: ${progress} releases`, 'loading');
      } else {
        player.setPlaylistUnavailable(
          'discography',
          `Label discography (loading ${progress})`,
          `Loading track info for this label: ${done} of ${discoItems.length} releases done.`,
          'loading'
        );
      }
      if (discoBtn) {
        discoBtn.textContent = `Loading label discography… ${progress}`;
        discoBtn.disabled = true;
      }
    };
    reportProgress(0);
    const { tracks: discoTracks, tracksByRelease, problems, recheckUrls } = await resolvePlaylist(discoItems, reportProgress);
    if (discoTracks.length === 0) {
      const { label, reason } = describeNothingToPlay(discoItems.length, problems, 'on this page');
      // Releases already played from the grid stay in the playlist.
      if (player.getPlaylistTracks('discography').length > 0) player.setPlaylistStatus('discography', reason, 'error');
      else player.setPlaylistUnavailable('discography', `Label discography (${label})`, reason, 'error');
      if (discoBtn) discoBtn.textContent = 'No playable discography tracks found';
      return false;
    }
    discoLoaded = true;
    tracksByReleaseUrl.discography = tracksByRelease;
    player.setPlaylist('discography', 'Label discography', discoTracks);
    player.setPlaylistStatus('discography', `${discoItems.length} releases (${discoTracks.length} tracks)`, 'info');
    refreshPlayButtons();
    if (discoBtn) {
      discoBtn.textContent = `Play label discography: ${discoItems.length} releases (${discoTracks.length} tracks)`;
      discoBtn.disabled = false;
    }
    void recheckPlayability(recheckUrls, player);
    return true;
  };
  const loadDiscography = (): Promise<boolean> => {
    discoLoad ??= resolveDiscography();
    return discoLoad;
  };
  // Loading can take minutes, so it only starts playing if the user has not
  // started something else in the meantime.
  const playDiscographyWhenLoaded = async (play: () => boolean, nothingToPlay: string): Promise<void> => {
    const playStartsAtClick = player.playStartCount;
    if (!(await loadDiscography())) return;
    if (player.playStartCount !== playStartsAtClick) {
      player.showToast('Label discography loaded', 'info');
      return;
    }
    if (!play()) player.showToast(nothingToPlay, 'warn');
  };
  // A grid ▶ plays its own release as soon as that one is fetched, and the
  // rest of the label loads behind it, keeping the release playing.
  const playGridRelease = async (item: CartItem): Promise<void> => {
    if (discoLoaded) {
      if (!playRelease(player, 'discography', item.url)) player.showToast(NO_RELEASE_STREAMS, 'warn');
      return;
    }
    const playStartsAtClick = player.playStartCount;
    void loadDiscography();
    const tracks = await fetchTracksForUrl(item.url);
    if (!discoLoaded && tracks.length > 0 && tracks.every((t) => t.unplayable)) {
      // Only greys out its ▶; the playlist gets these tracks with the rest.
      tracksByReleaseUrl.discography.set(normalizeUrl(item.url), tracks);
      refreshPlayButtons();
      player.showToast(NO_RELEASE_STREAMS, 'warn');
      return;
    }
    if (!discoLoaded && tracks.length > 0) {
      tracksByReleaseUrl.discography.set(normalizeUrl(item.url), tracks);
      player.addTracksToPlaylist('discography', tracks);
      refreshPlayButtons();
    }
    if (player.playStartCount !== playStartsAtClick) return;
    if (!playRelease(player, 'discography', item.url)) player.showToast(NO_RELEASE_STREAMS, 'warn');
  };
  const playDiscographyFromStart = (): boolean => {
    const index = player.firstTrackIndex('discography');
    if (index === undefined || player.getPlaylistTracks('discography')[index]!.unplayable) return false;
    player.jumpTo('discography', index);
    return true;
  };

  if (discoItems.length > 0) {
    // On a label page the discography is the page's own music, so its tab shows
    // before anything is fetched.
    player.setPlaylistOnDemand(
      'discography',
      `Label discography (${discoItems.length} releases)`,
      'Click to load and play every release on this page.',
      () => void playDiscographyWhenLoaded(playDiscographyFromStart, NO_DISCOGRAPHY_STREAMS)
    );

    log.info('[bcp] Discography releases found:');
    log.table(discoItems.map((it) => ({ type: it.type, url: it.url })));

    const onGridPlay = (item: CartItem) => void playGridRelease(item);
    injectDiscographyPlayButtons(discoItems, onGridPlay);
    watchMusicGrid(() => {
      injectDiscographyPlayButtons(discoItems, onGridPlay);
      refreshPlayButtons();
      const track = player.currentPlaylistId === 'discography' ? player.getActiveTrack('discography') : null;
      highlightDiscoItem(track ? releaseUrlForTrack('discography', track) : null);
    });
  }

  if (discoBtn) {
    discoBtn.textContent = `Play label discography: ${discoItems.length} releases`;
    discoBtn.style.display = player.discographyButtonEnabled ? '' : 'none';
    player.onDiscographyButtonVisibilityChange = (show) => {
      discoBtn.style.display = show ? '' : 'none';
    };
    discoBtn.addEventListener('click', () => void playDiscographyWhenLoaded(playDiscographyFromStart, NO_DISCOGRAPHY_STREAMS));
  }

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
    // Logged in, missing streams are the label's choice or Bandcamp's streaming
    // limit, which logging in doesn't lift.
    notes.push(unplayable / tracks.length >= 0.5 && !isLoggedIn()
      ? 'Log in for full streams'
      : `${unplayable} track${unplayable > 1 ? 's' : ''} unavailable`);
  }
  if (fetchFailed > 0) notes.push(`${fetchFailed} item${fetchFailed > 1 ? 's' : ''} could not be loaded`);
  if (noTracks > 0) notes.push(`${noTracks} item${noTracks > 1 ? 's have' : ' has'} nothing to play`);

  if (notes.length > 0) {
    player.setPlaylistStatus('cart', notes.join(' · '), 'warn');
  } else {
    const releaseCount = new Set(tracks.map((t) => t.releaseUrl)).size;
    player.setPlaylistStatus('cart', `${releaseCount} releases (${tracks.length} tracks)`, 'info');
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

function injectPlayButtonForSidecartItem(url: string, player: Player): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;
  const normalized = normalizeUrl(url);
  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
    if (normalizeUrl(link.href) === normalized) {
      if (link.previousElementSibling?.classList.contains('bcp-cart-play-btn')) return;
      const playBtn = createReleasePlayButton('bcp-cart-play-btn', 'Play in cart player', url, () => playCartItem(player, url));
      link.parentElement?.insertBefore(playBtn, link);
      refreshPlayButtons();
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
async function fetchRelease(url: string, { bulk = false } = {}): Promise<{ tracks: PlaylistTrack[]; problem?: ItemProblem }> {
  try {
    const response = await sendBcpMessage({ type: 'fetch', url, bulk });
    if (response.error) {
      log.warn('[bcp] Fetch error for', url, response.error);
      return { tracks: [], problem: 'fetch-failed' };
    }
    const html = response.html ?? '';
    const parsed = parseTralbum(html, url);
    if (parsed.length === 0) {
      log.warn('[bcp] No tracks parsed from', url);
      if (hasTralbumData(html)) writeCache(url, []);
      return { tracks: [], problem: 'no-tracks' };
    }
    const fetchedAt = Date.now();
    for (const track of parsed) track.streamFetchedAt = fetchedAt;
    writeCache(url, parsed);
    return { tracks: parsed };
  } catch (err) {
    log.warn('[bcp] Failed to fetch', url, err);
    return { tracks: [], problem: 'fetch-failed' };
  }
}

// Bypasses the track-metadata cache: ownership can change between visits to
// the same release page, so a stale cached fetch would miss a fresh purchase.
async function fetchRawHtml(url: string): Promise<string | null> {
  try {
    const response = await sendBcpMessage({ type: 'fetch', url });
    if (response.error) {
      log.error('[bcp] fetchRawHtml: fetch error for', url, response.error);
      return null;
    }
    return response.html ?? null;
  } catch (err) {
    log.error('[bcp] fetchRawHtml: exception for', url, err);
    return null;
  }
}

// The album's copy of a single-track page's track, which carries the album's
// id and url. Null when the album page could not be loaded.
async function albumTrackFor(track: PlaylistTrack): Promise<PlaylistTrack | null> {
  if (!track.albumUrl) return null;
  const albumTracks = await fetchTracksForUrl(track.albumUrl, LIVE_DATA_MAX_AGE_MS);
  return albumTracks.find((t) => t.trackId === track.trackId) ?? albumTracks[0] ?? null;
}

async function fetchTracksForUrl(url: string, maxAgeMs = TRACK_DETAILS_MAX_AGE_MS, { bulk = false } = {}): Promise<PlaylistTrack[]> {
  return (await readCache(url, maxAgeMs)) ?? (await fetchRelease(url, { bulk })).tracks;
}

function allPlaylistTracks(player: Player): PlaylistTrack[] {
  return (['currentpage', 'cart', 'discography'] as const).flatMap((id) => player.getPlaylistTracks(id));
}

// Copies stream links and playability from freshly fetched tracks onto the
// matching tracks already in the player.
function applyFreshStreams(fresh: PlaylistTrack[], loaded: PlaylistTrack[]): void {
  const freshByPage = new Map(fresh.map((t) => [normalizeUrl(t.pageUrl), t]));
  for (const track of loaded) {
    const match = freshByPage.get(normalizeUrl(track.pageUrl));
    if (!match) continue;
    track.streamUrl = match.streamUrl;
    track.unplayable = match.unplayable;
    track.streamFetchedAt = match.streamFetchedAt;
  }
}

// Refetches cached releases that have unplayable tracks, after their playlist
// is already showing, and updates those tracks in place.
async function recheckPlayability(urls: string[], player: Player): Promise<void> {
  if (urls.length === 0) return;
  await mapWithConcurrency(urls, RELEASE_FETCH_CONCURRENCY, (url) => fetchRelease(url, { bulk: true }), (result) => {
    if (result.tracks.length === 0) return;
    applyFreshStreams(result.tracks, allPlaylistTracks(player));
    player.refreshTrackAvailability();
    refreshPlayButtons();
  });
}

// The background worker caps fetches across all tabs; this keeps one page from
// queueing work it may not wait for, e.g. when the user navigates away.
const RELEASE_FETCH_CONCURRENCY = 4;

async function resolvePlaylist(
  items: CartItem[],
  onProgress: (done: number) => void
): Promise<{
  tracks: PlaylistTrack[];
  tracksByRelease: Map<string, PlaylistTrack[]>;
  problems: Map<string, ItemProblem>;
  recheckUrls: string[];
}> {
  const tracks: PlaylistTrack[] = [];
  const tracksByRelease = new Map<string, PlaylistTrack[]>();
  const problems = new Map<string, ItemProblem>();
  const cached = await readCacheBatch(items.map((item) => item.url));
  let done = cached.size;
  onProgress(done);

  const misses = items.filter((item) => !cached.has(item.url));
  const fetched = await mapWithConcurrency(misses, RELEASE_FETCH_CONCURRENCY, (item) => fetchRelease(item.url, { bulk: true }), () => {
    done++;
    onProgress(done);
  });
  const fetchedByUrl = new Map(misses.map((item, i) => [item.url, fetched[i]!]));

  for (const item of items) {
    const entry = cached.get(item.url);
    const result = entry ? { tracks: entry.tracks } : fetchedByUrl.get(item.url)!;
    if (result.tracks.length > 0) {
      tracks.push(...result.tracks);
      tracksByRelease.set(normalizeUrl(item.url), result.tracks);
    } else {
      problems.set(item.url, result.problem ?? 'no-tracks');
    }
  }

  const recheckUrls = Array.from(cached).filter(([, entry]) => needsPlayabilityRecheck(entry)).map(([url]) => url);
  return { tracks, tracksByRelease, problems, recheckUrls };
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

// The page item a playing track belongs to, looked up by the track itself
// because removals shift the tracks' positions in the playlist.
function releaseUrlForTrack(id: 'cart' | 'discography', track: PlaylistTrack): string | null {
  const page = normalizeUrl(track.pageUrl);
  for (const [url, tracks] of tracksByReleaseUrl[id]) {
    if (tracks.some((t) => normalizeUrl(t.pageUrl) === page)) return url;
  }
  return null;
}

function highlightCartItem(activeUrl: string | null): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;
  for (const el of Array.from(sidecartBody.querySelectorAll<HTMLElement>('.bcp-playing'))) {
    el.classList.remove('bcp-playing');
  }
  if (!activeUrl) return;
  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
    if (normalizeUrl(link.href) === activeUrl) {
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

function highlightDiscoItem(activeUrl: string | null): void {
  clearDiscoHighlight();
  if (!activeUrl) return;
  for (const li of Array.from(document.querySelectorAll<HTMLElement>(SEL_MUSIC_GRID_ITEM))) {
    const a = li.querySelector<HTMLAnchorElement>('a[href]');
    if (a && normalizeUrl(a.href) === activeUrl) li.classList.add('bcp-playing');
  }
}

function clearDiscoHighlight(): void {
  for (const li of Array.from(document.querySelectorAll<HTMLElement>(`${SEL_MUSIC_GRID_ITEM}.bcp-playing`))) {
    li.classList.remove('bcp-playing');
  }
}

function injectCartPlayButtons(player: Player): void {
  const sidecartBody = document.querySelector<HTMLElement>(SEL_SIDECART_BODY);
  if (!sidecartBody) return;

  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>(SEL_SIDECART_ITEM_LINK))) {
    if (!tracksByReleaseUrl.cart.has(normalizeUrl(link.href))) continue;
    if (link.previousElementSibling?.classList.contains('bcp-cart-play-btn')) continue; // already injected

    const url = link.href;
    const playBtn = createReleasePlayButton('bcp-cart-play-btn', 'Play in cart player', url, () => playCartItem(player, url));
    link.parentElement?.insertBefore(playBtn, link);
  }
  refreshPlayButtons();
}

// A ▶ button for one release on the page. It greys out once the release's
// tracks are known and none of them can be streamed.
function createReleasePlayButton(
  className: string,
  title: string,
  releaseUrl: string,
  onPlay: () => void,
  { stopPropagation = false } = {}
): HTMLButtonElement {
  const playBtn = document.createElement('button');
  playBtn.className = className;
  playBtn.textContent = '▶';
  playBtn.title = title;
  playBtn.dataset.playTitle = title;
  playBtn.dataset.releaseUrl = normalizeUrl(releaseUrl);
  playBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (stopPropagation) e.stopPropagation();
    if (playBtn.classList.contains('bcp-disabled')) return;
    onPlay();
  });
  return playBtn;
}

// Plays a release from its first streamable track; many releases only stream
// some of their tracks. Returns false when the release is not in the playlist.
function playRelease(player: Player, id: 'cart' | 'discography', releaseUrl: string): boolean {
  const tracks = tracksByReleaseUrl[id].get(normalizeUrl(releaseUrl));
  if (!tracks) return false;
  // Matched by page URL: adding a release to the cart skips the tracks already
  // in it, so the playlist can hold other copies of them.
  const pages = new Set(tracks.map((t) => normalizeUrl(t.pageUrl)));
  const playlist = player.getPlaylistTracks(id);
  const inRelease = (t: PlaylistTrack) => pages.has(normalizeUrl(t.pageUrl));
  let index = playlist.findIndex((t) => inRelease(t) && !t.unplayable);
  if (index === -1) index = playlist.findIndex(inRelease);
  if (index === -1) return false;
  player.jumpTo(id, index);
  return true;
}

const NO_RELEASE_STREAMS = 'No playable tracks for this release';
const NO_DISCOGRAPHY_STREAMS = 'None of the tracks on this page can be streamed';

function playCartItem(player: Player, url: string): void {
  if (!playRelease(player, 'cart', url)) player.showToast(NO_RELEASE_STREAMS, 'warn');
}

function refreshPlayButtons(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.bcp-cart-play-btn, .bcp-grid-play-btn'))) {
    const id = btn.classList.contains('bcp-cart-play-btn') ? 'cart' : 'discography';
    const tracks = tracksByReleaseUrl[id].get(btn.dataset.releaseUrl ?? '');
    const nothingToStream = tracks !== undefined && tracks.every((t) => t.unplayable);
    btn.classList.toggle('bcp-disabled', nothingToStream);
    btn.setAttribute('aria-disabled', String(nothingToStream));
    btn.title = nothingToStream ? 'No streamable tracks in this release' : (btn.dataset.playTitle ?? '');
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
      const playBtn = createReleasePlayButton('bcp-grid-play-btn', 'Play in discography player', item.url, () => onPlay(item), {
        stopPropagation: true,
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

// Bandcamp draws a big label's remaining releases into #music-grid as the page
// scrolls; `onItemsDrawn` runs after each batch so they get a ▶ too.
function watchMusicGrid(onItemsDrawn: () => void): void {
  const grid = document.querySelector<HTMLElement>(SEL_MUSIC_GRID);
  if (!grid) return;
  const isGridItem = (node: Node) =>
    node instanceof HTMLElement && (node.matches(SEL_MUSIC_GRID_ITEM) || node.querySelector(SEL_MUSIC_GRID_ITEM) !== null);
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => Array.from(m.addedNodes).some(isGridItem))) onItemsDrawn();
  });
  observer.observe(grid, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}
