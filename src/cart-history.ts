import type { SavedCartItem, CartSnapshot } from './types';
import { normalizeUrl } from './url';

export const CART_HISTORY_KEY = 'bcp_cart_history_v1';

const MAX_SNAPSHOTS = 60;
const EXPORT_FORMAT = 'bandcamp-cart-player-history';
const EXPORT_VERSION = 1;

export interface CartHistory {
  snapshots: CartSnapshot[];
  updatedAt: number;
}

export interface CartHistoryExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: number;
  snapshots: CartSnapshot[];
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

export function buildHistoryExport(snapshots: CartSnapshot[]): CartHistoryExport {
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: Date.now(), snapshots };
}

function isSavedCartItem(value: unknown): value is SavedCartItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.url === 'string' &&
    typeof item.title === 'string' &&
    (item.artist === undefined || typeof item.artist === 'string') &&
    (item.purchaseType === undefined || item.purchaseType === 'track' || item.purchaseType === 'album')
  );
}

function isCartSnapshot(value: unknown): value is CartSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.savedAt === 'number' &&
    Array.isArray(snapshot.items) &&
    snapshot.items.every(isSavedCartItem)
  );
}

// Parse an exported history file. Throws with a user-facing message when the file is not
// a cart history export or contains malformed snapshots.
export function parseHistoryExport(text: string): CartSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  const data = parsed as Partial<CartHistoryExport> | null;
  if (typeof data !== 'object' || data === null || data.format !== EXPORT_FORMAT) {
    throw new Error('File is not a Bandcamp Cart Player history export.');
  }
  if (data.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${String(data.version)}.`);
  }
  if (!Array.isArray(data.snapshots) || !data.snapshots.every(isCartSnapshot)) {
    throw new Error('Export contains malformed cart snapshots.');
  }
  return data.snapshots;
}

function snapshotIdentity(snapshot: CartSnapshot): string {
  const urls = snapshot.items.map((i) => normalizeUrl(i.url)).sort();
  return `${snapshot.savedAt}|${urls.join('|')}`;
}

// Combine imported snapshots with the existing history: duplicates (same time and same items)
// are kept once, the result is ordered newest first and capped at the usual history size.
export function mergeSnapshots(existing: CartSnapshot[], imported: CartSnapshot[]): CartSnapshot[] {
  const byIdentity = new Map<string, CartSnapshot>();
  for (const snapshot of [...existing, ...imported]) {
    if (snapshot.items.length === 0) continue;
    const identity = snapshotIdentity(snapshot);
    if (!byIdentity.has(identity)) byIdentity.set(identity, snapshot);
  }
  return [...byIdentity.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SNAPSHOTS);
}
