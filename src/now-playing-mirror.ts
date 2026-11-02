import type { PlaylistTrack } from './types';

// Other browser extensions can follow what plays on a Bandcamp page by reading
// the page. On label and cart pages they look for the markup of Bandcamp's old
// home page player, which nothing on those pages has, and only hear about
// playback from the <audio> elements on the page when they load. So they never
// see this extension's player.
//
// The mirror copies the player's track into that markup and fires events on an
// <audio> element of its own. That element must be on the page before they
// load, which happens once the page has finished loading.

const PAGE_TYPES_WITH_OWN_SELECTORS = ['album', 'song', 'profile', 'music.playlist'];

// True on the pages where readers fall back to the old home page player's
// markup. Elsewhere they read Bandcamp's own player, and the mirror would
// change nothing.
export function needsNowPlayingMirror(doc: Document): boolean {
  if (doc.querySelector('main#p-tralbum-page')) return false;
  const pageType = doc.querySelector('meta[property="og:type"]')?.getAttribute('content') ?? '';
  if (PAGE_TYPES_WITH_OWN_SELECTORS.includes(pageType)) return false;
  if (doc.querySelector('#carousel-player')) return false;
  return !window.location.pathname.startsWith('/discover');
}

export class NowPlayingMirror {
  readonly element: HTMLElement;
  private readonly audio: HTMLAudioElement;
  private readonly artistEl: HTMLAnchorElement;
  private readonly titleEl: HTMLElement;
  private readonly albumEl: HTMLElement;
  private readonly artworkEl: HTMLImageElement;

  constructor(doc: Document) {
    this.element = doc.createElement('div');
    this.element.id = 'bcp-now-playing-mirror';
    this.element.hidden = true;
    // The text is read even though it is hidden: innerText falls back to
    // textContent for elements that are not rendered. The audio element has no
    // src, so readers skip it when looking for a track id.
    this.element.innerHTML = `
      <audio></audio>
      <div class="detail-artist"><a></a></div>
      <div class="track_info"><span class="title"></span></div>
      <div class="detail-album"></div>
      <div class="discover-detail-inner"><img alt=""></div>`;
    this.audio = this.element.querySelector('audio')!;
    this.artistEl = this.element.querySelector('.detail-artist a')!;
    this.titleEl = this.element.querySelector('.track_info .title')!;
    this.albumEl = this.element.querySelector('.detail-album')!;
    this.artworkEl = this.element.querySelector('.discover-detail-inner img')!;
    doc.body.appendChild(this.element);
  }

  setTrack(track: PlaylistTrack | null) {
    this.artistEl.textContent = track?.artist ?? '';
    this.titleEl.textContent = track?.trackTitle ?? '';
    // Single-track releases have no album, and readers would report the track
    // title as one.
    this.albumEl.textContent = track && track.releaseType === 'album' ? track.albumTitle : '';
    if (track?.artworkUrl) this.artworkEl.src = track.artworkUrl;
    else this.artworkEl.removeAttribute('src');
    this.notify();
  }

  // Readers count the page as playing while any element has the class `playing`.
  setPlaying(playing: boolean) {
    this.element.classList.toggle('playing', playing);
    this.notify();
  }

  // Readers re-read the page on 'playing', 'pause' and 'timeupdate'.
  private notify() {
    this.audio.dispatchEvent(new Event('timeupdate'));
  }
}
