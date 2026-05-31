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

  return (data.trackinfo ?? []).map((t) => ({
    trackTitle: t.title,
    albumTitle,
    artist,
    streamUrl: t.file?.['mp3-128'] ?? null,
    pageUrl: t.title_link ? `${origin}${t.title_link}` : pageUrl,
    artworkUrl,
    durationSec: t.duration ?? 0,
    unplayable: !t.file?.['mp3-128'],
  }));
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
