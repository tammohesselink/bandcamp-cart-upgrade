import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SavedCartItem, CartSnapshot } from '../src/types';
import { openCartHistoryModal, type CartHistoryModalDeps } from '../src/cart-history-modal';

function item(slug: string, title = `Item ${slug}`): SavedCartItem {
  return { url: `https://a.bandcamp.com/album/${slug}`, title, purchaseType: 'album' };
}

function snapshot(items: SavedCartItem[], savedAt: number): CartSnapshot {
  return { savedAt, items };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function modal(): HTMLElement {
  return document.querySelector('.bcp-hm') as HTMLElement;
}

function snapshotRows(): HTMLLIElement[] {
  return Array.from(modal().querySelectorAll('ul.bcp-hl > li'));
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

function makeDeps(overrides: Partial<CartHistoryModalDeps> = {}): CartHistoryModalDeps {
  return {
    snapshots: [],
    initialItems: [],
    addItem: vi.fn().mockResolvedValue(true),
    removeItem: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

afterEach(() => {
  document.querySelector('.bcp-hb')?.remove();
});

describe('openCartHistoryModal', () => {
  it('renders collapsed rows with counts only and no item text', async () => {
    const snap = snapshot([item('a'), item('b'), item('c')], 1000);
    void openCartHistoryModal(makeDeps({
      snapshots: [snap],
      initialItems: [item('a')],
    }));

    const rows = snapshotRows();
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0]!.querySelector('.bcp-snap-count'))).toBe('3 items');
    expect(textOf(rows[0]!.querySelector('.bcp-add-count'))).toBe('+2');
    expect(rows[0]!.querySelector('.bcp-snap-items')).toBeNull();
    expect(rows[0]!.textContent).not.toContain('Item b');
  });

  it('expanding a row reveals per-item buttons and the restore-completely button', async () => {
    const snap = snapshot([item('a'), item('b')], 1000);
    void openCartHistoryModal(makeDeps({
      snapshots: [snap],
      initialItems: [item('a')],
    }));

    const header = snapshotRows()[0]!.querySelector('.bcp-snap-hd') as HTMLElement;
    header.click();

    const row = snapshotRows()[0]!;
    expect(textOf(row.querySelector('.bcp-item-action'))).toBe('Add back');
    expect(textOf(row.querySelector('.bcp-snap-restore-all'))).toBe('Restore this cart');
  });

  it('restores a collapsed row from its header without expanding it', async () => {
    const target = snapshot([item('a'), item('b')], 1000);
    const deps = makeDeps({ snapshots: [target], initialItems: [item('a')] });
    void openCartHistoryModal(deps);

    (snapshotRows()[0]!.querySelector('.bcp-snap-restore-all') as HTMLButtonElement).click();
    await flush();

    expect(deps.addItem).toHaveBeenCalledTimes(1);
    expect(snapshotRows()[0]!.querySelector('.bcp-snap-items')).toBeNull();
    expect(textOf(snapshotRows()[0]!.querySelector('.bcp-snap-same'))).toBe('current');
  });

  it('prepares every add before the first cart change of a complete restore', async () => {
    const target = snapshot([item('a'), item('b'), item('c')], 1000);
    const calls: string[] = [];
    const deps = makeDeps({
      snapshots: [target],
      initialItems: [item('a')],
      prepareAdds: vi.fn(async (items: SavedCartItem[], onProgress: (done: number) => void) => {
        calls.push(`prepare ${items.length}`);
        onProgress(items.length);
      }),
      addItem: vi.fn(async (added: SavedCartItem) => {
        calls.push(`add ${added.title}`);
        return true;
      }),
    });
    void openCartHistoryModal(deps);

    (snapshotRows()[0]!.querySelector('.bcp-snap-restore-all') as HTMLButtonElement).click();
    await flush();

    expect(calls).toEqual(['prepare 2', 'add Item b', 'add Item c']);
  });

  it('the master toggle expands every row and then collapses every row', async () => {
    const snapshots = [snapshot([item('a'), item('b')], 2000), snapshot([item('a')], 1000)];
    void openCartHistoryModal(makeDeps({ snapshots, initialItems: [item('a')] }));

    const toggleAllBtn = modal().querySelector('.bcp-toggle-all') as HTMLButtonElement;
    expect(toggleAllBtn.textContent).toBe('Expand all');

    toggleAllBtn.click();
    let rows = snapshotRows();
    expect(rows[0]!.querySelector('.bcp-snap-items')).not.toBeNull();
    expect(modal().querySelector('.bcp-toggle-all')!.textContent).toBe('Collapse all');

    (modal().querySelector('.bcp-toggle-all') as HTMLButtonElement).click();
    rows = snapshotRows();
    expect(rows[0]!.querySelector('.bcp-snap-items')).toBeNull();
  });

  it('adding one item back updates the counts on the other snapshot rows without closing', async () => {
    const target = snapshot([item('a'), item('b')], 2000);
    const other = snapshot([item('a'), item('b'), item('c')], 1000);
    const deps = makeDeps({ snapshots: [target, other], initialItems: [item('a')] });
    void openCartHistoryModal(deps);

    (snapshotRows()[0]!.querySelector('.bcp-snap-hd') as HTMLElement).click();
    (snapshotRows()[0]!.querySelector('.bcp-item-action') as HTMLButtonElement).click();
    await flush();

    expect(deps.addItem).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.bcp-hb')).not.toBeNull();

    const rows = snapshotRows();
    expect(textOf(rows[0]!.querySelector('.bcp-snap-same'))).toBe('current');
    expect(textOf(rows[1]!.querySelector('.bcp-add-count'))).toBe('+1');
  });

  it('removing one item updates the counts on the other snapshot rows without closing', async () => {
    const p = snapshot([item('a')], 2000);
    const q = snapshot([item('a'), item('c')], 1000);
    const deps = makeDeps({ snapshots: [p, q], initialItems: [item('a'), item('b')] });
    void openCartHistoryModal(deps);

    (snapshotRows()[0]!.querySelector('.bcp-snap-hd') as HTMLElement).click();
    (snapshotRows()[0]!.querySelector('.bcp-item-action.bcp-remove-action') as HTMLButtonElement).click();
    await flush();

    expect(deps.removeItem).toHaveBeenCalledTimes(1);
    const rows = snapshotRows();
    expect(textOf(rows[0]!.querySelector('.bcp-snap-same'))).toBe('current');
    expect(textOf(rows[1]!.querySelector('.bcp-add-count'))).toBe('+1');
    expect(rows[1]!.querySelector('.bcp-extra-count')).toBeNull();
  });

  it('restoring completely applies every add and every remove for that snapshot', async () => {
    const target = snapshot([item('a'), item('b')], 1000);
    const deps = makeDeps({ snapshots: [target], initialItems: [item('a'), item('extra')] });
    void openCartHistoryModal(deps);

    (snapshotRows()[0]!.querySelector('.bcp-snap-hd') as HTMLElement).click();
    (snapshotRows()[0]!.querySelector('.bcp-snap-restore-all') as HTMLButtonElement).click();
    await flush();

    expect(deps.addItem).toHaveBeenCalledTimes(1);
    expect((deps.addItem as ReturnType<typeof vi.fn>).mock.calls[0]![0].url).toContain('/b');
    expect(deps.removeItem).toHaveBeenCalledTimes(1);
    expect((deps.removeItem as ReturnType<typeof vi.fn>).mock.calls[0]![0].url).toContain('/extra');
    expect(textOf(snapshotRows()[0]!.querySelector('.bcp-snap-same'))).toBe('current');
  });

  it('a failed add leaves the item listed and surfaces an inline error', async () => {
    const snap = snapshot([item('a'), item('b')], 1000);
    const deps = makeDeps({
      snapshots: [snap],
      initialItems: [item('a')],
      addItem: vi.fn().mockResolvedValue(false),
    });
    void openCartHistoryModal(deps);

    (snapshotRows()[0]!.querySelector('.bcp-snap-hd') as HTMLElement).click();
    (snapshotRows()[0]!.querySelector('.bcp-item-action') as HTMLButtonElement).click();
    await flush();

    const row = snapshotRows()[0]!;
    expect(textOf(row.querySelector('.bcp-add-count'))).toBe('+1');
    expect(textOf(row.querySelector('.bcp-item-error'))).toBe('Add failed');
    const actionBtn = row.querySelector('.bcp-item-action') as HTMLButtonElement;
    expect(actionBtn.disabled).toBe(false);
    expect(actionBtn.textContent).toBe('Add back');
  });

  it('a failed remove during a complete restore leaves the item listed with an inline error', async () => {
    const target = snapshot([item('a'), item('b')], 1000);
    const deps = makeDeps({
      snapshots: [target],
      initialItems: [item('a'), item('extra')],
      removeItem: vi.fn().mockResolvedValue(false),
    });
    void openCartHistoryModal(deps);

    (snapshotRows()[0]!.querySelector('.bcp-snap-hd') as HTMLElement).click();
    (snapshotRows()[0]!.querySelector('.bcp-snap-restore-all') as HTMLButtonElement).click();
    await flush();

    const row = snapshotRows()[0]!;
    expect(row.querySelector('.bcp-add-count')).toBeNull();
    expect(textOf(row.querySelector('.bcp-extra-count'))).toBe('−1');
    expect(textOf(row.querySelector('.bcp-item-error'))).toBe('Remove failed');
    expect(textOf(row.querySelector('.bcp-snap-restore-all'))).toBe('Restore this cart');
  });

  it('all action buttons are disabled while a mutation is in flight', async () => {
    let resolveAdd!: (ok: boolean) => void;
    const pending = new Promise<boolean>((r) => { resolveAdd = r; });
    const snap = snapshot([item('a'), item('b')], 1000);
    const deps = makeDeps({
      snapshots: [snap],
      initialItems: [item('a')],
      addItem: vi.fn().mockReturnValue(pending),
    });
    void openCartHistoryModal(deps);

    (snapshotRows()[0]!.querySelector('.bcp-snap-hd') as HTMLElement).click();
    (snapshotRows()[0]!.querySelector('.bcp-item-action') as HTMLButtonElement).click();
    await flush();

    expect((modal().querySelector('.bcp-item-action') as HTMLButtonElement).disabled).toBe(true);
    expect((modal().querySelector('.bcp-hcl') as HTMLButtonElement).disabled).toBe(true);
    expect((modal().querySelector('.bcp-toggle-all') as HTMLButtonElement).disabled).toBe(true);

    resolveAdd(true);
    await flush();
    expect(document.querySelector('.bcp-item-action')).toBeNull();
  });

  it('resolves with zero when closed without changes, and with the change count otherwise', async () => {
    const snap = snapshot([item('a'), item('b')], 1000);
    const deps = makeDeps({ snapshots: [snap], initialItems: [item('a')] });
    const result = openCartHistoryModal(deps);

    (modal().querySelector('.bcp-hcl') as HTMLButtonElement).click();
    expect(await result).toBe(0);

    document.body.innerHTML = '';
    const deps2 = makeDeps({ snapshots: [snap], initialItems: [item('a')] });
    const result2 = openCartHistoryModal(deps2);

    (snapshotRows()[0]!.querySelector('.bcp-snap-hd') as HTMLElement).click();
    (snapshotRows()[0]!.querySelector('.bcp-item-action') as HTMLButtonElement).click();
    await flush();
    (modal().querySelector('.bcp-hcl') as HTMLButtonElement).click();

    expect(await result2).toBe(1);
  });
});
