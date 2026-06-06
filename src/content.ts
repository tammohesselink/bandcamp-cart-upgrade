import type { CartItem, PlaylistTrack, SavedCartItem, CartSnapshot } from './types';
import { parseTralbum } from './bandcamp';
import { Player } from './player';
import { probeCart, probeDiscography, injectDiscographyButton, injectRestoreCartButton } from './probe';
import { addSnapshotIfChanged, diffSnapshot } from './cart-history';
import { normalizeUrl } from './url';
import {
  readPageContext,
  isTrackOrAlbumPage,
  isCheckoutPage,
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

// --- Pending-restore storage (partial checkout) -------------------------------
// Leftovers from a partial checkout are persisted here and re-added
// automatically on the next non-checkout Bandcamp page load.

const PENDING_RESTORE_KEY = 'bcp_pending_restore_v1';
const MAX_RESTORE_ATTEMPTS = 3;

interface PendingRestore {
  items: SavedCartItem[];
  savedAt: number;
  attempts: number;
}

async function loadPendingRestore(): Promise<PendingRestore | null> {
  try {
    const result = await chrome.storage.local.get(PENDING_RESTORE_KEY);
    return (result[PENDING_RESTORE_KEY] as PendingRestore | undefined) ?? null;
  } catch {
    return null;
  }
}

function savePendingRestore(items: SavedCartItem[]): Promise<void> {
  const entry: PendingRestore = { items, savedAt: Date.now(), attempts: 0 };
  return chrome.storage.local.set({ [PENDING_RESTORE_KEY]: entry });
}

function clearPendingRestore(): void {
  chrome.storage.local.remove(PENDING_RESTORE_KEY).catch(() => {});
}

// --- Cart history modal ------------------------------------------------------

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${time}`;
}

function ensureHistoryStyles(): void {
  if (document.getElementById('bcp-history-styles')) return;
  const style = document.createElement('style');
  style.id = 'bcp-history-styles';
  style.textContent = `
    .bcp-hb{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999999;display:flex;align-items:center;justify-content:center}
    .bcp-hm{background:#fff;color:#1a1a1a;border-radius:8px;padding:20px 24px;max-width:520px;width:90%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.3);font-family:inherit;font-size:14px}
    .bcp-hm h3{margin:0 0 14px;font-size:15px;font-weight:600}
    .bcp-hl{list-style:none;margin:0 0 16px;padding:0;overflow-y:auto;flex:1 1 auto}
    .bcp-hl li{padding:9px 8px;border-radius:4px;border-bottom:1px solid #f0f0f0}
    .bcp-hl li:last-child{border-bottom:none}
    .bcp-hl li.bcp-clickable{cursor:pointer}
    .bcp-hl li.bcp-clickable:hover{background:#f0f9fc}
    .bcp-snap-hd{display:flex;align-items:center;gap:10px}
    .bcp-snap-ts{flex:1;font-size:13px}
    .bcp-snap-count{color:#999;font-size:12px;white-space:nowrap}
    .bcp-snap-same{color:#ccc;font-size:12px;font-weight:600;white-space:nowrap}
    .bcp-snap-restore{padding:3px 10px;border-radius:3px;border:1px solid #1da0c3;color:#1da0c3;background:none;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap}
    .bcp-snap-restore:hover{background:#e8f7fb}
    .bcp-snap-items{list-style:none;margin:5px 0 0;padding:0 0 0 8px;font-size:12px}
    .bcp-snap-items li{padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
    .bcp-item-add{color:#1da0c3}
    .bcp-item-extra{color:#bbb}
    .bcp-ha{display:flex;justify-content:flex-end;flex-shrink:0}
    .bcp-ha button{padding:7px 16px;border-radius:4px;border:1px solid #ccc;cursor:pointer;font-size:13px;font-family:inherit}
    .bcp-hcl:hover{background:#f5f5f5}
  `;
  document.head.appendChild(style);
}

function showSnapshotListModal(
  snapshots: CartSnapshot[],
  currentItems: SavedCartItem[]
): Promise<CartSnapshot | null> {
  ensureHistoryStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'bcp-hb';

    const modal = document.createElement('div');
    modal.className = 'bcp-hm';

    const title = document.createElement('h3');
    title.textContent = 'Cart history';
    modal.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'bcp-hl';

    for (const snapshot of snapshots) {
      const { toAdd, extra } = diffSnapshot(snapshot, currentItems);
      const li = document.createElement('li');

      const header = document.createElement('div');
      header.className = 'bcp-snap-hd';

      const ts = document.createElement('span');
      ts.className = 'bcp-snap-ts';
      ts.textContent = formatTimestamp(snapshot.savedAt);

      const count = document.createElement('span');
      count.className = 'bcp-snap-count';
      count.textContent = `${snapshot.items.length} item${snapshot.items.length !== 1 ? 's' : ''}`;

      header.append(ts, count);

      if (toAdd.length === 0 && extra.length === 0) {
        const same = document.createElement('span');
        same.className = 'bcp-snap-same';
        same.textContent = 'current';
        header.appendChild(same);
      } else {
        const parts: string[] = [];
        if (toAdd.length > 0) parts.push(`+${toAdd.length} item${toAdd.length !== 1 ? 's' : ''}`);
        if (extra.length > 0) parts.push(`−${extra.length} item${extra.length !== 1 ? 's' : ''}`);
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'bcp-snap-restore';
        restoreBtn.textContent = `Restore (${parts.join(' ')})`;
        restoreBtn.addEventListener('click', () => close(snapshot));
        header.appendChild(restoreBtn);
        li.classList.add('bcp-clickable');
        li.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          close(snapshot);
        });
      }

      li.appendChild(header);

      if (toAdd.length > 0 || extra.length > 0) {
        const itemList = document.createElement('ul');
        itemList.className = 'bcp-snap-items';
        for (const item of toAdd) {
          const row = document.createElement('li');
          row.className = 'bcp-item-add';
          row.textContent = `+ ${item.title || item.url}`;
          itemList.appendChild(row);
        }
        for (const item of extra) {
          const row = document.createElement('li');
          row.className = 'bcp-item-extra';
          row.textContent = `− ${item.title || item.url}`;
          itemList.appendChild(row);
        }
        li.appendChild(itemList);
      }

      list.appendChild(li);
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

    const close = (result: CartSnapshot | null) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    closeBtn.addEventListener('click', () => close(null));

    document.body.appendChild(backdrop);
  });
}

// --- Cart mutation primitives -------------------------------------------------
// Used by doRestore (cart history), onCheckoutSelected (partial checkout), and
// the auto-restore-on-return path. Keeping the hardened add/remove logic here
// ensures sync_num handling and line-item-id resolution are always consistent.

async function addCartItem(item: SavedCartItem, cartLengthHint: number): Promise<boolean> {
  const tracks = await fetchTracksForUrl(item.url);
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

    return true;
  }

  return false;
}

async function doRestore(button: HTMLButtonElement, toAdd: SavedCartItem[], toRemove: SavedCartItem[]): Promise<void> {
  button.disabled = true;
  let changed = 0;
  const errors: string[] = [];
  const total = toAdd.length + toRemove.length;

  for (let i = 0; i < toAdd.length; i++) {
    button.textContent = `Restoring ${i + 1} / ${total}…`;
    const ok = await addCartItem(toAdd[i]!, probeCart().length + i);
    if (ok) {
      changed++;
    } else {
      errors.push(`Could not restore: ${toAdd[i]!.title || toAdd[i]!.url}`);
    }
  }

  for (let i = 0; i < toRemove.length; i++) {
    button.textContent = `Restoring ${toAdd.length + i + 1} / ${total}…`;
    const ok = await removeCartItem(toRemove[i]!);
    if (ok) {
      changed++;
    } else {
      errors.push(`Remove failed: ${toRemove[i]!.title || toRemove[i]!.url}`);
    }
  }

  if (changed === 0 && total > 0) {
    button.disabled = false;
    button.textContent = 'Restore failed';
    const summary = errors.length > 0
      ? errors.slice(0, 3).join('\n') + (errors.length > 3 ? `\n…and ${errors.length - 3} more` : '')
      : 'No changes could be made. Check the DevTools console for details.';
    alert(`Cart restore failed:\n\n${summary}`);
    return;
  }

  location.reload();
}

main().catch(console.error);

async function main() {
  // --- Auto-restore leftovers from a partial checkout -----------------------
  // When the user does a partial checkout, the leftover cart items are saved to
  // storage. On the next non-checkout Bandcamp page we re-add them automatically
  // so their cart is restored to the pre-checkout state (minus what they bought).
  let autoRestoreCount = 0;
  if (!isCheckoutPage()) {
    const pending = await loadPendingRestore();
    if (pending && pending.items.length > 0) {
      if (pending.attempts >= MAX_RESTORE_ATTEMPTS) {
        console.warn('[bcp] pending restore exceeded max attempts, clearing', pending.items);
        clearPendingRestore();
      } else {
        // Increment the attempt counter before mutating so a crash mid-restore
        // still advances the counter and eventually clears the key.
        await chrome.storage.local.set({
          [PENDING_RESTORE_KEY]: { ...pending, attempts: pending.attempts + 1 },
        }).catch(() => {});

        // Show a centered modal so the user knows not to close the tab.
        const total = pending.items.length;
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
        titleEl.textContent = 'Restoring cart…';

        const progressEl = document.createElement('div');
        Object.assign(progressEl.style, { color: '#1da0c3', fontSize: '13px' });
        progressEl.textContent = `0 / ${total} items`;

        const noteEl = document.createElement('div');
        Object.assign(noteEl.style, { color: '#666', fontSize: '11px', marginTop: '10px' });
        noteEl.textContent = 'Please don\'t close this tab';

        card.append(titleEl, progressEl, noteEl);
        backdrop.appendChild(card);
        document.body.appendChild(backdrop);

        // Prevent accidental tab close while items are being re-added.
        const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
        window.addEventListener('beforeunload', onBeforeUnload);

        let allOk = true;
        for (let i = 0; i < pending.items.length; i++) {
          const ok = await addCartItem(pending.items[i]!, probeCart().length + i);
          progressEl.textContent = `${i + 1} / ${total} items`;
          if (ok) {
            autoRestoreCount++;
          } else {
            allOk = false;
          }
        }

        window.removeEventListener('beforeunload', onBeforeUnload);
        backdrop.remove();

        if (allOk) {
          clearPendingRestore();
        } else {
          console.warn(
            '[bcp] auto-restore: some items failed (attempt',
            pending.attempts + 1,
            ') — will retry on next page load'
          );
        }
      }
    }
  }
  // --------------------------------------------------------------------------

  const cartItems = probeCart();

  const liveItems: SavedCartItem[] = cartItems.map((i) => ({ url: i.url, title: i.title, purchaseType: i.purchaseType }));
  const snapshots = addSnapshotIfChanged(await loadSnapshots(), liveItems);
  saveSnapshots(snapshots);

  const settings = await loadSettings();
  if (settings.showCartHistoryBtn && snapshots.length > 0) {
    const btn = injectRestoreCartButton(snapshots.length);
    if (btn) {
      btn.addEventListener('click', async () => {
        const currentItems: SavedCartItem[] = probeCart().map((i) => ({ url: i.url, title: i.title, purchaseType: i.purchaseType }));
        const selected = await showSnapshotListModal(snapshots, currentItems);
        if (!selected) return;
        const { toAdd, extra } = diffSnapshot(selected, currentItems);
        if (toAdd.length > 0 || extra.length > 0) await doRestore(btn, toAdd, extra);
      });
    }
  }

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

  if (autoRestoreCount > 0) {
    player.showToast(`Restored ${autoRestoreCount} item${autoRestoreCount !== 1 ? 's' : ''} to cart`);
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

    let minPrice = addType === 'track' ? track.trackMinPrice : track.minPrice;

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
      const tracksToAdd = addType === 'track'
        ? [track]
        : await fetchTracksForUrl(track.releaseUrl).then((r) => r.length > 0 ? r : [track]);
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

  // Partial-checkout: remove unselected items, persist leftovers for restore,
  // then navigate to checkout in the same tab.
  player.onCheckoutSelected = async (selectedRawUrls, onProgress) => {
    const current = probeCart();
    const sel = new Set(selectedRawUrls.map(normalizeUrl));
    const leftover = current.filter((i) => !sel.has(normalizeUrl(i.url)));

    // Selecting everything is a normal full-cart checkout — no cart mutations.
    if (leftover.length === 0) {
      if (!clickCheckout()) {
        player.showToast('Could not find checkout button — opening cart page', 'warn');
        location.assign('/cart');
      }
      return;
    }

    // Persist leftovers before touching the cart so a crash/early-close still
    // leaves the restore key in place.
    await savePendingRestore(
      leftover.map((i) => ({ url: i.url, title: i.title, purchaseType: i.purchaseType }))
    );

    // Remove the leftover items from the cart, leaving only the selected ones.
    // This is the safe equivalent of "remove everything then re-add selected":
    // same end state (cart = selected only at checkout) without ever emptying
    // the cart or re-deriving IDs for items we want to keep.
    const failedRemovals: string[] = [];
    onProgress?.(0, leftover.length);
    for (let i = 0; i < leftover.length; i++) {
      const item = leftover[i]!;
      const ok = await removeCartItem({ url: item.url, title: item.title, purchaseType: item.purchaseType });
      if (!ok) failedRemovals.push(item.title || item.url);
      onProgress?.(i + 1, leftover.length);
    }

    if (failedRemovals.length > 0) {
      // Abort: navigating with unremoved items would charge the user for
      // things they didn't select. The pending key stays, so leftovers will be
      // reconciled automatically on the next non-checkout page load.
      player.showToast(
        `Could not remove ${failedRemovals.length} item${failedRemovals.length !== 1 ? 's' : ''} — checkout aborted`,
        'error'
      );
      console.error('[bcp] partial checkout aborted, remove failures:', failedRemovals);
      return;
    }

    if (!clickCheckout()) {
      player.showToast('Could not find checkout button — opening cart page', 'warn');
      location.assign('/cart');
    }
  };

  // Keep cart state in sync when Bandcamp's own JS updates the sidecart.
  const sidecartObserver = watchSidecart(player);

  // Tear down on navigation away: disconnect the observer, stop audio, and
  // remove the injected UI so subsequent pages start clean.
  window.addEventListener('pagehide', () => {
    sidecartObserver?.disconnect();
    player.destroy();
  }, { once: true });

  // Inject the discography button up front (in its disabled "Loading…" state) so it's
  // visible while the cart loads, instead of appearing only after the cart finishes.
  const discoBtn = discoItems.length > 0 ? injectDiscographyButton() : null;
  if (discoItems.length > 0) player.expectDiscography();

  if (cartItems.length > 0) {
    player.setStatus(`Loading 0 / ${cartItems.length}…`, 'loading');

    const { tracks: cartTracks, indexMap: cartIndexMap } = await resolvePlaylist(cartItems, (done) => {
      player.setStatus(`Loading ${done} / ${cartItems.length}…`, 'loading');
    });

    if (cartTracks.length === 0) {
      player.setStatus('No playable tracks found', 'error');
      return;
    }

    activeCartIndexMap = cartIndexMap;
    player.setPlaylist('cart', 'Cart', cartTracks);
    document.body.style.paddingBottom = `${player.wrapper.offsetHeight}px`;
    injectCartPlayButtons(cartIndexMap, player);
    cartItems.forEach((item) => injectCheckboxForSidecartItem(item.url));
    injectCheckoutSelectedBtn(player);

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

  if (discoItems.length > 0 && discoBtn) {
    discoBtn.style.display = player.discographyButtonEnabled ? '' : 'none';
    player.onDiscographyButtonVisibilityChange = (show) => {
      discoBtn.style.display = show ? '' : 'none';
    };


    console.log('[bcp] Discography releases found:');
    console.table(discoItems.map((it) => ({ type: it.type, url: it.url })));

    const { tracks: discoTracks, indexMap: discoIndexMap } = await resolvePlaylist(discoItems, (done) => {
      discoBtn.textContent = `Loading label discography… ${done} / ${discoItems.length}`;
    });

    if (discoTracks.length > 0) {
      activeDiscoIndexMap = discoIndexMap;
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

  if (isTrackOrAlbumPage()) {
    const pageTracks = parseTralbum(document.documentElement.outerHTML, location.href);
    if (pageTracks.length > 0) {
      player.setPlaylist('currentpage', 'Current page', pageTracks);
      const n = pageTracks.length;
      player.setPlaylistStatus('currentpage', `${n} track${n !== 1 ? 's' : ''}`, 'info');
      const teardown = setupNativePlayerSync(player);
      window.addEventListener('pagehide', teardown, { once: true });
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
  // Prune selected items no longer in the cart (e.g. removed via native sidecart).
  const freshUrls = new Set(fresh.map((i) => normalizeUrl(i.url)));
  for (const key of Array.from(cartSelection)) {
    if (!freshUrls.has(key)) cartSelection.delete(key);
  }
  updateCheckoutSelectedBtn();
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
      await player.onCheckoutSelected?.(selectedRawUrls, (done, total) => {
        btn.textContent = `Removing ${done} / ${total}…`;
      });
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
    const index = indexMap.get(item.url);
    if (index === undefined) continue;

    const itemPath = new URL(item.url).pathname;
    const lis = lisByPath.get(itemPath);
    if (!lis) continue;

    for (const li of lis) {
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
    // silent=true: native is already on the right track — don't drive it again.
    player.jumpTo('currentpage', idx === -1 ? 0 : idx, true);
  };

  // --- native → bottom: native paused ---
  const onNativePause = () => {
    if (suppressNative) return;
    // While the tab is backgrounded, Chrome suspends the muted native <audio>
    // and fires 'pause'. That is not a user action — don't stop the bottom player.
    if (document.hidden) return;
    player.pause();
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
    queueMicrotask(() => { suppressNative = false; });
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
    if (attachedAudio) {
      attachedAudio.muted = false;
      attachedAudio.removeEventListener('play', onNativePlay);
      attachedAudio.removeEventListener('pause', onNativePause);
      attachedAudio.removeEventListener('seeked', onNativeSeeked);
    }
  };
}
