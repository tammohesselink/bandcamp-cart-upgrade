import type { CartSnapshot, SavedCartItem } from './types';
import { diffSnapshot } from './cart-history';
import { normalizeUrl } from './url';
import { formatTimestamp } from './format';
import { ensureModalStyles } from './styles';

export interface CartHistoryModalDeps {
  snapshots: CartSnapshot[];
  initialItems: SavedCartItem[];
  addItem(item: SavedCartItem, cartLengthHint: number): Promise<boolean>;
  removeItem(item: SavedCartItem): Promise<boolean>;
  // Warms whatever addItem needs, so a full restore only waits on the cart
  // changes themselves, which must run one at a time.
  prepareAdds?(items: SavedCartItem[], onProgress: (done: number) => void): Promise<void>;
}

const HISTORY_STYLE_ID = 'bcp-cart-history-styles';

function ensureCartHistoryStyles(): void {
  if (document.getElementById(HISTORY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HISTORY_STYLE_ID;
  style.textContent = `
    .bcp-hm-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
    .bcp-hm-header h3{margin:0}
    .bcp-toggle-all{padding:4px 10px;border-radius:4px;border:1px solid #ccc;background:none;cursor:pointer;font-size:12px;font-family:inherit}
    .bcp-toggle-all:hover{background:#f5f5f5}
    .bcp-toggle-all:disabled{opacity:.5;cursor:default}
    .bcp-snap-hd{display:flex;align-items:center;gap:10px}
    .bcp-snap-chevron{width:10px;flex-shrink:0;color:#999;font-size:11px;display:inline-block;transition:transform .1s}
    .bcp-snap-chevron.bcp-open{transform:rotate(90deg)}
    .bcp-snap-ts{flex:1;font-size:13px}
    .bcp-snap-count{color:#999;font-size:12px;white-space:nowrap}
    .bcp-snap-same{color:#ccc;font-size:12px;font-weight:600;white-space:nowrap}
    .bcp-snap-diff{font-size:12px;white-space:nowrap}
    .bcp-snap-diff .bcp-add-count{color:#1da0c3}
    .bcp-snap-diff .bcp-extra-count{color:#bbb;margin-left:4px}
    .bcp-snap-items{list-style:none;margin:8px 0 0;padding:0;font-size:12px}
    .bcp-snap-item-row{display:flex;align-items:center;gap:8px;padding:3px 0}
    .bcp-snap-item-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bcp-item-add .bcp-snap-item-label{color:#1a1a1a}
    .bcp-item-extra .bcp-snap-item-label{color:#999}
    .bcp-item-action{padding:2px 8px;border-radius:3px;border:1px solid #1da0c3;color:#1da0c3;background:none;cursor:pointer;font-size:11px;font-family:inherit;white-space:nowrap}
    .bcp-item-action:hover:not(:disabled){background:#e8f7fb}
    .bcp-item-action.bcp-remove-action{border-color:#c0392b;color:#c0392b}
    .bcp-item-action.bcp-remove-action:hover:not(:disabled){background:#fbeceb}
    .bcp-item-action:disabled{opacity:.5;cursor:default}
    .bcp-item-error{font-size:11px;color:#c0392b;white-space:nowrap}
    .bcp-snap-restore-all{padding:2px 8px;border-radius:3px;border:1px solid #1da0c3;color:#1da0c3;background:none;cursor:pointer;font-size:11px;font-family:inherit;white-space:nowrap}
    .bcp-snap-restore-all:hover:not(:disabled){background:#e8f7fb}
    .bcp-snap-restore-all:disabled{opacity:.5;cursor:default}
  `;
  document.head.appendChild(style);
}

// The modal stays open across mutations, re-rendering every row's diff after each one.
// Resolves with the number of successful mutations so the caller can decide whether to reload.
export function openCartHistoryModal(deps: CartHistoryModalDeps): Promise<number> {
  ensureModalStyles();
  ensureCartHistoryStyles();

  let currentItems = deps.initialItems.slice();
  const expanded = new Set<number>();
  const itemErrors = new Map<string, string>();
  let busy = false;
  let changedCount = 0;
  let restoreProgress: { savedAt: number; phase: 'preparing' | 'restoring'; done: number; total: number } | null = null;

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'bcp-hb';

    const modal = document.createElement('div');
    modal.className = 'bcp-hm';
    backdrop.appendChild(modal);

    let list: HTMLUListElement | undefined;

    const close = (): void => {
      if (busy) return;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(changedCount);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    function renderItemRow(item: SavedCartItem, kind: 'add' | 'remove'): HTMLLIElement {
      const key = `${kind}:${normalizeUrl(item.url)}`;
      const row = document.createElement('li');
      row.className = `bcp-snap-item-row ${kind === 'add' ? 'bcp-item-add' : 'bcp-item-extra'}`;

      const label = document.createElement('span');
      label.className = 'bcp-snap-item-label';
      label.textContent = `${kind === 'add' ? '+' : '−'} ${item.title || item.url}`;
      row.appendChild(label);

      const error = itemErrors.get(key);
      if (error) {
        const errorSpan = document.createElement('span');
        errorSpan.className = 'bcp-item-error';
        errorSpan.textContent = error;
        row.appendChild(errorSpan);
      }

      const actionBtn = document.createElement('button');
      actionBtn.className = kind === 'add' ? 'bcp-item-action' : 'bcp-item-action bcp-remove-action';
      actionBtn.textContent = kind === 'add' ? 'Add back' : 'Remove';
      actionBtn.disabled = busy;
      actionBtn.addEventListener('click', () => void runItemAction(item, kind));
      row.appendChild(actionBtn);

      return row;
    }

    async function runItemAction(item: SavedCartItem, kind: 'add' | 'remove'): Promise<void> {
      if (busy) return;
      const key = `${kind}:${normalizeUrl(item.url)}`;
      busy = true;
      itemErrors.delete(key);
      render();

      const ok = kind === 'add'
        ? await deps.addItem(item, currentItems.length)
        : await deps.removeItem(item);

      if (ok) {
        currentItems = kind === 'add'
          ? [...currentItems, item]
          : currentItems.filter((i) => normalizeUrl(i.url) !== normalizeUrl(item.url));
        changedCount++;
      } else {
        itemErrors.set(key, kind === 'add' ? 'Add failed' : 'Remove failed');
      }

      busy = false;
      render();
    }

    async function restoreCompletely(
      snapshot: CartSnapshot,
      toAdd: SavedCartItem[],
      extra: SavedCartItem[]
    ): Promise<void> {
      if (busy) return;
      busy = true;
      if (deps.prepareAdds && toAdd.length > 0) {
        const prepareTotal = toAdd.length;
        restoreProgress = { savedAt: snapshot.savedAt, phase: 'preparing', done: 0, total: prepareTotal };
        render();
        await deps.prepareAdds(toAdd, (done) => {
          restoreProgress = { savedAt: snapshot.savedAt, phase: 'preparing', done, total: prepareTotal };
          render();
        });
      }

      const total = toAdd.length + extra.length;
      restoreProgress = { savedAt: snapshot.savedAt, phase: 'restoring', done: 0, total };
      render();

      for (const item of toAdd) {
        const key = `add:${normalizeUrl(item.url)}`;
        itemErrors.delete(key);
        const ok = await deps.addItem(item, currentItems.length);
        if (ok) {
          currentItems = [...currentItems, item];
          changedCount++;
        } else {
          itemErrors.set(key, 'Add failed');
        }
        restoreProgress = { savedAt: snapshot.savedAt, phase: 'restoring', done: restoreProgress.done + 1, total };
        render();
      }
      for (const item of extra) {
        const key = `remove:${normalizeUrl(item.url)}`;
        itemErrors.delete(key);
        const ok = await deps.removeItem(item);
        if (ok) {
          currentItems = currentItems.filter((i) => normalizeUrl(i.url) !== normalizeUrl(item.url));
          changedCount++;
        } else {
          itemErrors.set(key, 'Remove failed');
        }
        restoreProgress = { savedAt: snapshot.savedAt, phase: 'restoring', done: restoreProgress.done + 1, total };
        render();
      }

      busy = false;
      restoreProgress = null;
      render();
    }

    function render(): void {
      const scrollTop = list?.scrollTop ?? 0;
      modal.replaceChildren();

      const diffs = deps.snapshots.map((snapshot) => ({ snapshot, ...diffSnapshot(snapshot, currentItems) }));
      const expandable = diffs.filter((d) => d.toAdd.length > 0 || d.extra.length > 0);

      const header = document.createElement('div');
      header.className = 'bcp-hm-header';

      const title = document.createElement('h3');
      title.textContent = 'Cart history';
      header.appendChild(title);

      const allExpanded = expandable.length > 0 && expandable.every((d) => expanded.has(d.snapshot.savedAt));
      const toggleAllBtn = document.createElement('button');
      toggleAllBtn.className = 'bcp-toggle-all';
      toggleAllBtn.textContent = allExpanded ? 'Collapse all' : 'Expand all';
      toggleAllBtn.disabled = busy || expandable.length === 0;
      toggleAllBtn.addEventListener('click', () => {
        if (allExpanded) {
          expanded.clear();
        } else {
          for (const d of expandable) expanded.add(d.snapshot.savedAt);
        }
        render();
      });
      header.appendChild(toggleAllBtn);
      modal.appendChild(header);

      list = document.createElement('ul');
      list.className = 'bcp-hl';

      for (const { snapshot, toAdd, extra } of diffs) {
        const li = document.createElement('li');
        const hasDiff = toAdd.length > 0 || extra.length > 0;
        const isOpen = expanded.has(snapshot.savedAt);
        const isRestoringThis = restoreProgress !== null && restoreProgress.savedAt === snapshot.savedAt;

        const headerRow = document.createElement('div');
        headerRow.className = 'bcp-snap-hd';

        if (hasDiff) {
          li.classList.add('bcp-clickable');
          const chevron = document.createElement('span');
          chevron.className = `bcp-snap-chevron${isOpen ? ' bcp-open' : ''}`;
          chevron.textContent = '▸';
          headerRow.appendChild(chevron);
          headerRow.addEventListener('click', () => {
            if (busy) return;
            if (isOpen) expanded.delete(snapshot.savedAt); else expanded.add(snapshot.savedAt);
            render();
          });
        }

        const ts = document.createElement('span');
        ts.className = 'bcp-snap-ts';
        ts.textContent = formatTimestamp(snapshot.savedAt);
        headerRow.appendChild(ts);

        const count = document.createElement('span');
        count.className = 'bcp-snap-count';
        count.textContent = `${snapshot.items.length} item${snapshot.items.length !== 1 ? 's' : ''}`;
        headerRow.appendChild(count);

        if (!hasDiff) {
          const same = document.createElement('span');
          same.className = 'bcp-snap-same';
          same.textContent = 'current';
          headerRow.appendChild(same);
        } else {
          const diff = document.createElement('span');
          diff.className = 'bcp-snap-diff';
          if (toAdd.length > 0) {
            const addSpan = document.createElement('span');
            addSpan.className = 'bcp-add-count';
            addSpan.textContent = `+${toAdd.length}`;
            diff.appendChild(addSpan);
          }
          if (extra.length > 0) {
            const extraSpan = document.createElement('span');
            extraSpan.className = 'bcp-extra-count';
            extraSpan.textContent = `−${extra.length}`;
            diff.appendChild(extraSpan);
          }
          headerRow.appendChild(diff);
        }

        // In the header so it stays in reach above a long list of items.
        if (hasDiff || isRestoringThis) {
          const restoreAllBtn = document.createElement('button');
          restoreAllBtn.className = 'bcp-snap-restore-all';
          restoreAllBtn.textContent = isRestoringThis
            ? `${restoreProgress!.phase === 'preparing' ? 'Fetching prices' : 'Restoring'} ${restoreProgress!.done} / ${restoreProgress!.total}…`
            : 'Restore this cart';
          restoreAllBtn.disabled = busy;
          restoreAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void restoreCompletely(snapshot, toAdd, extra);
          });
          headerRow.appendChild(restoreAllBtn);
        }

        li.appendChild(headerRow);

        if (isOpen && hasDiff) {
          const itemList = document.createElement('ul');
          itemList.className = 'bcp-snap-items';
          for (const item of toAdd) itemList.appendChild(renderItemRow(item, 'add'));
          for (const item of extra) itemList.appendChild(renderItemRow(item, 'remove'));
          li.appendChild(itemList);
        }

        list.appendChild(li);
      }
      modal.appendChild(list);
      list.scrollTop = scrollTop;

      const actions = document.createElement('div');
      actions.className = 'bcp-ha';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'bcp-hcl';
      closeBtn.textContent = 'Close';
      closeBtn.disabled = busy;
      closeBtn.addEventListener('click', close);
      actions.appendChild(closeBtn);
      modal.appendChild(actions);
    }

    render();
    document.body.appendChild(backdrop);
  });
}
