import { describe, it, expect } from 'vitest';
import type { SavedCartItem, CartSnapshot } from '../src/types';
import {
  addSnapshotIfChanged,
  buildHistoryExport,
  countNewSnapshots,
  diffSnapshot,
  mergeSnapshots,
  parseHistoryExport,
} from '../src/cart-history';

function item(slug: string, title = `Item ${slug}`, purchaseType?: 'track' | 'album'): SavedCartItem {
  return { url: `https://a.bandcamp.com/album/${slug}`, title, purchaseType };
}

function snapshot(items: SavedCartItem[], savedAt = 1000): CartSnapshot {
  return { savedAt, items };
}

// --- addSnapshotIfChanged ----------------------------------------------------

describe('addSnapshotIfChanged', () => {
  it('adds first snapshot from empty history', () => {
    const result = addSnapshotIfChanged([], [item('a')]);
    expect(result).toHaveLength(1);
    expect(result[0]!.items).toHaveLength(1);
  });

  it('returns existing snapshots unchanged when incoming is empty', () => {
    const existing = [snapshot([item('a')])];
    expect(addSnapshotIfChanged(existing, [])).toBe(existing);
  });

  it('returns empty array unchanged when both history and incoming are empty', () => {
    const result = addSnapshotIfChanged([], []);
    expect(result).toHaveLength(0);
  });

  it('does not add a new snapshot when cart is identical to the latest', () => {
    const existing = [snapshot([item('a'), item('b')])];
    const result = addSnapshotIfChanged(existing, [item('a'), item('b')]);
    expect(result).toHaveLength(1);
    expect(result).toBe(existing);
  });

  it('adds a new snapshot when cart changes', () => {
    const existing = [snapshot([item('a')])];
    const result = addSnapshotIfChanged(existing, [item('a'), item('b')]);
    expect(result).toHaveLength(2);
    expect(result[0]!.items).toHaveLength(2);
  });

  it('prepends new snapshot (most recent first)', () => {
    const existing = [snapshot([item('a')], 1000)];
    const result = addSnapshotIfChanged(existing, [item('b')]);
    expect(result[0]!.items[0]!.url).toContain('b');
    expect(result[1]!.items[0]!.url).toContain('a');
  });

  it('trims to MAX_SNAPSHOTS (60)', () => {
    const existing = Array.from({ length: 60 }, (_, i) => snapshot([item(`s${i}`)], i));
    const result = addSnapshotIfChanged(existing, [item('new')]);
    expect(result).toHaveLength(60);
    expect(result[0]!.items[0]!.url).toContain('new');
  });

  it('compares URLs case-insensitively ignoring trailing slashes', () => {
    const existing = [snapshot([{ url: 'https://a.bandcamp.com/album/FOO/', title: 'Foo' }])];
    const result = addSnapshotIfChanged(existing, [{ url: 'https://a.bandcamp.com/album/foo', title: 'Foo' }]);
    expect(result).toBe(existing);
  });
});

// --- diffSnapshot ------------------------------------------------------------

describe('diffSnapshot', () => {
  it('returns empty toAdd and extra when snapshot matches current', () => {
    const snap = snapshot([item('a'), item('b')]);
    const { toAdd, extra } = diffSnapshot(snap, [item('a'), item('b')]);
    expect(toAdd).toHaveLength(0);
    expect(extra).toHaveLength(0);
  });

  it('identifies items in snapshot missing from cart as toAdd', () => {
    const snap = snapshot([item('a'), item('b')]);
    const { toAdd } = diffSnapshot(snap, [item('a')]);
    expect(toAdd).toHaveLength(1);
    expect(toAdd[0]!.url).toContain('b');
  });

  it('identifies current cart items not in snapshot as extra', () => {
    const snap = snapshot([item('a')]);
    const { extra } = diffSnapshot(snap, [item('a'), item('extra')]);
    expect(extra).toHaveLength(1);
    expect(extra[0]!.url).toContain('extra');
  });

  it('extra items carry their title', () => {
    const snap = snapshot([item('a')]);
    const { extra } = diffSnapshot(snap, [item('a'), item('x', 'My Extra Track')]);
    expect(extra[0]!.title).toBe('My Extra Track');
  });

  it('handles completely disjoint sets', () => {
    const snap = snapshot([item('a'), item('b')]);
    const { toAdd, extra } = diffSnapshot(snap, [item('c')]);
    expect(toAdd).toHaveLength(2);
    expect(extra).toHaveLength(1);
  });

  it('normalises URLs when comparing (trailing slash, case)', () => {
    const snap = snapshot([{ url: 'https://a.bandcamp.com/album/FOO/', title: 'Foo' }]);
    const { toAdd } = diffSnapshot(snap, [{ url: 'https://a.bandcamp.com/album/foo', title: 'Foo' }]);
    expect(toAdd).toHaveLength(0);
  });
});

