import type { NamedCart, SavedCartItem } from './types';
import { normalizeUrl } from './url';

export function createNamedCart(carts: NamedCart[], name: string): NamedCart[] {
  const trimmed = name.trim();
  if (!trimmed) return carts;
  const cart: NamedCart = { id: crypto.randomUUID(), name: trimmed, createdAt: Date.now(), items: [] };
  return [cart, ...carts];
}

export function renameNamedCart(carts: NamedCart[], id: string, name: string): NamedCart[] {
  const trimmed = name.trim();
  if (!trimmed) return carts;
  return carts.map((c) => (c.id === id ? { ...c, name: trimmed } : c));
}

export function deleteNamedCart(carts: NamedCart[], id: string): NamedCart[] {
  return carts.filter((c) => c.id !== id);
}

// Adds the item if the cart doesn't already contain it (by normalised URL), removes it otherwise.
export function toggleItemInNamedCart(carts: NamedCart[], id: string, item: SavedCartItem): NamedCart[] {
  return carts.map((c) => {
    if (c.id !== id) return c;
    const normalized = normalizeUrl(item.url);
    const has = c.items.some((i) => normalizeUrl(i.url) === normalized);
    const items = has
      ? c.items.filter((i) => normalizeUrl(i.url) !== normalized)
      : [...c.items, item];
    return { ...c, items };
  });
}

// How many of `items` the cart already contains, by normalised URL.
export function countItemsInNamedCart(cart: NamedCart, items: SavedCartItem[]): number {
  const held = new Set(cart.items.map((i) => normalizeUrl(i.url)));
  return items.filter((i) => held.has(normalizeUrl(i.url))).length;
}

// Puts every one of `items` into the cart, skipping those it already contains,
// or takes them all out: checking a whole selection in or out at once.
export function setItemsInNamedCart(carts: NamedCart[], id: string, items: SavedCartItem[], include: boolean): NamedCart[] {
  return carts.map((c) => {
    if (c.id !== id) return c;
    const held = new Set(c.items.map((i) => normalizeUrl(i.url)));
    if (include) {
      const added = items.filter((i) => !held.has(normalizeUrl(i.url)));
      return { ...c, items: [...c.items, ...added] };
    }
    const removed = new Set(items.map((i) => normalizeUrl(i.url)));
    return { ...c, items: c.items.filter((i) => !removed.has(normalizeUrl(i.url))) };
  });
}

// Maps a normalised item URL to the ids of every named cart containing it.
export function namedCartMembership(carts: NamedCart[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const cart of carts) {
    for (const item of cart.items) {
      const normalized = normalizeUrl(item.url);
      const ids = map.get(normalized);
      if (ids) {
        ids.push(cart.id);
      } else {
        map.set(normalized, [cart.id]);
      }
    }
  }
  return map;
}

// Splits a named cart's items against the live Bandcamp cart: present = still
// in the real cart, stale = no longer there (but still resolvable at checkout).
export function partitionByCart(
  cart: NamedCart,
  currentItems: SavedCartItem[]
): { present: SavedCartItem[]; stale: SavedCartItem[] } {
  const currentNorms = new Set(currentItems.map((i) => normalizeUrl(i.url)));
  const present: SavedCartItem[] = [];
  const stale: SavedCartItem[] = [];
  for (const item of cart.items) {
    (currentNorms.has(normalizeUrl(item.url)) ? present : stale).push(item);
  }
  return { present, stale };
}
