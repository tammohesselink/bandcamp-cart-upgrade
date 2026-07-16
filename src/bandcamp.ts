import type { PlaylistTrack, TralbumData } from './types';

// Parsing is pure string/regex based (no DOMParser) so this can run in either
// the content script or the MV3 background service worker, which has no DOM.
export function parseTralbum(html: string, pageUrl: string): PlaylistTrack[] {
  const data = extractTralbumData(html);
  if (!data) return [];

  const albumTitle = data.current?.title ?? data.album_title ?? '';
  const artist = data.artist ?? data.current?.artist ?? '';
  const artId = data.art_id ?? data.current?.art_id;
  const artworkUrl = artId ? `https://f4.bcbits.com/img/a${artId}_10.jpg` : '';
  const origin = safeOrigin(pageUrl);

  const releaseUrl = data.url ?? pageUrl;
  const releaseId = data.id ?? null;
  const releaseType: 'track' | 'album' =
    data.tralbum_type === 't' || releaseUrl.includes('/track/') ? 'track' : 'album';
  const bandId = data.band_id ?? data.current?.band_id ?? null;
  const minPrice = data.current?.minimum_price ?? null;

  // Bandcamp exposes no JSON flag for "track sold only as part of the release".
  // The rendered buy column is the source of truth: an album-only track page
  // shows "Buy the Full Digital Album" (buyAlbumLink) and no digital-track buy
  // command (li.buyItem.digital). Only detectable on the track's own page.
  const scanned = stripHtmlComments(html);
  const albumOnly =
    releaseType === 'track' &&
    htmlHasIdOrClassToken(scanned, 'buyAlbumLink') &&
    !htmlHasClassTokens(scanned, ['buyItem', 'digital']);

  return (data.trackinfo ?? []).map((t) => {
    // Per-track minimum price: prefer minimum_price (PWYW floor) when > 0,
    // fall back to fixed price field. 0 means "no individual minimum set"
    // so || correctly skips it to reach price. Null means not individually
    // purchasable. For standalone single-track releases the release price applies.
    const trackMinPrice: number | null =
      releaseType === 'track'
        ? minPrice
        : (t.minimum_price || t.price || null);

    return {
      trackTitle: t.title,
      albumTitle,
      artist,
      streamUrl: t.file?.['mp3-128'] ?? null,
      pageUrl: t.title_link ? `${origin}${t.title_link}` : pageUrl,
      artworkUrl,
      durationSec: t.duration ?? 0,
      unplayable: !t.file?.['mp3-128'],
      releaseUrl,
      releaseId,
      releaseType,
      trackId: t.id ?? null,
      bandId,
      minPrice,
      trackMinPrice,
      currency: null,
      purchasable: !albumOnly,
    };
  });
}

function extractTralbumData(html: string): TralbumData | null {
  // Strategy 1: data-tralbum attribute (some Bandcamp pages). Attribute values
  // HTML-entity-encode their inner quotes, so decode before JSON.parse.
  const attrMatch = /data-tralbum=(?:"([^"]*)"|'([^']*)')/.exec(html);
  if (attrMatch) {
    const raw = attrMatch[1] ?? attrMatch[2] ?? '';
    try {
      const parsed = JSON.parse(decodeHtmlEntities(raw));
      if (isPlainObject(parsed)) return parsed as TralbumData;
    } catch {
      // fallthrough
    }
  }

  // Strip comments before the remaining strategies scan raw HTML instead of
  // parsed <script> textContent — otherwise a marker mentioned only in an
  // HTML comment (e.g. explanatory prose) would be mistaken for real data.
  const scanned = stripHtmlComments(html);

  // Strategy 2: inline TralbumData variable
  const byMarker = findJsonAfterMarker(scanned, 'TralbumData');
  if (byMarker) return byMarker as TralbumData;

  // Strategy 3: any JSON object containing "trackinfo", regardless of variable
  // name. Handles cases where Bandcamp minified TralbumData to a short
  // identifier. JSON string keys ("trackinfo") survive minification even when
  // variable names do not.
  const byKey = findJsonContainingKey(scanned, '"trackinfo"');
  if (byKey && Array.isArray((byKey as Record<string, unknown>).trackinfo)) {
    return byKey as TralbumData;
  }

  return null;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

const HTML_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

// Single-pass decode: String.replace scans the original string once and never
// re-scans replacement text, so "&amp;quot;" correctly becomes "&quot;" (not
// double-decoded into `"`).
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, ent: string) => {
    if (ent[0] === '#') {
      const codePoint = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    const replacement = HTML_ENTITIES[ent.toLowerCase()];
    return replacement ?? match;
  });
}

// Scans every occurrence of `marker` in `source` and returns the first valid
// JSON object found starting at the next `{` after it.
function findJsonAfterMarker(source: string, marker: string): unknown | null {
  let from = 0;
  while (true) {
    const markerIdx = source.indexOf(marker, from);
    if (markerIdx === -1) return null;
    const start = source.indexOf('{', markerIdx + marker.length);
    if (start !== -1) {
      const obj = extractJsonObjectAt(source, start);
      if (isPlainObject(obj)) return obj;
    }
    from = markerIdx + marker.length;
  }
}

// Scans every occurrence of `key` in `source` and returns the first valid JSON
// object enclosing it.
function findJsonContainingKey(source: string, key: string): unknown | null {
  let from = 0;
  while (true) {
    const idx = source.indexOf(key, from);
    if (idx === -1) return null;
    const obj = extractJsonContaining(source, idx);
    if (isPlainObject(obj)) return obj;
    from = idx + key.length;
  }
}

// True if `html` has an element with `id="token"` or a class attribute
// containing `token` as one of its whitespace-separated tokens.
function htmlHasIdOrClassToken(html: string, token: string): boolean {
  const idRe = new RegExp(`\\bid\\s*=\\s*(?:"${token}"|'${token}')`, 'i');
  return idRe.test(html) || htmlHasClassTokens(html, [token]);
}

// True if some single class attribute in `html` contains every token in
// `tokens` (order-independent, e.g. class="buyItem digital").
function htmlHasClassTokens(html: string, tokens: string[]): boolean {
  const classRe = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(html))) {
    const value = m[1] ?? m[2] ?? '';
    const valueTokens = new Set(value.split(/\s+/));
    if (tokens.every((t) => valueTokens.has(t))) return true;
  }
  return false;
}

// Extracts the JSON object that starts at `start` by counting matched braces.
function extractJsonObjectAt(source: string, start: number): unknown | null {
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') {
      depth++;
      continue;
    }
    if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(source.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

// Scans backward from `markerPos` to find the opening `{` of the enclosing
// JSON object, then parses it. The backward scan is brace-count based and
// does not fully handle string literals in surrounding JS code, but is
// reliable for Bandcamp's embedded data patterns.
function extractJsonContaining(source: string, markerPos: number): unknown | null {
  let depth = 0;
  for (let i = markerPos - 1; i >= 0; i--) {
    const c = source[i];
    if (c === '}') { depth++; continue; }
    if (c === '{') {
      if (depth === 0) return extractJsonObjectAt(source, i);
      depth--;
    }
  }
  return null;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
