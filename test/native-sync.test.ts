import { describe, it, expect, beforeEach } from 'vitest';
import { Player } from '../src/player';
import { setupNativePlayerSync } from '../src/native-sync';
import type { PlaylistTrack } from '../src/types';
import { makeTrack } from './track-factory';

const HOUR = 60 * 60 * 1000;
const TRACK_COUNT = 3;

function pageTrack(n: number, overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return makeTrack({
    trackTitle: `Track ${n}`,
    pageUrl: `https://solardrift.bandcamp.com/track/track-${n}`,
    streamUrl: `https://t4.bcbits.com/stream/track-${n}-old`,
    trackId: n,
    streamFetchedAt: Date.now(),
    ...overrides,
  });
}

function audioOf(player: Player): HTMLAudioElement {
  return (player as unknown as { audio: HTMLAudioElement }).audio;
}

function playButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('#bcp-bar .bcp-btn-play')!;
}

function nextButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('#bcp-bar button[aria-label="Next"]')!;
}

// The native audio seeks to 0:00 when a track starts, so seeks just after a
// play or a tab switch are not passed on.
async function pastSeekGrace(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// A stand-in for an album page's own player: a track table whose play controls
// make a row current and play it, and an audio element that moves on to the
// next row when its track ends.
function bandcampPage() {
  const rows = Array.from({ length: TRACK_COUNT }, (_, i) => `
    <tr class="track_row_view">
      <td class="play_col"><div class="play_status"></div></td>
      <td><a href="https://solardrift.bandcamp.com/track/track-${i + 1}">Track ${i + 1}</a></td>
    </tr>`).join('');
  document.body.innerHTML = `<table id="track_table">${rows}</table><audio></audio>`;
  const native = document.querySelector('audio')!;
  const rowEls = Array.from(document.querySelectorAll<HTMLElement>('tr.track_row_view'));
  let current = -1;
  let ended = false;
  Object.defineProperty(native, 'ended', { get: () => ended });
  Object.defineProperty(native, 'duration', { value: 180 });

  const select = (i: number) => {
    if (i === current && !native.paused) {
      native.pause();
      return;
    }
    rowEls.forEach((row, j) => row.classList.toggle('current_track', j === i));
    current = i;
    ended = false;
    native.src = `https://t4.bcbits.com/stream/native-${i + 1}`;
    native.currentTime = 0;
    void native.play();
  };
  rowEls.forEach((row, i) => row.querySelector('.play_col')!.addEventListener('click', () => select(i)));
  native.addEventListener('ended', () => {
    if (current < TRACK_COUNT - 1) select(current + 1);
  });

  return {
    native,
    clickRow: (i: number) => (rowEls[i]!.querySelector('.play_col') as HTMLElement).click(),
    currentRow: () => current,
    // Bandcamp's play-status icon changes class while a track buffers and plays.
    flickerStatus: (i: number) => rowEls[i]!.querySelector('.play_status')!.classList.toggle('busy'),
    // As in browsers, reaching the end pauses the audio before 'ended' fires.
    finish: () => {
      ended = true;
      native.pause();
      native.dispatchEvent(new Event('ended'));
    },
  };
}

function setup(tracks = [1, 2, 3].map((n) => pageTrack(n))) {
  const page = bandcampPage();
  const player = new Player([]);
  document.body.appendChild(player.wrapper);
  player.setPlaylist('currentpage', 'Current page', tracks);
  const teardown = setupNativePlayerSync(player);
  return { page, player, teardown };
}

// Holds every stream refresh until release() is called.
function deferredRefresh(player: Player) {
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => { release = resolve; });
  player.onRefreshStream = async (track) => {
    await done;
    track.streamUrl = track.streamUrl!.replace('-old', '-new');
    track.streamFetchedAt = Date.now();
  };
  return () => release();
}

const expired = () => [1, 2, 3].map((n) => pageTrack(n, { streamFetchedAt: Date.now() - 2 * HOUR }));

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: { get: (_keys: unknown, callback?: (result: object) => void) => callback?.({}) } },
  };
});