// --- export / import ---------------------------------------------------------

describe('parseHistoryExport', () => {
  it('round-trips an export', () => {
    const snapshots = [snapshot([item('a', 'A', 'album')], 2000), snapshot([item('b')], 1000)];
    const text = JSON.stringify(buildHistoryExport(snapshots));
    expect(parseHistoryExport(text)).toEqual(JSON.parse(JSON.stringify(snapshots)));
  });

  it('rejects invalid JSON', () => {
    expect(() => parseHistoryExport('not json')).toThrow('not valid JSON');
  });

  it('rejects JSON that is not a history export', () => {
    expect(() => parseHistoryExport(JSON.stringify({ snapshots: [] }))).toThrow('not a Bandcamp Cart Player');
    expect(() => parseHistoryExport('null')).toThrow('not a Bandcamp Cart Player');
  });

  it('rejects an unsupported version', () => {
    const data = { ...buildHistoryExport([]), version: 2 };
    expect(() => parseHistoryExport(JSON.stringify(data))).toThrow('Unsupported export version');
  });

  it('rejects malformed snapshots', () => {
    const data = { ...buildHistoryExport([]), snapshots: [{ savedAt: 1, items: [{ url: 5 }] }] };
    expect(() => parseHistoryExport(JSON.stringify(data))).toThrow('malformed');
  });
});

describe('mergeSnapshots', () => {
  it('keeps duplicates once and orders newest first', () => {
    const shared = snapshot([item('a'), item('b')], 2000);
    const existing = [shared, snapshot([item('c')], 1000)];
    const imported = [snapshot([item('d')], 3000), snapshot([item('b'), item('a')], 2000)];
    const merged = mergeSnapshots(existing, imported);
    expect(merged.map((s) => s.savedAt)).toEqual([3000, 2000, 1000]);
  });

  it('keeps snapshots saved at the same time with different items', () => {
    const merged = mergeSnapshots([snapshot([item('a')], 1000)], [snapshot([item('b')], 1000)]);
    expect(merged).toHaveLength(2);
  });

  it('drops empty snapshots', () => {
    expect(mergeSnapshots([], [snapshot([], 1000)])).toHaveLength(0);
  });

  it('caps the merged history at 60 snapshots', () => {
    const imported = Array.from({ length: 70 }, (_, i) => snapshot([item(`s${i}`)], i));
    const merged = mergeSnapshots([], imported);
    expect(merged).toHaveLength(60);
    expect(merged[0]!.savedAt).toBe(69);
  });
});

// --- countNewSnapshots -------------------------------------------------------

describe('countNewSnapshots', () => {
  it('counts imported snapshots even when the cap drops older ones', () => {
    const existing = Array.from({ length: 60 }, (_, i) => snapshot([item(`old${i}`)], i));
    const imported = Array.from({ length: 10 }, (_, i) => snapshot([item(`new${i}`)], 1000 + i));
    const merged = mergeSnapshots(existing, imported);
    expect(merged).toHaveLength(60);
    expect(countNewSnapshots(existing, merged)).toBe(10);
  });

  it('returns zero when every imported snapshot already exists', () => {
    const existing = [snapshot([item('a')], 1000)];
    expect(countNewSnapshots(existing, mergeSnapshots(existing, existing))).toBe(0);
  });
});
