import { describe, it, expect } from 'vitest';
import { isTrackOrAlbumPage, isCheckoutPage } from '../src/bandcamp-dom';

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
