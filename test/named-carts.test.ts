import { describe, it, expect } from 'vitest';
import type { NamedCart, SavedCartItem } from '../src/types';
import {
  createNamedCart,
  renameNamedCart,
  deleteNamedCart,
  countItemsInNamedCart,
  setItemsInNamedCart,
  namedCartMembership,
  partitionByCart,
} from '../src/named-carts';

function item(slug: string, title = `Item ${slug}`, purchaseType?: 'track' | 'album'): SavedCartItem {
  return { url: `https://a.bandcamp.com/album/${slug}`, title, purchaseType };
}

function namedCart(id: string, name: string, items: SavedCartItem[] = []): NamedCart {
  return { id, name, createdAt: 1000, items };
}

// --- createNamedCart ----------------------------------------------------------

describe('createNamedCart', () => {
  it('adds a new empty cart with the given name', () => {
    const result = createNamedCart([], 'Friday set');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Friday set');
    expect(result[0]!.items).toHaveLength(0);
  });

  it('prepends the new cart (most recent first)', () => {
    const existing = [namedCart('1', 'Old')];
    const result = createNamedCart(existing, 'New');
    expect(result[0]!.name).toBe('New');
    expect(result[1]!.name).toBe('Old');
  });

  it('trims surrounding whitespace from the name', () => {
    const result = createNamedCart([], '  Friday set  ');
    expect(result[0]!.name).toBe('Friday set');
  });

  it('does not add a cart when the name is blank', () => {
    const existing = [namedCart('1', 'Old')];
    expect(createNamedCart(existing, '   ')).toBe(existing);
  });

  it('assigns each new cart a unique id', () => {
    const first = createNamedCart([], 'A');
    const second = createNamedCart(first, 'B');
    expect(second[0]!.id).not.toBe(second[1]!.id);
  });

  it('does not mutate the input array', () => {
    const existing = [namedCart('1', 'Old')];
    createNamedCart(existing, 'New');
    expect(existing).toHaveLength(1);
  });
});

// --- renameNamedCart ------------------------------------------------------------

describe('renameNamedCart', () => {
  it('renames the matching cart', () => {
    const existing = [namedCart('1', 'Old')];
    const result = renameNamedCart(existing, '1', 'New name');
    expect(result[0]!.name).toBe('New name');
  });

  it('leaves other carts untouched', () => {
    const existing = [namedCart('1', 'A'), namedCart('2', 'B')];
    const result = renameNamedCart(existing, '1', 'Renamed');
    expect(result[1]!.name).toBe('B');
  });

  it('does nothing when no cart matches the id', () => {
    const existing = [namedCart('1', 'A')];
    const result = renameNamedCart(existing, 'missing', 'New');
    expect(result[0]!.name).toBe('A');
  });

  it('does not rename to a blank name', () => {
    const existing = [namedCart('1', 'Old')];
    expect(renameNamedCart(existing, '1', '   ')).toBe(existing);
  });
});

// --- deleteNamedCart ------------------------------------------------------------

describe('deleteNamedCart', () => {
  it('removes the matching cart', () => {
    const existing = [namedCart('1', 'A'), namedCart('2', 'B')];
    const result = deleteNamedCart(existing, '1');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('2');
  });

  it('returns an equivalent array when no cart matches the id', () => {
    const existing = [namedCart('1', 'A')];
    const result = deleteNamedCart(existing, 'missing');
    expect(result).toHaveLength(1);
  });
});

// --- countItemsInNamedCart / setItemsInNamedCart ----------------------------

describe('countItemsInNamedCart', () => {
  it('counts the given items the cart already holds, ignoring a trailing slash', () => {
    const cart = namedCart('1', 'Set', [item('a'), item('b')]);
    const b = { ...item('b'), url: `${item('b').url}/` };
    expect(countItemsInNamedCart(cart, [item('a'), b, item('c')])).toBe(2);
  });
});

