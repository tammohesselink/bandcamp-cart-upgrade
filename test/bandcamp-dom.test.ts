import { describe, it, expect } from 'vitest';
import { isTrackOrAlbumPage } from '../src/bandcamp-dom';

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
