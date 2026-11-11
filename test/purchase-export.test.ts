import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isPurchasesPage, readOrderHistoryContext } from '../src/bandcamp-dom';
import { injectPurchaseExport } from '../src/purchase-export';
import { RATES_STORAGE_KEY } from '../src/purchases';

function setLocation(hostname: string, pathname: string): void {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, hostname, pathname, href: `https://${hostname}${pathname}` },
    configurable: true,
  });
}

function setUpPurchasesPage(blob: unknown): void {
  document.head.innerHTML = '';
  document.body.innerHTML = `
    <div id="pagedata" data-blob='${JSON.stringify(blob)}'></div>
    <div id="js-crumbs-data" data-crumbs='{"api/orderhistory/1/get_items":"page-crumb"}'></div>
    <div class="purchases"></div>`;
}

const FAN_BLOB = { identities: { fan: { username: 'somefan' } }, orderhistory: { total_items: 3 } };

describe('isPurchasesPage', () => {
  beforeEach(() => setUpPurchasesPage(FAN_BLOB));

  it('recognises bandcamp.com/<username>/purchases', () => {
    setLocation('bandcamp.com', '/somefan/purchases');
    expect(isPurchasesPage()).toBe(true);
  });

  it('ignores other pages and artist domains', () => {
    setLocation('bandcamp.com', '/somefan');
    expect(isPurchasesPage()).toBe(false);
    setLocation('artist.bandcamp.com', '/somefan/purchases');
    expect(isPurchasesPage()).toBe(false);
  });
});

describe('readOrderHistoryContext', () => {
  it('reads the logged-in username and order count', () => {
    setUpPurchasesPage(FAN_BLOB);
    expect(readOrderHistoryContext()).toEqual({ username: 'somefan', totalItems: 3 });
  });

  it('is null when logged out', () => {
    setUpPurchasesPage({ identities: { fan: null } });
    expect(readOrderHistoryContext()).toBeNull();
  });
});

describe('injectPurchaseExport', () => {
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useRealTimers();
    setUpPurchasesPage(FAN_BLOB);
    sent = [];
    const pages = [
      { items: [
        { payment_date: '02 Jan 2023 12:00:00 GMT', currency: 'EUR', unit_price: 10, item_title: 'Old', artist_name: 'A' },
        { payment_date: '15 Mar 2024 12:00:00 GMT', currency: 'USD', unit_price: 11, item_title: 'New', artist_name: 'B' },
      ], last_token: 't1' },
      { items: [], last_token: 't2' },
    ];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: async (msg: Record<string, unknown>) => {
          sent.push(msg);
          return { ok: true, body: pages[sent.length - 1], crumb: 'fresh-crumb' };
        },
      },
      storage: {
        local: {
          get: async () => ({
            [RATES_STORAGE_KEY]: { startDate: '2020-01-01', endDate: '2999-01-01', rates: { '2024-03-15': { USD: 1.1 } } },
          }),
          set: async () => {},
        },
      },
    };
  });

  it('loads nothing until asked, then shows the total in the most used currency', async () => {
    injectPurchaseExport();
    const panel = document.getElementById('bcp-purchase-export')!;
    expect(panel.nextElementSibling?.classList.contains('purchases')).toBe(true);
    expect(sent).toHaveLength(0);

    vi.useFakeTimers();
    panel.querySelector('button')!.click();
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    expect(sent.map((m) => [m.lastToken, m.crumb])).toEqual([[null, 'page-crumb'], ['t1', 'fresh-crumb']]);
    const yearSelect = panel.querySelectorAll('select')[0]!;
    yearSelect.value = 'all';
    yearSelect.dispatchEvent(new Event('change'));
    // EUR and USD are tied, so the first seen (EUR) wins: €10 + $11 → €20.
    expect(panel.querySelector('.bcp-purchase-export-total')!.textContent).toMatch(/All time: .*20\.00/);
    expect(panel.textContent).toContain('2 purchases');
  });

  it('retries a failed page and carries on from it after giving up', async () => {
    let failuresLeft = 5;
    const answer = (msg: Record<string, unknown>) => {
      sent.push(msg);
      if (msg.lastToken === 't1' && failuresLeft-- > 0) return { ok: false, error: 'HTTP 429' };
      if (msg.lastToken === null) {
        return { ok: true, crumb: 'c', body: { items: [{ payment_date: '15 Mar 2024 12:00:00 GMT', currency: 'EUR', unit_price: 1 }], last_token: 't1' } };
      }
      return { ok: true, crumb: 'c', body: { items: [], last_token: 't2' } };
    };
    (globalThis as unknown as { chrome: { runtime: unknown } }).chrome.runtime = { sendMessage: async (m: Record<string, unknown>) => answer(m) };

    injectPurchaseExport();
    const panel = document.getElementById('bcp-purchase-export')!;
    vi.useFakeTimers();
    panel.querySelector('button')!.click();
    await vi.runAllTimersAsync();
    // The first page, then the second tried four times (once and three retries).
    expect(sent.map((m) => m.lastToken)).toEqual([null, 't1', 't1', 't1', 't1']);
    expect(panel.textContent).toContain('1 purchases loaded so far are kept');

    sent = [];
    panel.querySelector('button')!.click();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    // Carries on from the failed page instead of starting over.
    expect(sent[0]!.lastToken).toBe('t1');
    expect(panel.querySelector('.bcp-purchase-export-total')).not.toBeNull();
  });

  it('only injects once', () => {
    injectPurchaseExport();
    injectPurchaseExport();
    expect(document.querySelectorAll('#bcp-purchase-export')).toHaveLength(1);
  });
});
