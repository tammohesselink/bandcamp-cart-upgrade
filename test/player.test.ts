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
