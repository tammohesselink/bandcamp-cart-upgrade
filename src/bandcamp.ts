import type { PlaylistTrack, TralbumData } from './types';

// Parses with string scanning rather than DOMParser: content scripts share the
// page's main thread, and building a DOM for every fetched release makes it lag.
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

  // A track page that belongs to an album links to it, both in TralbumData
  // and in the "Buy the Full Digital Album" link.
  const albumHref = releaseType === 'track'
    ? (data.album_url ?? extractIdHref(scanned, 'buyAlbumLink'))
    : null;
  const albumUrl = albumHref ? resolveUrl(albumHref, pageUrl) : null;

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
      albumUrl,
    };
  });
}

// True when the page is a release page Bandcamp served normally, even if it
// lists no tracks; false for error or challenge pages.
export function hasTralbumData(html: string): boolean {
  return extractTralbumData(html) !== null;
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

  // A marker mentioned only in an HTML comment would otherwise be mistaken
  // for real data.
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
  const idRe = new RegExp(`\\sid\\s*=\\s*(?:"${token}"|'${token}')`, 'i');
  return idRe.test(html) || htmlHasClassTokens(html, [token]);
}

// The href of the element with `id="token"`, or null.
function extractIdHref(html: string, token: string): string | null {
  const tagRe = new RegExp(`<a\\b[^>]*\\sid\\s*=\\s*(?:"${token}"|'${token}')[^>]*>`, 'i');
  const tag = tagRe.exec(html)?.[0];
  if (!tag) return null;
  const hrefMatch = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? '';
  return href ? decodeHtmlEntities(href) : null;
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

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// Fan-written text (comments, about/credits, lyrics) can quote the ownership
// phrases verbatim, so those sections are stripped before text matching.
const USER_CONTENT_CLASSES = ['tralbumData', 'lyricsText', 'collected-by', 'comment'];
const OWNED_PATTERNS = [/you\s+own\s+this/i, /already\s+in\s+your\s+collection/i];

// Drops <script>/<style> blocks and the fan-written sections above, so a
// quoted ownership phrase inside them can't match. Best-effort: a class
// token's open tag is matched to its first same-named closing tag, which can
// under-strip deeply nested markup — an acceptable trade for avoiding a full
// DOM parse on every release fetch (see parseTralbum's note on content-script
// performance).
function stripUserContent(html: string): string {
  let out = stripHtmlComments(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  for (const token of USER_CONTENT_CLASSES) {
    const re = new RegExp(
      `<(\\w+)\\b[^>]*\\bclass\\s*=\\s*(?:"[^"]*\\b${token}\\b[^"]*"|'[^']*\\b${token}\\b[^']*')[^>]*>[\\s\\S]*?<\\/\\1>`,
      'gi'
    );
    out = out.replace(re, '');
  }
  return out;
}

// The fetch must carry the fan's session cookies; a logged-out page never
// reports ownership. The tralbum is_purchased flag is authoritative when
// present (true or false) — the rendered "you own this" buy panel is only a
// fallback for pages where Bandcamp doesn't set the flag at all (null/undefined).
export function isReleaseOwned(html: string): boolean {
  const isPurchased = extractTralbumData(html)?.is_purchased;
  if (isPurchased != null) return isPurchased;

  return OWNED_PATTERNS.some((pattern) => pattern.test(stripUserContent(html)));
}

// Bandcamp answers an add it won't make (e.g. an album-only track sent as a
// track) without an error: it just asks the client to resync to its cart,
// which doesn't contain the item.
export function isCartAddRejected(body: unknown, itemId: number | null, itemType: 't' | 'a'): boolean {
  const response = body as Record<string, unknown> | null;
  if (!response?.resync) return false;
  const items = (response.cart_data as Record<string, unknown> | null | undefined)?.items;
  if (!Array.isArray(items)) return true;
  return !items.some((i) => {
    const item = i as Record<string, unknown>;
    return item.item_id === itemId && item.item_type === itemType;
  });
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
