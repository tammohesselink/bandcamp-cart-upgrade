import { describe, it, expect } from 'vitest';
import { isTrackOrAlbumPage, isCheckoutPage, isLoggedIn, readPageContext, sidecartItemFor, readOwnFanPageFanId, readPageCrumb } from '../src/bandcamp-dom';

function setPathname(pathname: string): void {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname, href: `https://artist.bandcamp.com${pathname}` },
    configurable: true,
  });
}

describe('isTrackOrAlbumPage', () => {
  it('returns true for a track page', () => {
    setPathname('/track/some-track');
    expect(isTrackOrAlbumPage()).toBe(true);
  });

  it('returns true for an album page', () => {
    setPathname('/album/some-album');
    expect(isTrackOrAlbumPage()).toBe(true);
  });

  it('returns false for the label music page', () => {
    setPathname('/music');
    expect(isTrackOrAlbumPage()).toBe(false);
  });

  it('returns false for the root page', () => {
    setPathname('/');
    expect(isTrackOrAlbumPage()).toBe(false);
  });

  it('returns false for an arbitrary page', () => {
    setPathname('/merch');
    expect(isTrackOrAlbumPage()).toBe(false);
  });
});

describe('isCheckoutPage', () => {
  it('returns true for /checkout path', () => {
    setPathname('/checkout');
    expect(isCheckoutPage()).toBe(true);
  });

  it('returns true for /checkout/ trailing slash', () => {
    setPathname('/checkout/');
    expect(isCheckoutPage()).toBe(true);
  });

  it('returns true for /cart/checkout path', () => {
    setPathname('/cart/checkout');
    expect(isCheckoutPage()).toBe(true);
  });

  it('returns true for /payment path', () => {
    setPathname('/payment');
    expect(isCheckoutPage()).toBe(true);
  });

  it('returns false for a normal track page', () => {
    setPathname('/track/some-track');
    expect(isCheckoutPage()).toBe(false);
  });

  it('returns false for an album page', () => {
    setPathname('/album/some-album');
    expect(isCheckoutPage()).toBe(false);
  });

  it('returns false for the root', () => {
    setPathname('/');
    expect(isCheckoutPage()).toBe(false);
  });

  it('returns false for /cart alone (not checkout)', () => {
    setPathname('/cart');
    expect(isCheckoutPage()).toBe(false);
  });
});

describe('isLoggedIn', () => {
  function setPageData(blob: object): void {
    const div = document.createElement('div');
    div.id = 'pagedata';
    div.setAttribute('data-blob', JSON.stringify(blob));
    document.body.replaceChildren(div);
  }

  it('is true when the page data names a signed-in fan', () => {
    setPageData({ identities: { fan: { id: 2105866, username: 'someone' } } });
    expect(isLoggedIn()).toBe(true);
  });

  it('is false when the page data has no fan', () => {
    setPageData({ identities: { fan: null } });
    expect(isLoggedIn()).toBe(false);
  });

  it('is false when the page has no page data', () => {
    document.body.replaceChildren();
    expect(isLoggedIn()).toBe(false);
  });
});

describe('readPageContext fan id', () => {
  it('reads the fan id from the identities in the page data', () => {
    const div = document.createElement('div');
    div.setAttribute('data-blob', JSON.stringify({ identities: { fan: { id: 2105866 } } }));
    document.body.replaceChildren(div);
    expect(readPageContext(null).fanId).toBe('2105866');
  });
});

