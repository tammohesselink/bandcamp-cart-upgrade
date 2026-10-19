import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Player } from '../src/player';
import type { PlaylistTrack } from '../src/types';
import { makeTrack } from './track-factory';

const HOUR = 60 * 60 * 1000;

function freshTrack(n: number, overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return makeTrack({
    trackTitle: `Track ${n}`,
    pageUrl: `https://solardrift.bandcamp.com/track/track-${n}`,
    streamUrl: `https://t4.bcbits.com/stream/track-${n}-old`,
    trackId: n,
    streamFetchedAt: Date.now(),
    ...overrides,
  });
}

function expiredTrack(n: number, overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return freshTrack(n, { streamFetchedAt: Date.now() - 2 * HOUR, ...overrides });
}

function audioOf(player: Player): HTMLAudioElement {
  return (player as unknown as { audio: HTMLAudioElement }).audio;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// Stands in for the content script's refetch of the release page: gives each
// refreshed track a new link, or marks the listed tracks as no longer streamable.
function refreshWith(player: Player, { unplayable = [] as string[] } = {}) {
  const refresh = vi.fn(async (track: PlaylistTrack) => {
    if (unplayable.includes(track.trackTitle)) {
      track.unplayable = true;
      track.streamUrl = null;
    } else {
      track.streamUrl = track.streamUrl!.replace('-old', '-new');
    }
    track.streamFetchedAt = Date.now();
  });
  player.onRefreshStream = refresh;
  return refresh;
}

beforeEach(() => {
  document.body.innerHTML = '';
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: { get: (_keys: unknown, callback?: (result: object) => void) => callback?.({}) } },
  };
});

describe('Player stream link refresh', () => {
  it('plays a track with a fresh link without refetching it', async () => {
    const player = new Player([freshTrack(1)]);
    const refresh = refreshWith(player);

    player.jumpTo('cart', 0);
    await settle();

    expect(refresh).not.toHaveBeenCalled();
    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-1-old');
    expect(audioOf(player).paused).toBe(false);
  });

  it('refetches an expired link before playing the track', async () => {
    const player = new Player([freshTrack(1), expiredTrack(2)]);
    const refresh = refreshWith(player);

    player.jumpTo('cart', 1);
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-new');
    expect(audioOf(player).paused).toBe(false);
  });

  it('does not refetch the link of a track that is already playing', async () => {
    const player = new Player([freshTrack(1)]);
    const refresh = refreshWith(player);
    player.jumpTo('cart', 0);
    await settle();
    player.getPlaylistTracks('cart')[0]!.streamFetchedAt = Date.now() - 2 * HOUR;

    player.jumpTo('cart', 0);
    await settle();

    expect(refresh).not.toHaveBeenCalled();
    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-1-old');
  });

  it('resumes the loaded track when play is pressed after its release was removed', async () => {
    const other = freshTrack(1, { releaseUrl: 'https://solardrift.bandcamp.com/album/other' });
    const removed = freshTrack(2);
    const player = new Player([other, removed]);
    refreshWith(player);
    player.jumpTo('cart', 1);
    await settle();
    audioOf(player).currentTime = 150;

    player.removeTracksByReleaseUrl('cart', removed.releaseUrl);
    player.pause();
    player.play();
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-old');
    expect(audioOf(player).currentTime).toBe(150);
  });

  it('skips to the next playable track when the refresh shows the next one can no longer stream', async () => {
    const player = new Player([freshTrack(1), expiredTrack(2), freshTrack(3)]);
    refreshWith(player, { unplayable: ['Track 2'] });
    player.jumpTo('cart', 0);
    await settle();

    audioOf(player).dispatchEvent(new Event('ended'));
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-3-old');
    expect(audioOf(player).paused).toBe(false);
  });

  it('retries a failing link once with a refreshed copy', async () => {
    const player = new Player([freshTrack(1), freshTrack(2)]);
    const refresh = refreshWith(player);
    player.jumpTo('cart', 0);
    await settle();

    audioOf(player).dispatchEvent(new Event('error'));
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-1-new');
  });

  it('moves on to the next track when the refreshed link fails as well', async () => {
    const player = new Player([freshTrack(1), freshTrack(2)]);
    const refresh = refreshWith(player);
    player.jumpTo('cart', 0);
    await settle();

    audioOf(player).dispatchEvent(new Event('error'));
    await settle();
    audioOf(player).dispatchEvent(new Event('error'));
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-old');
  });

  it('shows a spinner on the play button while a link is being refreshed and the play glyph after a pause', async () => {
    const player = new Player([expiredTrack(1)]);
    player.onRefreshStream = () => new Promise<void>(() => {});
    const playButton = player.wrapper.querySelector('.bcp-btn-play')!;

    player.jumpTo('cart', 0);
    await settle();
    const spinnerWhileRefreshing = playButton.querySelector('.bcp-spinner');
    player.pause();

    expect(spinnerWhileRefreshing).not.toBeNull();
    expect(playButton.querySelector('.bcp-spinner')).toBeNull();
    expect(playButton.textContent).toBe('▶');
  });

  it('shows the play glyph again when the browser refuses to play after a refresh', async () => {
    const player = new Player([expiredTrack(1)]);
    refreshWith(player);
    vi.spyOn(audioOf(player), 'play').mockRejectedValue(new Error('NotAllowedError'));
    const playButton = player.wrapper.querySelector('.bcp-btn-play')!;

    player.jumpTo('cart', 0);
    await settle();

    expect(playButton.querySelector('.bcp-spinner')).toBeNull();
    expect(playButton.textContent).toBe('▶');
  });

  it('does not start playback when pause is pressed while a link is being refreshed', async () => {
    const player = new Player([expiredTrack(1)]);
    let finishRefresh = () => {};
    player.onRefreshStream = (track) =>
      new Promise<void>((resolve) => {
        finishRefresh = () => {
          track.streamUrl = 'https://t4.bcbits.com/stream/track-1-new';
          track.streamFetchedAt = Date.now();
          resolve();
        };
      });

    player.jumpTo('cart', 0);
    await settle();
    player.pause();
    finishRefresh();
    await settle();

    expect(audioOf(player).paused).toBe(true);
  });
});

