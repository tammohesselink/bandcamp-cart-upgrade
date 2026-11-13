import type {
  BcpRequest,
  CartMutationResponse,
  FetchAudioResponse,
  FetchResponse,
  OrderHistoryPageRequest,
  OrderHistoryPageResponse,
  WishlistRemoveRequest,
} from './messages';
import { AUDIO_HOST_PERMISSION, MAX_AUDIO_BYTES, MAX_WHOLE_AUDIO_BYTES, bytesToBase64, isStreamUrl, readCapped } from './audio-fetch';
import { createLimiter, dedupeInFlight, type Priority } from './inflight';
import { pruneTrackCache } from './cache';
import { isCartAddRejected } from './bandcamp';
import { AUDIO_FEATURES, AUDIO_PERMISSION_REQUESTED_FOR_KEY, loadSettings, saveSetting, type AudioFeature } from './settings';

chrome.runtime.onStartup.addListener(() => { void pruneTrackCache(); });
chrome.runtime.onInstalled.addListener(() => { void pruneTrackCache(); });

// The stream permission is what turns tempo analysis and the waveform on and
// off, and this is the one place that saves them when it changes: Firefox
// closes the popup while it asks, before the popup could save it, and the
// permission can also be taken away in the browser's extension settings.
// Writing only when the value differs keeps it from overwriting a toggle the
// popup just saved.
const grantsAudio = (permissions: chrome.permissions.Permissions) =>
  !!permissions.origins?.includes(AUDIO_HOST_PERMISSION);
async function setAudioFeature(feature: AudioFeature, enabled: boolean): Promise<void> {
  if ((await loadSettings())[feature] !== enabled) await saveSetting(feature, enabled);
}
// The popup notes which toggle asked for the permission. Granted any other way
// (the browser's extension settings), it turns on tempo analysis, as it did
// before there was a waveform.
async function takeRequestedAudioFeature(): Promise<AudioFeature> {
  const result = await chrome.storage.local.get(AUDIO_PERMISSION_REQUESTED_FOR_KEY).catch(() => ({}) as Record<string, unknown>);
  const requested = result[AUDIO_PERMISSION_REQUESTED_FOR_KEY];
  await chrome.storage.local.remove(AUDIO_PERMISSION_REQUESTED_FOR_KEY).catch(() => {});
  return AUDIO_FEATURES.find((feature) => feature === requested) ?? 'tempoAnalysis';
}
chrome.permissions.onAdded.addListener((permissions) => {
  if (grantsAudio(permissions)) void takeRequestedAudioFeature().then((feature) => setAudioFeature(feature, true));
});
chrome.permissions.onRemoved.addListener((permissions) => {
  if (!grantsAudio(permissions)) return;
  void (async () => {
    for (const feature of AUDIO_FEATURES) await setAudioFeature(feature, false);
  })();
});

