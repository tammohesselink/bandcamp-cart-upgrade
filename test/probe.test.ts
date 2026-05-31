import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { probeCart, probeDiscography, injectDiscographyButton, readDataCart, injectRestoreCartButton, type DataCartItem } from '../src/probe';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

function loadFixture(name: string): void {
  document.documentElement.innerHTML = fixture(name);
}

// happy-dom's window.location is read-only, but we can stub the pathname via
// Object.defineProperty so the probeDiscography path guard is testable.
function setPathname(pathname: string): void {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname, href: `https://testlabel.bandcamp.com${pathname}` },
    configurable: true,
  });
}

// --- probeCart ---------------------------------------------------------------

describe('probeCart — sidecart with items', () => {
  beforeEach(() => loadFixture('sidecart-with-items.html'));

  it('returns one item per unique href', () => {
    expect(probeCart()).toHaveLength(3);
  });

  it('detects album purchaseType from "digital album" suffix', () => {
    const items = probeCart();
    const album = items.find((i) => i.url.includes('/album/my-album'));
    expect(album?.purchaseType).toBe('album');
  });

  it('detects track purchaseType from "digital track" suffix', () => {
    const items = probeCart();
    const track = items.find((i) => i.url.includes('/track/my-track'));
    expect(track?.purchaseType).toBe('track');
  });

  it('leaves purchaseType undefined when no digital suffix', () => {
    const items = probeCart();
    const bundle = items.find((i) => i.url.includes('bundle'));
    expect(bundle?.purchaseType).toBeUndefined();
  });

  it('strips the "digital track/album" text from the title', () => {
    const items = probeCart();
    const album = items.find((i) => i.url.includes('/album/my-album'));
    expect(album?.title).toBe('My Album');
    const track = items.find((i) => i.url.includes('/track/my-track'));
    expect(track?.title).toBe('My Track');
  });

  it('detects url type from path segment', () => {
    const items = probeCart();
    const album = items.find((i) => i.url.includes('/album/'));
    expect(album?.type).toBe('album');
    const track = items.find((i) => i.url.includes('/track/'));
    expect(track?.type).toBe('track');
  });

  it('deduplicates identical hrefs', () => {
    // Add a duplicate link to the DOM
    const dup = document.createElement('a');
    dup.className = 'itemName notSkinnable';
    dup.href = 'https://artist.bandcamp.com/album/my-album';
    dup.textContent = 'My Album, digital album';
    document.getElementById('sidecartBody')!.appendChild(dup);

    expect(probeCart()).toHaveLength(3);
  });
});

describe('probeCart — empty sidecart', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<body><div id="sidecartBody"></div></body>';
  });

  it('returns empty array when there are no item links', () => {
    expect(probeCart()).toEqual([]);
  });
});

describe('probeCart — no sidecartBody', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<body></body>';
  });

  it('returns empty array when #sidecartBody is absent', () => {
    expect(probeCart()).toEqual([]);
  });
});

// --- probeDiscography --------------------------------------------------------

