import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  probeCart,
  probeDiscography,
  probeReleaseGrid,
  releaseGridItemKey,
  releaseGridItemTracks,
  injectDiscographyButton,
  readDataCart,
  injectRestoreCartButton,
  injectRemoveAlreadyOwnedButton,
  injectCheckoutCartButton,
  type DataCartItem,
} from '../src/probe';
import { makeTrack } from './track-factory';
import { findCheckoutControl, clickCheckout, COLLECTION_GRID, FEED_STORIES_GRID, FEED_NEW_RELEASES_GRID } from '../src/bandcamp-dom';

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

// --- probeReleaseGrid --------------------------------------------------------

describe('probeReleaseGrid — fan collection page', () => {
  beforeEach(() => loadFixture('collection.html'));

  it('returns the collection items drawn on the page, in page order', () => {
    expect(probeReleaseGrid(COLLECTION_GRID).map((i) => i.url)).toEqual([
      'https://amadeupsound.bandcamp.com/album/ex-libris-004',
      'https://spacelab.bandcamp.com/album/dusk-illusions',
      'https://earlyreflex.bandcamp.com/album/zahyo',
    ]);
  });

  it('leaves out the wishlist', () => {
    expect(probeReleaseGrid(COLLECTION_GRID).some((i) => i.url.includes('wished-for'))).toBe(false);
  });

  it('reads the title without the hidden "(gift given)" label, and the artist without "by"', () => {
    const first = probeReleaseGrid(COLLECTION_GRID)[0]!;
    expect(first.title).toBe('ex_libris - 004');
    expect(first.artist).toBe('ex_libris');
  });

  it('tells a track bought on its own from an album, though it links to its album', () => {
    const items = probeReleaseGrid(COLLECTION_GRID);
    expect(items[0]).toMatchObject({ type: 'album', tralbumType: 'a', tralbumId: 2017834381 });
    expect(items[2]).toMatchObject({ type: 'track', tralbumType: 't', tralbumId: 1625256874, title: 'Ue' });
  });

  it('keeps two tracks bought from the same album apart', () => {
    const grid = document.querySelector('#collection-items ol.collection-grid')!;
    const copy = grid.querySelector('#collection-item-container_1625256874')!.cloneNode(true) as HTMLElement;
    copy.setAttribute('data-tralbumid', '1625256875');
    grid.appendChild(copy);
    const items = probeReleaseGrid(COLLECTION_GRID);
    expect(items).toHaveLength(4);
    expect(new Set(items.map(releaseGridItemKey)).size).toBe(4);
  });

  it('returns nothing on a page without a collection', () => {
    loadFixture('label-with-music-grid.html');
    expect(probeReleaseGrid(COLLECTION_GRID)).toEqual([]);
  });
});

describe('probeReleaseGrid — fan feed page', () => {
  beforeEach(() => loadFixture('feed.html'));

  it('returns the stories that have a release to play, without the "?from=" referral', () => {
    expect(probeReleaseGrid(FEED_STORIES_GRID).map((i) => i.url)).toEqual([
      'https://cryingoutcast.bandcamp.com/album/bella',
      'https://soccercommittee.bandcamp.com/album/belongs',
    ]);
  });

  it('reads a story\'s title and artist', () => {
    expect(probeReleaseGrid(FEED_STORIES_GRID)[0]).toMatchObject({
      type: 'album',
      title: 'Bella',
      artist: 'Annis',
      tralbumId: 2162350188,
    });
  });

  it('returns the sidebar new releases, apart from the stories', () => {
    const items = probeReleaseGrid(FEED_NEW_RELEASES_GRID);
    expect(items.map((i) => i.url)).toEqual([
      'https://guyfromdownstairs.bandcamp.com/album/the-son-of-knuf-ep-gfd012',
      'https://naturalrhythm.bandcamp.com/album/mis-bandidos',
    ]);
    expect(items[1]).toMatchObject({ title: 'Mis Bandidos', artist: 'DJ OSIRIS' });
  });

  it('lists a release once when two stories show it', () => {
    const list = document.querySelector('#story-list')!;
    list.appendChild(list.querySelector('li.story.nr')!.cloneNode(true));
    expect(probeReleaseGrid(FEED_STORIES_GRID)).toHaveLength(2);
  });

  it('finds no feed on a collection page, nor a collection on the feed', () => {
    expect(probeReleaseGrid(COLLECTION_GRID)).toEqual([]);
    loadFixture('collection.html');
    expect(probeReleaseGrid(FEED_STORIES_GRID)).toEqual([]);
    expect(probeReleaseGrid(FEED_NEW_RELEASES_GRID)).toEqual([]);
  });
});

