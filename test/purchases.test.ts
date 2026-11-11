import { describe, it, expect, vi } from 'vitest';
import {
  ALL_YEARS,
  FrankfurterHttpError,
  convert,
  convertPurchases,
  inYear,
  loadRates,
  mostUsedCurrency,
  parseOrderHistoryItem,
  parseOrderHistoryPage,
  purchaseYears,
  purchasesToCsv,
  ratesStartFor,
  totalPurchases,
  type Purchase,
  type RatesCache,
  type RatesDeps,
  type RatesTable,
} from '../src/purchases';

function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    paymentDate: '2024-03-15',
    artist: 'Artist',
    title: 'Release',
    url: 'https://artist.bandcamp.com/album/release',
    currency: 'EUR',
    unitPrice: 10,
    quantity: 1,
    shipping: 0,
    tax: 0,
    totalPrice: 10,
    ...overrides,
  };
}

const RATES: RatesTable = {
  '2024-03-15': { USD: 1.1, GBP: 0.85 },
  '2025-06-02': { USD: 1.2, GBP: 0.8 },
};

describe('parseOrderHistoryItem', () => {
  it('reads a Bandcamp order and adds up its total', () => {
    const parsed = parseOrderHistoryItem({
      payment_date: '15 Mar 2024 12:00:00 GMT',
      artist_name: 'Some Artist',
      item_title: 'Some Album',
      item_url: 'https://someartist.bandcamp.com/album/some-album',
      currency: 'usd',
      unit_price: 7,
      quantity: 2,
      shipping: 5,
      tax: 1.5,
    });
    expect(parsed).toMatchObject({
      paymentDate: '2024-03-15',
      artist: 'Some Artist',
      title: 'Some Album',
      currency: 'USD',
      totalPrice: 20.5,
    });
  });

  it('counts a missing quantity as one and missing amounts as zero', () => {
    const parsed = parseOrderHistoryItem({ payment_date: '15 Mar 2024 12:00:00 GMT', currency: 'EUR', unit_price: 4, shipping: null, tax: null });
    expect(parsed?.totalPrice).toBe(4);
  });

  it('skips an order without a readable date or currency', () => {
    expect(parseOrderHistoryItem({ payment_date: 'not a date', currency: 'EUR' })).toBeNull();
    expect(parseOrderHistoryItem({ payment_date: '15 Mar 2024 12:00:00 GMT' })).toBeNull();
    expect(parseOrderHistoryItem(null)).toBeNull();
  });
});

describe('parseOrderHistoryPage', () => {
  it('counts every item Bandcamp sent, including unreadable ones', () => {
    const page = parseOrderHistoryPage({
      items: [{ payment_date: '15 Mar 2024 12:00:00 GMT', currency: 'EUR', unit_price: 1 }, { junk: true }],
      last_token: 'abc',
    });
    expect(page.purchases).toHaveLength(1);
    expect(page.itemCount).toBe(2);
    expect(page.lastToken).toBe('abc');
  });

  it('reads an unexpected answer as an empty last page', () => {
    expect(parseOrderHistoryPage('nope')).toEqual({ purchases: [], itemCount: 0, lastToken: null });
  });
});

describe('convert', () => {
  it('converts through EUR at the rates of the payment date', () => {
    expect(convert(11, 'USD', 'EUR', RATES, '2024-03-15')).toBeCloseTo(10);
    expect(convert(10, 'EUR', 'GBP', RATES, '2024-03-15')).toBeCloseTo(8.5);
    expect(convert(11, 'USD', 'GBP', RATES, '2024-03-15')).toBeCloseTo(8.5);
  });

  it('uses the last business day before a weekend or holiday', () => {
    // 2024-03-17 is a Sunday.
    expect(convert(10, 'EUR', 'USD', RATES, '2024-03-17')).toBeCloseTo(11);
  });

  it('needs no rates for the same currency', () => {
    expect(convert(10, 'JPY', 'JPY', {}, '2024-03-15')).toBe(10);
  });

  it('fails without rates near the date or for an unknown currency', () => {
    expect(() => convert(10, 'EUR', 'USD', RATES, '2020-01-01')).toThrow();
    expect(() => convert(10, 'EUR', 'XYZ', RATES, '2024-03-15')).toThrow(/XYZ/);
  });
});

