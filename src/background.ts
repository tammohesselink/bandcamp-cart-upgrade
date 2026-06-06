import type { BcpRequest } from './messages';

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

chrome.runtime.onMessage.addListener((message: BcpRequest, sender, sendResponse) => {
  // Only act on messages from this extension's own content scripts/pages.
  if (sender.id !== chrome.runtime.id) return false;

  if (message.type === 'fetch') {
    if (!bandcampOrigin(message.url)) {
      sendResponse({ error: 'Refused: not a bandcamp.com URL' });
      return false;
    }
    fetch(message.url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ error: `HTTP ${res.status}` });
          return;
        }
        sendResponse({ html: await res.text() });
      })
      .catch((err: unknown) => {
        sendResponse({ error: String(err) });
      });
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

  if (message.type === 'cart-clear') {
    // Delete the cart_client_id cookie — Bandcamp uses this to tie the browser
    // session to the server-side cart. Removing it empties the cart instantly.
    chrome.cookies.remove({ url: 'https://bandcamp.com', name: 'cart_client_id' })
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: String(err) });
      });
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
        sendResponse({ ok: true, body: json });
      })
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: String(err) });
      });

    return true;
  }

  return false;
});
