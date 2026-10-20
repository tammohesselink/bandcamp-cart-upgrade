import type { PlaylistTrack } from '../src/types';

export function makeTrack(overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return {
    trackTitle: 'Intro',
    albumTitle: 'Echoes of the Void',
    artist: 'Solar Drift',
    streamUrl: 'https://t4.bcbits.com/stream/fake-stream-url-1',
    pageUrl: 'https://solardrift.bandcamp.com/track/intro',
    artworkUrl: '',
    durationSec: 90,
    unplayable: false,
    releaseUrl: 'https://solardrift.bandcamp.com/album/echoes-of-the-void',
    releaseId: 5000,
    releaseType: 'album',
    trackId: 10,
    bandId: 99999,
    minPrice: 7,
    trackMinPrice: 1.5,
    currency: null,
    purchasable: true,
    ...overrides,
  };
}