describe('convertPurchases and totalPurchases', () => {
  it('totals converted purchases and keeps unconvertible ones for the export', () => {
    const converted = convertPurchases(
      [purchase(), purchase({ currency: 'USD', totalPrice: 11 }), purchase({ currency: 'XYZ', totalPrice: 3 })],
      RATES,
      'EUR',
    );
    expect(converted[2]!.convertedTotal).toBeNull();
    expect(converted[2]!.conversionError).toMatch(/XYZ/);

    const totals = totalPurchases(converted);
    expect(totals.convertedTotal).toBeCloseTo(20);
    expect(totals.convertedCount).toBe(2);
    expect(totals.unconvertedCount).toBe(1);
    expect(totals.byCurrency.map((c) => c.currency)).toEqual(['EUR', 'USD', 'XYZ']);
  });

  it('still converts same-currency purchases when rates could not be loaded', () => {
    const converted = convertPurchases([purchase(), purchase({ currency: 'USD', totalPrice: 11 })], null, 'EUR');
    expect(converted.map((p) => p.convertedTotal)).toEqual([10, null]);
  });
});

describe('years and currencies', () => {
  const purchases = [
    purchase({ paymentDate: '2023-01-02', currency: 'USD' }),
    purchase({ paymentDate: '2025-06-02', currency: 'GBP' }),
    purchase({ paymentDate: '2025-07-01', currency: 'GBP' }),
  ];

  it('lists the years with purchases, newest first, and filters by year', () => {
    expect(purchaseYears(purchases)).toEqual(['2025', '2023']);
    expect(inYear(purchases, '2025')).toHaveLength(2);
    expect(inYear(purchases, ALL_YEARS)).toHaveLength(3);
  });

  it('picks the most used currency', () => {
    expect(mostUsedCurrency(purchases)).toBe('GBP');
    expect(mostUsedCurrency([])).toBeNull();
  });

  it('starts the rates in mid-December before the first purchase year', () => {
    expect(ratesStartFor(purchases)).toBe('2022-12-15');
    expect(ratesStartFor([])).toBeNull();
  });
});

