import type { SavedCartItem, CartSnapshot } from './types';

const MAX_SNAPSHOTS = 20;

function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, '');
}

function sameItems(a: SavedCartItem[], b: SavedCartItem[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a.map((i) => normalizeUrl(i.url)));
  for (const item of b) {
    if (!setA.has(normalizeUrl(item.url))) return false;
  }
  return true;
}

// Add a new snapshot only when the cart content has changed from the most recent one.
// An empty incoming cart never writes to history.
export function addSnapshotIfChanged(
  snapshots: CartSnapshot[],
  items: SavedCartItem[]
): CartSnapshot[] {
  if (items.length === 0) return snapshots;
  const latest = snapshots[0];
  if (latest && sameItems(latest.items, items)) return snapshots;
  return [{ savedAt: Date.now(), items }, ...snapshots].slice(0, MAX_SNAPSHOTS);
}

// Compare a snapshot against the current cart items.
// toAdd: items in snapshot missing from cart (will be re-added on restore).
// extra: current cart items not present in snapshot (would remain in cart after restore).
export function diffSnapshot(
  snapshot: CartSnapshot,
  currentItems: SavedCartItem[]
): { toAdd: SavedCartItem[]; extra: SavedCartItem[] } {
  const currentNorms = new Set(currentItems.map((i) => normalizeUrl(i.url)));
  const snapshotNorms = new Set(snapshot.items.map((i) => normalizeUrl(i.url)));
  const toAdd = snapshot.items.filter((i) => !currentNorms.has(normalizeUrl(i.url)));
  const extra = currentItems.filter((i) => !snapshotNorms.has(normalizeUrl(i.url)));
  return { toAdd, extra };
}
