import type { PlaylistTrack, TralbumData } from './types';

export function parseTralbum(html: string, pageUrl: string): PlaylistTrack[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const data = extractTralbumData(doc);
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
  const albumOnly =
    releaseType === 'track' &&
    !!doc.querySelector('#buyAlbumLink, li.buyAlbumLink') &&
    !doc.querySelector('li.buyItem.digital');

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

function extractTralbumData(doc: Document): TralbumData | null {
  // Strategy 1: data-tralbum attribute (some older Bandcamp pages)
  const el = doc.querySelector('[data-tralbum]');
  if (el) {
    try {
      return JSON.parse(el.getAttribute('data-tralbum')!) as TralbumData;
    } catch {
      // fallthrough
    }
  }

  // Strategy 2: inline TralbumData variable in <script> tags (modern Bandcamp)
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const text = script.textContent ?? '';
    if (!text.includes('TralbumData')) continue;
    const extracted = extractJsonObject(text, 'TralbumData');
    if (extracted) return extracted as TralbumData;
  }

  return null;
}

// Counts braces to extract the full JSON object starting after `marker` in `source`.
function extractJsonObject(source: string, marker: string): unknown | null {
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) return null;

  const start = source.indexOf('{', markerIdx + marker.length);
  if (start === -1) return null;

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

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