describe('probeDiscography — with #music-grid', () => {
  beforeEach(() => {
    loadFixture('label-with-music-grid.html');
    setPathname('/music');
  });

  it('returns all releases from #music-grid', () => {
    expect(probeDiscography()).toHaveLength(3);
  });

  it('detects album type', () => {
    const items = probeDiscography();
    const albums = items.filter((i) => i.type === 'album');
    expect(albums).toHaveLength(2);
  });

  it('detects track type', () => {
    const items = probeDiscography();
    const tracks = items.filter((i) => i.type === 'track');
    expect(tracks).toHaveLength(1);
  });

  it('extracts title from p.title', () => {
    const items = probeDiscography();
    const first = items.find((i) => i.url.includes('/album/first-album'));
    expect(first?.title).toBe('First Album');
  });

  it('resolves relative hrefs to absolute URLs', () => {
    const items = probeDiscography();
    for (const item of items) {
      expect(item.url).toMatch(/^https?:\/\//);
    }
  });
});

describe('probeDiscography — fallback to .leftMiddleColumns when no #music-grid', () => {
  beforeEach(() => {
    loadFixture('label-no-music-grid.html');
    setPathname('/music');
  });

  it('finds items via .leftMiddleColumns fallback', () => {
    expect(probeDiscography().length).toBeGreaterThan(0);
  });

  it('returns 3 items from .leftMiddleColumns', () => {
    expect(probeDiscography()).toHaveLength(3);
  });
});

describe('probeDiscography — path guard', () => {
  beforeEach(() => loadFixture('label-with-music-grid.html'));

  it('returns empty array on non-root/music path', () => {
    setPathname('/album/something');
    expect(probeDiscography()).toEqual([]);
  });

  it('returns items on / (root) path', () => {
    setPathname('/');
    expect(probeDiscography().length).toBeGreaterThan(0);
  });

  it('returns items on /music path', () => {
    setPathname('/music');
    expect(probeDiscography().length).toBeGreaterThan(0);
  });
});

// --- injectDiscographyButton -------------------------------------------------

describe('injectDiscographyButton — with #music-grid', () => {
  beforeEach(() => loadFixture('label-with-music-grid.html'));

  it('returns a button element', () => {
    const btn = injectDiscographyButton();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('button has the bcp-discography-btn class', () => {
    const btn = injectDiscographyButton();
    expect(btn.classList.contains('bcp-discography-btn')).toBe(true);
  });

  it('button is disabled initially', () => {
    const btn = injectDiscographyButton();
    expect(btn.disabled).toBe(true);
  });

  it('inserts button immediately before #music-grid', () => {
    const btn = injectDiscographyButton();
    const grid = document.getElementById('music-grid')!;
    expect(grid.previousElementSibling).toBe(btn);
  });
});

describe('injectDiscographyButton — with featured-grid present', () => {
  beforeEach(() => loadFixture('label-with-featured-grid.html'));

  it('inserts button before #music-grid (not .featured-grid) when #music-grid exists', () => {
    const btn = injectDiscographyButton();
    const grid = document.getElementById('music-grid')!;
    expect(grid.previousElementSibling).toBe(btn);
  });
});

describe('injectDiscographyButton — fallback to .leftMiddleColumns', () => {
  beforeEach(() => loadFixture('label-no-music-grid.html'));

  it('inserts button before .leftMiddleColumns when #music-grid absent', () => {
    const btn = injectDiscographyButton();
    const col = document.querySelector('.leftMiddleColumns')!;
    expect(col.previousElementSibling).toBe(btn);
  });
});

// --- readDataCart ------------------------------------------------------------

describe('readDataCart — with [data-cart] attribute', () => {
  beforeEach(() => loadFixture('sidecart-with-data-cart.html'));

  it('returns two items from [data-cart]', () => {
    expect(readDataCart()).toHaveLength(2);
  });

  it('parses item_id correctly', () => {
    const items = readDataCart() as DataCartItem[];
    expect(items[0]!.item_id).toBe(111);
    expect(items[1]!.item_id).toBe(222);
  });

  it('parses item_type correctly', () => {
    const items = readDataCart() as DataCartItem[];
    expect(items[0]!.item_type).toBe('a');
    expect(items[1]!.item_type).toBe('t');
  });

  it('parses item_title and band_name', () => {
    const items = readDataCart() as DataCartItem[];
    expect(items[0]!.item_title).toBe('My Album');
    expect(items[0]!.band_name).toBe('Artist One');
  });

  it('parses unit_price and currency', () => {
    const items = readDataCart() as DataCartItem[];
    expect(items[0]!.unit_price).toBe(7.0);
    expect(items[0]!.currency).toBe('USD');
  });

  it('parses url', () => {
    const items = readDataCart() as DataCartItem[];
    expect(items[0]!.url).toBe('https://artist.bandcamp.com/album/my-album');
  });
});

describe('readDataCart — missing or malformed', () => {
  it('returns empty array when [data-cart] element is absent', () => {
    document.documentElement.innerHTML = '<body></body>';
    expect(readDataCart()).toEqual([]);
  });

  it('returns empty array when items array is empty', () => {
    document.documentElement.innerHTML = '<body><div data-cart=\'{"items":[]}\' /></body>';
    expect(readDataCart()).toEqual([]);
  });

  it('returns empty array when JSON is malformed', () => {
    document.documentElement.innerHTML = '<body><div data-cart="not-json" /></body>';
    expect(readDataCart()).toEqual([]);
  });

  it('skips items with invalid item_type', () => {
    document.documentElement.innerHTML = `<body><div data-cart='{"items":[{"item_id":1,"item_type":"x","item_title":"Bad","band_name":"B","unit_price":1,"currency":"USD","url":"https://a.bandcamp.com/album/x"}]}' /></body>`;
    expect(readDataCart()).toEqual([]);
  });
});

// --- injectRestoreCartButton -------------------------------------------------

describe('injectRestoreCartButton — with #sidecart', () => {
  beforeEach(() => loadFixture('sidecart-with-data-cart.html'));

  it('returns a button element', () => {
    const btn = injectRestoreCartButton(5);
    expect(btn?.tagName).toBe('BUTTON');
  });

  it('button has bcp-restore-btn class', () => {
    const btn = injectRestoreCartButton(5);
    expect(btn?.classList.contains('bcp-restore-btn')).toBe(true);
  });

  it('button has buttonLink class', () => {
    const btn = injectRestoreCartButton(5);
    expect(btn?.classList.contains('buttonLink')).toBe(true);
  });

  it('button text contains the snapshot count', () => {
    const btn = injectRestoreCartButton(5);
    expect(btn?.textContent).toContain('5');
  });

  it('button is inserted after #sidecart', () => {
    const btn = injectRestoreCartButton(5);
    const sidecart = document.getElementById('sidecart')!;
    expect(sidecart.nextElementSibling).toBe(btn);
  });

  it('does not double-inject', () => {
    injectRestoreCartButton(5);
    injectRestoreCartButton(5);
    const btns = document.querySelectorAll('.bcp-restore-btn');
    expect(btns).toHaveLength(1);
  });
});

describe('injectRestoreCartButton — no sidecart anchor', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<body></body>';
  });

  it('returns null when #sidecart, #sidecartReveal and #sidecartBody are absent', () => {
    expect(injectRestoreCartButton(5)).toBeNull();
  });
});