// Returns the https origin for a Bandcamp URL, or null if the URL isn't a valid
// https://*.bandcamp.com address. Used to refuse proxying credentialed requests
// to arbitrary hosts.
function bandcampOrigin(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return null;
    if (u.hostname !== 'bandcamp.com' && !u.hostname.endsWith('.bandcamp.com')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

// Several tabs can miss the cache for the same release at once; the service
// worker is shared by all of them, so coalescing here gives one real fetch.
const inFlightHtmlFetches = new Map<string, Promise<FetchResponse>>();

// Every tab's release-page fetches share this limit, so a few open tabs with
// large carts stay below Bandcamp's rate limiting.
const limitReleaseFetches = createLimiter(4);

// A server that never answers would otherwise hold up every playlist load
// waiting on it. Reading the page gets longer, so a slow connection still finishes.
const RESPONSE_TIMEOUT_MS = 20_000;
const BODY_TIMEOUT_MS = 60_000;

async function fetchWithTimeouts(url: string): Promise<FetchResponse> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new Error('No response within 20 s')), RESPONSE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('Page took over 60 s to download')), BODY_TIMEOUT_MS);
    return { html: await res.text() };
  } catch (err) {
    return { error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function fetchBandcampHtml(url: string, priority: Priority): Promise<FetchResponse> {
  return dedupeInFlight(inFlightHtmlFetches, url, () => limitReleaseFetches(priority, () => fetchWithTimeouts(url)));
}

// Audio downloads are a few megabytes each; two at a time keeps a playlist-wide
// detection from crowding out the stream that is playing.
const limitAudioFetches = createLimiter(2);

// A whole track is ten times the start tempo analysis reads, so it gets longer.
const WHOLE_AUDIO_TIMEOUT_MS = 180_000;

async function fetchAudio(url: string, whole: boolean): Promise<FetchAudioResponse> {
  const allowed = await chrome.permissions.contains({ origins: [AUDIO_HOST_PERMISSION] }).catch(() => false);
  if (!allowed) return { noPermission: true, error: 'Not allowed to read Bandcamp streams' };
  const maxBytes = whole ? MAX_WHOLE_AUDIO_BYTES : MAX_AUDIO_BYTES;
  const timeout = whole ? WHOLE_AUDIO_TIMEOUT_MS : BODY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Audio took over ${timeout / 1000} s to download`)), timeout);
  try {
    // The server may ignore the range and send the whole file; readCapped then
    // stops the download once it has enough.
    const res = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` }, signal: controller.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { audioBase64: bytesToBase64(await readCapped(res, maxBytes)) };
  } catch (err) {
    return { error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message: BcpRequest, sender, sendResponse) => {
  // Only act on messages from this extension's own content scripts/pages.
  if (sender.id !== chrome.runtime.id) return false;

  if (message.type === 'fetch') {
    if (!bandcampOrigin(message.url)) {
      sendResponse({ error: 'Refused: not a bandcamp.com URL' });
      return false;
    }
    fetchBandcampHtml(message.url, message.bulk ? 'bulk' : 'interactive').then(sendResponse);
    return true; // keep message channel open for async response
  }

  if (message.type === 'fetch-audio') {
    if (!isStreamUrl(message.url)) {
      sendResponse({ error: 'Refused: not a Bandcamp stream URL' });
      return false;
    }
    limitAudioFetches(message.bulk ? 'bulk' : 'interactive', () => fetchAudio(message.url, !!message.whole)).then(sendResponse);
    return true;
  }

  if (message.type === 'cart-remove') {
    // Endpoint: POST {artist}.bandcamp.com/cart/cb
    // Body fields captured via DevTools: req=del, id, client_id, sync_num, req_id
    const origin = bandcampOrigin(message.releaseUrl);
    if (!origin) {
      sendResponse({ ok: false, error: 'Invalid releaseUrl' });
      return false;
    }

    const body = new URLSearchParams({
      req: 'del',
      id: String(message.tralbumId),
      fan_id: message.fanId,
      client_id: message.clientId,
      sync_num: String(message.syncNum),
      req_id: crypto.randomUUID(),
    });

    fetch(`${origin}/cart/cb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: body.toString(),
    })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        let json: unknown;
        try { json = await res.json(); } catch { json = null; }
        // Bandcamp returns an error string in the `error` field on failure (HTTP 200).
        if (json && typeof json === 'object' && 'error' in json && (json as Record<string, unknown>).error) {
          sendResponse({ ok: false, error: String((json as Record<string, unknown>).error), body: json });
          return;
        }
        sendResponse({ ok: true, body: json });
      })
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: String(err) });
      });

    return true;
  }

  if (message.type === 'wishlist-remove') {
    // Endpoint: POST {artist}.bandcamp.com/uncollect_item_cb
    // Body fields captured via DevTools: fan_id, item_id, item_type, band_id, crumb
    // Releases on an artist's own domain go through bandcamp.com instead.
    const origin = bandcampOrigin(message.releaseUrl) ?? 'https://bandcamp.com';
    removeFromWishlist(origin, message).then(sendResponse);
    return true;
  }

  if (message.type === 'orderhistory-page') {
    fetchOrderHistoryPage(message).then(sendResponse);
    return true;
  }

  if (message.type === 'incognito-access') {
    chrome.extension.isAllowedIncognitoAccess()
      .then((allowed) => sendResponse({ allowed }))
      .catch(() => sendResponse({ allowed: false }));
    return true;
  }

  if (message.type === 'open-incognito-checkout') {
    // Open a private window at the Bandcamp cart page, passing the selected
    // items in the URL hash so the content script can add them to the fresh
    // incognito cart and proceed to checkout. chrome.windows.create opens the
    // window even when "Allow in incognito" is off — the content script just
    // never runs there — so callers check 'incognito-access' first.
    const payload = encodeURIComponent(JSON.stringify(message.items));
    const url = `https://bandcamp.com/cart#bcp_cart=${payload}`;
    chrome.windows.create({ url, incognito: true })
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === 'cart-add') {
    // Endpoint: POST {artist}.bandcamp.com/cart/cb
    // Body fields mirror Bandcamp's own add-to-cart request (captured via DevTools).
    const origin = bandcampOrigin(message.releaseUrl);
    if (!origin) {
      sendResponse({ ok: false, error: 'Invalid releaseUrl' });
      return false;
    }

    const body = new URLSearchParams({
      req: 'add',
      local_id: crypto.randomUUID(),
      item_type: message.tralbumType,
      item_id: String(message.tralbumId),
      unit_price: String(message.minPrice ?? 0),
      quantity: '1',
      band_id: String(message.bandId ?? ''),
      ip_country_code: message.countryCode,
      is_cardable: 'true',
      cart_length: String(message.cartLength),
      fan_id: message.fanId,
      client_id: message.clientId,
      sync_num: String(message.syncNum),
      req_id: crypto.randomUUID(),
    });

    fetch(`${origin}/cart/cb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: body.toString(),
    })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        let json: unknown;
        try { json = await res.json(); } catch { json = null; }
        if (json && typeof json === 'object' && 'error' in json && (json as Record<string, unknown>).error) {
          sendResponse({ ok: false, error: String((json as Record<string, unknown>).error), body: json });
          return;
        }
        if (isCartAddRejected(json, message.tralbumId, message.tralbumType)) {
          sendResponse({ ok: false, error: 'Bandcamp did not add the item', body: json });
          return;
        }
        sendResponse({ ok: true, body: json });
      })
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: String(err) });
      });

    return true;
  }

  return false;
});

// Bandcamp answers a missing or expired crumb with error "invalid_crumb" and a
// fresh crumb, so a failed first try is retried once with that one. Answers
// with the crumb the request succeeded with, for the caller to reuse.
async function postWithCrumbRetry(
  url: string,
  initialCrumb: string | null,
  buildRequest: (crumb: string) => { contentType: string; body: string },
): Promise<CartMutationResponse & { crumb?: string }> {
  let crumb = initialCrumb ?? '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const { contentType, body } = buildRequest(crumb);
    let json: Record<string, unknown> | null = null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        credentials: 'include',
        body,
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
      } catch {
        json = null;
      }
    } catch (err: unknown) {
      return { ok: false, error: String(err) };
    }
    // Anything but JSON, such as a login page once the session has expired,
    // is not a successful answer.
    if (json === null) return { ok: false, error: 'Unexpected response from Bandcamp' };
    if (!json.error) return { ok: true, body: json, crumb };
    if (json.error === 'invalid_crumb' && typeof json.crumb === 'string' && attempt === 0) {
      crumb = json.crumb;
      continue;
    }
    return { ok: false, error: String(json.error), body: json };
  }
  return { ok: false, error: 'invalid_crumb' };
}

function removeFromWishlist(origin: string, message: WishlistRemoveRequest): Promise<CartMutationResponse> {
  return postWithCrumbRetry(`${origin}/uncollect_item_cb`, message.crumb, (crumb) => ({
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({
      fan_id: message.fanId,
      item_id: String(message.itemId),
      item_type: message.itemType,
      band_id: String(message.bandId),
      crumb,
    }).toString(),
  }));
}

// One page of the fan's order history, as the purchases page itself loads it
// when scrolled. Sent from here rather than the content script, like the other
// credentialed Bandcamp calls: Firefox content-script fetches don't reliably
// carry the page's cookies.
function fetchOrderHistoryPage(message: OrderHistoryPageRequest): Promise<OrderHistoryPageResponse> {
  return postWithCrumbRetry('https://bandcamp.com/api/orderhistory/1/get_items', message.crumb, (crumb) => ({
    contentType: 'application/json',
    body: JSON.stringify({ username: message.username, last_token: message.lastToken, platform: 'Mac', crumb }),
  }));
}
