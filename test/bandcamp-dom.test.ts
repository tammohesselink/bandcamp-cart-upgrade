import { describe, it, expect } from 'vitest';
import { isTrackOrAlbumPage, isCheckoutPage, isLoggedIn, readPageContext, sidecartItemFor } from '../src/bandcamp-dom';

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
    return document.querySelector<HTMLAnchorElement>(`a.itemName[href="${url}"]`)!;
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

  it('returns the entry when the entries sit directly in #sidecartBody', () => {
    document.body.innerHTML = `<div id="sidecartBody">` +
      item('First', 'https://a.bandcamp.com/album/first') +
      item('Second', 'https://a.bandcamp.com/album/second') +
      `</div>`;

    const entry = sidecartItemFor(linkTo('https://a.bandcamp.com/album/first'));

    expect(entry?.textContent).toContain('First');
    expect(entry?.textContent).not.toContain('Second');
  });

  it('returns nothing for a link outside the sidecart', () => {
    document.body.innerHTML = `<div id="sidecartBody"><ul id="item_list"></ul></div>` +
      `<a class="itemName" href="https://a.bandcamp.com/album/elsewhere">Elsewhere</a>`;

    expect(sidecartItemFor(linkTo('https://a.bandcamp.com/album/elsewhere'))).toBeNull();
  });
});