describe('releaseGridItemTracks', () => {
  const album = [makeTrack({ trackId: 1, pageUrl: 'https://a.bandcamp.com/track/one' }), makeTrack({ trackId: 2, pageUrl: 'https://a.bandcamp.com/track/two' })];
  const item = (type: 'track' | 'album', tralbumId: number) =>
    ({ url: 'https://a.bandcamp.com/album/x', type, title: '', artist: '', thumbnailUrl: '', tralbumId });

  it('plays the whole release for an album', () => {
    expect(releaseGridItemTracks(item('album', 99), album)).toEqual(album);
  });

  it('plays only the bought track for a track bought on its own', () => {
    expect(releaseGridItemTracks(item('track', 2), album)).toEqual([album[1]]);
  });

  it('falls back to the whole release when the track is not on it', () => {
    expect(releaseGridItemTracks(item('track', 3), album)).toEqual(album);
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

describe('probeDiscography — releases Bandcamp has not drawn yet', () => {
  beforeEach(() => {
    loadFixture('label-with-music-grid.html');
    setPathname('/music');
    const clientItems = [
      { page_url: '/album/first-album', title: 'First Album', artist: 'Drawn', type: 'album' },
      { page_url: '/album/undrawn-album', title: 'Undrawn Album', artist: 'Later', type: 'album' },
      { page_url: 'https://other.bandcamp.com/track/guest-track', title: 'Guest Track', artist: 'Guest', type: 'track' },
    ];
    document.getElementById('music-grid')!.setAttribute('data-client-items', JSON.stringify(clientItems));
  });

  it('adds the undrawn releases after the drawn ones, without repeating drawn ones', () => {
    const urls = probeDiscography().map((i) => i.url);
    expect(urls).toHaveLength(5);
    expect(urls.slice(3)).toEqual([
      new URL('/album/undrawn-album', document.baseURI).href,
      'https://other.bandcamp.com/track/guest-track',
    ]);
  });

  it('reads the type, title and artist of an undrawn release', () => {
    const guest = probeDiscography().find((i) => i.url.includes('guest-track'));
    expect(guest).toMatchObject({ type: 'track', title: 'Guest Track', artist: 'Guest' });
  });

  it('ignores a data-client-items value it cannot parse', () => {
    document.getElementById('music-grid')!.setAttribute('data-client-items', '{not json');
    expect(probeDiscography()).toHaveLength(3);
  });
});

describe('probeDiscography — with featured-grid and #music-grid', () => {
  beforeEach(() => {
    loadFixture('label-with-featured-grid.html');
    setPathname('/music');
  });

  it('returns 3 unique items (featured-grid item deduped against hidden #music-grid copy)', () => {
    expect(probeDiscography()).toHaveLength(3);
  });

  it('includes the featured album', () => {
    const items = probeDiscography();
    expect(items.some((i) => i.url.includes('/album/featured-album'))).toBe(true);
  });

  it('includes items from #music-grid', () => {
    const items = probeDiscography();
    expect(items.some((i) => i.url.includes('/album/main-album'))).toBe(true);
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

  it('button is enabled initially so the discography can load on demand', () => {
    const btn = injectDiscographyButton();
    expect(btn.disabled).toBe(false);
  });

  it('inserts button immediately before #music-grid', () => {
    const btn = injectDiscographyButton();
    const grid = document.getElementById('music-grid')!;
    expect(grid.previousElementSibling).toBe(btn);
  });
});

describe('injectDiscographyButton — with featured-grid present', () => {
  beforeEach(() => loadFixture('label-with-featured-grid.html'));

  it('inserts button before .featured-grid (above featured releases)', () => {
    const btn = injectDiscographyButton();
    const featuredGrid = document.querySelector('ol.featured-grid')!;
    expect(featuredGrid.previousElementSibling).toBe(btn);
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

// --- injectRemoveAlreadyOwnedButton -------------------------------------------

describe('injectRemoveAlreadyOwnedButton — with #sidecart', () => {
  beforeEach(() => loadFixture('sidecart-with-data-cart.html'));

  it('returns a button element', () => {
    const btn = injectRemoveAlreadyOwnedButton();
    expect(btn?.tagName).toBe('BUTTON');
  });

  it('button has bcp-remove-owned-btn class', () => {
    const btn = injectRemoveAlreadyOwnedButton();
    expect(btn?.classList.contains('bcp-remove-owned-btn')).toBe(true);
  });

  it('button is inserted after #sidecart', () => {
    const btn = injectRemoveAlreadyOwnedButton();
    const sidecart = document.getElementById('sidecart')!;
    expect(sidecart.nextElementSibling).toBe(btn);
  });

  it('does not double-inject', () => {
    injectRemoveAlreadyOwnedButton();
    injectRemoveAlreadyOwnedButton();
    const btns = document.querySelectorAll('.bcp-remove-owned-btn');
    expect(btns).toHaveLength(1);
  });
});

describe('injectRemoveAlreadyOwnedButton — no sidecart anchor', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<body></body>';
  });

  it('returns null when #sidecart, #sidecartReveal and #sidecartBody are absent', () => {
    expect(injectRemoveAlreadyOwnedButton()).toBeNull();
  });
});

// --- injectCheckoutCartButton -------------------------------------------------

describe('injectCheckoutCartButton — falls back to the sidecart anchor chain', () => {
  beforeEach(() => loadFixture('sidecart-with-data-cart.html'));

  it('returns a button element', () => {
    const btn = injectCheckoutCartButton(2, true);
    expect(btn?.tagName).toBe('BUTTON');
  });

  it('button has bcp-checkout-cart-btn class', () => {
    const btn = injectCheckoutCartButton(2, true);
    expect(btn?.classList.contains('bcp-checkout-cart-btn')).toBe(true);
  });

  it('button text contains the named-cart count', () => {
    const btn = injectCheckoutCartButton(2, true);
    expect(btn?.textContent).toContain('2');
  });

  it('is inserted after #sidecart when no checkout-selected button is present', () => {
    const btn = injectCheckoutCartButton(2, true);
    const sidecart = document.getElementById('sidecart')!;
    expect(sidecart.nextElementSibling).toBe(btn);
  });

  it('is hidden when there are no named carts', () => {
    const btn = injectCheckoutCartButton(0, true);
    expect(btn?.hidden).toBe(true);
  });

  it('is hidden while named carts are off', () => {
    const btn = injectCheckoutCartButton(2, false);
    expect(btn?.hidden).toBe(true);
  });

  it('does not double-inject', () => {
    injectCheckoutCartButton(2, true);
    injectCheckoutCartButton(2, true);
    expect(document.querySelectorAll('.bcp-checkout-cart-btn')).toHaveLength(1);
  });

  it('updates the label on a second call instead of leaving a stale count', () => {
    injectCheckoutCartButton(1, true);
    const btn = injectCheckoutCartButton(3, true);
    expect(btn?.textContent).toContain('3');
    expect(btn?.hidden).toBe(false);
  });
});

describe('injectCheckoutCartButton — inserted after an existing checkout-selected button', () => {
  beforeEach(() => {
    loadFixture('sidecart-with-data-cart.html');
    const selectedBtn = document.createElement('button');
    selectedBtn.className = 'bcp-checkout-selected-btn';
    document.getElementById('sidecart')!.insertAdjacentElement('afterend', selectedBtn);
  });

  it('lands directly after the checkout-selected button', () => {
    const btn = injectCheckoutCartButton(1, true);
    const selectedBtn = document.querySelector('.bcp-checkout-selected-btn')!;
    expect(selectedBtn.nextElementSibling).toBe(btn);
  });
});

describe('injectCheckoutCartButton — no sidecart anchor', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<body></body>';
  });

  it('returns null when #sidecart, #sidecartReveal and #sidecartBody are absent', () => {
    expect(injectCheckoutCartButton(1, true)).toBeNull();
  });
});

// --- findCheckoutControl / clickCheckout ------------------------------------

describe('findCheckoutControl — with checkout link', () => {
  beforeEach(() => loadFixture('sidecart-with-checkout.html'));

  it('finds the known .checkout-link selector', () => {
    const control = findCheckoutControl();
    expect(control).not.toBeNull();
    expect(control?.classList.contains('checkout-link')).toBe(true);
  });

  it('clickCheckout returns true and the element is found', () => {
    let clicked = false;
    const control = document.querySelector<HTMLElement>('.checkout-link')!;
    control.addEventListener('click', () => { clicked = true; });
    const result = clickCheckout();
    expect(result).toBe(true);
    expect(clicked).toBe(true);
  });
});

describe('findCheckoutControl — text-content fallback', () => {
  beforeEach(() => {
    // A sidecart with only a generic button whose text contains "Check out"
    document.documentElement.innerHTML = `
      <body>
        <div id="sidecart">
          <button class="some-other-class">Check out now</button>
        </div>
      </body>
    `;
  });

  it('finds the control via text-content fallback', () => {
    const control = findCheckoutControl();
    expect(control).not.toBeNull();
    expect(control?.tagName).toBe('BUTTON');
  });
});

describe('findCheckoutControl — no checkout control present', () => {
  beforeEach(() => loadFixture('sidecart-with-items.html'));

  it('returns null when no checkout control exists in the sidecart', () => {
    expect(findCheckoutControl()).toBeNull();
  });

  it('clickCheckout returns false', () => {
    expect(clickCheckout()).toBe(false);
  });
});

describe('findCheckoutControl — no sidecart in DOM', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<body></body>';
  });

  it('returns null when sidecart containers are absent', () => {
    expect(findCheckoutControl()).toBeNull();
  });
});