describe('setItemsInNamedCart', () => {
  it('adds only the items the cart does not hold yet, after the existing ones', () => {
    const carts = [namedCart('1', 'Set', [item('a')])];
    const result = setItemsInNamedCart(carts, '1', [item('a'), item('b'), item('c')], true);
    expect(result[0]!.items.map((i) => i.url)).toEqual([item('a').url, item('b').url, item('c').url]);
  });

  it('removes all the given items and keeps the rest', () => {
    const carts = [namedCart('1', 'Set', [item('a'), item('b'), item('c')])];
    const result = setItemsInNamedCart(carts, '1', [item('a'), item('c'), item('d')], false);
    expect(result[0]!.items.map((i) => i.url)).toEqual([item('b').url]);
  });

  it('leaves other carts alone', () => {
    const other = namedCart('2', 'Other', [item('x')]);
    const result = setItemsInNamedCart([namedCart('1', 'Set'), other], '1', [item('a')], true);
    expect(result[1]).toBe(other);
  });

  it('matches items regardless of case and a trailing slash', () => {
    const carts = [namedCart('1', 'Set', [{ url: 'https://a.bandcamp.com/album/FOO/', title: 'Foo' }])];
    const foo = { url: 'https://a.bandcamp.com/album/foo', title: 'Foo' };
    expect(setItemsInNamedCart(carts, '1', [foo], true)[0]!.items).toHaveLength(1);
    expect(setItemsInNamedCart(carts, '1', [foo], false)[0]!.items).toHaveLength(0);
  });

  it('does not change the cart list it was given', () => {
    const carts = [namedCart('1', 'Set')];
    setItemsInNamedCart(carts, '1', [item('a')], true);
    expect(carts[0]!.items).toHaveLength(0);
  });
});

// --- namedCartMembership --------------------------------------------------------

describe('namedCartMembership', () => {
  it('maps an item URL to the id of the cart containing it', () => {
    const carts = [namedCart('1', 'A', [item('x')])];
    const map = namedCartMembership(carts);
    expect(map.get('https://a.bandcamp.com/album/x')).toEqual(['1']);
  });

  it('lists multiple cart ids when an item is tagged into more than one cart', () => {
    const carts = [namedCart('1', 'A', [item('x')]), namedCart('2', 'B', [item('x')])];
    const map = namedCartMembership(carts);
    expect(map.get('https://a.bandcamp.com/album/x')).toEqual(['1', '2']);
  });

  it('normalises URLs used as map keys', () => {
    const carts = [namedCart('1', 'A', [{ url: 'https://a.bandcamp.com/album/FOO/', title: 'Foo' }])];
    const map = namedCartMembership(carts);
    expect(map.has('https://a.bandcamp.com/album/foo')).toBe(true);
  });

  it('returns an empty map when there are no carts', () => {
    expect(namedCartMembership([]).size).toBe(0);
  });
});

// --- partitionByCart -------------------------------------------------------------

describe('partitionByCart', () => {
  it('puts items that are still in the current cart into present', () => {
    const cart = namedCart('1', 'A', [item('a'), item('b')]);
    const { present, stale } = partitionByCart(cart, [item('a'), item('b')]);
    expect(present).toHaveLength(2);
    expect(stale).toHaveLength(0);
  });

  it('puts items no longer in the current cart into stale', () => {
    const cart = namedCart('1', 'A', [item('a'), item('b')]);
    const { present, stale } = partitionByCart(cart, [item('a')]);
    expect(present).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.url).toContain('b');
  });

  it('treats all items as stale when the current cart is empty', () => {
    const cart = namedCart('1', 'A', [item('a')]);
    const { present, stale } = partitionByCart(cart, []);
    expect(present).toHaveLength(0);
    expect(stale).toHaveLength(1);
  });

  it('normalises URLs when comparing against the current cart', () => {
    const cart = namedCart('1', 'A', [{ url: 'https://a.bandcamp.com/album/FOO/', title: 'Foo' }]);
    const { present } = partitionByCart(cart, [{ url: 'https://a.bandcamp.com/album/foo', title: 'Foo' }]);
    expect(present).toHaveLength(1);
  });
});
