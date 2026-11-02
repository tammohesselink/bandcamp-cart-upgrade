import { describe, it, expect, beforeEach } from 'vitest';
import { NowPlayingMirror, needsNowPlayingMirror } from '../src/now-playing-mirror';
import { makeTrack } from './track-factory';

function setPage(head: string, pathname = '/music'): void {
  document.head.innerHTML = head;
  document.body.innerHTML = '';
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname, href: `https://testlabel.bandcamp.com${pathname}` },
    configurable: true,
  });
}

// Reads the page the way an extension following playback does on a label or
// cart page.
function readerState() {
  const text = (selector: string) => document.querySelector<HTMLElement>(selector)?.textContent ?? null;
  return {
    artist: text('.detail-artist a'),
    track: text('.track_info .title'),
    album: text('.detail-album'),
    trackArt: document.querySelector('.discover-detail-inner img')?.getAttribute('src') ?? null,
    isPlaying: document.querySelector('.playing') !== null,
  };
}

describe('needsNowPlayingMirror', () => {
  it('is true on a label page', () => {
    setPage('<meta property="og:type" content="band">');
    expect(needsNowPlayingMirror(document)).toBe(true);
  });

  it('is true on the cart page', () => {
    setPage('<meta property="og:type" content="website">', '/cart');
    expect(needsNowPlayingMirror(document)).toBe(true);
  });

  it('is false on album and track pages, where readers read Bandcamp\'s own player', () => {
    setPage('<meta property="og:type" content="album">', '/album/echoes');
    expect(needsNowPlayingMirror(document)).toBe(false);
    setPage('<meta property="og:type" content="song">', '/track/intro');
    expect(needsNowPlayingMirror(document)).toBe(false);
  });

  it('is false on the discover page', () => {
    setPage('<meta property="og:type" content="website">', '/discover');
    expect(needsNowPlayingMirror(document)).toBe(false);
  });
});

describe('NowPlayingMirror', () => {
  let mirror: NowPlayingMirror;
  let events: number;

  beforeEach(() => {
    setPage('<meta property="og:type" content="band">');
    mirror = new NowPlayingMirror(document);
    // Readers attach their listeners to the audio elements on the page when it loads.
    events = 0;
    for (const audio of document.getElementsByTagName('audio')) {
      audio.addEventListener('timeupdate', () => events++);
    }
  });

  it('puts an audio element without a src on the page straight away', () => {
    const audio = mirror.element.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.getAttribute('src')).toBeNull();
    expect(mirror.element.hidden).toBe(true);
  });

  it('shows the track it is given and tells readers', () => {
    mirror.setTrack(makeTrack({ artworkUrl: 'https://f4.bcbits.com/img/a1_10.jpg' }));
    expect(readerState()).toEqual({
      artist: 'Solar Drift',
      track: 'Intro',
      album: 'Echoes of the Void',
      trackArt: 'https://f4.bcbits.com/img/a1_10.jpg',
      isPlaying: false,
    });
    expect(events).toBe(1);
  });

  it('leaves the album out for a single-track release', () => {
    mirror.setTrack(makeTrack({ releaseType: 'track', albumTitle: 'Intro' }));
    expect(readerState().album).toBe('');
  });

  it('marks the page as playing while the player plays', () => {
    mirror.setTrack(makeTrack());
    mirror.setPlaying(true);
    expect(readerState().isPlaying).toBe(true);
    mirror.setPlaying(false);
    expect(readerState().isPlaying).toBe(false);
    expect(events).toBe(3);
  });

  it('clears the track when there is none', () => {
    mirror.setTrack(makeTrack({ artworkUrl: 'https://f4.bcbits.com/img/a1_10.jpg' }));
    mirror.setTrack(null);
    expect(readerState()).toMatchObject({ artist: '', track: '', album: '', trackArt: null });
  });
});
