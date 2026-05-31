// Centralised catalogue of Bandcamp DOM selectors. Keeping them here means a
// single diff when Bandcamp changes their markup, rather than hunting across
// multiple source files.

// Cart sidebar
export const SEL_SIDECART_BODY = '#sidecartBody';
export const SEL_SIDECART_ITEM_LIST = '#item_list';
export const SEL_SIDECART_ITEM_LINK = 'a.itemName[href]';

// Discography grid (label pages)
export const SEL_MUSIC_GRID = '#music-grid';
export const SEL_LEFT_MIDDLE_COLUMNS = '.leftMiddleColumns';
export const SEL_MUSIC_GRID_ITEM = '.music-grid-item';
export const SEL_GRID_ITEM_TITLE = 'p.title';
export const SEL_FEATURED_GRID = 'ol.featured-grid';

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
 * logs a single warning (in development) listing which fields are missing.
 */
export function readPageContext(latestSyncNum: number | null): BandcampPageContext {
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
        const fan = blob.fan as Record<string, unknown> | undefined;
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
  if (missing.length > 0) {
    console.warn(
      `[bcp] Could not find ${missing.join(', ')} in page. ` +
        'Cart mutations may fail. Bandcamp may have changed their page format.'
    );
  }

  return { syncNum: syncNum ?? 0, clientId, currency, fanId, countryCode };
}