function preloadedOf(player: Player): Map<string, HTMLAudioElement> {
  return (player as unknown as { preloaded: Map<string, HTMLAudioElement> }).preloaded;
}

describe('Player preloading upcoming tracks', () => {
  it('refreshes the links of the next four playable tracks and buffers them while a track plays', async () => {
    const player = new Player([
      freshTrack(1),
      expiredTrack(2),
      freshTrack(3, { unplayable: true, streamUrl: null }),
      freshTrack(4),
      expiredTrack(5),
      freshTrack(6),
      freshTrack(7),
    ]);
    const refresh = refreshWith(player);
    player.jumpTo('cart', 0);
    await settle();

    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();

    expect(refresh.mock.calls.map(([track]) => track.trackTitle)).toEqual(['Track 2', 'Track 5']);
    expect([...preloadedOf(player).keys()]).toEqual([
      'https://t4.bcbits.com/stream/track-2-new',
      'https://t4.bcbits.com/stream/track-4-old',
      'https://t4.bcbits.com/stream/track-5-new',
      'https://t4.bcbits.com/stream/track-6-old',
    ]);
    expect(preloadedOf(player).get('https://t4.bcbits.com/stream/track-2-new')!.preload).toBe('auto');
  });

  it('plays the next track from its buffered element without refetching its link', async () => {
    const player = new Player([freshTrack(1), expiredTrack(2)]);
    const refresh = refreshWith(player);
    player.jumpTo('cart', 0);
    await settle();
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();
    const buffered = preloadedOf(player).get('https://t4.bcbits.com/stream/track-2-new')!;
    const first = audioOf(player);

    first.dispatchEvent(new Event('ended'));
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(audioOf(player)).toBe(buffered);
    expect(audioOf(player).paused).toBe(false);
    expect(first.getAttribute('src')).toBeNull();
    expect(preloadedOf(player).size).toBe(0);
  });

  it('keeps playing a track when preloading the rest of its release gives it a new link', async () => {
    const tracks = [expiredTrack(1), expiredTrack(2)];
    tracks[0]!.streamFetchedAt = Date.now();
    const player = new Player(tracks);
    // Like the real refetch, a refresh updates every track of the release.
    const refresh = vi.fn(async () => {
      for (const track of player.getPlaylistTracks('cart')) {
        track.streamUrl = track.streamUrl!.replace('-old', '-new');
        track.streamFetchedAt = Date.now();
      }
    });
    player.onRefreshStream = refresh;
    player.jumpTo('cart', 0);
    await settle();
    const playing = audioOf(player);
    playing.currentTime = 90;
    playing.dispatchEvent(new Event('playing'));
    await settle();

    player.jumpTo('cart', 0);
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(audioOf(player)).toBe(playing);
    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-1-old');
    expect(audioOf(player).currentTime).toBe(90);
  });

  it('does not retry a preload refresh that left the link stale', async () => {
    const player = new Player([freshTrack(1), expiredTrack(2)]);
    // The release page could not be fetched, so nothing changes.
    const refresh = vi.fn(async () => {});
    player.onRefreshStream = refresh;
    player.jumpTo('cart', 0);
    await settle();

    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(preloadedOf(player).size).toBe(0);
  });

  it('retries a failed preload refresh once some time has passed', async () => {
    const player = new Player([freshTrack(1), expiredTrack(2)]);
    const refresh = vi.fn(async () => {});
    player.onRefreshStream = refresh;
    player.jumpTo('cart', 0);
    await settle();
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();
    clock.mockRestore();

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('loads the link afresh when its buffered element failed', async () => {
    const player = new Player([freshTrack(1), freshTrack(2)]);
    refreshWith(player);
    player.jumpTo('cart', 0);
    await settle();
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();
    const buffered = preloadedOf(player).get('https://t4.bcbits.com/stream/track-2-old')!;
    Object.defineProperty(buffered, 'error', { value: { code: 2 } });
    const first = audioOf(player);

    first.dispatchEvent(new Event('ended'));
    await settle();

    expect(audioOf(player)).toBe(first);
    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-old');
    expect(buffered.getAttribute('src')).toBeNull();
  });

  it('applies the tempo to a buffered element when it is swapped in', async () => {
    const player = new Player([freshTrack(1), freshTrack(2)]);
    refreshWith(player);
    player.jumpTo('cart', 0);
    await settle();
    (player as unknown as { playbackRate: number }).playbackRate = 1.08;
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();

    audioOf(player).dispatchEvent(new Event('ended'));
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-2-old');
    expect(audioOf(player).playbackRate).toBe(1.08);
  });

  it('drops buffered tracks when switching playlist or tearing down', async () => {
    const player = new Player([freshTrack(1), freshTrack(2)]);
    refreshWith(player);
    player.setPlaylist('discography', 'Label discography', [freshTrack(10)]);
    player.jumpTo('cart', 0);
    await settle();
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();
    const buffered = preloadedOf(player).get('https://t4.bcbits.com/stream/track-2-old')!;

    player.selectPlaylist('discography');

    expect(preloadedOf(player).size).toBe(0);
    expect(buffered.getAttribute('src')).toBeNull();

    player.jumpTo('cart', 0);
    await settle();
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();
    const rebuffered = preloadedOf(player).get('https://t4.bcbits.com/stream/track-2-old')!;
    player.destroy();

    expect(preloadedOf(player).size).toBe(0);
    expect(rebuffered.getAttribute('src')).toBeNull();
  });

  it('ignores events from elements that are only buffering', async () => {
    const player = new Player([freshTrack(1), freshTrack(2), freshTrack(3)]);
    refreshWith(player);
    player.jumpTo('cart', 0);
    await settle();
    audioOf(player).dispatchEvent(new Event('playing'));
    await settle();

    preloadedOf(player).get('https://t4.bcbits.com/stream/track-2-old')!.dispatchEvent(new Event('ended'));
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-1-old');
  });
});

describe('Player with a removed track still loaded', () => {
  it('moves on to the next track when the removed track can no longer stream', async () => {
    const otherRelease = 'https://solardrift.bandcamp.com/album/other';
    const first = freshTrack(1, { releaseUrl: otherRelease });
    const removed = freshTrack(2);
    const next = freshTrack(3, { releaseUrl: otherRelease });
    const player = new Player([first, removed, next]);
    refreshWith(player, { unplayable: ['Track 2'] });
    player.jumpTo('cart', 1);
    await settle();
    player.removeTracksByReleaseUrl('cart', removed.releaseUrl);

    audioOf(player).dispatchEvent(new Event('error'));
    await settle();

    expect(audioOf(player).src).toBe('https://t4.bcbits.com/stream/track-3-old');
    expect(audioOf(player).paused).toBe(false);
  });
});

describe('Player playlist tabs', () => {
  function tabNamed(player: Player, text: string): HTMLButtonElement | undefined {
    return Array.from(player.wrapper.querySelectorAll<HTMLButtonElement>('.bcp-tab')).find((tab) => tab.textContent === text);
  }

  it('shows a greyed-out tab that explains why the playlist cannot be played', () => {
    const player = new Player([]);
    player.setPlaylistUnavailable('cart', 'Cart (empty)', 'Your cart is empty.');

    const tab = tabNamed(player, 'Cart (empty)');

    expect(tab?.getAttribute('aria-disabled')).toBe('true');
    expect(tab?.title).toBe('Your cart is empty.');
  });

  it('shows the reason as a message, also announced to screen readers, when the greyed-out tab is clicked', async () => {
    const player = new Player([]);
    player.setPlaylistUnavailable('cart', 'Cart (could not load)', 'None of the 3 releases could be loaded.', 'error');

    tabNamed(player, 'Cart (could not load)')!.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(document.querySelector('.bcp-toast-error')?.textContent).toBe('None of the 3 releases could be loaded.');
    expect(player.wrapper.querySelector('[role="status"]')?.textContent).toBe('None of the 3 releases could be loaded.');
  });

  it('greys out an emptied playlist and restores it when tracks are added again', () => {
    const track = freshTrack(1);
    const player = new Player([track]);

    player.removeTracksByReleaseUrl('cart', track.releaseUrl);
    player.setPlaylistUnavailable('cart', 'Cart (empty)', 'Everything was removed from your cart.');
    const emptiedTab = tabNamed(player, 'Cart (empty)');
    player.addTracksToPlaylist('cart', [freshTrack(2)]);

    expect(emptiedTab?.getAttribute('aria-disabled')).toBe('true');
    expect(tabNamed(player, 'Cart')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('shows a clickable tab for an on-demand playlist that starts loading it when clicked', () => {
    const player = new Player([freshTrack(1)]);
    const onLoad = vi.fn(() => player.setPlaylist('discography', 'Label discography', [freshTrack(2)]));
    player.setPlaylistOnDemand('discography', 'Label discography (5 releases)', 'Click to load.', onLoad);

    const tab = tabNamed(player, 'Label discography (5 releases)');
    expect(tab?.getAttribute('aria-disabled')).toBeNull();
    expect(tab?.classList.contains('bcp-tab-unavailable')).toBe(false);

    tab!.click();

    expect(onLoad).toHaveBeenCalledOnce();
    expect(tabNamed(player, 'Label discography')).toBeDefined();
  });

  it('replaces the greyed-out tab with a playable one once the playlist loads', () => {
    const player = new Player([freshTrack(1)]);
    player.setPlaylistUnavailable('discography', 'Label discography (loading 0 / 5)', 'Loading.', 'loading');

    player.setPlaylist('discography', 'Label discography', [freshTrack(2)]);

    expect(tabNamed(player, 'Label discography (loading 0 / 5)')).toBeUndefined();
    expect(tabNamed(player, 'Label discography')?.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('Player cart buttons', () => {
  async function playing(track: PlaylistTrack): Promise<Player> {
    const player = new Player([track]);
    player.jumpTo('cart', 0);
    await settle();
    return player;
  }

  function cartButton(player: Player, text: string): HTMLButtonElement {
    const buttons = Array.from(player.wrapper.querySelectorAll<HTMLButtonElement>('.bcp-cart-action-btn'));
    return buttons.find((b) => b.textContent === text)!;
  }

  it('offers both the track and its release for an album track', async () => {
    const player = await playing(freshTrack(1));

    expect(cartButton(player, '+ Track').classList.contains('bcp-disabled')).toBe(false);
    expect(cartButton(player, '+ Release').classList.contains('bcp-disabled')).toBe(false);
  });

  it('greys out "+ Release" for a single-track release that is not on an album', async () => {
    const player = await playing(freshTrack(1, {
      releaseType: 'track',
      releaseUrl: 'https://solardrift.bandcamp.com/track/track-1',
      albumUrl: null,
    }));

    expect(cartButton(player, '+ Track').classList.contains('bcp-disabled')).toBe(false);
    expect(cartButton(player, '+ Release').classList.contains('bcp-disabled')).toBe(true);
  });

  it('adds only the track from "+ Track" on a track page that is also on an album', async () => {
    const player = await playing(freshTrack(1, {
      releaseType: 'track',
      releaseUrl: 'https://solardrift.bandcamp.com/track/track-1',
      albumUrl: 'https://solardrift.bandcamp.com/album/echoes-of-the-void',
    }));
    const onCartAdd = vi.fn(async () => true);
    player.onCartAdd = onCartAdd;

    cartButton(player, '+ Track').click();
    await settle();

    expect(onCartAdd).toHaveBeenCalledWith(expect.objectContaining({ trackId: 1 }), 'release');
  });

  it('adds the album from a track page whose track is only sold with the album', async () => {
    const player = await playing(freshTrack(1, {
      releaseType: 'track',
      releaseUrl: 'https://solardrift.bandcamp.com/track/track-1',
      albumUrl: 'https://solardrift.bandcamp.com/album/echoes-of-the-void',
      purchasable: false,
    }));
    const onCartAdd = vi.fn(async () => true);
    player.onCartAdd = onCartAdd;

    expect(cartButton(player, '+ Track').classList.contains('bcp-disabled')).toBe(true);
    cartButton(player, '+ Release').click();
    await settle();

    expect(onCartAdd).toHaveBeenCalledWith(expect.objectContaining({ trackId: 1 }), 'album');
  });

  it('shows a track page as in the cart once its album was added', async () => {
    const albumUrl = 'https://solardrift.bandcamp.com/album/echoes-of-the-void';
    const player = await playing(freshTrack(1, {
      releaseType: 'track',
      releaseUrl: 'https://solardrift.bandcamp.com/track/track-1',
      albumUrl,
    }));

    player.addCartUrl(albumUrl);

    expect(player.wrapper.querySelector('.bcp-in-cart-badge')?.textContent).toBe('✓ In cart (full album)');
  });
});
