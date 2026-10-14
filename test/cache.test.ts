import { describe, it, expect } from 'vitest';
import {
  isCacheEntryUsable,
  isStreamFresh,
  LIVE_DATA_MAX_AGE_MS,
  TRACK_DETAILS_MAX_AGE_MS,
} from '../src/cache';
import { makeTrack as track } from './track-factory';

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

describe('isCacheEntryUsable', () => {
  it.each([
    {
      name: 'accepts track details cached three months ago',
      tracks: [track()],
      ageMs: 90 * DAY,
      maxAgeMs: TRACK_DETAILS_MAX_AGE_MS,
      expected: true,
    },
    {
      name: 'rejects track details older than half a year',
      tracks: [track()],
      ageMs: 183 * DAY,
      maxAgeMs: TRACK_DETAILS_MAX_AGE_MS,
      expected: false,
    },
    {
      name: 'rejects an entry older than an hour when live data is required',
      tracks: [track()],
      ageMs: 61 * MINUTE,
      maxAgeMs: LIVE_DATA_MAX_AGE_MS,
      expected: false,
    },
    {
      name: 'accepts an entry younger than an hour when live data is required',
      tracks: [track()],
      ageMs: 30 * MINUTE,
      maxAgeMs: LIVE_DATA_MAX_AGE_MS,
      expected: true,
    },
    {
      name: 'accepts a release with unplayable tracks cached three months ago',
      tracks: [track(), track({ unplayable: true, streamUrl: null })],
      ageMs: 90 * DAY,
      maxAgeMs: TRACK_DETAILS_MAX_AGE_MS,
      expected: true,
    },
    {
      name: 'rejects an entry without tracks',
      tracks: [],
      ageMs: 0,
      maxAgeMs: TRACK_DETAILS_MAX_AGE_MS,
      expected: false,
    },
    {
      name: 'rejects any entry when a forced refresh asks for zero age',
      tracks: [track()],
      ageMs: 1,
      maxAgeMs: 0,
      expected: false,
    },
  ])('$name', ({ tracks, ageMs, maxAgeMs, expected }) => {
    expect(isCacheEntryUsable({ tracks, cachedAt: NOW - ageMs }, maxAgeMs, NOW)).toBe(expected);
  });
});

describe('isStreamFresh', () => {
  it.each([
    { name: 'treats a link fetched ten minutes ago as fresh', streamFetchedAt: NOW - 10 * MINUTE, expected: true },
    { name: 'treats a link fetched over an hour ago as expired', streamFetchedAt: NOW - 61 * MINUTE, expected: false },
    { name: 'treats a link with an unknown fetch time as expired', streamFetchedAt: undefined, expected: false },
  ])('$name', ({ streamFetchedAt, expected }) => {
    expect(isStreamFresh(track({ streamFetchedAt }), NOW)).toBe(expected);
  });
});