describe('native player sync', () => {
  it('plays a native row in the bottom player', async () => {
    const { page, player } = setup();

    page.clickRow(1);
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-old');
    expect(audioOf(player).paused).toBe(false);
    expect(page.native.paused).toBe(false);
  });

  it('keeps a play that waits for a fresh link when Bandcamp changes classes in the track table', async () => {
    const { page, player } = setup(expired());
    const release = deferredRefresh(player);

    page.clickRow(1);
    await settle();
    page.flickerStatus(1);
    await settle();
    page.flickerStatus(1);
    await settle();
    release();
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-new');
    expect(audioOf(player).paused).toBe(false);
  });

  it('pauses the native player when a play waiting for its link is cancelled', async () => {
    const { page, player } = setup(expired());
    deferredRefresh(player);
    page.clickRow(0);
    await settle();
    expect(page.native.paused).toBe(false);

    playButton().click();
    await settle();

    expect(page.native.paused).toBe(true);
    expect(audioOf(player).paused).toBe(true);
  });

  it('moves the native player to the track the bottom player skips to, and keeps it playing', async () => {
    const { page, player } = setup();
    player.jumpTo('currentpage', 0);
    await settle();
    expect(page.currentRow()).toBe(0);
    expect(page.native.paused).toBe(false);

    nextButton().click();
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-old');
    expect(page.currentRow()).toBe(1);
    expect(page.native.paused).toBe(false);
  });

  it('pauses and resumes the native player with the bottom player', async () => {
    const { page, player } = setup();
    player.jumpTo('currentpage', 0);
    await settle();

    playButton().click();
    await settle();
    expect(page.native.paused).toBe(true);

    playButton().click();
    await settle();
    expect(page.native.paused).toBe(false);
    expect(page.currentRow()).toBe(0);
  });

  it('pauses the bottom player when the native player is paused', async () => {
    const { page, player } = setup();
    page.clickRow(0);
    await settle();

    page.clickRow(0);
    await settle();

    expect(page.native.paused).toBe(true);
    expect(audioOf(player).paused).toBe(true);
  });

  it('does not cut the bottom player short when the native track ends first', async () => {
    const { page, player } = setup();
    player.jumpTo('currentpage', 0);
    await settle();

    page.finish();
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-1-old');
    expect(audioOf(player).paused).toBe(false);
    expect(page.currentRow()).toBe(1);
    expect(page.native.paused).toBe(true);

    audioOf(player).pause();
    audioOf(player).dispatchEvent(new Event('ended'));
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-old');
    expect(audioOf(player).paused).toBe(false);
    expect(page.currentRow()).toBe(1);
    expect(page.native.paused).toBe(false);
  });

  it('switches from the cart to the current page when a native row is played', async () => {
    const { page, player } = setup();
    player.setPlaylist('cart', 'Cart', [pageTrack(9, { releaseUrl: 'https://other.bandcamp.com/album/x' })]);
    player.jumpTo('cart', 0);
    await settle();
    expect(page.native.paused).toBe(true);

    page.clickRow(2);
    await settle();

    expect(player.currentPlaylistId).toBe('currentpage');
    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-3-old');
    expect(audioOf(player).paused).toBe(false);
  });

  it('leaves the cart track alone when the native player is seeked', async () => {
    const { page, player } = setup();
    player.setPlaylist('cart', 'Cart', [pageTrack(9, { releaseUrl: 'https://other.bandcamp.com/album/x' })]);
    player.jumpTo('cart', 0);
    await settle();
    Object.defineProperty(audioOf(player), 'duration', { value: 200 });
    audioOf(player).currentTime = 30;
    await pastSeekGrace();

    page.native.currentTime = 100;
    page.native.dispatchEvent(new Event('seeked'));

    expect(audioOf(player).currentTime).toBe(30);
  });

  it('seeks the bottom player when the native player is seeked on the current page', async () => {
    const { page, player } = setup();
    page.clickRow(0);
    await settle();
    Object.defineProperty(audioOf(player), 'duration', { value: 180 });
    await pastSeekGrace();

    page.native.currentTime = 90;
    page.native.dispatchEvent(new Event('seeked'));

    expect(audioOf(player).currentTime).toBe(90);
  });

  it('only cues a native row change while the bottom player is paused', async () => {
    const { player } = setup();
    const rows = document.querySelectorAll('tr.track_row_view');

    rows[1]!.classList.add('current_track');
    await settle();

    expect(player.getActiveTrack('currentpage')?.trackTitle).toBe('Track 2');
    expect(audioOf(player).paused).toBe(true);
  });

  it('unmutes the native player on teardown', () => {
    const { page, teardown } = setup();
    expect(page.native.muted).toBe(true);

    teardown();

    expect(page.native.muted).toBe(false);
  });
});

describe('Player.cueTrackByPageUrl', () => {
  it('keeps playing when it cues another track', async () => {
    const { player } = setup();
    player.jumpTo('currentpage', 0);
    await settle();

    player.cueTrackByPageUrl('currentpage', 'https://solardrift.bandcamp.com/track/track-3');
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-3-old');
    expect(audioOf(player).paused).toBe(false);
  });
});
