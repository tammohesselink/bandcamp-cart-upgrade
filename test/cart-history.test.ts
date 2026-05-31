import { describe, it, expect } from 'vitest';
import type { SavedCartItem, CartSnapshot } from '../src/types';
import { addSnapshotIfChanged, diffSnapshot } from '../src/cart-history';

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

  it('trims to MAX_SNAPSHOTS (20)', () => {
    const existing = Array.from({ length: 20 }, (_, i) => snapshot([item(`s${i}`)], i));
    const result = addSnapshotIfChanged(existing, [item('new')]);
    expect(result).toHaveLength(20);
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