describe('sidecartItemFor', () => {
  function item(name: string, url: string): string {
    return `<li class="item"><div class="cartItemContents"><p><a class="itemName" href="${url}">${name}</a><br><span class="price">7.00 USD</span></p></div></li>`;
  }

  function linkTo(url: string): HTMLAnchorElement {
    return document.querySelector<HTMLAnchorElement>(`#sidecartBody a.itemName[href="${url}"]`)
      ?? document.querySelector<HTMLAnchorElement>(`a.itemName[href="${url}"]`)!;
  }

  it('returns just the entry when the entries sit in #item_list, as on the live sidecart', () => {
    document.body.innerHTML = `<div id="sidecartBody"><ul id="item_list">` +
      item('First', 'https://a.bandcamp.com/album/first') +
      item('Second', 'https://a.bandcamp.com/album/second') +
      `</ul><div class="total">14.00 USD</div></div>`;

    const entry = sidecartItemFor(linkTo('https://a.bandcamp.com/album/second'));

    expect(entry?.tagName).toBe('LI');
    expect(entry?.textContent).toContain('Second');
    expect(entry?.textContent).not.toContain('First');
  });

  it('returns just the entry when another wrapper sits between #item_list and the entries', () => {
    document.body.innerHTML = `<div id="sidecartBody"><div id="item_list"><div class="items">` +
      item('First', 'https://a.bandcamp.com/album/first') +
      item('Second', 'https://a.bandcamp.com/album/second') +
      `</div></div></div>`;

    const entry = sidecartItemFor(linkTo('https://a.bandcamp.com/album/first'));

    expect(entry?.textContent).toContain('First');
    expect(entry?.textContent).not.toContain('Second');
  });

  it('is not misled by another #item_list earlier on the page', () => {
    document.body.innerHTML = `<ul id="item_list"><li>Something else</li></ul>` +
      `<div id="sidecartBody"><ul id="item_list">` +
      item('First', 'https://a.bandcamp.com/album/first') +
      item('Second', 'https://a.bandcamp.com/album/second') +
      `</ul></div>`;

    const entry = sidecartItemFor(linkTo('https://a.bandcamp.com/album/first'));

    expect(entry?.textContent).toContain('First');
    expect(entry?.textContent).not.toContain('Second');
  });

  it('returns nothing, rather than a wrapper of several entries, when entries have no .item', () => {
    document.body.innerHTML = `<div id="sidecartBody"><div class="items">` +
      `<p><a class="itemName" href="https://a.bandcamp.com/album/first">First</a></p>` +
      `<p><a class="itemName" href="https://a.bandcamp.com/album/second">Second</a></p>` +
      `</div></div>`;

    expect(sidecartItemFor(linkTo('https://a.bandcamp.com/album/first'))).toBeNull();
  });

  it('returns nothing for a link outside the sidecart', () => {
    document.body.innerHTML = `<div id="sidecartBody"><ul id="item_list"></ul></div>` +
      `<a class="itemName" href="https://a.bandcamp.com/album/elsewhere">Elsewhere</a>`;

    expect(sidecartItemFor(linkTo('https://a.bandcamp.com/album/elsewhere'))).toBeNull();
  });
});

describe('readOwnFanPageFanId', () => {
  function fanPage(fanData: Record<string, unknown>, viewerId: number | null): void {
    const blob = { identities: { fan: viewerId === null ? null : { id: viewerId } }, fan_data: fanData };
    document.body.innerHTML = '';
    const el = document.createElement('div');
    el.setAttribute('data-blob', JSON.stringify(blob));
    document.body.appendChild(el);
  }

  it("returns the fan's id on their own page", () => {
    fanPage({ fan_id: 2105866, is_own_page: true }, 2105866);
    expect(readOwnFanPageFanId()).toBe('2105866');
  });

  it('tells the own page from the logged-in fan when is_own_page is missing', () => {
    fanPage({ fan_id: 2105866, is_own_page: null }, 2105866);
    expect(readOwnFanPageFanId()).toBe('2105866');
  });

  it("returns null on someone else's page, or logged out", () => {
    fanPage({ fan_id: 2105866, is_own_page: null }, 42);
    expect(readOwnFanPageFanId()).toBeNull();
    fanPage({ fan_id: 2105866, is_own_page: null }, null);
    expect(readOwnFanPageFanId()).toBeNull();
  });
});

describe('readPageCrumb', () => {
  it("reads the endpoint's crumb, or null when the page has none", () => {
    document.body.innerHTML = '<div id="js-crumbs-data" data-crumbs=\'{"uncollect_item_cb":"|uncollect_item_cb|1|abc"}\'></div>';
    expect(readPageCrumb('uncollect_item_cb')).toBe('|uncollect_item_cb|1|abc');
    expect(readPageCrumb('collect_item_cb')).toBeNull();
    document.body.innerHTML = '<div id="js-crumbs-data" data-crumbs="{}"></div>';
    expect(readPageCrumb('uncollect_item_cb')).toBeNull();
  });
});
