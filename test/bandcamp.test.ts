import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { parseTralbum } from '../src/bandcamp';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

describe('parseTralbum — single track page', () => {
  const pageUrl = 'https://solardrift.bandcamp.com/track/nightfall';
  const tracks = parseTralbum(fixture('single-track.html'), pageUrl);

  it('returns exactly one track', () => {
    expect(tracks).toHaveLength(1);
  });

  it('extracts the correct track title', () => {
    expect(tracks[0]!.trackTitle).toBe('Nightfall');
  });

  it('extracts the artist', () => {
    expect(tracks[0]!.artist).toBe('Solar Drift');
  });

  it('has a stream URL', () => {
    expect(tracks[0]!.streamUrl).toBe('https://t4.bcbits.com/stream/fake-stream-url-single');
  });

  it('marks the track as playable', () => {
    expect(tracks[0]!.unplayable).toBe(false);
  });

  it('extracts duration', () => {
    expect(tracks[0]!.durationSec).toBe(212.5);
  });

  it('builds the artwork URL from art_id', () => {
    expect(tracks[0]!.artworkUrl).toBe('https://f4.bcbits.com/img/a11111111_10.jpg');
  });

  it('releaseType is track for a single-track page', () => {
    expect(tracks[0]!.releaseType).toBe('track');
  });

  it('releaseId matches the tralbum id', () => {
    expect(tracks[0]!.releaseId).toBe(1);
  });

  it('trackId matches the track id', () => {
    expect(tracks[0]!.trackId).toBe(1);
  });

  it('releaseUrl is the track page URL', () => {
    expect(tracks[0]!.releaseUrl).toBe('https://solardrift.bandcamp.com/track/nightfall');
  });

  it('minPrice is extracted from current.minimum_price', () => {
    expect(tracks[0]!.minPrice).toBe(1.0);
  });

  it('trackMinPrice equals minPrice for a single-track release', () => {
    expect(tracks[0]!.trackMinPrice).toBe(1.0);
  });

  it('bandId is extracted from band_id', () => {
    expect(tracks[0]!.bandId).toBe(88888);
  });
});

describe('parseTralbum — album page', () => {
  const pageUrl = 'https://solardrift.bandcamp.com/album/echoes-of-the-void';
  const tracks = parseTralbum(fixture('album.html'), pageUrl);

  it('returns all three tracks', () => {
    expect(tracks).toHaveLength(3);
  });

  it('every track has the same album title', () => {
    for (const t of tracks) {
      expect(t.albumTitle).toBe('Echoes of the Void');
    }
  });

  it('marks the track without a stream URL as unplayable', () => {
    const unreleased = tracks.find((t) => t.trackTitle === 'Unreleased Fragment');
    expect(unreleased?.unplayable).toBe(true);
    expect(unreleased?.streamUrl).toBeNull();
  });

  it('keeps stream URLs for playable tracks', () => {
    const intro = tracks.find((t) => t.trackTitle === 'Intro');
    expect(intro?.streamUrl).toBe('https://t4.bcbits.com/stream/fake-stream-url-1');
    expect(intro?.unplayable).toBe(false);
  });

  it('resolves track page URLs relative to the album origin', () => {
    const intro = tracks.find((t) => t.trackTitle === 'Intro');
    expect(intro?.pageUrl).toBe('https://solardrift.bandcamp.com/track/intro');
  });

  it('builds artwork URL from art_id', () => {
    expect(tracks[0]!.artworkUrl).toBe('https://f4.bcbits.com/img/a22222222_10.jpg');
  });

  it('releaseType is album for an album page', () => {
    for (const t of tracks) {
      expect(t.releaseType).toBe('album');
    }
  });

  it('releaseId matches the album tralbum id', () => {
    for (const t of tracks) {
      expect(t.releaseId).toBe(5000);
    }
  });

  it('releaseUrl is the same for all tracks on the album', () => {
    for (const t of tracks) {
      expect(t.releaseUrl).toBe('https://solardrift.bandcamp.com/album/echoes-of-the-void');
    }
  });

  it('trackId is per-track', () => {
    expect(tracks[0]!.trackId).toBe(10);
    expect(tracks[1]!.trackId).toBe(11);
    expect(tracks[2]!.trackId).toBe(12);
  });

  it('minPrice is extracted from current.minimum_price', () => {
    for (const t of tracks) {
      expect(t.minPrice).toBe(7.0);
    }
  });

  it('trackMinPrice uses per-track minimum_price when present', () => {
    const intro = tracks.find((t) => t.trackTitle === 'Intro');
    expect(intro?.trackMinPrice).toBe(1.5);
  });

  it('trackMinPrice is null for tracks without individual pricing', () => {
    const deepSpace = tracks.find((t) => t.trackTitle === 'Deep Space');
    expect(deepSpace?.trackMinPrice).toBeNull();
  });

  it('bandId is extracted from band_id', () => {
    for (const t of tracks) {
      expect(t.bandId).toBe(99999);
    }
  });
});

describe('parseTralbum — invalid HTML', () => {
  it('returns empty array for empty string', () => {
    expect(parseTralbum('', 'https://example.com')).toEqual([]);
  });

  it('returns empty array when no TralbumData present', () => {
    expect(parseTralbum('<html><body><p>nothing</p></body></html>', 'https://example.com')).toEqual(
      []
    );
  });
});