describe('purchasesToCsv', () => {
  it('writes one row per purchase, oldest first, quoting where needed', () => {
    const csv = purchasesToCsv(
      convertPurchases(
        [
          purchase({ paymentDate: '2025-06-02', title: 'Late, "quoted"', currency: 'USD', totalPrice: 12, unitPrice: 12 }),
          purchase({ paymentDate: '2024-03-15' }),
        ],
        RATES,
        'EUR',
      ),
      'EUR',
    );
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Date,Artist,Title,URL,Currency,Unit price,Quantity,Shipping,Tax,Total,Total in EUR');
    expect(lines[1]).toMatch(/^2024-03-15,Artist,Release,/);
    expect(lines[2]).toContain('"Late, ""quoted"""');
    expect(lines[2]!.endsWith(',12,10')).toBe(true);
  });

  it('keeps spreadsheet apps from running a title as a formula', () => {
    const csv = purchasesToCsv(convertPurchases([purchase({ title: '=HYPERLINK("x")' })], RATES, 'EUR'), 'EUR');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('writes why a purchase could not be converted in place of its converted total', () => {
    const csv = purchasesToCsv(convertPurchases([purchase({ currency: 'XYZ' })], RATES, 'EUR'), 'EUR');
    expect(csv).toMatch(/No exchange rate for XYZ/);
  });
});

describe('loadRates', () => {
  function deps(cache: unknown, fetched: RatesTable = { '2026-11-10': { USD: 1.1 } }) {
    const written: RatesCache[] = [];
    const fetchRates = vi.fn(async () => fetched);
    const d: RatesDeps = {
      fetchRates,
      readCache: async () => cache,
      writeCache: async (c) => { written.push(c); },
      today: '2026-11-11',
    };
    return { d, fetchRates, written };
  }

  it('fetches the whole range without a cache and stores it', async () => {
    const { d, fetchRates, written } = deps(undefined);
    const rates = await loadRates('2020-01-01', d);
    expect(fetchRates).toHaveBeenCalledWith('2020-01-01', '2026-11-11');
    expect(rates).toEqual({ '2026-11-10': { USD: 1.1 } });
    expect(written[0]).toMatchObject({ startDate: '2020-01-01', endDate: '2026-11-10' });
  });

  it('only fetches the days since the last cached rate day', async () => {
    const cache: RatesCache = { startDate: '2020-01-01', endDate: '2026-11-06', rates: { '2026-11-06': { USD: 1 } } };
    const { d, fetchRates, written } = deps(cache);
    const rates = await loadRates('2021-01-01', d);
    expect(fetchRates).toHaveBeenCalledWith('2026-11-06', '2026-11-11');
    expect(Object.keys(rates)).toEqual(['2026-11-06', '2026-11-10']);
    expect(written[0]!.endDate).toBe('2026-11-10');
  });

  it('refetches everything when an earlier start is needed', async () => {
    const cache: RatesCache = { startDate: '2020-01-01', endDate: '2026-11-11', rates: {} };
    const { d, fetchRates } = deps(cache);
    await loadRates('2015-01-01', d);
    expect(fetchRates).toHaveBeenCalledWith('2015-01-01', '2026-11-11');
  });

  it('uses an up-to-date cache without fetching', async () => {
    const cache: RatesCache = { startDate: '2020-01-01', endDate: '2026-11-11', rates: { '2026-11-11': { USD: 1 } } };
    const { d, fetchRates } = deps(cache);
    expect(await loadRates('2020-01-01', d)).toBe(cache.rates);
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('keeps the cache when frankfurter has nothing newer', async () => {
    const cache: RatesCache = { startDate: '2020-01-01', endDate: '2026-11-10', rates: { '2026-11-10': { USD: 1 } } };
    const { d } = deps(cache);
    d.fetchRates = async () => { throw new FrankfurterHttpError(404); };
    expect(await loadRates('2020-01-01', d)).toBe(cache.rates);
  });

  it('uses the cache when the refresh fails', async () => {
    const cache: RatesCache = { startDate: '2020-01-01', endDate: '2026-11-06', rates: { '2026-11-06': { USD: 1 } } };
    const { d } = deps(cache);
    d.fetchRates = async () => { throw new FrankfurterHttpError(503); };
    expect(await loadRates('2020-01-01', d)).toBe(cache.rates);
  });

  it('asks for newer rates at most once a day', async () => {
    // A Saturday: Friday's rates are the latest, and they were checked today.
    const cache: RatesCache = { startDate: '2020-01-01', endDate: '2026-11-06', checkedDate: '2026-11-11', rates: {} };
    const { d, fetchRates } = deps(cache);
    await loadRates('2020-01-01', d);
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('remembers the day it checked', async () => {
    const cache: RatesCache = { startDate: '2020-01-01', endDate: '2026-11-06', rates: {} };
    const { d, written } = deps(cache);
    await loadRates('2020-01-01', d);
    expect(written[0]!.checkedDate).toBe('2026-11-11');
  });

  it('still returns fetched rates when storage fails', async () => {
    const { d } = deps(undefined);
    d.readCache = async () => { throw new Error('no storage'); };
    d.writeCache = async () => { throw new Error('no storage'); };
    expect(await loadRates('2020-01-01', d)).toEqual({ '2026-11-10': { USD: 1.1 } });
  });
});
