chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'fetch') {
    fetch(message.url as string, { credentials: 'include' })
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
    let origin: string;
    try {
      origin = new URL(message.releaseUrl as string).origin;
    } catch {
      sendResponse({ ok: false, error: 'Invalid releaseUrl' });
      return false;
    }

    const body = new URLSearchParams({
      req: 'del',
      id: String(message.tralbumId),
      fan_id: String(message.fanId ?? ''),
      client_id: String(message.clientId ?? ''),
      sync_num: String(message.syncNum ?? 0),
      req_id: String(Math.random()),
    });

    console.log('[bcp] cart-remove POST', `${origin}/cart/cb`, Object.fromEntries(body));
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
        console.log('[bcp] cart-remove response', json);
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

  if (message.type === 'cart-add') {
    // Endpoint: POST {artist}.bandcamp.com/cart/cb
    // Body fields mirror Bandcamp's own add-to-cart request (captured via DevTools).
    let origin: string;
    try {
      origin = new URL(message.releaseUrl as string).origin;
    } catch {
      sendResponse({ ok: false, error: 'Invalid releaseUrl' });
      return false;
    }

    const body = new URLSearchParams({
      req: 'add',
      local_id: String(Math.random()),
      item_type: String(message.tralbumType ?? 't'),
      item_id: String(message.tralbumId),
      unit_price: String(message.minPrice ?? 0),
      quantity: '1',
      band_id: String(message.bandId ?? ''),
      ip_country_code: String(message.countryCode ?? ''),
      is_cardable: 'true',
      cart_length: String(message.cartLength ?? 0),
      fan_id: String(message.fanId ?? ''),
      client_id: String(message.clientId ?? ''),
      sync_num: String(message.syncNum ?? 0),
      req_id: String(Math.random()),
    });

    console.log('[bcp] cart-add POST', `${origin}/cart/cb`, Object.fromEntries(body));
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
        console.log('[bcp] cart-add response', json);
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
