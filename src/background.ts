import type { BcpRequest, FetchResponse } from './messages';
import { createLimiter, dedupeInFlight, type Priority } from './inflight';
import { pruneTrackCache } from './cache';
import { isCartAddRejected } from './bandcamp';

chrome.runtime.onStartup.addListener(() => { void pruneTrackCache(); });
chrome.runtime.onInstalled.addListener(() => { void pruneTrackCache(); });

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
