// Pure DOM-probe and injection functions extracted from content.ts so they can
// be unit-tested without importing the full content script (which runs main()
// at module level and has side effects).

import type { CartItem } from './types';

// --- Cart DOM probe -----------------------------------------------------------

export function probeCart(): CartItem[] {
  const sidecartBody = document.getElementById('sidecartBody');
  if (!sidecartBody) {
    console.warn('[bcp] #sidecartBody not found — cart may be empty or DOM changed');
    return [];
  }

  const seen = new Set<string>();
  const items: CartItem[] = [];

  for (const link of Array.from(sidecartBody.querySelectorAll<HTMLAnchorElement>('a.itemName[href]'))) {
    const url = link.href;
    if (seen.has(url)) continue;
    seen.add(url);

    const typeMatch = url.match(/\/(track|album)\//);
    const type =
      typeMatch?.[1] === 'album' ? 'album' :
      typeMatch?.[1] === 'track' ? 'track' :
      'unknown';

    const rawTitle = link.textContent?.trim() ?? '';
    const purchaseTypeMatch = rawTitle.match(/,\s*digital\s+(track|album)$/i);
    const purchaseType: 'track' | 'album' | undefined =
      purchaseTypeMatch?.[1]?.toLowerCase() === 'album' ? 'album' :
      purchaseTypeMatch?.[1]?.toLowerCase() === 'track' ? 'track' :
      undefined;
    const title = rawTitle.replace(/,\s*digital\s+(track|album)$/i, '').trim();

    items.push({ url, type, title, artist: '', thumbnailUrl: '', purchaseType });
  }

  return items;
}

// --- Discography DOM probe ---------------------------------------------------

export function probeDiscography(): CartItem[] {
  if (window.location.pathname !== '/music' && window.location.pathname !== '/') return [];

  // Try the standard music grid first; fall back to scanning the whole column.
  const grid = document.getElementById('music-grid');
  const container = grid ?? document.querySelector('.leftMiddleColumns');
  if (!container) return [];

  const seen = new Set<string>();
  const items: CartItem[] = [];

  const selector = 'a[href*="/album/"], a[href*="/track/"]';
  for (const link of Array.from(container.querySelectorAll<HTMLAnchorElement>(selector))) {
    // Resolve relative URLs (Bandcamp grid hrefs are relative: "/album/lateral")
    const url = new URL(link.href, window.location.href).href;

    // Skip in-page section links or hash-only hrefs
    if (!url.match(/\/(album|track)\//)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const typeMatch = url.match(/\/(track|album)\//);
    const type = typeMatch?.[1] === 'album' ? 'album' : 'track';

    const title = link.querySelector('p.title')?.textContent?.trim() ?? link.textContent?.trim() ?? '';

    items.push({ url, type, title, artist: '', thumbnailUrl: '' });
  }

  return items;
}

// --- Discography button injection --------------------------------------------

export function injectDiscographyButton(): HTMLButtonElement {
  const grid = document.getElementById('music-grid');
  const container = grid ?? document.querySelector('.leftMiddleColumns');

  const button = document.createElement('button');
  button.className = 'bcp-discography-btn';
  button.textContent = 'Loading label discography…';
  button.disabled = true;

  const target = grid ?? container;
  if (target) {
    target.parentElement?.insertBefore(button, target);
  }

  return button;
}
